// 本地模型的一键配置：找已经跑着的服务、算预设、写启动脚本，以及扫端口。
//
// 不联网、不下载：下载要用真的网络与 1.1 GB 磁盘，只做手工验证；这里判定的是
// 「给定磁盘状态和探测结果，面板该填什么」。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildStartScript,
  findServer,
  MODEL_FILE,
  presetFor,
  probeLocalServers,
  readLocalFiles,
  writeStartScript,
} from '../src/setup.js';

const serverName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dpl-setup-'));
}

test('a local server that is already running wins over downloading anything', () => {
  const preset = presetFor({
    files: { server: { ok: false }, model: { ok: false }, script: { ok: false } },
    hits: [{ name: 'LM Studio', baseURL: 'http://127.0.0.1:1234/v1', models: ['qwen2.5-7b'] }],
  });
  assert.equal(preset.ready, true);
  assert.equal(preset.engine, 'api');
  assert.equal(preset.baseURL, 'http://127.0.0.1:1234/v1');
  assert.equal(preset.model, 'qwen2.5-7b');
  assert.equal(preset.localCommand, '');
  assert.equal(preset.localAutoStart, false);
  assert.match(preset.note, /LM Studio/);
});

test('downloaded files produce a preset with the start script and auto start', () => {
  const preset = presetFor({
    files: {
      server: { ok: true, path: 'C:\\p\\llama-server.exe' },
      model: { ok: true, path: 'C:\\p\\model.gguf' },
      script: { ok: true, path: 'C:\\p\\start-llama.bat' },
    },
  });
  assert.equal(preset.ready, true);
  assert.equal(preset.baseURL, 'http://127.0.0.1:8080/v1');
  assert.equal(preset.model, 'hy-mt');
  assert.equal(preset.localCommand, 'C:\\p\\start-llama.bat');
  assert.equal(preset.localAutoStart, true);
});

test('nothing on disk and nothing running says what to download', () => {
  const preset = presetFor({ files: { server: { ok: false }, model: { ok: false }, script: { ok: false } } });
  assert.equal(preset.ready, false);
  assert.equal(preset.engine, 'api');
  assert.match(preset.note, /1\.1 GB/);
});

test('the start script carries the server, the model and the port', () => {
  const script = buildStartScript({ serverPath: 'C:\\p\\llama-server.exe', modelPath: 'C:\\p\\m.gguf', port: 9090 });
  assert.match(script, /llama-server\.exe/);
  assert.match(script, /m\.gguf/);
  assert.match(script, /--port 9090/);
  assert.match(script, /--alias hy-mt/);
  assert.match(script, /127\.0\.0\.1/);
});

test('llama-server is found even when the zip unpacked into a sub folder', () => {
  const dir = tempDir();
  try {
    mkdirSync(join(dir, 'build', 'bin'), { recursive: true });
    writeFileSync(join(dir, 'build', 'bin', serverName), 'x');
    assert.equal(findServer(dir), join(dir, 'build', 'bin', serverName));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readLocalFiles reports what is already there, and writeStartScript fills the gap', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, MODEL_FILE), 'x'.repeat(64));
    writeFileSync(join(dir, serverName), 'y');
    const before = readLocalFiles(dir);
    assert.equal(before.model.ok, true);
    assert.equal(before.server.ok, true);
    assert.equal(before.script.ok, false);

    const scriptPath = writeStartScript(dir, before);
    assert.equal(scriptPath, before.script.path);
    const after = readLocalFiles(dir);
    assert.equal(after.script.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('probing only reports ports that answer with a model list', async () => {
  const asked = [];
  const hits = await probeLocalServers({
    fetchImpl: async (url) => {
      asked.push(url);
      if (url.includes(':1234')) return { ok: true, json: async () => ({ data: [{ id: 'local-7b' }] }) };
      throw new Error('ECONNREFUSED');
    },
  });
  assert.deepEqual(hits, [{ port: 1234, name: 'LM Studio', baseURL: 'http://127.0.0.1:1234/v1', models: ['local-7b'] }]);
  assert.equal(asked.length, 5);
});

test('a port that answers without models is not offered as a preset', () => {
  const preset = presetFor({
    files: { server: { ok: false }, model: { ok: false }, script: { ok: false } },
    hits: [{ name: 'Ollama', baseURL: 'http://127.0.0.1:11434/v1', models: [] }],
  });
  assert.equal(preset.ready, false);
});
