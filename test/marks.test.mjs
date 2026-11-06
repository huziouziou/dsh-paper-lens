import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  MARKS_DIR,
  addMark,
  marksFileFor,
  normalizeMark,
  normalizeRect,
  readMarks,
  removeMark,
  resolvePdfPath,
} from '../src/marks.js';

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'dpl-marks-'));
  const paper = join(dir, 'paper');
  mkdirSync(paper, { recursive: true });
  const pdf = join(paper, 'main.pdf');
  writeFileSync(pdf, '%PDF-1.4\n');
  return { dir, pdf };
}

test('a relative PDF path resolves inside the session workspace; outside and non-PDF are refused', () => {
  const { dir, pdf } = workspace();
  try {
    assert.equal(resolvePdfPath('paper/main.pdf', dir), resolve(pdf));
    assert.equal(resolvePdfPath('C:/papers/main.pdf', undefined), resolve('C:/papers/main.pdf'));
    assert.equal(resolvePdfPath('../escape.pdf', dir), null);
    assert.equal(resolvePdfPath('paper/main.txt', dir), null);
    assert.equal(resolvePdfPath('', dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('marks live in marks/<name>.marks.json next to the PDF', () => {
  const file = marksFileFor('D:/papers/main.pdf');
  assert.equal(file, join('D:', 'papers', MARKS_DIR, 'main.marks.json'));
  assert.equal(marksFileFor('D:/papers/Figure S3.pdf').endsWith(join('marks', 'Figure S3.marks.json')), true);
});

test('rects accept {x,y,w,h} and Agentero-style corners', () => {
  assert.deepEqual(normalizeRect({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }), { x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
  assert.deepEqual(normalizeRect({ x1: 0.4, y1: 0.6, x2: 0.1, y2: 0.2 }), { x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
  assert.equal(normalizeRect({ x: 0.5, y: 0.5, w: 0, h: 0.1 }), null);
  assert.equal(normalizeRect(null), null);
});

test('create, list and delete a mark, with the quote and colour preserved', () => {
  const { dir, pdf } = workspace();
  try {
    const added = addMark(pdf, {
      pageIndex: 2,
      rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.04 },
      segmentRects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.04 }],
      strokeColor: '#ef4444',
      custom: { quote: 'A quoted sentence.' },
    });
    assert.match(added.id, /^m-/);
    assert.equal(added.pageIndex, 2);
    const list = readMarks(pdf);
    assert.equal(list.length, 1);
    assert.equal(list[0].custom.quote, 'A quoted sentence.');
    assert.equal(list[0].strokeColor, '#ef4444');
    const stored = JSON.parse(readFileSync(marksFileFor(pdf), 'utf8'));
    assert.equal(stored.version, 1);
    assert.equal(stored.pdf, 'main.pdf');
    assert.equal(stored.marks.length, 1);

    assert.equal(removeMark(pdf, added.id), true);
    assert.deepEqual(readMarks(pdf), []);
    assert.equal(removeMark(pdf, added.id), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a malformed mark is refused instead of being written', () => {
  assert.equal(normalizeMark({ pageIndex: -1, rect: { x: 0, y: 0, w: 1, h: 1 }, custom: { quote: 'x' } }), null);
  assert.equal(normalizeMark({ pageIndex: 0, rect: { x: 0, y: 0, w: 1, h: 1 }, custom: { quote: '' } }), null);
  assert.equal(normalizeMark({ pageIndex: 0, rect: { x: 2, y: 0, w: 1, h: 1 }, custom: { quote: 'x' } }), null);
});
