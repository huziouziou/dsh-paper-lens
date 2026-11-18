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

function harness(stateFile, { defaultModel } = {}) {
  const routes = {};
  const ctx = {
    on: () => {},
    logger: {},
    get: (id) => (id === 'agentDefaultModel' && defaultModel ? { currentSelection: () => defaultModel } : undefined),
    inject: (_names, fn) => fn({
      effect: (f) => f(),
      get: (id) => (id === 'agentDefaultModel' && defaultModel ? { currentSelection: () => defaultModel } : undefined),
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
    engine: 'session', modelProvider: '', modelName: '', apiBaseURL: '', apiModel: '', apiKey: '', targetLang: 'zh-Hans', reasoning: 'auto', localCommand: '', localAutoStart: false,
  });
  const kept = normalizeTranslateSettings({
    engine: 'api', modelProvider: ' p ', modelName: ' n ', apiBaseURL: ' https://x/v1 ', apiModel: ' m ', apiKey: 'k', targetLang: 'ja', reasoning: 'high', localCommand: ' D:\\start.bat ', localAutoStart: true,
  });
  assert.deepEqual(kept, { engine: 'api', modelProvider: 'p', modelName: 'n', apiBaseURL: 'https://x/v1', apiModel: 'm', apiKey: 'k', targetLang: 'ja', reasoning: 'high', localCommand: 'D:\\start.bat', localAutoStart: true });
  assert.equal(normalizeTranslateSettings({ engine: 'nope', apiKey: 42 }).engine, 'session');
  assert.equal(normalizeTranslateSettings({ engine: 'nope', apiKey: 42 }).apiKey, '');
  assert.equal(normalizeTranslateSettings({ targetLang: 'klingon', reasoning: 'max' }).targetLang, 'zh-Hans');
  assert.equal(normalizeTranslateSettings({ targetLang: 'klingon', reasoning: 'max' }).reasoning, 'auto');
});

test('the two engines keep their own model, and an old single-model file is migrated', () => {
  // 0.5.4 及更早只有 provider/model/baseURL：带地址的是 API 那一套，不带地址的是指定模型。
  assert.deepEqual(
    normalizeTranslateSettings({ engine: 'model', provider: 'opencode-go', model: 'deepseek-v4.1-flash' }),
    { engine: 'model', modelProvider: 'opencode-go', modelName: 'deepseek-v4.1-flash', apiBaseURL: '', apiModel: '', apiKey: '', targetLang: 'zh-Hans', reasoning: 'auto', localCommand: '', localAutoStart: false },
  );
  assert.deepEqual(
    normalizeTranslateSettings({ engine: 'api', baseURL: 'http://127.0.0.1:8080/v1', model: 'hy-mt' }),
    { engine: 'api', modelProvider: '', modelName: '', apiBaseURL: 'http://127.0.0.1:8080/v1', apiModel: 'hy-mt', apiKey: '', targetLang: 'zh-Hans', reasoning: 'auto', localCommand: '', localAutoStart: false },
  );
  // 两套字段同时存在时各自保留，互不覆盖。
  const both = normalizeTranslateSettings({
    engine: 'model', modelProvider: 'opencode-go', modelName: 'claude-haiku-5-5', apiBaseURL: 'http://127.0.0.1:8080/v1', apiModel: 'hy-mt',
  });
  assert.equal(both.modelName, 'claude-haiku-5-5');
  assert.equal(both.apiModel, 'hy-mt');
});

test('the public view never carries the key, only whether one is saved', () => {
  const shown = publicTranslateSettings({ engine: 'api', apiBaseURL: 'https://x', apiModel: 'm', apiKey: 'secret' });
  assert.deepEqual(shown, {
    engine: 'api', modelProvider: '', modelName: '', apiBaseURL: 'https://x', apiModel: 'm', hasKey: true, targetLang: 'zh-Hans', reasoning: 'auto', localCommand: '', localAutoStart: false,
  });
  assert.equal('apiKey' in shown, false);
});

