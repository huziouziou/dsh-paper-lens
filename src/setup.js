// One-click local model: find a server you already run, or download one into
// the plugin's own data directory and write the start script for it.
//
// Nothing here runs on its own: every network call starts from an explicit
// click in the settings panel, and everything downloaded stays inside
// ~/.dsh/storages/dsh-paper-lens/local/.

import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

export const MODEL_REPO = 'tencent/Hy-MT2-1.8B-GGUF';
export const MODEL_FILE = 'Hy-MT2-1.8B-Q4_K_M.gguf';
export const MODEL_URL = `https://hf-mirror.com/${MODEL_REPO}/resolve/main/${MODEL_FILE}`;
export const MODEL_URL_ALT = `https://huggingface.co/${MODEL_REPO}/resolve/main/${MODEL_FILE}`;
export const SERVER_BUILD = 'b12345';
export const SERVER_ZIP = `llama-${SERVER_BUILD}-bin-win-cpu-x64.zip`;
export const SERVER_URL = `https://github.com/ggml-org/llama.cpp/releases/download/${SERVER_BUILD}/${SERVER_ZIP}`;
export const SERVER_MIRRORS = [
  SERVER_URL,
  `https://gh-proxy.com/${SERVER_URL}`,
  `https://ghfast.top/${SERVER_URL}`,
];
export const DEFAULT_PORT = 8080;

/** Where downloaded files live: inside the plugin's own storage folder. */
export function localModelDir(env = {}) {
  const home = env.homedir ?? homedir();
  return join(home, '.dsh', 'storages', 'dsh-paper-lens', 'local');
}

function sizeOf(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** What is already on disk, without touching the network. */
export function readLocalFiles(dir) {
  const modelPath = join(dir, MODEL_FILE);
  const scriptPath = join(dir, process.platform === 'win32' ? 'start-llama.bat' : 'start-llama.sh');
  const serverPath = findServer(dir);
  return {
    dir,
    model: { path: modelPath, ok: sizeOf(modelPath) > 0, bytes: sizeOf(modelPath) },
    server: { path: serverPath ?? '', ok: Boolean(serverPath), bytes: serverPath ? sizeOf(serverPath) : 0 },
    script: { path: scriptPath, ok: existsSync(scriptPath) },
  };
}

/** llama-server.exe may sit at the top of the unpacked folder or one level down. */
export function findServer(dir) {
  if (!existsSync(dir)) return null;
  const name = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const stack = [dir];
  const seen = new Set();
  while (stack.length) {
    const current = stack.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isFile() && entry.name === name) return path;
      // Keep the search shallow: the zip has bin/, build/bin/ and a few dlls.
      if (entry.isDirectory() && seen.size < 40) stack.push(path);
    }
  }
  return null;
}

const SCRIPT_EXTRA = '-c 8192 -t 8 --alias hy-mt';

/** The start command the plugin runs; also the thing a user can run by hand. */
export function buildStartScript({ serverPath, modelPath, port = DEFAULT_PORT }) {
  if (process.platform === 'win32') {
    return [
      '@echo off',
      'rem Started by dsh-paper-lens. Safe to run by hand too.',
      `"${serverPath}" -m "${modelPath}" --host 127.0.0.1 --port ${port} ${SCRIPT_EXTRA}`,
      '',
    ].join('\r\n');
  }
  return [
    '#!/bin/sh',
    '# Started by dsh-paper-lens. Safe to run by hand too.',
    `exec "${serverPath}" -m "${modelPath}" --host 127.0.0.1 --port ${port} ${SCRIPT_EXTRA}`,
    '',
  ].join('\n');
}

export function writeStartScript(dir, files) {
  const scriptPath = files?.script?.path ?? join(dir, process.platform === 'win32' ? 'start-llama.bat' : 'start-llama.sh');
  mkdirSync(dir, { recursive: true });
  writeFileSync(scriptPath, buildStartScript({ serverPath: files.server.path, modelPath: files.model.path }), 'utf8');
  return scriptPath;
}

