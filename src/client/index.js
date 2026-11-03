// dsh-paper-lens — browser half.
//
// Takes over .pdf in dsh's Files tab (a "plugin" priority preview ranks above
// the built-in one) with a pdf.js view whose text can be selected. Selecting
// text shows Quote / Ask / Explain / Check this; each puts the passage, tagged
// "file · p.N", into the composer of the chat you are in. Replies that cite
// [p.N] get those citations turned into links that jump the PDF.

import React from 'react';
import { PdfView, selectionInPdf } from './viewer.js';
import { selectionEnds, dragSelectionEnd, adjustByKey } from './selection.js';
import { ACTIONS, formatQuote, insertIntoChat, cleanSelection } from './chat.js';
import { ViewerRegistry, installPageLinks, HIGHLIGHT } from './pagelinks.js';
import TEXT_LAYER_CSS from '../textlayer.css';
import { CiteLinksHeaderButton, CHIP_CSS, lastSessionId } from './chip.js';

const h = React.createElement;
const { useEffect, useRef, useState, useCallback } = React;

export const PREVIEW_ID = 'dsh-paper-lens/pdf';
/** 服务端的插件路由根（与 src/index.js 的 BASE 必须一致）。 */
const PLUGIN_BASE = '/plugin-data/dsh-paper-lens';
// Every service apply() or the body touches must be declared, or the loader
// refuses the read ("cannot get property … without inject").
export const inject = ['slots', 'documentPreviews', 'sessions', 'conversation', 'sidebarRight'];

/** The plugin's root context, for the body (a preview body gets no ctx of its own). */
let rootCtx = null;
export const registry = new ViewerRegistry();

/* ---- look ------------------------------------------------------------------ */

