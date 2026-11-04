// dsh-paper-lens — host half: teach each chat how to point at a place in a PDF,
// and `/cite-links` to make a chat do it on every answer.
//
// The PDF view, selection toolbar and links are the browser half
// (lib/client.js). This half adds text to each chat's system prompt:
//
//  - always: a short guide to the citation format the browser turns into links
//      [main.pdf "exact words"]   [main.pdf p.7 "exact words"]   [p.7]
//  - with `/cite-links on`: a standing instruction to back every statement
//    about the paper with such a link, for that chat only, until
//    `/cite-links off`. Saved, so a chat keeps its setting across restarts.
//
// Both are plain text, not a tool: the model writes the citation in its reply
// and the browser does the rest. Toggling changes that chat's system prompt
// once, at the toggle; the cached prompt prefix is unaffected otherwise.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const name = 'dsh-paper-lens';
export const inject = [];

/** After the built-in sections; memory-recall uses 9500, so these sit just before it. */
export const SECTION_ORDER = 9400;
export const SECTION_NAME = 'dsh-paper-lens';
export const MODE_SECTION_NAME = 'dsh-paper-lens:cite-links';

export const CITATION_GUIDE = [
  '# Pointing at places in PDFs',
  '',
  'The chat turns PDF citations into links that open the PDF and highlight the spot. When you refer to a place in a PDF in this workspace — a passage you discuss, or text you just changed in the LaTeX source — cite it like this:',
  '',
  '- `[main.pdf "exact words from that spot"]` — the page is found for you. Use this after editing LaTeX: you usually do not know the page.',
  '- `[main.pdf p.7 "exact words from that spot"]` — when you know the page.',
  '- `[p.7]` — a page of the PDF the user is reading.',
  '',
  'Rules: copy 4–12 consecutive words exactly as they read in the compiled PDF — prose, not LaTeX (no commands, no `$…$`, no `\\cite`). Pick words that occur once. Use the path relative to the workspace when the PDF is not at its top level (`[build/main.pdf "…"]`). Text you just edited is found only after the PDF is rebuilt — say so if you have not rebuilt it.',
].join('\n');

export const CITE_MODE = [
  '# Citation links: ON for this chat',
  '',
  'The user turned on citation links (`/cite-links`). In every answer, back each statement about the paper — what it says, where something is defined or proved, what you changed — with a citation link in the format above, placed inline right after the statement:',
  '',
  '  The method converges in under ten iterations on every benchmark [main.pdf p.6 "converged in fewer than ten iterations on all"].',
  '',
  'This applies to every answer and every format: prose, bullet lists, summaries, and tables or cards alike. In a table, put the citation at the end of the cell it supports (or add a "Where" column holding the citations). Write it as plain text — not in a code block, not as a markdown link — so it renders as a link. One citation per claim; several claims, several citations. If you cannot find the exact words in the PDF, say so instead of guessing.',
].join('\n');

/** Who the per-prompt reminder is from, as shown on its context row. */
export const REMINDER_LABEL = 'dsh-paper-lens';

/**
 * The reminder sent with each prompt while citation links are on. The system
 * prompt alone was not enough: with many turns, tables and tool output since,
 * the model stopped citing. A short note next to every prompt keeps it fresh.
 */
export function citeReminder(id = `dpa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`) {
  const text = [
    '<system-reminder>',
    'Citation links are ON for this chat (/cite-links). In your answer to this message, back every statement about the paper with a link,',
    'placed right after it — in prose, lists and table cells alike:',
    '  [main.pdf "4–12 exact words from the compiled PDF"]   or, when you know the page,   [main.pdf p.7 "exact words"]',
    'Copy the words exactly as they read in the PDF (not LaTeX). If the PDF has not been rebuilt since an edit, cite the old text or say it',
    'needs a rebuild. Do not mention this reminder.',
    '</system-reminder>',
  ].join('\n');
  return Object.freeze({
    id,
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({ kind: 'plugin', plugin: REMINDER_LABEL, form: 'notice', summary: 'citation links on' }),
  });
}