/** Ports where a local OpenAI-compatible server usually lives. */
export const KNOWN_SERVERS = [
  { port: 8080, name: 'llama.cpp' },
  { port: 1234, name: 'LM Studio' },
  { port: 11434, name: 'Ollama' },
  { port: 8000, name: 'vLLM / SGLang' },
  { port: 30000, name: 'SGLang' },
];

/**
 * Ask each well-known port for its model list. A hit means the user already
 * has something running, which is always better than downloading 1.1 GB.
 */
export async function probeLocalServers(env = {}) {
  const fetchImpl = env.fetchImpl ?? fetch;
  const timeout = env.timeoutMs ?? 1200;
  const hits = await Promise.all(
    KNOWN_SERVERS.map(async ({ port, name }) => {
      const baseURL = `http://127.0.0.1:${port}/v1`;
      try {
        const response = await fetchImpl(`${baseURL}/models`, { signal: AbortSignal.timeout(timeout) });
        if (!response.ok) return null;
        const body = await response.json().catch(() => ({}));
        const models = Array.isArray(body?.data) ? body.data.map((item) => item?.id).filter(Boolean) : [];
        return { port, name, baseURL, models };
      } catch {
        return null;
      }
    }),
  );
  return hits.filter(Boolean);
}

/** The settings the panel should save, given what we found. */
export function presetFor({ files, hits = [], port = DEFAULT_PORT }) {
  const running = hits.find((hit) => hit.models.length > 0);
  if (running) {
    return {
      ready: true,
      source: 'running',
      engine: 'api',
      baseURL: running.baseURL,
      model: running.models[0],
      localCommand: '',
      localAutoStart: false,
      note: `本机已有 ${running.name} 在 ${running.baseURL} 运行，模型 ${running.models[0]}；不用下载，也不用自动启动。`,
    };
  }
  if (files?.server?.ok && files?.model?.ok) {
    return {
      ready: true,
      source: 'managed',
      engine: 'api',
      baseURL: `http://127.0.0.1:${port}/v1`,
      model: 'hy-mt',
      localCommand: files.script?.ok ? files.script.path : '',
      localAutoStart: true,
      note: `已找到本机的 llama-server 与 ${MODEL_FILE}，翻译时会自动拉起，空闲十分钟后关掉。`,
    };
  }
  return {
    ready: false,
    source: null,
    engine: 'api',
    baseURL: `http://127.0.0.1:${port}/v1`,
    model: 'hy-mt',
    localCommand: '',
    localAutoStart: true,
    note: `还没有本地模型：可以下载 ${MODEL_FILE}（约 1.1 GB）与 llama.cpp（约 24 MB），也可以自己起一个 OpenAI 兼容服务。`,
  };
}

/** Progress of the background download, polled by the settings panel. */
let downloadState = { phase: 'idle', received: 0, total: 0, message: '', error: '', files: null };
let downloadAbort = null;

export function localDownloadState() {
  return { ...downloadState };
}

export function cancelLocalDownload() {
  downloadAbort?.abort();
  downloadAbort = null;
}

async function fetchToFile(url, dest, { onProgress, signal, label }) {
  const partial = sizeOf(dest);
  const headers = partial > 0 ? { range: `bytes=${partial}-` } : {};
  const response = await fetch(url, { headers, signal });
  if (response.status === 416) return { bytes: partial, skipped: true };
  if (!response.ok) {
    throw new Error(`${label}下载失败：HTTP ${response.status}（${url}）`);
  }
  const totalHeader = response.headers.get('content-range')?.split('/')?.[1];
  const total = Number(totalHeader ?? response.headers.get('content-length') ?? 0) || 0;
  let received = partial;
  const stream = createWriteStream(dest, { flags: partial > 0 ? 'a' : 'w' });
  try {
    for await (const chunk of response.body) {
      received += chunk.length;
      onProgress(received, total);
      if (!stream.write(chunk)) await new Promise((resolve) => stream.once('drain', resolve));
    }
  } finally {
    await new Promise((resolve) => stream.end(resolve));
  }
  return { bytes: received, total };
}