const STYLE_ID = 'dsh-paper-lens-style';
const CSS = [
  '.dpa-root{display:flex;flex-direction:column;min-height:100%;background:var(--dsw-alias-bg-secondary,#2a2a2c)}',
  '.dpa-root.dpa-own-scroll{height:100%;overflow:auto}',
  '.dpa-bar{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:6px;padding:6px 10px;font-size:12px;'
    + 'background:var(--dsw-alias-bg-primary,#1f1f20);border-bottom:1px solid var(--dsw-alias-separator-primary,rgba(255,255,255,.1));color:var(--dsw-alias-label-primary,#e8e8ea)}',
  '.dpa-bar input{width:44px;text-align:right;background:transparent;color:inherit;border:1px solid rgba(128,128,128,.4);border-radius:5px;padding:2px 4px;font:inherit}',
  '.dpa-btn{border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit;border-radius:6px;padding:2px 8px;cursor:pointer;font:inherit}',
  '.dpa-btn:hover{background:rgba(128,128,128,.18)}',
  '.dpa-spacer{flex:1}',
  '.dpa-note{opacity:.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.dpa-note.dpa-err{color:#ff7b72;opacity:1}',
  '.dpa-pages{display:flex;flex-direction:column;align-items:center;gap:14px;padding:16px 16px 40px}',
  '.dpa-page{position:relative;background:#fff;box-shadow:0 1px 6px rgba(0,0,0,.35);flex:none;cursor:text;contain:layout paint}',
  // A page still loading: a soft grey shimmer instead of a blank white box.
  // The sweep is a transformed pseudo-element, so the GPU moves it without
  // repainting the page each frame (animating background-position did).
  '.dpa-page.dpa-pending{background:#dedee2;overflow:hidden}',
  '.dpa-page.dpa-pending::after{content:"";position:absolute;inset:0;background:linear-gradient(100deg,transparent 35%,rgba(255,255,255,.45) 50%,transparent 65%);transform:translateX(-100%);animation:dpa-shimmer 1.3s linear infinite;will-change:transform;pointer-events:none}',
  '@keyframes dpa-shimmer{to{transform:translateX(100%)}}',
  '.dpa-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;opacity:0;transition:opacity .12s ease-out}',
  '.dpa-canvas.dpa-shown{opacity:1}',
  '.dpa-page .textLayer, .dpa-page .textLayer .endOfContent{cursor:text}',
  '.dpa-pageno{cursor:default;user-select:none}',
  // Selection handles: a bar at each end with a knob, like a Mac/iPad selection.
  '.dpa-handle{position:fixed;z-index:1001;width:22px;margin-left:-11px;cursor:grab;touch-action:none}',
  '.dpa-handle:active{cursor:grabbing}',
  '.dpa-handle::before{content:"";position:absolute;left:10px;top:0;bottom:0;width:2px;background:#2563eb;border-radius:1px}',
  '.dpa-handle::after{content:"";position:absolute;left:5px;width:12px;height:12px;border-radius:50%;background:#2563eb;box-shadow:0 0 0 2px #fff,0 1px 4px rgba(0,0,0,.4)}',
  '.dpa-handle.dpa-start::after{top:-11px}',
  '.dpa-handle.dpa-end::after{bottom:-11px}',
  '.dpa-pageno{position:absolute;right:-30px;bottom:0;font-size:11px;opacity:.45;color:var(--dsw-alias-label-primary,#ccc)}',
  '.dpa-page.dpa-flash{animation:dpa-flash 1.5s ease-out}',
  '@keyframes dpa-flash{0%{box-shadow:0 0 0 4px rgba(59,130,246,.9)}100%{box-shadow:0 1px 6px rgba(0,0,0,.35)}}',
  // The passage a link points at: a yellow highlight that fades in, holds, and fades out.
  '.dpa-mark{position:absolute;background:rgba(250,204,21,.55);mix-blend-mode:multiply;pointer-events:none;border-radius:2px;z-index:2;opacity:0;animation:dpa-fade 3.3s ease-in-out forwards}',
  '@keyframes dpa-fade{0%{opacity:0}8%{opacity:1}55%{opacity:1}100%{opacity:0}}',
  '.dpa-toast{position:fixed;z-index:1002;padding:7px 11px;border-radius:8px;background:#1f2937;color:#f3f4f6;font:12px/1.4 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.35);transition:opacity .35s;pointer-events:none}',
  '.dpa-toast.dpa-toast-out{opacity:0}',
  '.dpa-pop{position:fixed;z-index:1000;display:flex;gap:2px;padding:3px;border-radius:9px;background:#1f2937;box-shadow:0 6px 24px rgba(0,0,0,.4);font-size:12px}',
  '.dpa-pop button{border:none;background:transparent;color:#f3f4f6;padding:4px 9px;border-radius:6px;cursor:pointer;font:inherit;white-space:nowrap}',
  '.dpa-pop button:hover{background:rgba(255,255,255,.12)}',
  '.dpa-pop button.dpa-primary{background:#2563eb}',
  '.dpa-pop button.dpa-primary:hover{background:#1d4ed8}',
  '.dpa-pop button.dpa-translate{background:#0f766e}',
  '.dpa-pop button.dpa-translate:hover{background:#0d6b63}',
  // 译文气泡跟随应用主题（明/暗），而不是写死的深色底——写死深色在浅色主题下对比很糟。
  '.dpa-tr{position:fixed;z-index:1001;display:flex;flex-direction:column;max-height:56vh;border-radius:10px;background:var(--dsw-alias-bg-overlay,#ffffff);color:var(--dsw-alias-label-primary,#1f2937);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));box-shadow:0 10px 30px rgba(0,0,0,.18);font:13px/1.65 system-ui,sans-serif}',
  '.dpa-tr-head{display:flex;align-items:center;gap:6px;padding:5px 8px 5px 6px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary,#475569);cursor:move;user-select:none;touch-action:none}',
  '.dpa-tr-grip{letter-spacing:-2px;opacity:.45}',
  '.dpa-tr-title{flex:1}',
  '.dpa-tr-head button{border:none;background:transparent;color:inherit;cursor:pointer;font:inherit;line-height:1;padding:2px 6px;border-radius:5px}',
  '.dpa-tr-head button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16))}',
  '.dpa-tr-body{padding:10px 12px;overflow:auto;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary,#1f2937)}',
  '.dpa-tr-body.dpa-err{color:#dc2626}',
  '.dpa-tr-body.dpa-tr-loading{opacity:.9}',
  '.dpa-tr-caret{display:inline-block;width:2px;height:1em;margin-left:1px;vertical-align:text-bottom;background:currentColor;animation:dpa-blink 1s steps(1) infinite}',
  '@keyframes dpa-blink{0%,50%{opacity:1}50.01%,100%{opacity:0}}',
  '.dpa-center{padding:40px;text-align:center;color:var(--dsw-alias-label-secondary,#aaa)}',
  `::highlight(${HIGHLIGHT}){color:#60a5fa;text-decoration:underline;text-decoration-style:dotted;text-underline-offset:2px}`,
  // pdf.js text layer: transparent, selectable text over the canvas.
  // Selection colour on the text only. Line breaks (<br>) must stay
  // transparent, as pdf.js sets them: a selected <br> paints a bar at the
  // start of its line, which showed as blue stripes in the left margin.
  '.dpa-page .textLayer span::selection{background:rgba(37,99,235,.32);color:transparent}',
  '.dpa-page .textLayer br::selection{background:transparent}',
].join('\n');

