// 本地翻译服务的按需启动：健康检查、拉起、空闲关闭。
//
// 这里不启动真的进程：fetch 与 spawn 都由测试注入，所以判定的是
// 「什么时候该拉、拉完等多久、什么情况算没起来、关的时候发给谁」。

import test from 'node:test';
import assert from 'node:assert/strict';

import { createLocalRunner, isLocalBaseURL } from '../src/local.js';

const healthyResponse = { ok: true };

function fakeChild(pid = 4242) {
  const child = {
    pid,
    killed: null,
    once() {},
    unref() {},
    kill(signal) { child.killed = signal; },
  };
  return child;
}

test('only this machine counts as local', () => {
  assert.equal(isLocalBaseURL('http://127.0.0.1:8080/v1'), true);
  assert.equal(isLocalBaseURL('http://localhost:8080/v1'), true);
  assert.equal(isLocalBaseURL('http://[::1]:8080/v1'), true);
  assert.equal(isLocalBaseURL('https://api.example.com/v1'), false);
  assert.equal(isLocalBaseURL('not a url'), false);
  assert.equal(isLocalBaseURL(''), false);
});

test('a healthy server is used as-is, without spawning anything', async () => {
  let spawned = 0;
  const runner = createLocalRunner({
    fetchImpl: async () => healthyResponse,
    spawnImpl: () => { spawned += 1; return fakeChild(); },
  });
  const result = await runner.ensure({ baseURL: 'http://127.0.0.1:8080/v1', command: 'start.bat', autoStart: true });
  assert.deepEqual(result, { ready: true, started: false });
  assert.equal(spawned, 0);
  runner.stop();
});

test('an unhealthy server is started and polled until it answers', async () => {
  let calls = 0;
  let spawned = 0;
  const runner = createLocalRunner({
    pollMs: 1,
    readyMs: 200,
    fetchImpl: async () => {
      calls += 1;
      return calls >= 3 ? healthyResponse : { ok: false };
    },
    spawnImpl: () => { spawned += 1; return fakeChild(); },
  });
  const result = await runner.ensure({ baseURL: 'http://127.0.0.1:8080/v1', command: 'start.bat', autoStart: true });
  assert.deepEqual(result, { ready: true, started: true });
  assert.equal(spawned, 1);
  assert.ok(calls >= 3);
  runner.stop();
});

test('without autoStart nothing is spawned and the reason says so', async () => {
  let spawned = 0;
  const runner = createLocalRunner({
    fetchImpl: async () => ({ ok: false }),
    spawnImpl: () => { spawned += 1; return fakeChild(); },
  });
  const result = await runner.ensure({ baseURL: 'http://127.0.0.1:8080/v1', command: 'start.bat', autoStart: false });
  assert.equal(result.ready, false);
  assert.equal(result.started, false);
  assert.match(result.reason, /自动启动/);
  assert.equal(spawned, 0);
});

test('a server that never answers is reported, not waited on forever', async () => {
  const runner = createLocalRunner({
    pollMs: 1,
    readyMs: 20,
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    spawnImpl: () => fakeChild(),
  });
  const result = await runner.ensure({ baseURL: 'http://127.0.0.1:8080/v1', command: 'start.bat', autoStart: true });
  assert.equal(result.ready, false);
  assert.equal(result.started, true);
  assert.match(result.reason, /没有响应/);
});

test('stop kills the whole process tree on Windows, or signals it elsewhere', async () => {
  const calls = [];
  const runner = createLocalRunner({
    fetchImpl: async () => ({ ok: false }),
    spawnImpl: (command, args) => { calls.push([command, args]); return fakeChild(4242); },
  });
  await runner.ensure({ baseURL: 'http://127.0.0.1:8080/v1', command: 'start.bat', autoStart: true });
  runner.stop();
  if (process.platform === 'win32') {
    assert.deepEqual(calls.at(-1), ['taskkill', ['/PID', '4242', '/T', '/F']]);
  } else {
    assert.equal(calls.length, 1);
  }
  assert.equal(runner.status().running, false);
});
