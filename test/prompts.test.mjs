import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PROMPTS, normalizePrompts, promptsForConfig } from '../src/prompts.js';

test('no config keeps the three built-in presets, in their old order', () => {
  const list = normalizePrompts(undefined);
  assert.deepEqual(list.map((p) => p.id), ['ask', 'explain', 'check']);
  assert.equal(list[0].prompt, '问题：');
  assert.notEqual(list, DEFAULT_PROMPTS, 'returned entries are copies');
});

test('a config array replaces the presets and an empty array turns them off', () => {
  const list = normalizePrompts([{ id: 'sum', label: '总结', prompt: '用三句话总结。' }]);
  assert.deepEqual(list, [{ id: 'sum', label: '总结', title: '带「总结」提示词引用', prompt: '用三句话总结。' }]);
  assert.deepEqual(normalizePrompts([]), []);
});

test('an object map works too, string shorthand included', () => {
  const list = normalizePrompts({ ask: '问题：', explain: { label: '讲明白', prompt: '讲明白。' } });
  assert.deepEqual(list.map((p) => [p.id, p.label, p.prompt]), [
    ['ask', 'ask', '问题：'],
    ['explain', '讲明白', '讲明白。'],
  ]);
});

test('malformed presets are dropped rather than silently restoring the defaults', () => {
  const list = normalizePrompts([{ id: 'ok', prompt: '好的。' }, { id: 'bad', prompt: '   ' }, null]);
  assert.deepEqual(list.map((p) => p.id), ['ok']);
  assert.equal(list[0].title, '带「ok」提示词引用');
});

test('the config route payload is just the normalized list', () => {
  assert.deepEqual(promptsForConfig({ prompts: [{ label: '问', prompt: '问题：' }] }).map((p) => p.label), ['问']);
});
