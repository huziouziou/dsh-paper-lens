// dsh-paper-lens — how a page is laid out.
//
// The reader picks a passage with the mouse. Under it, pdf.js leaves a flat pile
// of spans, and the browser's own selection string walks that pile from the first
// caret to the second. That gets two things wrong that this module fixes:
//
//   * page furniture — running heads, licence strips, footers — is not something a
//     fixed band can recognise: NAR prints its header at the body size and Nature
//     prints its footer at 97% of it, while bioRxiv repeats a licence strip on
//     every page. So the document itself is measured: a y strip that repeats on
//     most sampled pages is furniture, at whatever size it is set in.
//   * reading order on a multi-column page is column by column, not top to bottom
//     across the full width: Science's three-column body read left-first otherwise
//     alternates between columns line by line.
//
// Everything here is pure: no DOM, no pdf.js objects beyond the items/ viewport
// pair pdf.js already hands us. That is what makes the rules testable, and it is
// where the measured numbers came from (see PROGRESS.md, layout study).

/** Page fractions: a y strip is "furniture" when it repeats on this share of pages. */
export const BAND_SHARE = 0.6;
/** Tolerance when matching a line against a furniture band, in page fractions. */
export const BAND_TOL = 0.012;
/** Lines only count towards the bands in these edge regions. */
export const TOP_REGION = 0.1;
export const BOTTOM_REGION = 0.9;
/** On the page a selection starts on, only this hard strip is unconditionally furniture. */
export const TOP_HARD = 0.05;
/** At the very bottom of a page, even a last page's foot can go. */
export const BOTTOM_HARD = 0.9;
/** A line this much smaller than the body is secondary type (superscripts are exempt: they sit inside the body flow). */
export const SMALL_RATIO = 0.92;
/** Words that mark a bottom block as a footer even when it sits above the page's last line. */
export const FOOTER_MARKERS = /(?:©|\(c\)\s*\d{4}|copyright|downloaded from|to whom correspondence|correspondence should|corresponding author|all rights reserved|creative commons|open access|licen[cs]e|issn|https?:\/\/doi)/i;

/**
 * The document's body size: the font size that carries the most characters.
 * Character weight, not line count, so a caption-heavy page cannot outvote the
 * body with many small lines.
 */
export function bodySizeOf(lines) {
  const weights = new Map();
  for (const line of lines ?? []) {
    const size = Number(line?.size) || 0;
    if (size <= 0) continue;
    const length = String(line.text ?? '').replace(/\s+/g, '').length;
    if (length === 0) continue;
    const bucket = Math.round(size * 2) / 2;
    weights.set(bucket, (weights.get(bucket) ?? 0) + length);
  }
  let best = 0;
  let bestWeight = -1;
  for (const [size, weight] of weights) {
    if (weight > bestWeight) {
      best = size;
      bestWeight = weight;
    }
  }
  // The 0.5pt bucket is only a coarse vote; journals use 8.25pt and 8.67pt body
  // sizes, and half a point of slack is enough to let figure captions vote as
  // paragraph text later on. Refine to the weighted mean of the winning bucket.
  let total = 0;
  let weighted = 0;
  for (const line of lines ?? []) {
    const size = Number(line?.size) || 0;
    if (Math.abs(size - best) > 0.35) continue;
    const length = String(line.text ?? '').replace(/\s+/g, '').length;
    if (!length) continue;
    total += length;
    weighted += size * length;
  }
  return total ? weighted / total : best;
}

/** Lines that look like a paragraph of body text in one column. */
function paragraphLines(lines, body) {
  return (lines ?? []).filter((line) => {
    const width = Number(line?.x1) - Number(line?.x0);
    const size = Number(line?.size) || 0;
    if (String(line?.text ?? '').trim().length < 8) return false;
    // A figure caption or a table note often runs across every column and lands
    // within a point of the body size. Capping the width at half the text block
    // keeps those out of the vote, which is what lets a gutter stay empty.
    if (!(width >= 0.2 && width <= 0.5)) return false;
    return body <= 0 || Math.abs(size - body) <= Math.max(0.3, body * 0.05);
  });
}

