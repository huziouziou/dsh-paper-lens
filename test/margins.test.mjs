import test from 'node:test';
import assert from 'node:assert/strict';

import { isMarginFurniture } from '../src/client/margins.js';

const H = 1000; // page height in px

test('a thin band at the top of a page we are passing into is always furniture', () => {
  // A bioRxiv license banner: 8pt words in a text item that reports the body size.
  assert.equal(isMarginFurniture({ first: false, last: false, small: false, top: 10, bottom: 900, height: H }), true);
  // Body text right below it stays.
  assert.equal(isMarginFurniture({ first: false, last: false, small: false, top: 93, bottom: 800, height: H }), false);
});

test('the start page keeps a title that begins near the top', () => {
  assert.equal(isMarginFurniture({ first: true, last: false, small: false, top: 20, bottom: 800, height: H }), false);
});

test('a small running head on the start page is still dropped', () => {
  assert.equal(isMarginFurniture({ first: true, last: false, small: true, top: 25, bottom: 900, height: H }), true);
});

test('small type further down is a running head on later pages only', () => {
  assert.equal(isMarginFurniture({ first: false, last: true, small: true, top: 140, bottom: 700, height: H }), true);
  assert.equal(isMarginFurniture({ first: true, last: false, small: true, top: 140, bottom: 700, height: H }), false);
});

test('small type at the bottom is a footer unless it is the last page', () => {
  assert.equal(isMarginFurniture({ first: false, last: false, small: true, top: 900, bottom: 40, height: H }), true);
  assert.equal(isMarginFurniture({ first: false, last: true, small: true, top: 900, bottom: 40, height: H }), false);
});

test('body type at the bottom is never removed', () => {
  assert.equal(isMarginFurniture({ first: false, last: false, small: false, top: 880, bottom: 50, height: H }), false);
});

test('a page without a measured height leaves everything alone', () => {
  assert.equal(isMarginFurniture({ first: false, last: false, small: true, top: 0, bottom: 0, height: 0 }), false);
});
