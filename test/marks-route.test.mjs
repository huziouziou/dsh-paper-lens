import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply, BASE } from '../src/index.js';

function harness(config = {}, services = {}) {
  const routes = {};
  const handlers = {};
  const ctx = {
    on: (name, fn) => { (handlers[name] ??= []).push(fn); },
    logger: {},
    get: (id) => services[id],
    inject: (names, fn) => fn({
      effect: (f) => f(),
      get: (id) => (id === 'agentDefaultModel'
        ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
        : services[id]),
      webServer: { register: (r) => { routes[r.path] = r.handler; return () => {}; } },
      commands: { register: () => () => {} },
      llm: { stream: async function* () { yield { type: 'finish', reason: 'stop' }; } },
    }),
  };
  apply(ctx, { routes: true, stateFile: join(tmpdir(), `dpl-route-${Date.now()}-${Math.random().toString(36).slice(2)}.json`), ...config });
  return { routes, handlers };
}

/** A live agent as the host exposes it: session id + workspace cwd. */
function liveAgent(id, cwd) {
  return { session: { id, header: { cwd } }, ctx: { get: () => undefined } };
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
  const { routes } = harness({ prompts: [{ id: 'sum', label: '总结', prompt: '用三句话总结。' }] });
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
    const { routes } = harness();
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
  const { routes } = harness();
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

test('a relative PDF path resolves against the live session cwd', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dpl-marks-cwd-'));
  try {
    writeFileSync(join(dir, 'main.pdf'), '%PDF-1.4\n');
    const mark = {
      pageIndex: 0,
      rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.04 },
      strokeColor: '#f59e0b',
      custom: { quote: 'Resolved beside the PDF.' },
    };
    // dsh 0.2.2: the session is live in the session store, so its header carries cwd.
    const sessions = { get: (id) => (id === 'session-1' ? { header: { cwd: dir } } : undefined) };
    const { routes } = harness({}, { sessions });
    const created = await call(routes[`${BASE}/marks`], {
      method: 'POST',
      body: { session: 'session-1', path: 'main.pdf', mark },
    });
    assert.equal(created.status, 200);
    const file = join(dir, 'marks', 'main.marks.json');
    assert.ok(existsSync(file), 'marks file lands beside the PDF');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).marks[0].custom.quote, 'Resolved beside the PDF.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the agent registry is enough when the session start event never fires', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dpl-marks-agent-'));
  try {
    writeFileSync(join(dir, 'main.pdf'), '%PDF-1.4\n');
    const agents = { get: (id) => (id === 'session-1' ? liveAgent('session-1', dir) : undefined) };
    const { routes } = harness({}, { agents });
    const listed = await call(routes[`${BASE}/marks`], { url: `${BASE}/marks?session=session-1&path=main.pdf` });
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.json.marks, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('agent/created is the event dsh 0.2.2 sends, so a chat keeps its cwd', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dpl-marks-event-'));
  try {
    writeFileSync(join(dir, 'main.pdf'), '%PDF-1.4\n');
    const { routes, handlers } = harness();
    // No registry at all: only the lifecycle event can teach the route this cwd.
    assert.equal(typeof handlers['agent/created']?.[0], 'function');
    await handlers['agent/created'][0]({ agent: liveAgent('session-2', dir), source: 'resume' });
    const listed = await call(routes[`${BASE}/marks`], { url: `${BASE}/marks?session=session-2&path=main.pdf` });
    assert.equal(listed.status, 200);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