/**
 * Column bands and the gutters that separate them, from the horizontal extent of
 * body-size paragraph lines: a gutter is a run of x positions that essentially no
 * paragraph reaches into. One column is returned when no such gutter exists.
 *
 * Only paragraph-width lines vote: full-width titles and figure captions cross
 * every gutter, and counting them would vote a gutter out of existence on a page
 * with a large figure.
 */
export function columnsFromLines(lines, body) {
  const tall = paragraphLines(lines, body);
  if (tall.length < 8) return { columns: [{ x0: 0, x1: 1 }], gutters: [] };

  const bins = 200;
  const hits = new Array(bins).fill(0);
  for (const line of tall) {
    const from = Math.min(bins - 1, Math.max(0, Math.floor(line.x0 * bins)));
    const to = Math.min(bins - 1, Math.max(0, Math.floor(line.x1 * bins)));
    for (let i = from; i <= to; i += 1) hits[i] += 1;
  }
  const limit = Math.max(1, Math.floor(tall.length * 0.06));
  const gutters = [];
  for (let i = 0; i < bins; i += 1) {
    if (hits[i] > limit) continue;
    let j = i;
    while (j + 1 < bins && hits[j + 1] <= limit) j += 1;
    if (j - i + 1 >= 2) {
      const centre = (i + j + 1) / 2 / bins;
      if (centre > 0.15 && centre < 0.85) gutters.push({ x0: i / bins, x1: (j + 1) / bins, at: centre });
    }
    i = j;
  }
  if (!gutters.length) return { columns: [{ x0: 0, x1: 1 }], gutters: [] };

  const left = Math.min(...tall.map((line) => line.x0));
  const right = Math.max(...tall.map((line) => line.x1));
  const edges = [left, ...gutters.map((gutter) => gutter.at), right];
  const columns = [];
  for (let i = 0; i + 1 < edges.length; i += 1) columns.push({ x0: edges[i], x1: edges[i + 1] });
  return { columns, gutters };
}

/** Merge the gutters of several sampled pages into one column band set. */
export function columnsFromSamples(samples, body) {
  const pages = (samples ?? []).filter((sample) => Array.isArray(sample?.lines) && sample.lines.length);
  const lines = pages.flatMap((page) => page.lines);
  const tall = paragraphLines(lines, body || bodySizeOf(lines));
  if (tall.length < 12) return [{ x0: 0, x1: 1 }];

  const bins = 200;
  const hits = new Array(bins).fill(0);
  for (const line of tall) {
    const from = Math.min(bins - 1, Math.max(0, Math.floor(line.x0 * bins)));
    const to = Math.min(bins - 1, Math.max(0, Math.floor(line.x1 * bins)));
    for (let i = from; i <= to; i += 1) hits[i] += 1;
  }
  const limit = Math.max(1, Math.floor(tall.length * 0.06));
  const gutters = [];
  for (let i = 0; i < bins; i += 1) {
    if (hits[i] > limit) continue;
    let j = i;
    while (j + 1 < bins && hits[j + 1] <= limit) j += 1;
    if (j - i + 1 >= 2) {
      const centre = (i + j + 1) / 2 / bins;
      const edge = { x0: i / bins, x1: (j + 1) / bins, at: centre };
      // Both neighbouring columns must actually carry paragraphs; otherwise this
      // is just the ragged right edge of a single column.
      const left = tall.filter((line) => line.x1 <= edge.x0 + 0.01).length;
      const right = tall.filter((line) => line.x0 >= edge.x1 - 0.01).length;
      if (centre > 0.15 && centre < 0.85 && left >= tall.length * 0.2 && right >= tall.length * 0.2) gutters.push(edge);
    }
    i = j;
  }
  if (!gutters.length) return [{ x0: 0, x1: 1 }];

  const left = Math.min(...tall.map((line) => line.x0));
  const right = Math.max(...tall.map((line) => line.x1));
  const edges = [left, ...gutters.map((gutter) => gutter.at), right];
  const columns = [];
  for (let i = 0; i + 1 < edges.length; i += 1) columns.push({ x0: edges[i], x1: edges[i + 1] });
  return columns;
}