async function unpack(zipPath, dir, signal) {
  mkdirSync(dir, { recursive: true });
  const args = ['-xf', zipPath, '-C', dir];
  await new Promise((resolve, reject) => {
    const child = spawn('tar', args, { stdio: 'ignore', windowsHide: true });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`解压失败（tar 退出码 ${code}）`))));
    signal?.addEventListener('abort', () => child.kill(), { once: true });
  });
}

/**
 * Download model + server into the plugin folder, then write the start script.
 * Runs in the background; the panel polls localDownloadState().
 */
export async function startLocalDownload(env = {}) {
  if (downloadState.phase === 'model' || downloadState.phase === 'server' || downloadState.phase === 'unpack') {
    return localDownloadState();
  }
  const dir = env.dir ?? localModelDir(env);
  mkdirSync(dir, { recursive: true });
  const modelPath = join(dir, MODEL_FILE);
  const zipPath = join(dir, SERVER_ZIP);
  downloadState = { phase: 'model', received: 0, total: 0, message: '下载模型…', error: '', files: null };
  downloadAbort = new AbortController();
  const signal = downloadAbort.signal;
  const report = (received, total) => {
    downloadState = { ...downloadState, received, total };
  };
  try {
    if (process.platform !== 'win32') {
      throw new Error('一键下载目前只支持 Windows；其他系统请用系统包管理器装 llama.cpp，再把它的可执行文件填进「启动命令」。');
    }
    if (!existsSync(modelPath) || sizeOf(modelPath) < 1024) {
      const urls = [MODEL_URL, MODEL_URL_ALT];
      let lastError = null;
      for (const url of urls) {
        try {
          await fetchToFile(url, modelPath, { onProgress: report, signal, label: '模型' });
          lastError = null;
          break;
        } catch (error) {
          if (signal.aborted) throw error;
          lastError = error;
        }
      }
      if (lastError) throw lastError;
    }
    downloadState = { ...downloadState, phase: 'server', received: 0, total: 0, message: '下载 llama.cpp…' };
    const serverFound = findServer(dir);
    if (!serverFound) {
      let lastError = null;
      for (const url of SERVER_MIRRORS) {
        try {
          await fetchToFile(url, zipPath, { onProgress: report, signal, label: 'llama.cpp' });
          lastError = null;
          break;
        } catch (error) {
          if (signal.aborted) throw error;
          lastError = error;
        }
      }
      if (lastError) throw lastError;
      downloadState = { ...downloadState, phase: 'unpack', message: '解压 llama.cpp…' };
      await unpack(zipPath, dir, signal);
      try {
        unlinkSync(zipPath);
      } catch {
        /* the zip is just clutter; leaving it is harmless */
      }
    }
    const files = readLocalFiles(dir);
    if (!files.server.ok) throw new Error('解压后没有找到 llama-server 可执行文件，请手动下载 llama.cpp 解压到 ' + dir);
    if (!files.model.ok) throw new Error('模型文件不完整，请重试');
    const scriptPath = writeStartScript(dir, files);
    files.script = { path: scriptPath, ok: true };
    downloadState = { phase: 'done', received: 0, total: 0, message: '下载完成，已写好启动脚本。', error: '', files };
    return localDownloadState();
  } catch (error) {
    const aborted = signal.aborted;
    downloadState = {
      ...downloadState,
      phase: aborted ? 'idle' : 'error',
      message: aborted ? '已取消。' : downloadState.message,
      error: aborted ? '' : String(error?.message ?? error),
    };
    return localDownloadState();
  } finally {
    downloadAbort = null;
  }
}
