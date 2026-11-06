// dsh-paper-lens — annotations on the browser side: turning a selection into
// the stored shape, and the small HTTP client for the marks route.
//
// A mark is stored next to the PDF, not in this bundle. The shape follows
// Agentero's format: pageIndex (0-based page), rect/segmentRects as fractions
// of the page, strokeColor, custom.quote. `rect` is the union used for the
// list and for jumping back; `segmentRects` are the per-line boxes.

import { cleanSelection } from './chat.js';

const BASE = '/plugin-data/dsh-paper-lens';

/** Palette shown in the selection toolbar; the server accepts these hex forms. */
export const MARK_COLORS = Object.freeze(['#f59e0b', '#ef4444', '#22c55e', '#3b82f6']);

/** The union of normalized boxes, or null when there are none. */
export function unionRect(boxes = []) {
  const list = boxes.filter((b) => b && [b.x, b.y, b.w, b.h].every((n) => Number.isFinite(Number(n))) && b.w > 0 && b.h > 0);
  if (!list.length) return null;
  const x1 = Math.min(...list.map((b) => b.x));
  const y1 = Math.min(...list.map((b) => b.y));
  const x2 = Math.max(...list.map((b) => b.x + b.w));
  const y2 = Math.max(...list.map((b) => b.y + b.h));
  const round = (n) => Math.round(n * 1e6) / 1e6;
  return { x: round(x1), y: round(y1), w: round(x2 - x1), h: round(y2 - y1) };
}

/**
 * The mark a selection would create. `sel` is selectionInPdf's result:
 * { page (1-based), text, boxes (fractions of the page) }.
 */
export function markFromSelection(sel, strokeColor) {
  const quote = cleanSelection(sel?.text);
  const boxes = Array.isArray(sel?.boxes) ? sel.boxes : [];
  const rect = unionRect(boxes);
  if (!quote || !rect || !Number.isInteger(sel?.page)) return null;
  return {
    pageIndex: sel.page - 1,
    rect,
    segmentRects: boxes,
    strokeColor,
    custom: { quote },
  };
}

function query(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  return search.toString();
}

async function jsonOrThrow(response) {
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
  return data;
}

export async function loadMarks({ session, path, fetchImpl = fetch }) {
  const response = await fetchImpl(`${BASE}/marks?${query({ session, path })}`, { headers: { accept: 'application/json' } });
  const data = await jsonOrThrow(response);
  return Array.isArray(data?.marks) ? data.marks : [];
}

export async function saveMark({ session, path, mark, fetchImpl = fetch }) {
  const response = await fetchImpl(`${BASE}/marks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ session, path, mark }),
  });
  const data = await jsonOrThrow(response);
  return data?.mark;
}

export async function deleteMark({ session, path, id, fetchImpl = fetch }) {
  const response = await fetchImpl(`${BASE}/marks?${query({ session, path, id })}`, {
    method: 'DELETE',
    headers: { accept: 'application/json' },
  });
  await jsonOrThrow(response);
  return true;
}

/** Set (or clear, with an empty string) one mark's text note. */
export async function updateMarkNote({ session, path, id, note, fetchImpl = fetch }) {
  const response = await fetchImpl(`${BASE}/marks`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ session, path, id, note: String(note ?? '') }),
  });
  const data = await jsonOrThrow(response);
  return data?.mark;
}