/**
 * The y strips that repeat on most sampled pages: running heads, licence
 * banners, footers. Returned as `{ y0, y1, share }` in page fractions.
 */
export function furnitureBands(samples) {
  const pages = (samples ?? []).filter((sample) => Array.isArray(sample?.lines) && sample.lines.length);
  if (pages.length < 2) return [];
  const bins = 250;
  const counts = new Array(bins).fill(0);
  for (const page of pages) {
    const seen = new Set();
    for (const line of page.lines) {
      const centre = (Number(line.top) + Number(line.bottom)) / 2;
      if (!Number.isFinite(centre) || (centre >= TOP_REGION && centre <= BOTTOM_REGION)) continue;
      const index = Math.min(bins - 1, Math.max(0, Math.floor(centre * bins)));
      if (seen.has(index)) continue;
      seen.add(index);
      counts[index] += 1;
    }
  }
  const need = Math.max(2, Math.ceil(pages.length * BAND_SHARE));
  const bands = [];
  for (let i = 0; i < bins; i += 1) {
    if (counts[i] < need) continue;
    let j = i;
    let share = counts[i];
    while (j + 1 < bins && counts[j + 1] >= need) {
      j += 1;
      share = Math.max(share, counts[j]);
    }
    bands.push({ y0: i / bins, y1: (j + 1) / bins, share: share / pages.length });
    i = j;
  }
  return bands;
}

/**
 * Is this line page furniture rather than part of the passage? `first`/`last`
 * say whether the line sits on the page the selection starts/ends on: only the
 * boundary pages can carry furniture the reader did not mean to include.
 */
export function isFurniture(line, context) {
  const { body = 0, first = false, last = false, flowTop = 0, flowBottom = 1, bands = [] } = context ?? {};
  const size = Number(line?.size) || 0;
  const top = Number(line?.top) || 0;
  const bottom = Number(line?.bottom) || top;
  const centre = (top + bottom) / 2;
  const small = body > 0 && size > 0 && size < body * SMALL_RATIO;

  const band = (bands ?? []).find((candidate) => centre >= candidate.y0 - BAND_TOL && centre <= candidate.y1 + BAND_TOL);
  if (band) {
    // A page the selection merely passes into keeps none of its furniture; the
    // boundary page keeps its head only outside the very top strip (the title of
    // page 1 often sits close to the header, so only small type is dropped up
    // there), and drops its foot unless the selection ends there.
    if (!first) return true;
    if (centre > 0.5) return !last || centre > BOTTOM_HARD;
    return centre < TOP_HARD || small;
  }

  // Not a repeating band: fall back to position relative to the page's own body
  // flow. Text above where the body starts is a running head; text below where it
  // ends is a footer, a footnote block or a reference tail.
  if (small && centre < flowTop) return !first || top < TOP_HARD;
  if (small && top > flowBottom) {
    if (FOOTER_MARKERS.test(String(line?.text ?? ''))) return true;
    return last ? top > BOTTOM_HARD : top > 0.85;
  }
  return false;
}

/**
 * Lines in reading order: column by column left to right, top to bottom inside a
 * column. Lines wider than half the text width (titles, full-width figures) stay
 * with the first column, which is where they belong in the vertical order.
 */
