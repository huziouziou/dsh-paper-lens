import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findAllInItems, findInItems, stepHit } from '../src/client/textsearch.js';

/** A line of pdf.js text content: one item per line, baseline going down. */
function line(str, y, hasEOL = true) {
  return { str, transform: [1, 0, 0, 1, 0, y], width: str.length * 5, height: 10, hasEOL };
}

test('findAllInItems finds every occurrence on a page, in reading order', () => {
  const items = [line('The quick brown fox', 700), line('jumps over the lazy dog', 680)];
  const hits = findAllInItems(items, 'the');
  assert.equal(hits.length, 2);
  // First hit is inside the first item, second inside the second.
  assert.deepEqual(hits.map((spans) => spans.length), [1, 1]);
  assert.equal(hits[0][0].item, 0);
  assert.equal(hits[1][0].item, 1);
});

test('findAllInItems matches the same word twice in one line', () => {
  const items = [line('cell and cell again', 700)];
  assert.equal(findAllInItems(items, 'cell').length, 2);
});

test('findAllInItems folds case and joins words hyphenated across lines', () => {
  const items = [line('the evalu-', 700, false), line('ation is fine', 680)];
  const hits = findAllInItems(items, 'Evaluation');
  assert.equal(hits.length, 1);
  // The match spans the end of line 1 and the start of line 2.
  assert.deepEqual(hits[0].map((span) => span.item), [0, 1]);
});

test('findAllInItems ignores punctuation between words when needed', () => {
  const items = [line('Results: 12 sites', 700)];
  assert.equal(findAllInItems(items, 'results 12').length, 1);
});

test('findAllInItems needs two characters and reports nothing for a blank query', () => {
  const items = [line('anything at all', 700)];
  assert.deepEqual(findAllInItems(items, ''), []);
  assert.deepEqual(findAllInItems(items, ' '), []);
  assert.deepEqual(findAllInItems(items, 'a'), []);
  assert.deepEqual(findAllInItems(items, 'missing'), []);
});

test('findAllInItems honours the limit', () => {
  const items = [line('x x x x x x', 700)];
  assert.equal(findAllInItems(items, 'x x', 2).length, 2);
});

test('findInItems still returns only the first match', () => {
  const items = [line('cell and cell again', 700)];
  const spans = findInItems(items, 'cell');
  assert.ok(spans && spans.length === 1);
  assert.equal(spans[0].from, 0);
});

test('stepHit walks forward and backward with wrap-around', () => {
  assert.equal(stepHit(-1, 1, 4), 0);
  assert.equal(stepHit(-1, -1, 4), 3);
  assert.equal(stepHit(0, 1, 4), 1);
  assert.equal(stepHit(3, 1, 4), 0);
  assert.equal(stepHit(0, -1, 4), 3);
  assert.equal(stepHit(1, 1, 1), 0);
  assert.equal(stepHit(0, 1, 0), -1);
});
