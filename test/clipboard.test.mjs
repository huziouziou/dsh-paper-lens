import test from 'node:test';
import assert from 'node:assert/strict';

import { copyText } from '../src/client/clipboard.js';

/** The smallest textarea the fallback touches. */
function fakeDocument({ copyResult = true, throwOnCopy = false } = {}) {
  const area = {
    value: '',
    style: {},
    removed: false,
    setAttribute() {},
    select() { this.selected = true; },
    remove() { this.removed = true; },
  };
  return {
    area,
    createElement(tag) {
      assert.equal(tag, 'textarea');
      return area;
    },
    body: { appendChild(node) { node.appended = true; } },
    execCommand(command) {
      if (throwOnCopy) throw new Error('nope');
      assert.equal(command, 'copy');
      return copyResult;
    },
  };
}

test('the async clipboard is used when it works', async () => {
  const written = [];
  const ok = await copyText('译文', { clip: { writeText: async (t) => written.push(t) }, document: fakeDocument() });
  assert.equal(ok, true);
  assert.deepEqual(written, ['译文']);
});

test('a rejecting clipboard falls back to a temporary textarea', async () => {
  const doc = fakeDocument();
  const ok = await copyText('选中文字', { clip: { writeText: async () => { throw new Error('denied'); } }, document: doc });
  assert.equal(ok, true);
  assert.equal(doc.area.value, '选中文字');
  assert.equal(doc.area.selected, true);
  assert.equal(doc.area.appended, true);
  assert.equal(doc.area.removed, true, 'textarea 用完就删掉');
});

test('nothing to copy, or no clipboard at all, reports failure instead of throwing', async () => {
  assert.equal(await copyText('', { clip: { writeText: async () => {} }, document: fakeDocument() }), false);
  assert.equal(await copyText('x', { clip: undefined, document: undefined }), false);
  const denied = await copyText('x', { clip: { writeText: async () => { throw new Error('no'); } }, document: fakeDocument({ copyResult: false }) });
  assert.equal(denied, false);
});
