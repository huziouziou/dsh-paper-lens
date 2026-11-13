import { spawn } from 'node:child_process';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** True when the endpoint is this machine — only then may the plugin start it. */
export function isLocalBaseURL(baseURL) {
  try {
    const host = new URL(baseURL).hostname.replace(/^\[|\]$/g, '');
    return LOCAL_HOSTS.has(host);
  } catch {
    return false;
  }
}

/**
 * Starts a user-supplied local translation server on demand and stops it after
 * an idle period. The command is the user's own (a .bat, an .exe, anything the
 * shell can run); the plugin only knows its path and the health URL.
 */
export function createLocalRunner(env = {}) {
  const spawnImpl = env.spawnImpl ?? spawn;
  const fetchImpl = env.fetchImpl ?? fetch;
  const idleMs = env.idleMs ?? 10 * 60 * 1000;
  const pollMs = env.pollMs ?? 400;
  const readyMs = env.readyMs ?? 30 * 1000;
  let child = null;
  let timer = null;
  let pending = null;
  let lastError = null;

  async function healthy(baseURL) {
    try {
      const response = await fetchImpl(`${String(baseURL).replace(/\/+$/, '')}/models`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(1500),
      });
      return Boolean(response?.ok);
    } catch {
      return false;
    }
  }

  function armIdle() {
    clearTimeout(timer);
    timer = setTimeout(() => stop(), idleMs);
    timer?.unref?.();
  }

  function stop() {
    clearTimeout(timer);
    timer = null;
    const target = child;
    child = null;
    if (!target?.pid) return;
    try {
      if (process.platform === 'win32') {
        spawnImpl('taskkill', ['/PID', String(target.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } else {
        target.kill?.('SIGTERM');
      }
    } catch { /* already gone */ }
  }

  async function ensure({ baseURL, command, autoStart } = {}) {
    if (await healthy(baseURL)) {
      armIdle();
      return { ready: true, started: false };
    }
    if (!autoStart || !command) {
      return { ready: false, started: false, reason: '本地服务没有在运行，也没有配置自动启动' };
    }
    if (pending) return pending;
    pending = (async () => {
      lastError = null;
      try {
        child = spawnImpl(command, { shell: true, detached: true, stdio: 'ignore', windowsHide: true });
        child?.once?.('error', (error) => { lastError = error?.message ?? String(error); });
        child?.unref?.();
      } catch (error) {
        lastError = error?.message ?? String(error);
        return { ready: false, started: false, reason: `启动命令执行失败：${lastError}` };
      }
      const deadline = Date.now() + readyMs;
      while (Date.now() < deadline) {
        if (lastError) break;
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        if (await healthy(baseURL)) {
          armIdle();
          return { ready: true, started: true };
        }
      }
      const reason = lastError ?? `启动后 ${Math.round(readyMs / 1000)} 秒内没有响应`;
      stop();
      return { ready: false, started: true, reason };
    })().finally(() => { pending = null; });
    return pending;
  }

  return {
    ensure,
    stop,
    status: () => ({ running: Boolean(child), lastError }),
  };
}