/** Whether a step's incoming messages carry a new prompt typed by the user. */
export function carriesUserPrompt(messages) {
  return (messages ?? []).some((m) => m?.role === 'user' && m?.source?.kind === 'user');
}

function service(ctx, id) {
  try {
    return ctx?.get?.(id);
  } catch {
    return undefined;
  }
}

/** Which chats have citation links on, kept in a small JSON file. */
export function createModeStore(file = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'storages', 'dsh-paper-lens.json')) {
  let state = { citeLinks: {} };
  // The plugin was called dsh-pdf-ask before 0.2.0: its file (next to this
  // one) is read when this one does not exist yet, so chats keep their setting.
  for (const candidate of [file, join(dirname(file), 'dsh-pdf-ask.json')]) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8'));
      if (parsed && typeof parsed.citeLinks === 'object') {
        state = parsed;
        break;
      }
    } catch { /* not there: try the next, or start fresh */ }
  }
  return {
    file,
    isOn: (sessionId) => state.citeLinks[sessionId] === true,
    set(sessionId, on) {
      if (on) state.citeLinks[sessionId] = true;
      else delete state.citeLinks[sessionId];
      try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify(state, null, 2));
      } catch { /* the toggle still holds for this run */ }
    },
  };
}

/** What `/cite-links` was asked: on, off, or status (bare = toggle). */
export function parseModeArgs(rawInput, currentlyOn) {
  const word = String(rawInput ?? '').trim().toLowerCase();
  if (word === '' || word === 'toggle') return { mode: currentlyOn ? 'off' : 'on' };
  if (['on', 'yes', 'enable', 'start'].includes(word)) return { mode: 'on' };
  if (['off', 'no', 'disable', 'stop'].includes(word)) return { mode: 'off' };
  if (['status', '?'].includes(word)) return { mode: 'status' };
  return { mode: 'unknown', word };
}

export const BASE = '/plugin-data/dsh-paper-lens';

/** 划词翻译一次能送出的最大字符数（服务端与客户端共用同一条上限）。 */
export const MAX_TRANSLATE_CHARS = 6000;

/**
 * 翻译的提示词：只要译文。
 *
 * 只输出译文本身——不解释、不重复原文、不加引号，这样气泡里除了译文没有别的东西。
 * 公式与变量名要求原样保留，因为 PDF 文本层里的公式本来就是残缺的（`$F_\\theta$` 常只剩
 * `F`），再让模型"顺手翻译"只会更糟。
 */
export function translatePrompt(text) {
  return [
    '把下面这段英文翻译成简体中文。',
    '',
    '规则：',
    '1. 只输出译文本身。不要前言、不要解释、不要重复原文、不要加引号或代码块。',
    '2. 公式、变量名、数字、单位、文献编号、专有名词保持原样，不要翻译或改写。',
    '3. 实在没有通用译名的术语，在译文里保留英文原词，不要加括号注释。',
    '4. 原文分段就分段，不要合并成一大段。',
    '',
    '原文：',
    text,
  ].join('\n');
}

/** 取这次翻译该用的 provider/model：显式配置优先，否则用应用当前默认模型。 */
export function pickSelection(scope, config = {}) {
  if (config.provider && config.model) return { provider: config.provider, model: config.model };
  const defaults = service(scope, 'agentDefaultModel') ?? service(scope, 'agent-default-model');
  try {
    const selection = defaults?.currentSelection?.();
    if (selection?.provider && selection?.model) return selection;
  } catch { /* fall through to "no model" */ }
  return null;
}

/**
 * 跑一次翻译，边收边通过 `onDelta` 推出去；返回汇总。
 *
 * 界面是流式的（边出边看），所以正常路径下 `out` 只是给调用方核对用的；
 * 只有「模型没给出任何文字」时才用它判断失败。
 */