export function orderLines(lines, columns) {
  const bands = Array.isArray(columns) && columns.length ? columns : [{ x0: 0, x1: 1 }];
  const textWidth = Math.max(0.001, bands[bands.length - 1].x1 - bands[0].x0);
  const columnOf = (line) => {
    const width = (Number(line.x1) || 0) - (Number(line.x0) || 0);
    if (bands.length > 1 && width > textWidth * 0.5) return 0;
    const centre = ((Number(line.x0) || 0) + (Number(line.x1) || 0)) / 2;
    for (let i = 0; i < bands.length; i += 1) {
      if (centre >= bands[i].x0 - 0.006 && centre <= bands[i].x1 + 0.006) return i;
    }
    return bands.length - 1;
  };
  return [...(lines ?? [])].sort((a, b) => columnOf(a) - columnOf(b) || a.top - b.top || a.x0 - b.x0);
}

/**
 * pdf.js text items — lines, in page fractions, with the raw size in points.
 * Items on one baseline are grouped, then split wherever the horizontal gap is
 * wider than a normal word space — otherwise a two-column page reads as one row.
 */
export function linesFromItems(items, viewport) {
  const width = Number(viewport?.width) || 1;
  const height = Number(viewport?.height) || 1;
  const boxes = [];
  for (const item of items ?? []) {
    const text = String(item?.str ?? '');
    if (!text.trim() || !Array.isArray(item.transform)) continue;
    const transform = item.transform;
    const fontHeight = Number(item.height) || Math.hypot(transform[2], transform[3]) || 10;
    const itemWidth = Number(item.width) || 0;
    const [ax, ay] = viewport.convertToViewportPoint(transform[4], transform[5] - fontHeight * 0.22);
    const [bx, by] = viewport.convertToViewportPoint(transform[4] + itemWidth, transform[5] + fontHeight * 0.92);
    const box = {
      x0: Math.min(ax, bx) / width,
      x1: Math.max(ax, bx) / width,
      top: Math.min(ay, by) / height,
      bottom: Math.max(ay, by) / height,
      // The size is the font's, not the box's: the box is padded above and below
      // the glyphs, and comparing padded heights to a body size would report
      // every 10pt line as 11.4pt.
      size: fontHeight,
      text,
    };
    // Rotated margin stamps ("Downloaded from …) extend past the page edge;
    // they are not text the reader can select, so they never join a line.
    if (box.x0 < -0.05 || box.x1 > 1.05 || box.top < -0.05 || box.bottom > 1.05) continue;
    boxes.push(box);
  }
  if (!boxes.length) return [];
  boxes.sort((a, b) => a.top - b.top || a.x0 - b.x0);

  const rows = [];
  for (const box of boxes) {
    const tolerance = Math.max(0.0015, (0.35 * box.size) / height);
    let row = null;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const candidate = rows[i];
      if (box.top - candidate.top > 0.05) break;
      // Same baseline, not "the padded boxes overlap": leading is tighter than
      // the padded box, so an overlap test chains several lines into one row.
      if (Math.abs(box.top - candidate.top) <= tolerance) {
        row = candidate;
        break;
      }
    }
    if (row) {
      row.boxes.push(box);
      row.top = Math.min(row.top, box.top);
      row.bottom = Math.max(row.bottom, box.bottom);
      row.size = Math.max(row.size, box.size);
    } else {
      rows.push({ top: box.top, bottom: box.bottom, size: box.size, boxes: [box] });
    }
  }

  const lines = [];
  for (const row of rows) {
    row.boxes.sort((a, b) => a.x0 - b.x0);
    let current = null;
    for (const box of row.boxes) {
      const gap = current ? box.x0 - current.x1 : 0;
      // The threshold follows the two runs being joined, not the row's largest
      // font, and it is close to one font width: NAR's gutter is 20pt against a
      // 10pt font, only twice a word space, so a generous threshold would read a
      // two-column page as one very wide column.
      const gapLimit = Math.max(0.004, (0.9 * Math.min(current?.size ?? box.size, box.size)) / width);
      if (current && gap > gapLimit) {
        lines.push(current);
        current = null;
      }
      if (current) {
        if (gap > 0.0005 && !/\s$/.test(current.text) && !/^\s/.test(box.text)) current.text += ' ';
        current.text += box.text;
        current.x1 = Math.max(current.x1, box.x1);
      } else {
        current = { x0: box.x0, x1: box.x1, top: row.top, bottom: row.bottom, size: box.size, text: box.text };
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

/**
 * The selected words, page by page and in reading order, with running heads,
 * licence strips and footers dropped.
 *
 * `pages` is plain data — `{ page, first, last, flowTop?, flowBottom?, pieces }`
 * where a piece is `{ text, size, top, bottom, left, right }` in page fractions
 * and `size` is the font size in PDF points. Keeping it DOM-free is what lets
 * the real papers drive it from a script.
 *
 * Furniture is decided by the document profile when there is one: a band that
 * repeats down the page margins is furniture whatever its font size (NAR prints
 * its header at body size), and a footer that carries a copyright or licence
 * marker goes even when no band overlaps it (NAR's first-page licence block
 * starts above the bottom tenth). Columns come from the profile too, so a
 * selection that crosses a gutter is read left column then right, not line by
 * line across the whole page.
 */
export function selectionText(pages, profile) {
  const body = profile?.body ?? 0;
  const bands = profile?.bands ?? [];
  const columns = profile?.columns ?? [];
  const lines = [];
  (pages ?? []).forEach((page, order) => {
    const pageBody = body || Number(page.body) || bodySizeOf(page.pieces.map((piece) => ({ size: piece.size, text: piece.text }))) || 0;
    const flow = page.flowTop !== undefined && page.flowBottom !== undefined ? { flowTop: page.flowTop, flowBottom: page.flowBottom } : flowOfPieces(page.pieces, pageBody);
    for (const piece of page.pieces ?? []) {
      const top = Number(piece.top) || 0;
      const bottom = piece.bottom === undefined ? top : Number(piece.bottom) || top;
      if (isFurniture({ size: piece.size, top, bottom, text: piece.text }, { body: pageBody, first: Boolean(page.first), last: Boolean(page.last), flowTop: flow.flowTop, flowBottom: flow.flowBottom, bands })) continue;
      const x0 = Number(piece.left) || 0;
      const x1 = piece.right === undefined ? x0 : Number(piece.right) || x0;
      const column = columnOf(columns, (x0 + x1) / 2);
      const line = lines[lines.length - 1];
      const lineHeight = Math.max(0.0015, (top - bottom) || 0.012);
      const sameLine = line && line.order === order && line.column === column && Math.abs(top - line.top) < Math.max(0.0025 * 0.5, lineHeight * 0.6);
      if (sameLine) {
        line.text += piece.text;
        line.top = Math.min(line.top, top);
        line.x1 = Math.max(line.x1, x1);
      } else {
        lines.push({ order, column, top, x0, x1, text: String(piece.text ?? '') });
      }
    }
  });
  lines.sort((a, b) => a.order - b.order || a.column - b.column || a.top - b.top || a.x0 - b.x0);
  return lines.map((line) => line.text.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

/** Which column band a horizontal position falls in. */
function columnOf(columns, centre) {
  const bands = Array.isArray(columns) && columns.length ? columns : [{ x0: 0, x1: 1 }];
  for (let i = 0; i < bands.length - 1; i += 1) {
    if (centre < bands[i].x1) return i;
  }
  return bands.length - 1;
}

/**
 * Where body text starts and ends on one page, from the pieces at hand. Pages
 * the profile did not sample fall back to this, which is enough to recognise a
 * footer strip below the last line the reader selected.
 */
function flowOfPieces(pieces, body) {
  const matches = (pieces ?? []).filter((piece) => body > 0 && piece.size > 0 && Math.abs(piece.size - body) <= Math.max(0.3, body * 0.05));
  const source = matches.length ? matches : pieces ?? [];
  if (!source.length) return { flowTop: 0, flowBottom: 1 };
  const tops = source.map((piece) => Number(piece.top) || 0);
  const bottoms = source.map((piece) => (piece.bottom === undefined ? Number(piece.top) || 0 : Number(piece.bottom) || 0));
  return { flowTop: Math.min(...tops), flowBottom: Math.max(...bottoms) };
}
