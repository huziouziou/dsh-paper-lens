import { test } from 'node:test';
import assert from 'node:assert/strict';

import { anchorFrom, normalizeAnchor, pageUnderTop, topForAnchor } from '../src/client/anchor.js';

// Three pages, same size, separated by a 16px gap — the layout the viewer uses.
const TOPS = [0, 716, 1432];
const HEIGHTS = [700, 700, 700];

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('pageUnderTop finds the page a position falls in', () => {
  assert.equal(pageUnderTop(TOPS, -50), 1);
  assert.equal(pageUnderTop(TOPS, 0), 1);
  assert.equal(pageUnderTop(TOPS, 699), 1);
  assert.equal(pageUnderTop(TOPS, 716), 2);
  assert.equal(pageUnderTop(TOPS, 1000), 2);
  assert.equal(pageUnderTop(TOPS, 1432), 3);
  assert.equal(pageUnderTop([], 100), 1);
});

test('a position between two pages keeps the exact offset, not the page start', () => {
  // 200px into page 2: the viewport shows the end of page 2 and the start of page 3.
  const anchor = anchorFrom(916, TOPS, HEIGHTS);
  assert.equal(anchor.page, 2);
  near(anchor.offset, 200 / 700);
});

test('anchorFrom and topForAnchor are inverse operations', () => {
  for (const top of [0, 100, 700, 916, 1400, 2000]) {
    const anchor = anchorFrom(top, TOPS, HEIGHTS);
    near(topForAnchor(anchor, TOPS, HEIGHTS), top);
  }
});

test('above the first page the offset is negative and still round-trips', () => {
  const anchor = anchorFrom(-100, TOPS, HEIGHTS);
  assert.equal(anchor.page, 1);
  near(anchor.offset, -100 / 700);
  near(topForAnchor(anchor, TOPS, HEIGHTS), -100);
});

test('the offset is a fraction of the page height, so a resize keeps the place', () => {
  const anchor = anchorFrom(916, TOPS, HEIGHTS);
  // Zooming to 2x doubles tops and heights; the same fraction means the same line.
  const scaled = topForAnchor(anchor, [0, 1432, 2864], [1400, 1400, 1400]);
  near(scaled, 1432 + (200 / 700) * 1400);
});

test('topForAnchor clamps a page outside the document', () => {
  assert.equal(topForAnchor({ page: 99, offset: 0.5 }, TOPS, HEIGHTS), 1432 + 350);
  assert.equal(topForAnchor({ page: -3, offset: 0 }, TOPS, HEIGHTS), 0);
  assert.equal(topForAnchor(null, TOPS, HEIGHTS), 0);
});

test('normalizeAnchor accepts what earlier versions saved', () => {
  // Earlier versions stored the bare page number, then { page }.
  assert.deepEqual(normalizeAnchor(3), { page: 3, offset: 0 });
  assert.deepEqual(normalizeAnchor('2'), { page: 2, offset: 0 });
  assert.deepEqual(normalizeAnchor({ page: 2 }), { page: 2, offset: 0 });
  assert.deepEqual(normalizeAnchor({ page: 2, offset: '0.5' }), { page: 2, offset: 0.5 });
  assert.deepEqual(normalizeAnchor({ page: 2.7, offset: 1 }), { page: 2, offset: 1 });
  assert.deepEqual(normalizeAnchor({ page: 2, offset: 'nope' }), { page: 2, offset: 0 });
});

test('normalizeAnchor rejects values that cannot be a position', () => {
  assert.equal(normalizeAnchor(null), null);
  assert.equal(normalizeAnchor(undefined), null);
  assert.equal(normalizeAnchor(0), null);
  assert.equal(normalizeAnchor(-2), null);
  assert.equal(normalizeAnchor({}), null);
  assert.equal(normalizeAnchor({ page: 0 }), null);
  assert.equal(normalizeAnchor('abc'), null);
});
