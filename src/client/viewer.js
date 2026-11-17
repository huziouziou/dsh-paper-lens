// dsh-paper-lens — the PDF view: pages drawn by pdf.js with its text layer on
// top, so text can be selected. No React here; the body component owns one.
//
// Built to stay smooth on long papers:
//  - page positions are computed from page sizes, never measured per scroll
//    event; the current page is a binary search, at most once per frame;
//  - ONE page renders at a time, nearest to the reading position first, and
//    a page that scrolls away before its turn is dropped from the queue;
//  - the text layer is built in idle time after the page image;
//  - pages far from view are freed and re-rendered when they come back;
//  - zoom stretches the current images at once, then re-renders them sharp.

import * as pdfjs from 'pdfjs-dist';
import { attachSelectionFix } from './selection.js';
import { findInItems, findAllInItems, boxesFor, searchOrder } from './textsearch.js';
import { isMarginFurniture } from './margins.js';
import { anchorFrom, normalizeAnchor, topForAnchor } from './anchor.js';

let sharedWorker; // undefined: not made yet; null: none (tests)

/**
 * One long-lived pdf.js worker for every PDF view, passed to each document
 * explicitly.
 *
 * It used to be installed as GlobalWorkerOptions.workerPort. Then closing one
 * view (following a link to another PDF unmounts the old one) destroyed that
 * shared worker while the new view was already creating a document on it:
 * "PDFWorker.create - the worker is being destroyed". pdf.js never destroys
 * a worker it was handed via getDocument({ worker }), so this one outlives
 * every document.
 */
function getWorker() {
  if (sharedWorker !== undefined) return sharedWorker;
  // eslint-disable-next-line no-undef
  const source = typeof __DSH_CITE_LENS_WORKER__ === 'string' ? __DSH_CITE_LENS_WORKER__ : null;
  if (source === null) {
    sharedWorker = null; // tests: pdf.js falls back to its fake worker
    return sharedWorker;
  }
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  const port = new Worker(url, { type: 'module', name: 'dsh-paper-lens' });
  sharedWorker = new pdfjs.PDFWorker({ port, name: 'dsh-paper-lens' });
  return sharedWorker;
}

function ensureWorker() {
  getWorker();
}

export const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const GAP = 14; // px between pages (matches .dpa-pages gap)
const PAD_TOP = 16; // px above the first page (matches .dpa-pages padding)
const KEEP = 6; // pages either side of the reading position kept rendered
const PRELOAD = 2; // pages either side rendered ahead of time
const MAX_CANVAS_PIXELS = 16_777_216;
const SETTLE_MS = 140; // scroll quiet this long before sharp re-renders
const FAST_PX_PER_MS = 2.5; // above this the scroll is a fling: hold new renders

const idle = (fn) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 250 }) : setTimeout(fn, 16));

