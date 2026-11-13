import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  apply, BASE, createModeStore, normalizeTranslateSettings, publicTranslateSettings,
} from '../src/index.js';
import { chatCompletionsUrl, translateViaApi } from '../src/api.js';

/** One SSE response whose body is handed out line by line. */
function sse(lines, { ok = true, status = 200 } = {}) {
  const encoder = new TextEncoder();
  const queue = lines.map((line) => encoder.encode(`${line}\n`));
  let index = 0;
  return {
    ok,
    status,
    headers: { get: () => 'text/event-stream' },
    text: async () => '',
    body: {
      getReader: () => ({
        read: async () => (index < queue.length
          ? { done: false, value: queue[index++] }
          : { done: true }),
      }),
    },
  };
}

function harness(stateFile) {
  const routes = {};
  const ctx = {
    on: () => {},
    logger: {},
    get: () => undefined,
    inject: (_names, fn) => fn({
      effect: (f) => f(),
      get: () => undefined,
      webServer: { register: (r) => { routes[r.path] = r.handler; return () => {}; } },
      commands: { register: () => () => {} },
      llm: { stream: async function* () { yield { type: 'finish', reason: 'stop' }; } },
    }),
  };
  apply(ctx, { routes: true, stateFile });
  return routes;
}

async function call(handler, { method = 'GET', url = '/', body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
  const req = { method, url, async* [Symbol.asyncIterator]() { for (const c of chunks) yield c; } };
  const out = { status: null, body: '' };
  const res = {
    writeHead(status) { out.status = status; },
    write() { return true; },
    end(text) { if (text) out.body += text; },
  };
  await handler(req, res);
  return { ...out, json: out.body ? JSON.parse(out.body) : null };
}

test('translate settings default to following the chat, and junk is ignored', () => {
  assert.deepEqual(normalizeTranslateSettings(null), {
    engine: 'session', provider: '', model: '', baseURL: '', apiKey: '',
  });
  const kept = normalizeTranslateSettings({
    engine: 'api', provider: ' p ', model: 'm', baseURL: ' https://x/v1 ', apiKey: 'k',
  });
  assert.deepEqual(kept, { engine: 'api', provider: 'p', model: 'm', baseURL: 'https://x/v1', apiKey: 'k' });
  assert.equal(normalizeTranslateSettings({ engine: 'nope', apiKey: 42 }).engine, 'session');
  assert.equal(normalizeTranslateSettings({ engine: 'nope', apiKey: 42 }).apiKey, '');
});

test('the public view never carries the key, only whether one is saved', () => {
  const shown = publicTranslateSettings({ engine: 'api', baseURL: 'https://x', model: 'm', apiKey: 'secret' });
  assert.deepEqual(shown, { engine: 'api', provider: '', model: 'm', baseURL: 'https://x', hasKey: true });
  assert.equal('apiKey' in shown, false);
});

test('the config route saves the engine, hides the key, and keeps it when omitted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dpl-engine-'));
  try {
    const routes = harness(join(dir, 'state.json'));
    const route = routes[`${BASE}/config`];

    const bad = await call(route, { method: 'POST', body: { engine: 'model', model: 'm' } });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /provider/);

    const saved = await call(route, {
      method: 'POST',
      body: { engine: 'api', baseURL: 'https://api.example.com/v1', model: 'fast', apiKey: 'sk-local' },
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.json.translate, {
      engine: 'api', provider: '', model: 'fast', baseURL: 'https://api.example.com/v1', hasKey: true,
    });
    assert.equal(saved.body.includes('sk-local'), false, 'the key never comes back');

    // Switching the engine without a key keeps the saved one.
    const switched = await call(route, { method: 'POST', body: { engine: 'session' } });
    assert.equal(switched.status, 200);
    assert.equal(switched.json.translate.hasKey, true);

    const listed = await call(route);
    assert.equal(listed.json.translate.engine, 'session');

    // An empty string is how the panel clears it.
    const cleared = await call(route, { method: 'POST', body: { apiKey: '' } });
    assert.equal(cleared.json.translate.hasKey, false);

    // The store on disk still follows normalization.
    assert.equal(createModeStore(join(dir, 'state.json')).translate().apiKey, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the endpoint is a base URL or already a full completions URL', () => {
  assert.equal(chatCompletionsUrl(''), '');
  assert.equal(chatCompletionsUrl(' https://x/v1/ '), 'https://x/v1/chat/completions');
  assert.equal(chatCompletionsUrl('https://x/v1/chat/completions'), 'https://x/v1/chat/completions');
});

test('the API engine streams content and drops reasoning', async () => {
  const deltas = [];
  const bodies = [];
  const result = await translateViaApi({
    baseURL: 'https://x/v1', apiKey: 'k', model: 'fast', text: 'Hello.', maxTokens: 99,
    onDelta: (piece) => deltas.push(piece),
  }, {
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return sse([
        'data: {"choices":[{"delta":{"reasoning_content":"thinking…"}}]}',
        'data: {"choices":[{"delta":{"content":"你好"}}]}',
        'data: {"choices":[{"delta":{"content":"。"},"finish_reason":"stop"}]}',
        'data: [DONE]',
      ]);
    },
  });
  assert.deepEqual(deltas, ['你好', '。']);
  assert.equal(result.translation, '你好。');
  assert.equal(result.truncated, false);
  // Local MT models repeat the rule list when it comes first, so the API engine
  // sends the compact text-first prompt.
  assert.match(bodies[0].messages[0].content, /^原文：\nHello\./);
  assert.equal(bodies[0].messages[0].content.includes('规则：'), false);
});

test('a length finish is flagged, and HTTP errors carry the detail', async () => {
  const cut = await translateViaApi({
    baseURL: 'https://x/v1', model: 'fast', text: 'Hi.',
  }, {
    fetchImpl: async () => sse([
      'data: {"choices":[{"delta":{"content":"半句"},"finish_reason":"length"}]}',
    ]),
  });
  assert.equal(cut.truncated, true);

  await assert.rejects(
    translateViaApi({ baseURL: 'https://x/v1', model: 'fast', text: 'Hi.' }, {
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'bad key' }),
    }),
    /HTTP 401/,
  );
});

test('a gateway that ignores stream:true is read as one JSON answer', async () => {
  const result = await translateViaApi({
    baseURL: 'https://x/v1', model: 'fast', text: 'Hi.',
  }, {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      body: null,
      json: async () => ({ choices: [{ message: { content: ' 你好。' } }] }),
    }),
  });
  assert.equal(result.translation, '你好。');
});