export async function translateText(llm, selection, text, { maxChars = MAX_TRANSLATE_CHARS, sessionId, onDelta } = {}) {
  const clipped = String(text ?? '').slice(0, maxChars);
  let out = '';
  const chunkKinds = {};
  let finishReason = '';
  let failure = null;

  for await (const chunk of llm.stream({
    provider: selection.provider,
    model: selection.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: translatePrompt(clipped) }] }],
    maxTokens: 4096,
    ...(sessionId ? { sessionId } : {}),
  })) {
    const kind = String(chunk?.type ?? chunk?.kind ?? 'unknown');
    chunkKinds[kind] = (chunkKinds[kind] ?? 0) + 1;

    if (kind === 'text-delta' && typeof chunk.text === 'string') {
      out += chunk.text;
      if (chunk.text) onDelta?.(chunk.text);
    } else if (kind === 'block-end' && !out && chunk.block?.type === 'text' && typeof chunk.block.text === 'string') {
      out = chunk.block.text;
      if (out) onDelta?.(out);
    } else if (kind !== 'finish' && kind !== 'reasoning-delta' && !out && typeof chunk?.text === 'string') {
      // 兜底只针对未知分片：reasoning-delta 也带 text，但那是模型的思考过程，
      // 一旦被当成译文，气泡里就会出现在想什么而不是译出来的东西。
      out += chunk.text;
      if (chunk.text) onDelta?.(chunk.text);
    }

    if (kind === 'finish') {
      const reason = chunk.reason;
      finishReason = typeof reason === 'string' ? reason : String(reason?.kind ?? reason?.type ?? '');
    }
    if (chunk?.failure) failure = chunk.failure;
  }

  return { translation: out.trim(), chunkKinds, finishReason, failure };
}

