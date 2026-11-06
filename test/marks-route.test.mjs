import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply, BASE } from '../src/index.js';

function harness(config = {}) {
  const routes = {};
  const ctx = {
    on: () => {},
    logger: {},
    inject: (names, fn) => fn({
      effect: (f) => f(),
      get: (id) => (id === 'agentDefaultModel'
        ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
        : undefined),
      webServer: { register: (r) => { routes[r.path] = r.handler; return () => {}; } },
      commands: { register: () => () => {} },
      llm: { stream: async function* () { yield { type: 'finish', reason: 'stop' }; } },
    }),
  };
  apply(ctx, { routes: true, stateFile: join(tmpdir(), `dpl-route-${Date.now()}.json`), ...config });
  return routes;
}

async function call(handler, { method = 'GET', url = '/', body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
  const req = { method, url, async* [Symbol.asyncIterator]() { for (const c of chunks) yield c; } };
  const out = { status: null, headers: null, body: '' };
  const res = {
    writeHead(status, headers) { out.status = status; out.headers = headers; },
    write() { return true; },
    end(text) { if (text) out.body += text; },
  };
  await handler(req, res);
  return { ...out, json: out.body ? JSON.parse(out.body) : null };
}

test('the config route returns the server presets and the mark palette', async () => {
  const routes = harness({ prompts: [{ id: 'sum', label: '总结', prompt: '用三句话总结。' }] });
  const out = await call(routes[`${BASE}/config`]);
  assert.equal(out.status, 200);
  assert.deepEqual(out.json.prompts.map((p) => p.label), ['总结']);
  assert.deepEqual(out.json.markColors, ['#f59e0b', '#ef4444', '#22c55e', '#3b82f6']);
});

test('marks: save, list and delete through the route, beside the PDF', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dpl-marks-route-'));
  try {
    const pdf = join(dir, 'main.pdf');
    writeFileSync(pdf, '%PDF-1.4\n');
    const routes = harness();
    const mark = {
      pageIndex: 0,
      rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.04 },
      segmentRects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.04 }],
      strokeColor: '#22c55e',
      custom: { quote: 'A sentence.' },
    };
    const created = await call(routes[`${BASE}/marks`], { method: 'POST', body: { path: pdf, mark } });
    assert.equal(created.status, 200);
    assert.match(created.json.mark.id, /^m-/);

    const listed = await call(routes[`${BASE}/marks`], { url: `${BASE}/marks?path=${encodeURIComponent(pdf)}` });
    assert.equal(listed.status, 200);
    assert.equal(listed.json.marks.length, 1);
    assert.equal(listed.json.marks[0].custom.quote, 'A sentence.');

    const deleted = await call(routes[`${BASE}/marks`], { method: 'DELETE', url: `${BASE}/marks?path=${encodeURIComponent(pdf)}&id=${created.json.mark.id}` });
    assert.equal(deleted.status, 200);
    const after = await call(routes[`${BASE}/marks`], { url: `${BASE}/marks?path=${encodeURIComponent(pdf)}` });
    assert.deepEqual(after.json.marks, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('marks: a relative path needs a session, and a bad mark is refused', async () => {
  const routes = harness();
  const noSession = await call(routes[`${BASE}/marks`], { url: `${BASE}/marks?path=papers/main.pdf` });
  assert.equal(noSession.status, 400);

  const dir = mkdtempSync(join(tmpdir(), 'dpl-marks-route-'));
  try {
    const pdf = join(dir, 'main.pdf');
    writeFileSync(pdf, '%PDF-1.4\n');
    const bad = await call(routes[`${BASE}/marks`], { method: 'POST', body: { path: pdf, mark: { pageIndex: 0 } } });
    assert.equal(bad.status, 400);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
