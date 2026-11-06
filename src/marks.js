// dsh-paper-lens — annotations beside the PDF.
//
// One JSON file per PDF, under `<pdf-dir>/marks/<pdf-name>.marks.json`. Keeping
// it next to the paper means moving/renaming the paper carries its marks along,
// and nothing is written into the workspace root. The record shape follows
// Agentero's annotation format closely enough to migrate by hand:
//
//   { id, pageIndex, rect, segmentRects, strokeColor, custom: { quote, note? }, createdAt }
//
// `rect` and every `segmentRects[]` entry are fractions of that page
// (x/y/w/h, 0..1) so zoom and DPI do not matter. `pageIndex` is 0-based.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const MARKS_DIR = 'marks';
export const MARK_COLORS = Object.freeze(['#f59e0b', '#ef4444', '#22c55e', '#3b82f6']);
const MAX_MARKS = 2000;
const MAX_QUOTE = 4000;

/**
 * The PDF's absolute path, or null when it cannot be resolved safely.
 *
 * `path` is what the preview reports: absolute, or workspace-relative (the
 * usual dsh-resource address). A relative path is joined to the session's cwd
 * and may not escape it; an absolute path is taken as is.
 */
export function resolvePdfPath(path, cwd) {
  const raw = String(path ?? '').trim();
  if (!raw) return null;
  const cleaned = raw.replace(/\\/g, '/');
  const absolute = /^[A-Za-z]:\//.test(cleaned) || cleaned.startsWith('//') || cleaned.startsWith('/');
  let full;
  if (absolute) {
    full = resolve(cleaned);
  } else {
    if (!cwd) return null;
    const root = resolve(String(cwd));
    full = resolve(root, cleaned);
    const rel = relative(root, full);
    if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) return null;
  }
  return extname(full).toLowerCase() === '.pdf' ? full : null;
}

/** Where this PDF's marks live: `<dir>/marks/<name>.marks.json`. */
export function marksFileFor(pdfPath) {
  const ext = extname(pdfPath);
  const name = pdfPath.slice(0, pdfPath.length - ext.length).split(/[\\/]/).pop();
  return join(dirname(pdfPath), MARKS_DIR, `${name}.marks.json`);
}

function frac(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

/** Accept {x,y,w,h} or {x1,y1,x2,y2}; return {x,y,w,h} or null. */
export function normalizeRect(raw) {
  if (!raw || typeof raw !== 'object') return null;
  let x; let y; let w; let h;
  if (raw.w !== undefined || raw.h !== undefined) {
    x = frac(raw.x); y = frac(raw.y); w = frac(raw.w); h = frac(raw.h);
  } else {
    const x1 = frac(raw.x1); const y1 = frac(raw.y1); const x2 = frac(raw.x2); const y2 = frac(raw.y2);
    x = Math.min(x1, x2); y = Math.min(y1, y2); w = Math.abs(x2 - x1); h = Math.abs(y2 - y1);
  }
  if (![x, y, w, h].every(Number.isFinite)) return null;
  if (w <= 0 || h <= 0) return null;
  if (x < -0.2 || y < -0.2 || x > 1.2 || y > 1.2 || w > 1.4 || h > 1.4) return null;
  const round = (n) => Math.round(n * 1e6) / 1e6;
  return { x: round(x), y: round(y), w: round(w), h: round(h) };
}

/** One stored mark, or null when the input is not a usable annotation. */
export function normalizeMark(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const pageIndex = Number(raw.pageIndex);
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex > 100000) return null;
  const rect = normalizeRect(raw.rect);
  if (!rect) return null;
  const segments = Array.isArray(raw.segmentRects)
    ? raw.segmentRects.map(normalizeRect).filter(Boolean).slice(0, 60)
    : [];
  const quote = String(raw.custom?.quote ?? raw.quote ?? '').trim().slice(0, MAX_QUOTE);
  if (!quote) return null;
  const note = String(raw.custom?.note ?? raw.note ?? '').trim().slice(0, 2000);
  const strokeColor = /^#[0-9a-f]{6}$/i.test(String(raw.strokeColor ?? ''))
    ? String(raw.strokeColor).toLowerCase()
    : MARK_COLORS[0];
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim().slice(0, 80) : `m-${now.toString(36)}-${randomUUID().slice(0, 8)}`;
  return {
    id,
    pageIndex,
    rect,
    segmentRects: segments.length ? segments : [rect],
    strokeColor,
    custom: { quote, ...(note ? { note } : {}) },
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : now,
  };
}

/** All marks for a PDF; a missing/corrupt file reads as no marks. */
export function readMarks(pdfPath) {
  const file = marksFileFor(pdfPath);
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const list = Array.isArray(data?.marks) ? data.marks : [];
    return list.map((m) => normalizeMark(m)).filter(Boolean).slice(0, MAX_MARKS);
  } catch {
    return [];
  }
}

export function writeMarks(pdfPath, marks) {
  const file = marksFileFor(pdfPath);
  mkdirSync(dirname(file), { recursive: true });
  const payload = { version: 1, pdf: pdfPath.split(/[\\/]/).pop(), marks: marks.slice(0, MAX_MARKS) };
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return file;
}

export function addMark(pdfPath, raw) {
  const mark = normalizeMark(raw);
  if (!mark) return null;
  const marks = readMarks(pdfPath);
  marks.push(mark);
  writeMarks(pdfPath, marks);
  return mark;
}

export function removeMark(pdfPath, id) {
  const marks = readMarks(pdfPath);
  const next = marks.filter((m) => m.id !== id);
  if (next.length === marks.length) return false;
  writeMarks(pdfPath, next);
  return true;
}

/** Whether the PDF exists; a mark next to a missing file is not useful. */
export function pdfExists(pdfPath) {
  return Boolean(pdfPath) && existsSync(pdfPath);
}