export class PdfView {
  /**
   * @param container where the pages are stacked (owned by this view)
   * @param scroller  the element that scrolls — the container's own root, or the Files tab's scroll area
   * @param opts.onPage called with the page most in view
   * @param opts.onPosition called with the exact scroll position ({ page, offset }) as it moves
   */
  constructor(container, scroller, { onPage, onPosition } = {}) {
    ensureWorker();
    this.container = container;
    this.scroller = scroller;
    this.onPage = onPage;
    this.onPosition = onPosition;
    this.pages = [];
    this.tops = [];
    this.heights = [];
    this.doc = null;
    this.zoom = 'fit';
    this.scale = 1;
    this.currentPage = 1;
    this.disposed = false;
    this.active = null; // the page being rendered right now
    this.queue = []; // page numbers waiting to render, nearest first
    this.frame = 0;
    this.lastScroll = { y: 0, t: 0, speed: 0 };
    this.settleTimer = null;
    this.marks = [];
    this.onMarkClick = null;
    this.pendingAnchor = null;

    this.resizeObserver = new ResizeObserver(() => {
      // A tab that was hidden while the PDF opened has no height yet: the saved
      // position can only be applied once it is laid out (scrollTop on a hidden
      // element stays 0).
      if (this.pendingAnchor) this.applyPendingPage();
      if (this.zoom === 'fit') this.relayout();
    });
    this.resizeObserver.observe(container);
    this.onScroll = () => {
      const now = performance.now();
      const y = this.scroller.scrollTop;
      const dt = Math.max(1, now - this.lastScroll.t);
      this.lastScroll = { y, t: now, speed: Math.abs(y - this.lastScroll.y) / dt };
      clearTimeout(this.settleTimer);
      this.settleTimer = setTimeout(() => {
        this.lastScroll.speed = 0;
        this.schedule();
      }, SETTLE_MS);
      if (this.frame) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.trackPage();
        this.schedule();
      });
    };
    scroller.addEventListener('scroll', this.onScroll, { passive: true });
    this.detachSelection = attachSelectionFix();
  }

  async open(bytes) {
    // pdf.js transfers the buffer to its worker; give it a copy so the tab's
    // own bytes stay usable for a reload.
    const data = bytes.slice ? bytes.slice() : new Uint8Array(bytes);
    const worker = getWorker();
    this.task = pdfjs.getDocument({ data, isEvalSupported: false, enableXfa: false, ...(worker ? { worker } : {}) });
    const doc = await this.task.promise;
    if (this.disposed) return;
    this.doc = doc;
    const first = await doc.getPage(1);
    if (this.disposed) return;
    this.baseSize = first.getViewport({ scale: 1 });
    this.build();
    // Real page sizes arrive in the background, so mixed portrait/landscape
    // papers settle without blocking the first paint.
    this.loadSizes();
  }

  get numPages() {
    return this.doc?.numPages ?? 0;
  }

  computeScale() {
    if (this.zoom !== 'fit') return this.zoom;
    const width = Math.max(200, this.container.clientWidth - 32);
    return Math.max(0.25, Math.min(4, width / this.baseSize.width));
  }

  build() {
    this.scale = this.computeScale();
    const frag = document.createDocumentFragment();
    for (let n = 1; n <= this.doc.numPages; n += 1) {
      const el = document.createElement('div');
      el.className = 'dpa-page dpa-pending';
      el.dataset.page = String(n);
      const label = document.createElement('div');
      label.className = 'dpa-pageno';
      label.textContent = String(n);
      el.appendChild(label);
      frag.appendChild(el);
      this.pages.push({ n, el, size: { width: this.baseSize.width, height: this.baseSize.height }, rendered: 0, canvas: null, text: null, task: null, textTask: null });
    }
    this.container.appendChild(frag);
    this.applySizes();
    // Not trackPage(true): a forced track reports page 1 as if the reader had
    // moved there, and the body saves that over the real last page. The bar
    // starts at 1 anyway; restoring a saved page sets currentPage explicitly.
    this.trackPage();
    this.schedule();
  }

  /**
   * Put the reader back exactly where it was, once the scroller has a real
   * height. Accepts what earlier versions saved (a bare page number) as well as
   * the current `{ page, offset }` form. Setting scrollTop on a hidden tab does
   * nothing, so keep the position pending and let the ResizeObserver retry when
   * the tab is shown.
   */
  restorePage(remembered) {
    const anchor = normalizeAnchor(remembered);
    if (!anchor || !this.pages.length) return false;
    anchor.page = Math.max(1, Math.min(Math.floor(anchor.page), this.pages.length));
    // A fresh document sits above page 1 (negative offset): nothing to restore.
    if (anchor.page <= 1 && anchor.offset <= 0.001) return false;
    this.pendingAnchor = anchor;
    return this.applyPendingPage();
  }

  applyPendingPage() {
    const anchor = this.pendingAnchor;
    if (!anchor || this.disposed || !this.pages.length) return false;
    if (this.scroller.clientHeight === 0) return false;
    this.pendingAnchor = null;
    return this.scrollToAnchor(anchor);
  }

  /** Where the reader is now: the page under the viewport's top edge, plus how far into it. */
  anchorState() {
    if (!this.pages.length) return null;
    return anchorFrom(this.scroller.scrollTop - (this.containerOffset ?? 0), this.tops, this.heights);
  }

  /** Scroll so the viewport's top edge sits back on a saved `{ page, offset }`. */
  scrollToAnchor(anchor, track = true) {
    if (!anchor || !this.pages.length) return false;
    const top = topForAnchor(anchor, this.tops, this.heights);
    this.scroller.scrollTop = Math.max(0, (this.containerOffset ?? 0) + top);
    if (track) {
      this.trackPage();
      this.schedule();
    }
    return true;
  }

  async loadSizes() {
    for (const page of this.pages) {
      if (this.disposed) return;
      if (page.n === 1) continue;
      try {
        const p = await this.doc.getPage(page.n);
        const v = p.getViewport({ scale: 1 });
        if (Math.abs(v.width - page.size.width) > 0.5 || Math.abs(v.height - page.size.height) > 0.5) {
          page.size = { width: v.width, height: v.height };
          this.applySizes(true);
        }
      } catch { /* keep the first page's size */ }
    }
  }

  /** Size every page box for the current scale and recompute their positions. */
  applySizes(keepPosition = false) {
    // Read the position before the sizes change: it is a fraction of the page
    // height, so it survives a resize while an absolute scrollTop would not.
    const saved = keepPosition ? this.anchorState() : null;
    const s = this.scale;
    let top = PAD_TOP;
    this.tops = [];
    this.heights = [];
    for (const page of this.pages) {
      const w = Math.floor(page.size.width * s);
      const h = Math.floor(page.size.height * s);
      const style = page.el.style;
      style.width = `${w}px`;
      style.height = `${h}px`;
      style.setProperty('--scale-factor', String(s));
      style.setProperty('--total-scale-factor', String(s));
      style.setProperty('--scale-round-x', '1px');
      style.setProperty('--scale-round-y', '1px');
      page.h = h;
      this.tops.push(top);
      this.heights.push(h);
      top += h + GAP;
    }
    this.containerOffset = this.container.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top + this.scroller.scrollTop;
    if (saved) this.scrollToAnchor(saved, false);
  }

  /** A page's top in the scroller's coordinates. */
  topOf(n) {
    return (this.containerOffset ?? 0) + (this.tops[n - 1] ?? 0);
  }

  scrollToPage(n, within = 0, track = true) {
    const clamped = Math.max(1, Math.min(n, this.pages.length));
    const page = this.pages[clamped - 1];
    if (!page) return;
    this.scroller.scrollTop = this.topOf(clamped) - 48 + within * page.h;
    if (track) {
      this.trackPage();
      this.schedule();
    }
  }

  /** The page under the reading line, by binary search over the computed tops. */
  trackPage(force = false) {
    if (!this.pages.length) return;
    const line = this.scroller.scrollTop + this.scroller.clientHeight * 0.35 - (this.containerOffset ?? 0);
    let lo = 0;
    let hi = this.tops.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.tops[mid] <= line) lo = mid;
      else hi = mid - 1;
    }
    const found = lo + 1;
    if (force || found !== this.currentPage) {
      this.currentPage = found;
      this.onPage?.(found);
    }
    // The exact position, not just the page: a tab reopened mid-page (or across
    // a page break) has to land on the same line the reader was looking at.
    if (this.onPosition) this.onPosition(this.anchorState());
  }

  /** Pages currently on screen. */
  visibleRange() {
    const top = this.scroller.scrollTop - (this.containerOffset ?? 0);
    const bottom = top + this.scroller.clientHeight;
    let first = this.currentPage;
    while (first > 1 && this.tops[first - 2] + this.pages[first - 2].h > top) first -= 1;
    while (first < this.pages.length && this.tops[first - 1] + this.pages[first - 1].h < top) first += 1;
    let last = first;
    while (last < this.pages.length && this.tops[last] < bottom) last += 1;
    return [first, last];
  }

  /** Queue what should be rendered, nearest first; free what is far away. */
  schedule() {
    if (this.disposed || !this.pages.length) return;
    const [first, last] = this.visibleRange();
    const want = [];
    for (let n = first; n <= last; n += 1) want.push(n);
    for (let d = 1; d <= PRELOAD; d += 1) {
      if (last + d <= this.pages.length) want.push(last + d);
      if (first - d >= 1) want.push(first - d);
    }
    // During a fling nothing new starts (pages keep their grey placeholder);
    // once it slows, visible pages draw fast at 1x, then sharp when settled.
    if (this.lastScroll.speed > FAST_PX_PER_MS) {
      this.queue = [];
    } else {
      const settled = this.lastScroll.speed === 0;
      this.queue = want
        .filter((n) => !this.isCurrent(this.pages[n - 1], settled))
        .sort((a, b) => Number(this.pages[a - 1].rendered === this.scale) - Number(this.pages[b - 1].rendered === this.scale));
    }
    for (const page of this.pages) {
      if ((page.n < first - KEEP || page.n > last + KEEP) && page.rendered) this.release(page);
    }
    this.pump();
  }

  pump() {
    if (this.active || this.disposed) return;
    const n = this.queue.shift();
    if (n === undefined) return;
    const page = this.pages[n - 1];
    if (this.isCurrent(page, this.lastScroll.speed === 0)) {
      this.pump();
      return;
    }
    this.active = page;
    this.renderPage(page).finally(() => {
      if (this.active === page) this.active = null;
      this.pump();
    });
  }

  /** Drawn at this scale already, and sharp when it needs to be. */
  isCurrent(page, settled) {
    if (page.rendered !== this.scale) return false;
    return !settled || page.sharp || (window.devicePixelRatio || 1) <= 1;
  }

  async renderPage(entry) {
    const scale = this.scale;
    // First draw at 1x so pages appear quickly; once scrolling settles the
    // same page is redrawn at the screen's full density.
    const sharp = entry.rendered === scale || this.lastScroll.speed === 0;
    try {
      const page = await this.doc.getPage(entry.n);
      if (this.disposed || scale !== this.scale) return;
      const viewport = page.getViewport({ scale });
      let ratio = sharp ? Math.min(window.devicePixelRatio || 1, 2) : 1;
      const pixels = viewport.width * viewport.height * ratio * ratio;
      if (pixels > MAX_CANVAS_PIXELS) ratio *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);

      const canvas = document.createElement('canvas');
      canvas.className = 'dpa-canvas';
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      entry.task = page.render({
        canvas,
        canvasContext: canvas.getContext('2d', { alpha: false }),
        viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      });
      await entry.task.promise;
      entry.task = null;
      if (this.disposed || scale !== this.scale) return;

      // Swap the new image in over the old (stretched) one: no blank frame.
      const old = entry.canvas;
      entry.el.prepend(canvas);
      requestAnimationFrame(() => canvas.classList.add('dpa-shown'));
      if (old) setTimeout(() => this.dropCanvas(old), 150);
      entry.canvas = canvas;
      const first = entry.rendered !== scale;
      entry.rendered = scale;
      entry.sharp = ratio > 1 || (window.devicePixelRatio || 1) <= 1;
      entry.el.classList.remove('dpa-pending');

      // The text layer comes after, in idle time, so scrolling never waits on it.
      if (first || !entry.text) idle(() => this.renderText(entry, page, viewport, scale));
    } catch (error) {
      if (error?.name !== 'RenderingCancelledException') entry.el.dataset.error = String(error?.message ?? error);
    }
  }

  async renderText(entry, page, viewport, scale) {
    if (this.disposed || scale !== this.scale || entry.rendered !== scale) return;
    entry.textTask?.cancel?.();
    const div = document.createElement('div');
    div.className = 'textLayer';
    const layer = new pdfjs.TextLayer({
      textContentSource: page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }),
      container: div,
      viewport,
    });
    entry.textTask = layer;
    try {
      await layer.render();
    } catch {
      return;
    }
    if (this.disposed || scale !== this.scale || entry.rendered !== scale) return;
    const end = document.createElement('div');
    end.className = 'endOfContent';
    div.append(end);
    entry.text?.remove();
    entry.el.appendChild(div);
    entry.text = div;
    entry.textTask = null;
  }

  dropCanvas(canvas) {
    canvas.width = 0; // frees the backing store immediately
    canvas.height = 0;
    canvas.remove();
  }

  /** Free a far-away page; it re-renders when it comes back into range. */
  release(page) {
    page.task?.cancel?.();
    page.textTask?.cancel?.();
    page.task = null;
    page.textTask = null;
    if (page.canvas) this.dropCanvas(page.canvas);
    page.text?.remove();
    page.canvas = null;
    page.text = null;
    page.rendered = 0;
    page.sharp = false;
    page.el.classList.add('dpa-pending');
  }

  /** New scale: stretch what is drawn now, keep the reading position, re-render sharp. */
  relayout() {
    if (!this.doc) return;
    const next = this.computeScale();
    if (Math.abs(next - this.scale) < 0.001) return;
    this.scale = next;
    for (const page of this.pages) {
      // The text layer is positioned for the old scale; hide it until rebuilt.
      page.text?.remove();
      page.text = null;
      page.textTask?.cancel?.();
    }
    this.applySizes(true);
    this.schedule();
  }

  setZoom(zoom) {
    this.zoom = zoom;
    this.relayout();
  }

  zoomBy(direction) {
    const current = this.scale;
    const steps = direction > 0 ? ZOOM_STEPS.filter((z) => z > current + 0.001) : ZOOM_STEPS.filter((z) => z < current - 0.001).reverse();
    if (steps.length) this.setZoom(steps[0]);
  }

  /**
   * Find quoted words: the hinted page first, then its neighbours, then the
   * rest. Searches pdf.js text content, so undrawn pages count too.
   * @returns {{ page: number, boxes: object[] } | null}
   */
  async locate(quote, hint) {
    if (!this.doc || !quote) return null;
    this.textCache ??= new Map();
    for (const n of searchOrder(this.doc.numPages, hint)) {
      if (this.disposed) return null;
      let entry = this.textCache.get(n);
      if (!entry) {
        const page = await this.doc.getPage(n);
        const { items } = await page.getTextContent();
        entry = { items, viewport: page.getViewport({ scale: 1 }) };
        this.textCache.set(n, entry);
      }
      const spans = findInItems(entry.items, quote);
      if (spans) return { page: n, boxes: boxesFor(spans, entry.items, entry.viewport) };
    }
    return null;
  }

  /** Scroll a passage into view (about a third down the screen) and highlight it. */
  reveal(n, boxes = []) {
    const page = this.pages[n - 1];
    if (!page) return;
    if (boxes.length) {
      const top = Math.min(...boxes.map((b) => b.y));
      const target = this.topOf(n) + top * page.h - this.scroller.clientHeight * 0.3;
      this.scroller.scrollTop = Math.max(0, target);
      this.trackPage();
      this.schedule();
    } else {
      this.scrollToPage(n);
    }
    this.flash(n, boxes);
  }

  /** Briefly mark a page, and the passage on it when given (in page-relative fractions). */
  flash(n, boxes = []) {
    const page = this.pages[n - 1];
    if (!page) return;
    page.el.classList.remove('dpa-flash');
    void page.el.offsetWidth;
    page.el.classList.add('dpa-flash');
    for (const box of boxes) {
      const mark = document.createElement('div');
      mark.className = 'dpa-mark';
      mark.style.left = `${box.x * 100}%`;
      mark.style.top = `${box.y * 100}%`;
      mark.style.width = `${box.w * 100}%`;
      mark.style.height = `${box.h * 100}%`;
      page.el.appendChild(mark);
      setTimeout(() => mark.remove(), 3400);
    }
    setTimeout(() => page.el.classList.remove('dpa-flash'), 1600);
  }

  /**
   * Every occurrence of a query in the document, in page order. Reads pdf.js
   * text content directly, so pages that were never drawn are searched too.
   * @returns {{ page: number, boxes: object[] }[]}
   */
  async findText(query, limit = 300) {
    if (!this.doc || !String(query ?? '').trim()) return [];
    this.textCache ??= new Map();
    const hits = [];
    for (let n = 1; n <= this.doc.numPages && hits.length < limit; n += 1) {
      if (this.disposed) return hits;
      let entry = this.textCache.get(n);
      if (!entry) {
        const page = await this.doc.getPage(n);
        const { items } = await page.getTextContent();
        entry = { items, viewport: page.getViewport({ scale: 1 }) };
        this.textCache.set(n, entry);
      }
      for (const spans of findAllInItems(entry.items, query, limit - hits.length)) {
        const boxes = boxesFor(spans, entry.items, entry.viewport);
        if (boxes.length) hits.push({ page: n, boxes });
      }
    }
    return hits;
  }

  /** Scroll to a find hit and keep it highlighted until the next one or a clear. */
  showHit(pageNo, boxes = []) {
    const page = this.pages[pageNo - 1];
    if (!page) return;
    this.clearFind();
    if (boxes.length) {
      const top = Math.min(...boxes.map((b) => b.y));
      this.scroller.scrollTop = Math.max(0, this.topOf(pageNo) + top * page.h - this.scroller.clientHeight * 0.35);
      this.trackPage();
      this.schedule();
    } else {
      this.scrollToPage(pageNo);
    }
    for (const box of boxes) {
      const hit = document.createElement('div');
      hit.className = 'dpa-find';
      hit.style.left = `${box.x * 100}%`;
      hit.style.top = `${box.y * 100}%`;
      hit.style.width = `${box.w * 100}%`;
      hit.style.height = `${box.h * 100}%`;
      page.el.appendChild(hit);
    }
  }

  /** Drop the find highlight (the box was cleared or another file opened). */
  clearFind() {
    for (const page of this.pages) page.el.querySelectorAll('.dpa-find').forEach((el) => el.remove());
  }

  /**
   * Draw stored annotations on their pages.
   * They are page-relative percentages, so zooming and re-rendering the page
   * text never needs to move them. The translucent bands are pointer-events:none
   * (text selection still works through them); a small numbered badge at the
   * first line opens the mark's popover.
   */
  setMarks(marks, onMarkClick) {
    this.marks = Array.isArray(marks) ? marks : [];
    this.onMarkClick = onMarkClick ?? null;
    for (const page of this.pages) {
      page.el.querySelectorAll('.dpa-anno, .dpa-anno-badge').forEach((el) => el.remove());
    }
    if (!this.marks.length || !this.pages.length) return;
    const total = this.marks.length;
    for (const [index, mark] of this.marks.entries()) {
      const page = this.pages[mark.pageIndex];
      if (!page) continue;
      const boxes = Array.isArray(mark.segmentRects) && mark.segmentRects.length ? mark.segmentRects : [mark.rect];
      for (const box of boxes) {
        if (!box) continue;
        const band = document.createElement('div');
        band.className = 'dpa-anno';
        band.style.left = `${box.x * 100}%`;
        band.style.top = `${box.y * 100}%`;
        band.style.width = `${box.w * 100}%`;
        band.style.height = `${box.h * 100}%`;
        band.style.background = mark.strokeColor;
        band.title = mark.custom?.quote ?? '';
        page.el.appendChild(band);
      }
      const first = boxes[0];
      if (!first) continue;
      const badge = document.createElement('button');
      badge.type = 'button';
      badge.className = 'dpa-anno-badge';
      badge.textContent = String(index + 1);
      badge.title = mark.custom?.quote ?? `第 ${mark.pageIndex + 1} 页批注`;
      badge.setAttribute('aria-label', `批注 ${index + 1}：${badge.title}`);
      badge.style.left = `${first.x * 100}%`;
      badge.style.top = `${first.y * 100}%`;
      badge.style.background = mark.strokeColor;
      badge.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      badge.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.onMarkClick?.(mark, event);
      });
      page.el.appendChild(badge);
    }
    this.container.dataset.marks = String(total);
  }

  dispose() {
    this.disposed = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    clearTimeout(this.settleTimer);
    this.resizeObserver.disconnect();
    this.scroller.removeEventListener('scroll', this.onScroll);
    this.detachSelection?.();
    for (const page of this.pages) this.release(page);
    this.task?.destroy?.();
    this.container.replaceChildren();
  }
}