/** 把失败原因拼成一行能查的说明：分片直方图 + 失败码 + 结束原因。 */
function translateFailureText(selection, result) {
  const kinds = Object.entries(result.chunkKinds).map(([k, n]) => `${k}×${n}`).join('、') || '无分片';
  const code = result.failure?.code ?? '';
  const message = result.failure?.message ?? '';
  const status = result.failure?.status != null ? `HTTP ${result.failure.status}` : '';
  const why = [code && `失败码 ${code}`, status, message, result.finishReason && `结束原因 ${result.finishReason}`]
    .filter(Boolean).join('；') || '未给出结束原因';
  return `模型没有返回译文（模型 ${selection.provider}/${selection.model}；收到 ${kinds}；${why}）`;
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

async function readJson(req, limit = 4096) {
  let text = '';
  for await (const chunk of req ?? []) {
    text += chunk;
    if (text.length > limit) return null;
  }
  if (!text) return {};
  try { return JSON.parse(text); } catch { return null; }
}

export function apply(ctx, config = {}) {
  const modes = config.modeStore ?? createModeStore(config.stateFile);
  /** agent ctx -> disposer of its citation-mode section, while on. */
  const modeSections = new Map();
  /** session id -> that chat's agent ctx, so the chat-bar chip can toggle it. */
  const agentsBySession = new Map();
  /** session id -> that chat's agent，用来读它实际路由到的 provider/model。 */
  const agentBySession = new Map();
  const added = new WeakSet();

  const sessionIdOf = (agent) => String(agent?.session?.id ?? '');

  function setModeSection(agentCtx, on) {
    const prompt = service(agentCtx, 'systemPrompt');
    if (typeof prompt?.section !== 'function') return false;
    const current = modeSections.get(agentCtx);
    if (on && !current) {
      const dispose = prompt.section({ name: MODE_SECTION_NAME, order: SECTION_ORDER + 1, text: CITE_MODE });
      modeSections.set(agentCtx, typeof dispose === 'function' ? dispose : () => {});
    } else if (!on && current) {
      try { current(); } catch { /* already gone */ }
      modeSections.delete(agentCtx);
    }
    return true;
  }

  ctx.on?.('agent/session-start', (payload) => {
    const agent = payload?.agent;
    const agentCtx = agent?.ctx;
    if (!agentCtx || added.has(agentCtx)) return;
    added.add(agentCtx);
    agentsBySession.set(sessionIdOf(agent), agentCtx);
    agentBySession.set(sessionIdOf(agent), agent);
    try {
      const prompt = service(agentCtx, 'systemPrompt');
      if (typeof prompt?.section !== 'function') return;
      // Fixed text, registered once per chat, so the cached prompt prefix holds.
      const register = () => prompt.section({ name: SECTION_NAME, order: SECTION_ORDER, text: CITATION_GUIDE });
      if (typeof agentCtx.effect === 'function') agentCtx.effect(register, 'dsh-paper-lens: citation guide');
      else register();
      // A chat that had citation links on before a restart keeps them.
      if (modes.isOn(sessionIdOf(agent))) setModeSection(agentCtx, true);
    } catch (error) {
      ctx.logger?.warn?.(`dsh-paper-lens: citation guide not added to this chat: ${error?.message ?? error}`);
    }
  });

  // With citation links on, every prompt the user sends goes in with a short
  // reminder beside it. Only on the step that carries the user's own new
  // message, so a turn with many tool steps gets it once, not per step.
  ctx.on?.('agent/pre-step', async (payload, next) => {
    const decision = await next();
    const agent = payload?.agent;
    if (!decision || decision.kind === 'reject' || !agent?.session) return decision;
    try {
      if (!modes.isOn(sessionIdOf(agent))) return decision;
      const messages = decision.messages ?? [];
      if (!carriesUserPrompt(messages)) return decision;
      if (messages.some((m) => m?.source?.plugin === REMINDER_LABEL)) return decision;
      return { ...decision, messages: [...messages, citeReminder()] };
    } catch (error) {
      ctx.logger?.warn?.(`dsh-paper-lens: citation reminder not added: ${error?.message ?? error}`);
      return decision;
    }
  });

  /** Turn a chat's mode on or off: saved, and applied to its prompt if it is live. */
  function toggle(sessionId, on) {
    modes.set(sessionId, on);
    const agentCtx = agentsBySession.get(sessionId);
    return agentCtx ? setModeSection(agentCtx, on) : true; // a cold chat picks it up when it starts
  }

  // The chat-bar chip reads and flips the mode through these.
  //   GET  /plugin-data/dsh-paper-lens/cite-links?session=…   → { on }
  //   POST /plugin-data/dsh-paper-lens/cite-links  { session, on } → { on }
  const routes = (web) => web.register({
    kind: 'exact',
    path: `${BASE}/cite-links`,
    handler: async (req = {}, res) => {
      const method = (req.method || 'GET').toUpperCase();
      if (method === 'GET') {
        const session = new URL(req.url ?? '/', 'http://x').searchParams.get('session');
        if (!session) return sendJson(res, 400, { error: 'missing session' });
        return sendJson(res, 200, { on: modes.isOn(session) });
      }
      if (method === 'POST') {
        const body = await readJson(req);
        if (!body || typeof body.session !== 'string' || typeof body.on !== 'boolean') {
          return sendJson(res, 400, { error: 'body must be { session, on }' });
        }
        toggle(body.session, body.on);
        return sendJson(res, 200, { on: modes.isOn(body.session) });
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    },
  });
  if (config.routes !== false) {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (scope) => {
        scope.effect(() => routes(scope.webServer), 'dsh-paper-lens: cite-links route');
      });
    } else {
      const web = service(ctx, 'webServer');
      if (web?.register) ctx.effect?.(() => routes(web), 'dsh-paper-lens: cite-links route');
    }
  }

  // 划词翻译：POST { text } → NDJSON 流（{delta} / {error} / {done}）。
  // 这里硬依赖 llm 服务；没有它时这条路由不挂载，插件的引用/链接功能照常工作。
  const translateRoute = (scope) => scope.webServer.register({
    kind: 'exact',
    path: `${BASE}/translate`,
    handler: async (req = {}, res) => {
      if ((req.method || 'GET').toUpperCase() !== 'POST') {
        return sendJson(res, 405, { error: '只支持 POST' });
      }
      const body = await readJson(req, MAX_TRANSLATE_CHARS * 4);
      const text = typeof body?.text === 'string' ? body.text.trim() : '';
      const sessionId = typeof body?.session === 'string' && body.session ? body.session : undefined;
      if (!text) return sendJson(res, 400, { error: '请求体需要 { text }' });
      if (text.length > MAX_TRANSLATE_CHARS) {
        return sendJson(res, 413, { error: `文本过长，上限 ${MAX_TRANSLATE_CHARS} 字符` });
      }
      const llm = scope.llm;
      if (typeof llm?.stream !== 'function') return sendJson(res, 503, { error: '模型服务不可用' });
      // 先问「这个会话实际路由到哪个模型」——和官方压缩调用同源（agent.session.requestHeader().config），
      // 它一定带着可用的凭据；应用默认值只作兜底。
      let selection = null;
      try {
        const routed = agentBySession.get(sessionId)?.session?.requestHeader?.()?.config;
        if (routed?.provider && routed?.model) selection = { provider: routed.provider, model: routed.model };
      } catch { /* 没有该会话时退回默认值 */ }
      selection ??= pickSelection(scope, config);
      if (!selection) {
        return sendJson(res, 503, { error: '没有可用的默认模型：请先在设置里选一个，或在插件配置里写 provider/model' });
      }
      // 流式：校验通过后就发头，之后一行一个 JSON 对象（NDJSON）：
      //   {"delta":"…"}  增量文字
      //   {"error":"…"}  失败（含分片直方图与失败码）
      //   {"done":true}  正常结束
      // 用 JSON 行而不是裸文本，因为译文里本来就有换行，裸文本没法区分"内容"与"结束"。
      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
      });
      const push = (payload) => {
        try { res.write(`${JSON.stringify(payload)}\n`); } catch { /* 客户端已断开 */ }
      };
      try {
        const result = await translateText(llm, selection, text, {
          sessionId,
          onDelta: (delta) => push({ delta }),
        });
        if (!result.translation) push({ error: translateFailureText(selection, result) });
        else push({ done: true });
      } catch (error) {
        push({ error: `翻译失败：${error?.message ?? error}` });
      } finally {
        try { res.end(); } catch { /* 已经结束 */ }
      }
      return undefined;
    },
  });
  if (config.routes !== false && typeof ctx.inject === 'function') {
    ctx.inject(['webServer', 'llm'], (scope) => {
      scope.effect(() => translateRoute(scope), 'dsh-paper-lens: translate route');
    });
  }

  // `/cite-links`. Soft-injected like graft's `/graft`: a profile without the
  // command runtime still gets the guide and the links.
  const command = {
    name: 'cite-links',
    description: '让本会话把关于论文的每条论断都链到 PDF（[main.pdf "exact words"]）。用法：/cite-links [on|off|status]',
    handler: async (invocation) => {
      const agent = invocation?.agent;
      const sessionId = sessionIdOf(agent);
      if (!sessionId) return { kind: 'error', text: '/cite-links：没有可作用的会话。' };
      const was = modes.isOn(sessionId);
      const args = parseModeArgs(invocation.rawInput, was);
      if (args.mode === 'unknown') return { kind: 'error', text: `/cite-links：无法识别 "${args.word}"——请用 on、off 或 status。` };
      if (args.mode === 'status') {
        return { kind: 'success', text: was ? '本会话的引用链接：已开启。' : '本会话的引用链接：已关闭。输入 /cite-links on 可开启。' };
      }
      const on = args.mode === 'on';
      agentsBySession.set(sessionId, agent.ctx);
      modes.set(sessionId, on);
      const applied = setModeSection(agent.ctx, on);
      if (!applied) return { kind: 'error', text: '/cite-links：本会话没有可改的系统提示词。' };
      return {
        kind: 'success',
        text: on
          ? '本会话引用链接已开启：回答会用 [main.pdf "exact words"] 这样的链接把关于论文的论断链到原文，点开即可跳到该处。输入 /cite-links off 可关闭。'
          : '本会话引用链接已关闭。你明确要求时模型仍会加链接。',
      };
    },
  };
  if (config.command !== false) {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['commands'], (scope) => {
        scope.effect(() => scope.commands.register(command), 'dsh-paper-lens: /cite-links');
      });
    } else {
      const commands = service(ctx, 'commands');
      if (commands?.register) ctx.effect?.(() => commands.register(command), 'dsh-paper-lens: /cite-links');
    }
  }
}

export default { apply, inject, name };
