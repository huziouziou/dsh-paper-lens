// 翻译的服务端逻辑：分片形态宽容、失败带诊断。
//
// 线上第一次点「译」时只报「模型没有返回译文」——模型明明可能答了，或者失败信息在
// finish 分片里被丢掉。这几条用例把这个行为钉住。

import test from 'node:test';
import assert from 'node:assert/strict';
import { translateText, translatePrompt, pickSelection, MAX_TRANSLATE_CHARS } from '../src/index.js';

/** A fake llm service whose stream yields the given chunks. */
function fakeLlm(chunks) {
  return {
    stream(options) {
      fakeLlm.lastOptions = options;
      return (async function* () {
        for (const chunk of chunks) yield chunk;
      })();
    },
  };
}

const selection = { provider: 'opencode-go', model: 'deepseek-v4.1-flash' };

test('text-delta chunks are concatenated into one translation', async () => {
  const llm = fakeLlm([
    { type: 'reasoning-delta', index: 0, text: '思考中' },
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '这是' },
    { type: 'text-delta', index: 0, text: '译文。' },
    { type: 'finish', reason: 'stop' },
  ]);
  const out = await translateText(llm, selection, 'This is the translation.');
  assert.equal(out.translation, '这是译文。');
  assert.equal(out.finishReason, 'stop');
});

test('a final block-end alone still yields the text', async () => {
  const llm = fakeLlm([
    { type: 'block-end', index: 0, block: { type: 'text', text: '只有整块，没有增量。' } },
    { type: 'finish', reason: 'stop' },
  ]);
  const out = await translateText(llm, selection, 'Only a finished block.');
  assert.equal(out.translation, '只有整块，没有增量。');
});

test('a failure chunk is reported instead of silently becoming "no translation"', async () => {
  const llm = fakeLlm([
    { kind: 'error', failure: { code: 'NO_ADAPTER', message: 'no adapter for opencode-go', status: 400 } },
  ]);
  const out = await translateText(llm, selection, 'x');
  assert.equal(out.translation, '');
  assert.equal(out.failure.code, 'NO_ADAPTER');
  assert.equal(out.failure.message, 'no adapter for opencode-go');
});

test('the call carries the session id and a token cap, like the official compaction call', async () => {
  const llm = fakeLlm([{ type: 'finish', reason: 'stop' }]);
  await translateText(llm, selection, 'x', { sessionId: 'session-1' });
  assert.equal(fakeLlm.lastOptions.sessionId, 'session-1');
  assert.equal(fakeLlm.lastOptions.provider, 'opencode-go');
  assert.ok(fakeLlm.lastOptions.maxTokens > 0);
});

test('the prompt asks for the translation only', () => {
  const prompt = translatePrompt('Some English text.');
  assert.match(prompt, /只输出译文/);
  assert.match(prompt, /Some English text\./);
});

test('pickSelection prefers an explicit provider/model over the app default', () => {
  const scope = { get: (id) => (id === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'a', model: 'b' }) } : undefined) };
  assert.deepEqual(pickSelection(scope, { provider: 'p', model: 'm' }), { provider: 'p', model: 'm' });
  assert.deepEqual(pickSelection(scope, {}), { provider: 'a', model: 'b' });
  assert.equal(pickSelection({ get: () => undefined }, {}), null);
});

test('deltas are pushed out in order, so the bubble can stream them', async () => {
  const llm = fakeLlm([
    { type: 'text-delta', index: 0, text: '第一段。' },
    { type: 'text-delta', index: 0, text: '第二段。' },
    { type: 'finish', reason: 'stop' },
  ]);
  const seen = [];
  const out = await translateText(llm, selection, 'x', { onDelta: (d) => seen.push(d) });
  assert.deepEqual(seen, ['第一段。', '第二段。']);
  assert.equal(out.translation, '第一段。第二段。');
});

test('a block-end-only stream still reaches the bubble as one delta', async () => {
  const llm = fakeLlm([
    { type: 'block-end', index: 0, block: { type: 'text', text: '整块到了。' } },
    { type: 'finish', reason: 'stop' },
  ]);
  const seen = [];
  await translateText(llm, selection, 'x', { onDelta: (d) => seen.push(d) });
  assert.deepEqual(seen, ['整块到了。']);
});

test('reasoning text never reaches the bubble', async () => {
  const llm = fakeLlm([
    { type: 'reasoning-delta', index: 0, text: '先想想……' },
    { type: 'text-delta', index: 0, text: '译文。' },
    { type: 'finish', reason: 'stop' },
  ]);
  const seen = [];
  const out = await translateText(llm, selection, 'x', { onDelta: (d) => seen.push(d) });
  assert.deepEqual(seen, ['译文。']);
  assert.equal(out.translation, '译文。');
});

test('the translate cap is bounded', () => {
  assert.ok(MAX_TRANSLATE_CHARS >= 1000 && MAX_TRANSLATE_CHARS <= 20000);
});