function ensureStyle() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `${TEXT_LAYER_CSS}\n${CSS}\n${CHIP_CSS}`;
  document.head.appendChild(style);
}

/* ---- helpers -------------------------------------------------------------- */

/**
 * The path a Files-tab address names: workspace-relative for a session
 * address, absolute for an absolute one. Used to match cited paths.
 */
export function pathOfAddress(address) {
  const prefix = 'dsh-resource://file/';
  const clean = String(address ?? '').replace(/[?#].*$/, '');
  if (!clean.startsWith(prefix)) return fileNameOf(address);
  const [scope, ...rest] = clean.slice(prefix.length).split('/');
  const decode = (parts) => parts.map((p) => {
    try { return decodeURIComponent(p); } catch { return p; }
  });
  if (scope === 'session') return decode(rest.slice(1)).join('/');
  if (scope === 'absolute') return decode(rest).join('/');
  return fileNameOf(address);
}

/** The Files-tab address for a cited path: absolute as is, otherwise relative to the current chat's workspace. */
export function addressFor(path, sessionId) {
  const clean = String(path ?? '').replace(/\\/g, '/');
  const enc = (parts) => parts.filter((p) => p !== '' && p !== '.').map(encodeURIComponent).join('/');
  if (/^[A-Za-z]:\//.test(clean)) return `dsh-resource://file/absolute/${enc(clean.split('/'))}`;
  if (clean.startsWith('//')) return `dsh-resource://file/absolute//${enc(clean.slice(2).split('/'))}`;
  if (clean.startsWith('/')) return `dsh-resource://file/absolute/${enc(clean.split('/'))}`;
  if (!sessionId) return undefined;
  return `dsh-resource://file/session/${encodeURIComponent(sessionId)}/${enc(clean.split('/'))}`;
}

/**
 * Which chat a relative cited path is relative to.
 *
 * dsh 0.1.x kept the selected session in the sessions list snapshot as
 * `current`. 0.2.x dropped that field — the snapshot is
 * `{ ids, byId, phase, projectionsBySession }` — and names the session on
 * screen through `ctx.sidebarRight.mounted` instead. Reading only `current`
 * made every named citation fail there ("no chat is open"), so try all three
 * sources: the old field, the on-screen session, then the last chat whose top
 * bar rendered (the header is handed its session id).
 *
 * @returns a session id, or undefined when no chat is known at all.
 */
export function currentSessionId(ctx) {
  try {
    const current = ctx?.sessions?.list?.getSnapshot?.()?.current;
    const id = typeof current === 'string' ? current : current?.sessionId ?? current?.id;
    if (id) return String(id);
  } catch { /* the sessions service is not mounted yet */ }
  try {
    const mounted = ctx?.sidebarRight?.mounted?.getSnapshot?.();
    if (mounted) return String(mounted);
  } catch { /* 0.1.x has no mounted snapshot */ }
  return lastSessionId();
}

/** Ask dsh to open (or reveal) a PDF in the Files tab. False when it cannot be addressed. */
export function openPdf(ctx, fileOrAddress) {
  try {
    let address = fileOrAddress;
    if (!String(address).startsWith('dsh-resource://')) {
      address = addressFor(fileOrAddress, currentSessionId(ctx));
    }
    if (!address) return false;
    ctx.sidebarRight.openResource(address);
    return true;
  } catch {
    return false;
  }
}

export function fileNameOf(address) {
  const clean = String(address ?? '').replace(/[?#].*$/, '');
  const last = clean.slice(clean.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

const memory = {
  get(key) {
    try {
      // dsh-pdf-ask (the name before 0.2.0) kept page positions under its own prefix.
      return JSON.parse(sessionStorage.getItem(`dsh-paper-lens:${key}`) ?? sessionStorage.getItem(`dsh-pdf-ask:${key}`) ?? 'null');
    } catch {
      return null;
    }
  },
  set(key, value) {
    try { sessionStorage.setItem(`dsh-paper-lens:${key}`, JSON.stringify(value)); } catch { /* best effort */ }
  },
};

/* ---- the body ------------------------------------------------------------- */

function PdfAskBody(props) {
  ensureStyle();
  const bytes = props.content && props.content.kind === 'bytes' ? props.content.data : undefined;
  const address = String(props.resourceAddress ?? '');
  const file = fileNameOf(address);

  const rootRef = useRef(null);
  const pagesRef = useRef(null);
  const viewRef = useRef(null);
  const [status, setStatus] = useState({ phase: 'loading' });
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const [zoomLabel, setZoomLabel] = useState('');
  const [pop, setPop] = useState(null);
  const [note, setNote] = useState(null);
  /** 划词翻译气泡：{ phase: 'streaming'|'done'|'error', rect, text?, error? } */
  const [tr, setTr] = useState(null);
  /** 气泡被拖动后的位移（相对选区位置），null = 还没动过。 */
  const [trDrag, setTrDrag] = useState(null);
  const trBodyRef = useRef(null);

  const say = useCallback((text, error = false) => {
    setNote({ text, error, at: Date.now() });
  }, []);
  useEffect(() => {
    if (!note) return undefined;
    const timer = setTimeout(() => setNote(null), note.error ? 6000 : 2200);
    return () => clearTimeout(timer);
  }, [note]);

  // Open (or re-open after the file changes) the document.
  useEffect(() => {
    if (bytes === undefined || !pagesRef.current) return undefined;
    // Scroll with the Files tab's own scroll area when it has one, so the
    // toolbar stays put and nothing double-scrolls.
    const outer = rootRef.current.parentElement?.closest('[data-textpreview-body]');
    const scrolls = outer && /(auto|scroll)/.test(getComputedStyle(outer).overflowY);
    rootRef.current.classList.toggle('dpa-own-scroll', !scrolls);
    const scroller = scrolls ? outer : rootRef.current;
    const view = new PdfView(pagesRef.current, scroller, {
      onPage: (n) => {
        setPage(n);
        setPageInput(String(n));
        memory.set(address, { page: n });
      },
    });
    viewRef.current = view;
    let cancelled = false;
    let unregister = () => {};
    setStatus({ phase: 'loading' });
    view.open(bytes).then(() => {
      if (cancelled) return;
      unregister = registry.add(address, file, view, pathOfAddress(address));
      setStatus({ phase: 'ready', pages: view.numPages });
      setZoomLabel(`${Math.round(view.scale * 100)}%`);
      const remembered = memory.get(address)?.page;
      if (remembered > 1) requestAnimationFrame(() => view.scrollToPage(remembered));
    }, (error) => {
      if (!cancelled) setStatus({ phase: 'error', message: String(error?.message ?? error) });
    });
    return () => {
      cancelled = true;
      unregister();
      view.dispose();
      viewRef.current = null;
    };
  }, [bytes, address, file]);

  // The selection: toolbar, handles, keyboard. Everything is recomputed from
  // the live DOM selection, so native drags, handle drags, Shift+click and
  // Shift+Arrow all end up in the same state.
  const [ends, setEnds] = useState(null);
  const dragRef = useRef(null);
  const nativeDrag = useRef(false);
  const refresh = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const selection = document.getSelection();
    const found = selectionInPdf(selection, root);
    if (!found) {
      setPop(null);
      setEnds(null);
      return;
    }
    registry.touch(address);
    setPop(found);
    setEnds(selectionEnds(selection));
  }, [address]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    let frame = 0;
    const later = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        refresh();
      });
    };
    const onDown = (event) => {
      if (event.target.closest?.('.dpa-pop, .dpa-handle')) return;
      if (root.contains(event.target)) {
        nativeDrag.current = true;
        // Shift+click extends the selection: keep the toolbar until it settles.
        if (!event.shiftKey) {
          setPop(null);
          setEnds(null);
        }
      } else {
        setPop(null);
        setEnds(null);
      }
    };
    const onUp = () => {
      if (!nativeDrag.current) return;
      nativeDrag.current = false;
      setTimeout(refresh, 0);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') {
        setPop(null);
        setEnds(null);
        return;
      }
      if (adjustByKey(document, event, root)) {
        event.preventDefault();
        later();
      }
    };
    // While a selection is shown, keep the toolbar and handles on it as the
    // page scrolls, instead of dropping them.
    const onScroll = () => {
      if (!nativeDrag.current && !dragRef.current) later();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('keydown', onKey);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('pointerup', onUp, true);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [refresh]);

  // Dragging a handle moves that end of the selection.
  const startHandle = (which) => (event) => {
    event.preventDefault();
    event.stopPropagation();
    const end = ends?.[which];
    if (!end) return;
    // Aim at the middle of the line the handle sits on, wherever on the knob the drag began.
    const lineMid = (end.top + end.bottom) / 2;
    const dy = lineMid - event.clientY;
    const dx = end.x - event.clientX;
    dragRef.current = which;
    setPop(null);
    const target = event.currentTarget;
    target.setPointerCapture?.(event.pointerId);
    const move = (e) => {
      if (dragSelectionEnd(document, which, e.clientX + dx, e.clientY + dy, rootRef.current)) {
        setEnds(selectionEnds(document.getSelection()));
      }
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      dragRef.current = null;
      refresh();
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  };

  /**
   * 划词翻译：把选中的原文发给服务端，译文边到边显示。
   *
   * 服务端回的是 NDJSON（一行一个 JSON）：`{delta}` 增量、`{error}` 失败、`{done}` 结束。
   * 用 JSON 行是因为译文本身带换行，纯文本流没法区分「内容结束」和「内容里有个换行」。
   * 模型由服务端决定（优先该会话实际路由的模型），所以这里不需要端点或 key。
   */
  const translateSelection = async () => {
    if (!pop) return;
    const text = cleanSelection(pop.text);
    const rect = pop.rect;
    setPop(null);
    setEnds(null);
    setTrDrag(null);
    if (!text) {
      say('没有选中可翻译的文字', true);
      return;
    }
    setTr({ phase: 'streaming', rect, text: '' });
    // 原文已经拿到，清掉 PDF 上的选区：气泡压在选区上会看花，也让人以为气泡里的字被选住了。
    document.getSelection()?.removeAllRanges();

    const fail = (error) => setTr({ phase: 'error', rect, error });
    try {
      const response = await fetch(`${PLUGIN_BASE}/translate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // 带上会话 id：服务端拿它做 llm.stream 的 sessionId——凭据与会话作用域由此解析，
        // 与官方压缩调用（passes agent.session.id）保持一致。
        body: JSON.stringify({ text, session: lastSessionId() }),
      });
      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => null);
        fail(data?.error || `翻译失败（HTTP ${response.status}）`);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let acc = '';
      let painted = 0;
      // 增量可能一个 token 一行；每行都 setState 会让 React 疯狂重渲染，
      // 所以攒到 ~60ms 再刷一次，最后一个 delta 由结尾统一收口。
      const paint = (force) => {
        const now = Date.now();
        if (!force && now - painted < 60) return;
        painted = now;
        setTr({ phase: 'streaming', rect, text: acc });
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf('\n');
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf('\n');
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg?.error) { fail(String(msg.error)); return; }
          if (typeof msg?.delta === 'string') { acc += msg.delta; paint(false); }
        }
      }
      // 流里最后一行可能没有换行符。
      if (buffer.trim()) {
        try {
          const msg = JSON.parse(buffer.trim());
          if (msg?.error) { fail(String(msg.error)); return; }
          if (typeof msg?.delta === 'string') acc += msg.delta;
        } catch { /* 半个 JSON 就丢掉 */ }
      }

      const final = acc.trim();
      if (!final) { fail('模型没有返回译文'); return; }
      setTr({ phase: 'done', rect, text: final });
    } catch (error) {
      fail(`翻译失败：${error?.message ?? error}`);
    }
  };

  /** 按住标题栏拖动译文气泡；位置是相对选区位置的位移。 */
  const startTrDrag = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const base = trDrag ?? { dx: 0, dy: 0 };
    const move = (e) => setTrDrag({ dx: base.dx + (e.clientX - startX), dy: base.dy + (e.clientY - startY) });
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // 流式输出时跟着滚到底，否则新到的译文会藏在可视区下面。
  useEffect(() => {
    if (tr?.phase !== 'streaming') return;
    const body = trBodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [tr?.phase, tr?.text]);

  const send = (action) => {
    if (!pop) return;
    const block = formatQuote({ file, page: pop.page, text: pop.text, action });
    registry.remember(address, pop.page, pop.boxes);
    // dsh 0.2.x 的 sessions.list 没有选中项，只能靠顶栏渲染过的会话 id 兜底。
    const result = rootCtx
      ? insertIntoChat(rootCtx, block, lastSessionId())
      : { ok: false, reason: '插件未挂载' };
    if (result.ok) {
      say(action === 'quote' || action === 'ask' ? `已引用第 ${pop.page} 页到会话，在下面写你的问题` : `已加入会话（第 ${pop.page} 页），按回车发送`);
      document.getSelection()?.removeAllRanges();
      setPop(null);
      setEnds(null);
    } else {
      say(`没能加入会话：${result.reason}`, true);
    }
  };

  const view = viewRef.current;
  const ready = status.phase === 'ready';
  const zoom = (z) => {
    if (!view) return;
    if (z === 'fit') view.setZoom('fit');
    else view.zoomBy(z);
    setZoomLabel(`${Math.round(view.scale * 100)}%`);
  };

  const popStyle = pop
    ? (() => {
        const width = 340;
        const left = Math.max(8, Math.min(window.innerWidth - width - 8, pop.rect.left + pop.rect.width / 2 - width / 2));
        const above = pop.rect.top - 52;
        return { left: `${left}px`, top: `${above > 8 ? above : pop.rect.bottom + 8}px` };
      })()
    : null;

  // 译文气泡默认贴在选区下方；拖过之后按位移走，并且始终收在窗口内。
  const trStyle = tr
    ? (() => {
        const width = Math.max(260, Math.min(420, window.innerWidth - 32));
        const baseLeft = Math.max(8, Math.min(window.innerWidth - width - 8, (tr.rect?.left ?? 8) + (tr.rect?.width ?? 0) / 2 - width / 2));
        const baseTop = Math.max(8, Math.min((tr.rect?.bottom ?? 120) + 8, window.innerHeight - 140));
        const dx = trDrag?.dx ?? 0;
        const dy = trDrag?.dy ?? 0;
        const left = Math.max(4, Math.min(window.innerWidth - width - 4, baseLeft + dx));
        const top = Math.max(4, Math.min(window.innerHeight - 64, baseTop + dy));
        return { left: `${left}px`, top: `${top}px`, width: `${width}px` };
      })()
    : null;

  return h(
    'div',
    { className: 'dpa-root', ref: rootRef, 'data-dsh-paper-lens': '' },
    h(
      'div',
      { className: 'dpa-bar' },
      h('span', null, '页码'),
      h('input', {
        value: pageInput,
        'aria-label': '页码',
        disabled: !ready,
        onChange: (event) => setPageInput(event.target.value.replace(/[^0-9]/g, '')),
        onKeyDown: (event) => {
          if (event.key === 'Enter') view?.scrollToPage(Number(pageInput) || 1);
        },
        onBlur: () => setPageInput(String(page)),
      }),
      h('span', null, ready ? `/ ${status.pages}` : ''),
      h('span', { className: 'dpa-spacer' }),
      note ? h('span', { className: `dpa-note${note.error ? ' dpa-err' : ''}`, title: note.text }, note.text) : h('span', { className: 'dpa-note' }, '选中文字即可翻译、引用或提问'),
      h('span', { className: 'dpa-spacer' }),
      h('button', { type: 'button', className: 'dpa-btn', title: '缩小', disabled: !ready, onClick: () => zoom(-1) }, '−'),
      h('span', { style: { minWidth: '38px', textAlign: 'center' } }, zoomLabel),
      h('button', { type: 'button', className: 'dpa-btn', title: '放大', disabled: !ready, onClick: () => zoom(1) }, '+'),
      h('button', { type: 'button', className: 'dpa-btn', title: '适合页宽', disabled: !ready, onClick: () => zoom('fit') }, '适宽'),
    ),
    status.phase === 'loading' ? h('div', { className: 'dpa-center' }, '正在打开 PDF…') : null,
    status.phase === 'error' ? h('div', { className: 'dpa-center' }, `无法打开该 PDF：${status.message}`) : null,
    h('div', { className: 'dpa-pages', ref: pagesRef }),
    ends
      ? [
          h('div', {
            key: 'hs',
            className: 'dpa-handle dpa-start',
            title: '拖动可改变选区起点',
            style: { left: `${ends.start.x}px`, top: `${ends.start.top}px`, height: `${Math.max(8, ends.start.bottom - ends.start.top)}px` },
            onPointerDown: startHandle('start'),
          }),
          h('div', {
            key: 'he',
            className: 'dpa-handle dpa-end',
            title: '拖动可改变选区终点',
            style: { left: `${ends.end.x}px`, top: `${ends.end.top}px`, height: `${Math.max(8, ends.end.bottom - ends.end.top)}px` },
            onPointerDown: startHandle('end'),
          }),
        ]
      : null,
    pop
      ? h(
          'div',
          { className: 'dpa-pop', style: popStyle, role: 'toolbar', 'aria-label': '对选中文字的处理' },
          h('button', {
            type: 'button',
            className: 'dpa-translate',
            title: '把这段翻成中文（只显示译文）',
            onMouseDown: (event) => event.preventDefault(), // keep the selection
            onClick: () => translateSelection(),
          }, '译'),
          Object.entries(ACTIONS).map(([key, action]) =>
            h('button', {
              key,
              type: 'button',
              className: key === 'quote' ? 'dpa-primary' : '',
              title: action.title,
              onMouseDown: (event) => event.preventDefault(), // keep the selection
              onClick: () => send(key),
            }, action.label)),
        )
      : null,
    tr
      ? h(
          'div',
          { className: 'dpa-tr', style: trStyle, role: 'dialog', 'aria-label': '划词翻译' },
          h(
            'div',
            { className: 'dpa-tr-head', onPointerDown: startTrDrag, title: '按住这里可以拖动' },
            h('span', { className: 'dpa-tr-grip', 'aria-hidden': 'true' }, '⋮⋮'),
            h(
              'span',
              { className: 'dpa-tr-title' },
              tr.phase === 'streaming' ? '正在翻译…' : tr.phase === 'error' ? '翻译失败' : '译文',
            ),
            h('button', {
              type: 'button',
              title: '关闭',
              onPointerDown: (event) => event.stopPropagation(), // 别让点关闭变成拖动
              onClick: () => setTr(null),
            }, '×'),
          ),
          h(
            'div',
            {
              ref: trBodyRef,
              className: `dpa-tr-body${tr.phase === 'error' ? ' dpa-err' : ''}${tr.phase === 'streaming' ? ' dpa-tr-loading' : ''}`,
            },
            tr.phase === 'error' ? tr.error : (tr.text || (tr.phase === 'streaming' ? '' : '')),
            tr.phase === 'streaming' ? h('span', { className: 'dpa-tr-caret', 'aria-hidden': 'true' }) : null,
          ),
        )
      : null,
  );
}

/* ---- registration --------------------------------------------------------- */

export function apply(ctx) {
  rootCtx = ctx;
  // The link style must exist before any PDF opens: citations in old chats
  // are painted on load, and without the ::highlight rule they were invisible.
  ensureStyle();
  ctx.effect(() => ctx.documentPreviews.register({
    id: PREVIEW_ID,
    extensions: ['pdf'],
    // A PDF's bytes are never readable text, so the plain-text fallback among
    // this file's viewer choices is dropped. Newer dsh reads this field; the
    // 0.1.x releases that predate it ignore it, which is harmless.
    binaryExtensions: ['pdf'],
    priority: 'extension',
    title: () => '论文阅读',
    loading: 'bytes-complete',
    wrap: false,
  }), 'dsh-paper-lens: preview type');
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({
    name: 'sidebar.right.tab.document',
    key: PREVIEW_ID,
  }, PdfAskBody)), 'dsh-paper-lens: preview body');
  // And in the chat's top bar, just left of the context gauge and the ⋮ menu.
  // Header order: open-in-app is -10; the gauge + ⋮ (session-view-menu, in
  // place of dsh's session-log-download) default to 0 and are one entry, so
  // -1 is the closest spot left of them. The slot hands each entry the open
  // chat's sessionId; it must be passed on.
  ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'dsh-paper-lens-cite-links',
    order: -1,
  }, (slotProps) => h(CiteLinksHeaderButton, slotProps || {}))), 'dsh-paper-lens: cite-links header button');
  ctx.effect(() => (typeof document === 'undefined'
    ? () => {}
    : installPageLinks(registry, document, { open: (fileOrAddress) => openPdf(ctx, fileOrAddress) })), 'dsh-paper-lens: page links');
  ctx.effect(() => () => {
    if (rootCtx === ctx) rootCtx = null;
  }, 'dsh-paper-lens: context');
}

export { PdfAskBody };
