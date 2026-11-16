// dsh-paper-lens — where the reader is, as a scroll position rather than a
// page number.
//
// A page number alone is not enough: the viewport usually starts in the middle
// of a page, and when a paper is read continuously it often spans two pages.
// Native PDF readers reopen exactly where the reader left off, so the position
// is kept as (page under the viewport's top edge, how far into that page).
//
// Pure functions, no DOM: the arithmetic is easy to get subtly wrong (gaps
// between pages, the padding above the first page, offsets below zero at the
// very top), so it is tested directly.

/** 1-based index of the page whose top is at or above `top`. */
export function pageUnderTop(tops, top) {
  if (!Array.isArray(tops) || !tops.length) return 1;
  let lo = 0;
  let hi = tops.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tops[mid] <= top) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * A scroll position as `{ page, offset }`: the page under the viewport's top
 * edge, plus how far into that page the edge sits (0 = page top, 1 = bottom).
 * Above the first page the offset is negative — that is a fresh open.
 */
export function anchorFrom(top, tops, heights) {
  const page = pageUnderTop(tops, top);
  const height = Math.max(1, Number(heights?.[page - 1]) || 0);
  return { page, offset: ((Number(top) || 0) - (Number(tops?.[page - 1]) || 0)) / height };
}

/** Inverse of `anchorFrom`: the `top` that puts the viewport back on `anchor`. */
export function topForAnchor(anchor, tops, heights) {
  if (!anchor || !Array.isArray(tops) || !tops.length) return 0;
  const n = Math.max(1, Math.min(Math.floor(Number(anchor.page) || 1), tops.length));
  const offset = Number(anchor.offset);
  const height = Math.max(1, Number(heights?.[n - 1]) || 0);
  return (Number(tops[n - 1]) || 0) + (Number.isFinite(offset) ? offset : 0) * height;
}

/**
 * Accepts what earlier versions saved (a bare page number, or `{ page }`), so
 * a tab that was open across an upgrade still reopens sensibly.
 */
export function normalizeAnchor(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'string') {
    const page = Math.floor(Number(value));
    return Number.isFinite(page) && page > 0 ? { page, offset: 0 } : null;
  }
  if (typeof value !== 'object') return null;
  const page = Math.floor(Number(value.page));
  if (!Number.isFinite(page) || page <= 0) return null;
  const offset = Number(value.offset);
  return { page, offset: Number.isFinite(offset) ? offset : 0 };
}
