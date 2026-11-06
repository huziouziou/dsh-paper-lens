// 翻译路由的 HTTP 契约：NDJSON 流式（{delta} / {error} / {done}）。
//
// 这条链路最容易坏——头一旦发出去就不能改状态码，错误只能作为一行 JSON 回来。
// 所以直接驱动路由处理器，把真实的写入顺序与内容钉住。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply, BASE } from '../src/index.js';

const TRANSLATE = `${BASE}/translate`;

/** A host ctx that injects a fake llm, plus the plumbing apply() asks for. */
function harness(llm, stateFile) {
  const routes = {};
  const ctx = {
    on: () => {},
    logger: {},
    inject: (names, fn) => fn({
      effect: (f) => f(),
      get: (id) => (id === 'agentDefaultModel'
        ? { currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }) }
        : undefined),
      webServer: { register: (r) => { routes[r.path] = r.handler; return () => {}; } },
      commands: { register: () => () => {} },
      ...(names.includes('llm') ? { llm } : {}),
    }),
  };
  apply(ctx, { stateFile });
  return routes[TRANSLATE];
}

/** A request whose body is the given JSON, plus a response that records what was written. */
function request(handler, body, method = 'POST') {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
  const req = {
    method,
    url: TRANSLATE,
    async* [Symbol.asyncIterator]() { for (const c of chunks) yield c; },
  };
  const out = { status: null, headers: null, chunks: [], ended: false, flushed: false };
  const res = {
    writeHead(status, headers) { out.status = status; out.headers = headers; },
    flushHeaders() { out.flushed = true; },
    write(text) { out.chunks.push(text); return true; },
    end() { out.ended = true; },
  };
  return handler(req, res).then(() => out);
}

/** Parse an NDJSON body the way the browser side does. */
function lines(out) {
  return out.chunks.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function llmYielding(chunks) {
  return {
    stream() {
      return (async function* () {
        for (const c of chunks) yield c;
      })();
    },
  };
}

const stream = (chunks) => ({
  provider: 'opencode-go',
  model: 'deepseek-v4.1-flash',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
  maxTokens: 1,
});

test('the route streams deltas as NDJSON and closes with done', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dpl-route-'));
  try {
    const handler = harness(llmYielding([
      { type: 'text-delta', index: 0, text: '译文' },
      { type: 'text-delta', index: 0, text: '第一段。' },
      { type: 'finish', reason: 'stop' },
    ]), join(dir, 'state.json'));

    const out = await request(handler, { text: 'Hello.' });
    assert.equal(out.status, 200);
    assert.match(String(out.headers['content-type']), /ndjson/);
    assert.deepEqual(lines(out), [{ delta: '译文' }, { delta: '第一段。' }, { done: true }]);
    assert.equal(out.ended, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty model answer becomes one error line carrying the diagnostics', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dpl-route-'));
  try {
    const handler = harness(llmYielding([
      { type: 'finish', reason: 'stop' },
    ]), join(dir, 'state.json'));

    const out = await request(handler, { text: 'Hello.' });
    assert.equal(out.status, 200); // 头已经发出去了，状态码不能再改
    const [line] = lines(out);
    assert.ok(line.error, '要有一行 error');
    assert.match(line.error, /模型没有返回译文/);
    assert.match(line.error, /收?到? ?无分片|finish×1/); // 直方图里要看得出模型确实结束了
    assert.equal(out.ended, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a mid-stream failure surfaces as an error line, not a silent end', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dpl-route-'));
  try {
    const handler = harness({
      stream() {
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: '半句' };
          throw new Error('上游断开');
        })();
      },
    }, join(dir, 'state.json'));

    const out = await request(handler, { text: 'Hello.' });
    const body = lines(out);
    assert.deepEqual(body[0], { delta: '半句' });
    assert.match(body[1].error, /翻译失败：上游断开/);
    assert.equal(out.ended, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validation happens before the headers go out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dpl-route-'));
  try {
    const handler = harness(llmYielding([]), join(dir, 'state.json'));

    const empty = await request(handler, { text: '' });
    assert.equal(empty.status, 400);

    const wrongMethod = await request(handler, { text: 'x' }, 'GET');
    assert.equal(wrongMethod.status, 405);

    const tooLong = await request(handler, { text: 'x'.repeat(7000) });
    assert.equal(tooLong.status, 413);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the stream call carries the session id the client sent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dpl-route-'));
  try {
    let seen;
    const handler = harness({
      stream(options) {
        seen = options;
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: '好' };
          yield { type: 'finish', reason: 'stop' };
        })();
      },
    }, join(dir, 'state.json'));

    await request(handler, { text: 'Hello.', session: 'session-9' });
    assert.equal(seen.sessionId, 'session-9');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('each delta reaches the response while the model is still generating', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dpl-route-'));
  try {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const handler = harness({
      stream() {
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: '第一段' };
          await gate;
          yield { type: 'text-delta', index: 0, text: '第二段' };
          yield { type: 'finish', reason: 'stop' };
        })();
      },
    }, join(dir, 'state.json'));

    const req = {
      method: 'POST',
      url: TRANSLATE,
      async* [Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ text: 'Hello.' }), 'utf8'); },
    };
    const out = { status: null, headers: null, chunks: [], ended: false };
    const res = {
      writeHead(status, headers) { out.status = status; out.headers = headers; },
      write(text) { out.chunks.push(text); return true; },
      end() { out.ended = true; },
    };
    const running = handler(req, res);

    // 第一段必须已经写出，而生成器还卡在 gate 上：这能区别「边收边写」和「收完再写」。
    for (let i = 0; i < 100 && out.chunks.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(lines(out), [{ delta: '第一段' }]);
    assert.equal(out.ended, false, '流应该还开着，模型还没生成完');

    release();
    await running;
    assert.deepEqual(lines(out), [{ delta: '第一段' }, { delta: '第二段' }, { done: true }]);
    assert.equal(out.ended, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('headers are flushed before the model produces anything', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dpl-route-'));
  try {
    const handler = harness(llmYielding([{ type: 'text-delta', index: 0, text: '好' }, { type: 'finish', reason: 'stop' }]), join(dir, 'state.json'));
    const out = await request(handler, { text: 'Hello.' });
    assert.equal(out.flushed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the same passage is served from cache without calling the model again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dpl-route-'));
  try {
    let calls = 0;
    const handler = harness({
      stream() {
        calls += 1;
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: '缓存译文' };
          yield { type: 'finish', reason: 'stop' };
        })();
      },
    }, join(dir, 'state.json'));

    const first = await request(handler, { text: 'Hello.' });
    assert.equal(calls, 1);
    assert.equal(first.headers['x-dpl-cache'], undefined);

    const second = await request(handler, { text: 'Hello.' });
    assert.equal(calls, 1, '第二次不应该再请求模型');
    assert.equal(second.headers['x-dpl-cache'], 'hit');
    assert.deepEqual(lines(second), [{ delta: '缓存译文' }, { done: true }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('paragraphs are translated in parallel and emitted in reading order', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dpl-route-'));
  try {
    const handler = harness({
      stream(options) {
        const prompt = options.messages[0].content[0].text;
        const which = prompt.includes('AAAA') ? '甲' : '乙';
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: which };
          yield { type: 'finish', reason: 'stop' };
        })();
      },
    }, join(dir, 'state.json'));

    const text = `${'A'.repeat(200)}\n\n${'B'.repeat(200)}`;
    const out = await request(handler, { text });
    assert.deepEqual(lines(out), [{ delta: '甲' }, { delta: '\n\n乙' }, { done: true }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