/**
 * Where a DOM selection sits in a PDF: its page and, for a later flash, its
 * boxes as fractions of that page. Null when the selection is not on a page.
 *
 * Cross-page selections are the reason this is more than `selection.toString()`:
 * the browser's string runs from the caret on page A to the caret on page B, so it
 * picks up whatever sits between them — running heads, the bioRxiv licence strip,
 * footers. We rebuild the text page by page and drop the small type in the top
 * band of a page the selection only passes into (and the bottom band it passes
 * out of). A single-page selection keeps every line, exactly as before.
 */
export function selectionInPdf(selection, root) {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const node = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
  const pageEl = node?.closest?.('.dpa-page');
  if (!pageEl || !root.contains(pageEl)) return null;
  const pieces = selectionPieces(range, root);
  if (!pieces.length) return null;
  const text = selectionText(groupPieces(pieces));
  if (text.trim() === '') return null;
  const pageRect = pageEl.getBoundingClientRect();
  const boxes = [...range.getClientRects()]
    .filter((r) => r.width > 1 && r.height > 1)
    .map((r) => ({
      x: (r.left - pageRect.left) / pageRect.width,
      y: (r.top - pageRect.top) / pageRect.height,
      w: r.width / pageRect.width,
      h: r.height / pageRect.height,
    }))
    .filter((b) => b.x > -0.05 && b.x < 1.05 && b.y > -0.05 && b.y < 1.05 && b.w < 1.1);
  const rect = range.getBoundingClientRect();
  // A cross-page selection's union rect can sit mostly below the viewport (its
  // bottom is off-screen), so the toolbar anchored to it lands off-screen too.
  // Anchor on the last line that is actually visible: that is the end of the
  // selection the reader is looking at, or the bottom edge of a long one.
  const rects = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1);
  const height = typeof window === 'undefined' ? 0 : window.innerHeight;
  const visible = rects.filter((r) => r.bottom > 4 && r.top < height - 4 && r.right > 0 && r.left < window.innerWidth);
  const anchor = visible.length ? visible[visible.length - 1] : null;
  const pages = [...new Set(pieces.map((piece) => Number(piece.pageEl.dataset.page)))];
  return { page: Number(pageEl.dataset.page), pages, text, boxes, rect, anchor };
}

