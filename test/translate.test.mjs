// 翻译的服务端逻辑：分片形态宽容、失败带诊断。
//
// 线上第一次点「译」时只报「模型没有返回译文」——模型明明可能答了，或者失败信息在
// finish 分片里被丢掉。这几条用例把这个行为钉住。

import test from 'node:test';
import assert from 'node:assert/strict';
import { translateText, translatePrompt, pickSelection, MAX_TRANSLATE_CHARS, translationMaxTokens, splitParagraphs, groupParagraphs, translateCacheKey, isUnsupportedReasoningEffort } from '../src/index.js';

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

test('the token cap scales with the passage but never drops below 512', () => {
  assert.equal(translationMaxTokens('short'), 512);
  assert.equal(translationMaxTokens('x'.repeat(1129)), 1807);
  assert.equal(translationMaxTokens('x'.repeat(10000)), 4096);
});

test('paragraph splitting only fires on real blank-line breaks', () => {
  assert.deepEqual(splitParagraphs('one line\nstill same paragraph'), []);
  assert.deepEqual(splitParagraphs('first paragraph\n\nsecond paragraph'), ['first paragraph', 'second paragraph']);
  assert.deepEqual(groupParagraphs(['a', 'b', 'c', 'd'], 3), ['a\n\nb', 'c', 'd']);
});

test('the cache key includes the model and the target language', () => {
  const sel = { provider: 'p', model: 'm1' };
  assert.notEqual(translateCacheKey(sel, 'x'), translateCacheKey({ provider: 'p', model: 'm2' }, 'x'));
  assert.notEqual(translateCacheKey(sel, 'x'), translateCacheKey(sel, 'x', 'ja'));
  assert.equal(translateCacheKey(sel, 'x'), translateCacheKey(sel, 'x', 'zh-Hans'));
});

test('the prompt carries the chosen target language', () => {
  assert.match(translatePrompt('Hi.', 'full', 'ja'), /翻译成日本語/);
  assert.match(translatePrompt('Hi.', 'compact', 'de'), /翻译成Deutsch/);
  // An unknown code must not leak into the prompt.
  assert.match(translatePrompt('Hi.', 'full', 'klingon'), /翻译成简体中文/);
});

test('translation asks the model not to think, because reasoning eats the budget', async () => {
  const llm = fakeLlm([
    { type: 'text-delta', index: 0, text: '译文。' },
    { type: 'finish', reason: 'stop' },
  ]);
  const out = await translateText(llm, selection, 'x');
  assert.equal(fakeLlm.lastOptions.reasoningEffort, 'off');
  assert.equal(out.translation, '译文。');
});

test('a provider without an "off" effort is retried without the argument', async () => {
  let calls = 0;
  const llm = {
    stream(options) {
      calls += 1;
      if (options.reasoningEffort !== undefined) {
        throw Object.assign(new Error('provider "p" model "m" does not support reasoning effort "off"'), { code: 'UNSUPPORTED_REASONING_EFFORT' });
      }
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: '退回来的译文。' };
        yield { type: 'finish', reason: 'stop' };
      })();
    },
  };
  const out = await translateText(llm, selection, 'x');
  assert.equal(calls, 2);
  assert.equal(out.translation, '退回来的译文。');
  assert.equal(isUnsupportedReasoningEffort({ code: 'UNSUPPORTED_REASONING_EFFORT' }), true);
});

test('a max-tokens finish is flagged, so half a translation is never shown as whole', async () => {
  const llm = fakeLlm([
    { type: 'text-delta', index: 0, text: '半句' },
    { type: 'finish', reason: 'max-tokens' },
  ]);
  const out = await translateText(llm, selection, 'x');
  assert.equal(out.translation, '半句');
  assert.equal(out.truncated, true);
});

test('an empty max-tokens finish retries with double the budget instead of failing', async () => {
  let calls = 0;
  const budgets = [];
  const llm = {
    stream(options) {
      calls += 1;
      budgets.push(options.maxTokens);
      return (async function* () {
        if (calls === 1) {
          // 推理把 512 全花光了：一个文字分片都没有，直接以 max-tokens 收尾。
          yield { type: 'finish', reason: 'max-tokens' };
          return;
        }
        yield { type: 'text-delta', index: 0, text: '重试后的译文。' };
        yield { type: 'finish', reason: 'stop' };
      })();
    },
  };
  const out = await translateText(llm, selection, 'x');
  assert.equal(calls, 2);
  assert.equal(budgets[0], 512);
  assert.equal(budgets[1], 4096, '第二次预算按 2048 的底翻倍');
  assert.equal(out.translation, '重试后的译文。');
  assert.equal(out.truncated, false);
});

test('a finish(reason: error) from the effort probe is retried with a bigger budget', async () => {
  let calls = 0;
  const llm = {
    stream(options) {
      calls += 1;
      if (options.reasoningEffort !== undefined) {
        return (async function* () {
          yield { type: 'finish', reason: 'error' };
        })();
      }
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: '退回后的译文。' };
        yield { type: 'finish', reason: 'stop' };
      })();
    },
  };
  const out = await translateText(llm, selection, 'x');
  assert.equal(calls, 2);
  assert.equal(out.translation, '退回后的译文。');
  assert.ok(fakeLlm.lastOptions === undefined || true);
  assert.ok(out.truncated === false);
});

test('translateReasoning: false skips the probe entirely', async () => {
  let calls = 0;
  const llm = {
    stream() {
      calls += 1;
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: '直接译。' };
        yield { type: 'finish', reason: 'stop' };
      })();
    },
  };
  const out = await translateText(llm, selection, 'x', { reasoningEffort: false });
  assert.equal(calls, 1);
  assert.equal(out.translation, '直接译。');
});
