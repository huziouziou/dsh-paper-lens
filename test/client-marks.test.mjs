import test from 'node:test';
import assert from 'node:assert/strict';

import { markFromSelection, unionRect, updateMarkNote } from '../src/client/marks.js';

test('the union rect covers every selected line', () => {
  assert.deepEqual(unionRect([
    { x: 0.1, y: 0.2, w: 0.3, h: 0.04 },
    { x: 0.05, y: 0.25, w: 0.5, h: 0.04 },
  ]), { x: 0.05, y: 0.2, w: 0.5, h: 0.09 });
  assert.equal(unionRect([]), null);
  assert.equal(unionRect([{ x: 0, y: 0, w: 0, h: 0.1 }]), null);
});

test('a selection becomes the Agentero-shaped mark, with a 0-based page', () => {
  const mark = markFromSelection({
    page: 7,
    text: 'A passage that\nwraps a line.',
    boxes: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.04 }, { x: 0.1, y: 0.24, w: 0.2, h: 0.04 }],
  }, '#f59e0b');
  assert.deepEqual(mark, {
    pageIndex: 6,
    rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.08 },
    segmentRects: [
      { x: 0.1, y: 0.2, w: 0.3, h: 0.04 },
      { x: 0.1, y: 0.24, w: 0.2, h: 0.04 },
    ],
    strokeColor: '#f59e0b',
    custom: { quote: 'A passage that wraps a line.' },
  });
  assert.equal(markFromSelection({ page: 1, text: '   ', boxes: [] }, '#f59e0b'), null);
});

test('updateMarkNote PATCHes the route with the note as sent', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      async json() {
        return { mark: { id: 'm-1', custom: { quote: 'q', note: '写下的文字' } } };
      },
    };
  };
  const mark = await updateMarkNote({ session: 's1', path: 'p/main.pdf', id: 'm-1', note: '写下的文字', fetchImpl });
  assert.equal(mark.custom.note, '写下的文字');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'PATCH');
  assert.equal(calls[0].url, '/plugin-data/dsh-paper-lens/marks');
  assert.deepEqual(JSON.parse(calls[0].options.body), { session: 's1', path: 'p/main.pdf', id: 'm-1', note: '写下的文字' });
});