/**
 * The selected words per page, clipped to the selection, with the geometry we
 * need to tell body text from a running head. Only pages the selection touches
 * are walked, so a long document costs nothing.
 */
function selectionPieces(range, root) {
  const pieces = [];
  for (const pageEl of root.querySelectorAll('.dpa-page')) {
    if (!range.intersectsNode(pageEl)) continue;
    const walker = document.createTreeWalker(pageEl, NodeFilter.SHOW_TEXT, {
      acceptNode(text) {
        if (!text.nodeValue || text.nodeValue.trim() === '') return NodeFilter.FILTER_REJECT;
        if (text.parentElement?.closest('.dpa-anno, .dpa-anno-badge, .dpa-pageno')) return NodeFilter.FILTER_REJECT;
        return range.intersectsNode(text) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      const start = text === range.startContainer ? range.startOffset : 0;
      const end = text === range.endContainer ? range.endOffset : text.nodeValue.length;
      if (end <= start) continue;
      const value = text.nodeValue.slice(start, end);
      if (value.trim() === '') continue;
      const clipped = document.createRange();
      clipped.setStart(text, start);
      clipped.setEnd(text, end);
      const rects = [...clipped.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5);
      if (!rects.length) continue;
      const style = text.parentElement ? getComputedStyle(text.parentElement) : null;
      pieces.push({
        pageEl,
        text: value,
        rects,
        rect: rects[0],
        fontSize: parseFloat(style?.fontSize ?? '') || 0,
      });
    }
  }
  return pieces;
}

/** Pieces in reading order, grouped by the page they sit on. */
function groupPieces(pieces) {
  const groups = [];
  const byPage = new Map();
  for (const piece of pieces) {
    let group = byPage.get(piece.pageEl);
    if (!group) {
      group = { pageEl: piece.pageEl, pieces: [] };
      byPage.set(piece.pageEl, group);
      groups.push(group);
    }
    group.pieces.push(piece);
  }
  return groups;
}

/** The page's body size, used to recognise smaller running heads/footers. */
function medianFontSize(pieces) {
  const sizes = pieces.map((piece) => piece.fontSize).filter((size) => size > 0).sort((a, b) => a - b);
  return sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0;
}

/**
 * The body size of a whole page, not just the selected pieces: a licence strip
 * can outnumber the body lines inside the selection and drag the median down,
 * which would make every line look like body text. Recomputed per selection: a
 * cached value taken while the text layer was still filling in would stick.
 */
function pageBodySize(pageEl) {
  const sizes = [];
  const walker = document.createTreeWalker(pageEl, NodeFilter.SHOW_TEXT, {
    acceptNode(text) {
      if (!text.nodeValue || text.nodeValue.trim() === '') return NodeFilter.FILTER_REJECT;
      if (text.parentElement?.closest('.dpa-anno, .dpa-anno-badge, .dpa-pageno')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    const size = parseFloat(text.parentElement ? getComputedStyle(text.parentElement).fontSize : '') || 0;
    if (size > 0) sizes.push(size);
  }
  sizes.sort((a, b) => a - b);
  const body = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0;
  return body;
}

function selectionText(groups) {
  const lines = [];
  groups.forEach((group, index) => {
    const firstPage = index === 0;
    const lastPage = index === groups.length - 1;
    const pageRect = group.pageEl.getBoundingClientRect();
    const body = pageBodySize(group.pageEl) || medianFontSize(group.pieces);
    for (const piece of group.pieces) {
      const small = body > 0 && piece.fontSize > 0 && piece.fontSize < body * 0.95;
      const fromTop = piece.rect.top - pageRect.top;
      const fromBottom = pageRect.bottom - piece.rect.bottom;
      // Running heads and license banners at the page edge are furniture, not the
      // passage (see margins.js for why a hard band is needed).
      if (isMarginFurniture({ first: firstPage, last: lastPage, small, top: fromTop, bottom: fromBottom, height: pageRect.height })) continue;
      const line = lines[lines.length - 1];
      if (line && line.pageEl === group.pageEl && Math.abs(piece.rect.top - line.top) < Math.max(2, line.height * 0.6)) {
        line.text += piece.text;
        line.top = Math.min(line.top, piece.rect.top);
        line.height = Math.max(line.height, piece.rect.height);
      } else {
        lines.push({ pageEl: group.pageEl, top: piece.rect.top, height: piece.rect.height, text: piece.text });
      }
    }
  });
  return lines.map((line) => line.text.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}