test('the config route saves the engine, hides the key, and keeps it when omitted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dpl-engine-'));
  try {
    const routes = harness(join(dir, 'state.json'));
    const route = routes[`${BASE}/config`];

    // 切到「指定模型」时字段可能还没填：允许先存下来，翻译时再报具体缺什么。
    const partial = await call(route, { method: 'POST', body: { engine: 'model', model: 'm' } });
    assert.equal(partial.status, 200);
    assert.equal(partial.json.translate.engine, 'model');
    assert.equal(partial.json.translate.modelName, 'm');

    const saved = await call(route, {
      method: 'POST',
      body: { engine: 'api', apiBaseURL: 'https://api.example.com/v1', apiModel: 'fast', apiKey: 'sk-local' },
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.json.translate, {
      engine: 'api', modelProvider: '', modelName: 'm', apiBaseURL: 'https://api.example.com/v1', apiModel: 'fast', hasKey: true, targetLang: 'zh-Hans', reasoning: 'auto', localCommand: '', localAutoStart: false,
    });
    assert.equal(saved.body.includes('sk-local'), false, 'the key never comes back');

    // 保存 API 那一套不会动「指定模型」的模型名。
    const pinned = await call(route, { method: 'POST', body: { modelProvider: 'opencode-go', modelName: 'claude-haiku-5-5' } });
    assert.equal(pinned.status, 200);
    assert.equal(pinned.json.translate.modelName, 'claude-haiku-5-5');
    assert.equal(pinned.json.translate.apiModel, 'fast');

    // Switching the engine without a key keeps the saved one.
    const switched = await call(route, { method: 'POST', body: { engine: 'session' } });
    assert.equal(switched.status, 200);
    assert.equal(switched.json.translate.hasKey, true);

    const listed = await call(route);
    assert.equal(listed.json.translate.engine, 'session');

    // An empty string is how the panel clears it.
    const cleared = await call(route, { method: 'POST', body: { apiKey: '' } });
    assert.equal(cleared.json.translate.hasKey, false);

    // A malformed address is still refused at save time.
    const wrongUrl = await call(route, { method: 'POST', body: { apiBaseURL: 'api.example.com' } });
    assert.equal(wrongUrl.status, 400);

    // The store on disk still follows normalization.
    assert.equal(createModeStore(join(dir, 'state.json')).translate().apiKey, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the config route saves the language and reasoning level, and rejects unknown ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dpl-lang-'));
  try {
    const routes = harness(join(dir, 'state.json'));
    const route = routes[`${BASE}/config`];

    assert.equal((await call(route, { method: 'POST', body: { targetLang: 'xx' } })).status, 400);
    assert.equal((await call(route, { method: 'POST', body: { reasoning: 'max' } })).status, 400);

    const saved = await call(route, { method: 'POST', body: { targetLang: 'ja', reasoning: 'high' } });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.translate.targetLang, 'ja');
    assert.equal(saved.json.translate.reasoning, 'high');

    const listed = await call(route);
    assert.equal(listed.json.translate.targetLang, 'ja');
    assert.equal(createModeStore(join(dir, 'state.json')).translate().reasoning, 'high');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the config route stores the local start command and its auto-start flag', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dpl-local-'));
  try {
    const routes = harness(join(dir, 'state.json'));
    const route = routes[`${BASE}/config`];

    assert.equal((await call(route, { method: 'POST', body: { localCommand: 42 } })).status, 400);
    assert.equal((await call(route, { method: 'POST', body: { localAutoStart: 'yes' } })).status, 400);

    const saved = await call(route, {
      method: 'POST',
      body: { localCommand: 'D:\\Models\\hy-mt\\start-llama.bat', localAutoStart: true },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.translate.localCommand, 'D:\\Models\\hy-mt\\start-llama.bat');
    assert.equal(saved.json.translate.localAutoStart, true);

    const listed = await call(route);
    assert.equal(listed.json.translate.localAutoStart, true);
    assert.equal(createModeStore(join(dir, 'state.json')).translate().localCommand.endsWith('start-llama.bat'), true);
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
    baseURL: 'https://x/v1', apiKey: 'k', model: 'fast', text: 'Hello.', maxTokens: 99, targetLang: 'ja',
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
  assert.match(bodies[0].messages[0].content, /翻译成日本語/);
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

test('the settings panel is told which model would actually be used', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dpl-resolved-'));
  try {
    const routes = harness(join(dir, 'state.json'), {
      defaultModel: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
    });
    const config = routes[`${BASE}/config`];

    const following = await call(config);
    assert.deepEqual(following.json.resolved, {
      engine: 'session',
      provider: 'opencode-go',
      model: 'deepseek-v4.1-flash',
      label: 'opencode-go / deepseek-v4.1-flash',
    });

    const pinned = await call(config, {
      method: 'POST',
      body: { engine: 'model', provider: 'opencode-go', model: 'claude-haiku-5-5' },
    });
    assert.equal(pinned.json.resolved.label, 'opencode-go / claude-haiku-5-5');

    const local = await call(config, {
      method: 'POST',
      body: { engine: 'api', model: 'hy-mt', baseURL: 'http://127.0.0.1:8080/v1' },
    });
    assert.equal(local.json.resolved.local, true);
    assert.equal(local.json.resolved.label, 'hy-mt @ http://127.0.0.1:8080/v1（本地）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
