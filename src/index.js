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

import { addMark, MARK_COLORS, pdfExists, readMarks, removeMark, resolvePdfPath, updateMarkNote } from './marks.js';
import { translateViaApi } from './api.js';
import { promptsForConfig } from './prompts.js';

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

/** The three ways a translation can find a model. */
export const TRANSLATE_ENGINES = ['session', 'model', 'api'];

/** 译文的目标语言；写进提示词，也写进缓存键（换语言不能复用旧译文）。 */
export const TARGET_LANGS = [
  ['zh-Hans', '简体中文'],
  ['zh-Hant', '繁體中文'],
  ['en', 'English'],
  ['ja', '日本語'],
  ['ko', '한국어'],
  ['de', 'Deutsch'],
  ['fr', 'Français'],
  ['es', 'Español'],
  ['ru', 'Русский'],
  ['ar', 'العربية'],
];
export const DEFAULT_TARGET_LANG = 'zh-Hans';
const LANG_LABELS = new Map(TARGET_LANGS);

/** 推理强度：auto 沿用插件配置（`translateReasoning`），其余显式下发。 */
export const REASONING_LEVELS = ['auto', 'off', 'low', 'medium', 'high'];

export function normalizeTargetLang(value) {
  const lang = String(value ?? '').trim();
  return LANG_LABELS.has(lang) ? lang : DEFAULT_TARGET_LANG;
}

/** The stored shape; anything malformed falls back to following the chat. */
export function normalizeTranslateSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const text = (value) => (typeof value === 'string' ? value.trim() : '');
  return {
    engine: TRANSLATE_ENGINES.includes(src.engine) ? src.engine : 'session',
    provider: text(src.provider),
    model: text(src.model),
    baseURL: text(src.baseURL),
    apiKey: typeof src.apiKey === 'string' ? src.apiKey : '',
    targetLang: normalizeTargetLang(src.targetLang),
    reasoning: REASONING_LEVELS.includes(src.reasoning) ? src.reasoning : 'auto',
  };
}

/** What the client may see: the key never leaves the host after it is saved. */
export function publicTranslateSettings(settings) {
  const safe = normalizeTranslateSettings(settings);
  return {
    engine: safe.engine,
    provider: safe.provider,
    model: safe.model,
    baseURL: safe.baseURL,
    hasKey: Boolean(safe.apiKey),
    targetLang: safe.targetLang,
    reasoning: safe.reasoning,
  };
}

/** Which chats have citation links on, and the optional translation engine. */
export function createModeStore(file = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'storages', 'dsh-paper-lens.json')) {
  let state = { citeLinks: {}, translate: normalizeTranslateSettings() };
  // The plugin was called dsh-pdf-ask before 0.2.0: its file (next to this
  // one) is read when this one does not exist yet, so chats keep their setting.
  for (const candidate of [file, join(dirname(file), 'dsh-pdf-ask.json')]) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8'));
      if (parsed && typeof parsed.citeLinks === 'object') {
        state = { ...parsed, translate: normalizeTranslateSettings(parsed.translate) };
        break;
      }
    } catch { /* not there: try the next, or start fresh */ }
  }
  const persist = () => {
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(state, null, 2));
    } catch { /* the change still holds for this run */ }
  };
  return {
    file,
    isOn: (sessionId) => state.citeLinks[sessionId] === true,
    set(sessionId, on) {
      if (on) state.citeLinks[sessionId] = true;
      else delete state.citeLinks[sessionId];
      persist();
    },
    translate: () => ({ ...state.translate }),
    saveTranslate(patch) {
      state.translate = normalizeTranslateSettings({ ...state.translate, ...(patch ?? {}) });
      persist();
      return { ...state.translate };
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

/** 同选区缓存的上限（条）；只存已成功、非空的译文。 */
export const TRANSLATE_CACHE_MAX = 48;

/**
 * 一次翻译的 token 上限。不要把 4096 无条件塞给每个短句：有些适配器会按上限
 * 预留/调度，短文本反而慢。按中文字符数估一个够用的值，并保留 512 的下限。
 */
export function translationMaxTokens(text, cap = 4096) {
  return Math.min(cap, Math.max(512, Math.ceil(String(text ?? '').length * 1.6)));
}

/**
 * 按空行切段，供长选区并行翻译。单段返回 []，调用方走原来的整段路径。
 * 选区来自 PDF 文本层，很多时候只有单换行；那种情况不硬拆，避免把一句话切碎。
 */
export function splitParagraphs(text) {
  const parts = String(text ?? '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return parts.length > 1 ? parts : [];
}

/** 把 N 段并成至多 max 组，保持原顺序；组内仍用空行分隔。 */
export function groupParagraphs(parts, max = 3) {
  if (parts.length <= max) return [...parts];
  const groups = Math.min(max, parts.length);
  const base = Math.floor(parts.length / groups);
  const extra = parts.length % groups;
  const out = [];
  let at = 0;
  for (let g = 0; g < groups; g += 1) {
    const size = base + (g < extra ? 1 : 0);
    out.push(parts.slice(at, at + size).join('\n\n'));
    at += size;
  }
  return out;
}

/** 同选区缓存的键：模型、目标语言与原文都算进去，换任何一个都不复用旧译文。 */
export function translateCacheKey(selection, text, targetLang = DEFAULT_TARGET_LANG) {
  return `${selection?.provider ?? ''}/${selection?.model ?? ''}\n${normalizeTargetLang(targetLang)}\n${text}`;
}


/**
 * 翻译的提示词：只要译文。
 *
 * 只输出译文本身——不解释、不重复原文、不加引号，这样气泡里除了译文没有别的东西。
 * 公式与变量名要求原样保留，因为 PDF 文本层里的公式本来就是残缺的（`$F_\\theta$` 常只剩
 * `F`），再让模型"顺手翻译"只会更糟。
 */
export function translatePrompt(text, style = 'full', target = DEFAULT_TARGET_LANG) {
  const lang = LANG_LABELS.get(normalizeTargetLang(target)) ?? '简体中文';
  if (style === 'compact') {
    // MT models (and small local ones) follow a short text-first instruction
    // better: with the rule list in front they sometimes start by repeating it.
    return ['原文：', text, '', `请把上面的文本翻译成${lang}，只输出译文，不要解释。`].join('\n');
  }
  return [
    `把下面这段文本翻译成${lang}。`,
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
export async function translateText(llm, selection, text, { maxChars = MAX_TRANSLATE_CHARS, sessionId, onDelta, maxTokens, reasoningEffort = 'off', targetLang = DEFAULT_TARGET_LANG } = {}) {
  const clipped = String(text ?? '').slice(0, maxChars);
  let out = '';
  const chunkKinds = {};
  let finishReason = '';
  let failure = null;
  let emitted = false;

  const request = (extra = {}) => ({
    provider: selection.provider,
    model: selection.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: translatePrompt(clipped, 'full', targetLang) }] }],
    maxTokens: maxTokens ?? translationMaxTokens(clipped),
    ...(sessionId ? { sessionId } : {}),
    ...extra,
  });

  const handle = (chunk) => {
    const kind = String(chunk?.type ?? chunk?.kind ?? 'unknown');
    chunkKinds[kind] = (chunkKinds[kind] ?? 0) + 1;

    if (kind === 'text-delta' && typeof chunk.text === 'string') {
      out += chunk.text;
      if (chunk.text) { emitted = true; onDelta?.(chunk.text); }
    } else if (kind === 'block-end' && !out && chunk.block?.type === 'text' && typeof chunk.block.text === 'string') {
      out = chunk.block.text;
      if (out) { emitted = true; onDelta?.(out); }
    } else if (kind !== 'finish' && kind !== 'reasoning-delta' && !out && typeof chunk?.text === 'string') {
      // 兜底只针对未知分片：reasoning-delta 也带 text，但那是模型的思考过程，
      // 一旦被当成译文，气泡里就会出现在想什么而不是译出来的东西。
      out += chunk.text;
      if (chunk.text) { emitted = true; onDelta?.(chunk.text); }
    }

    if (kind === 'finish') {
      const reason = chunk.reason;
      finishReason = typeof reason === 'string' ? reason : String(reason?.kind ?? reason?.type ?? '');
    }
    if (chunk?.failure) failure = chunk.failure;
  };

  const run = async (extra) => {
    for await (const chunk of llm.stream(request(extra))) handle(chunk);
  };

  // 译文不需要思考：推理分片同样吃 maxTokens，真机上短段落常常只剩半句、长段落
  // 直接以 max-tokens 结束（一个文字分片都没有）。先按配置关掉推理。
  //
  // provider 拒绝某个 effort 有两种表现：抛 UNSUPPORTED_REASONING_EFFORT，或者干脆
  // 用 finish(reason: 'error') 收尾（实测 opencode-go 对 'off' 是后者）。两种都在
  // 「还没出过任何文字」时退回不带 effort 的调用，并把预算抬到 2048，免得再死在
  // max-tokens 上。配置写 `translateReasoning: false` 则直接走退路，不试探。
  //
  // 推理模型（flash 只有 low/high/max，没有 off）在 low 下仍可能把 2048 全花在
  // 思考上：返回 max-tokens 且一个字都没出。这时把预算翻倍再试一次；已经出过字
  // 的不重试，否则同一段译文会被推两遍。
  const reset = () => {
    out = '';
    finishReason = '';
    failure = null;
    for (const key of Object.keys(chunkKinds)) delete chunkKinds[key];
  };
  const budget = maxTokens ?? translationMaxTokens(clipped);
  const runClean = async (extra) => {
    reset();
    await run(extra);
    return { emitted, finishReason };
  };
  const effort = reasoningEffort === false ? '' : String(reasoningEffort ?? 'off').trim();
  let firstFailed = false;
  if (effort) {
    try {
      await run({ reasoningEffort: effort });
      firstFailed = !emitted && finishReason === 'error';
    } catch (error) {
      if (emitted || !isUnsupportedReasoningEffort(error)) throw error;
      firstFailed = true;
    }
    if (firstFailed) reset();
  }
  if (firstFailed || !effort) {
    await runClean({ maxTokens: Math.max(budget, 2048) });
  }
  if (!emitted && !failure && /max[-_]?tokens|length/i.test(finishReason)) {
    await runClean({ maxTokens: Math.min(8192, Math.max(budget, 2048) * 2) });
  }


  return {
    translation: out.trim(),
    chunkKinds,
    finishReason,
    failure,
    truncated: /max[-_]?tokens|length/i.test(String(finishReason)),
  };
}

/** Whether this error means the provider does not take `reasoningEffort: 'off'`. */
export function isUnsupportedReasoningEffort(error) {
  const code = String(error?.code ?? '');
  const message = String(error?.message ?? error ?? '');
  return code === 'UNSUPPORTED_REASONING_EFFORT' || /does not support reasoning effort/i.test(message);
}


/** 把失败原因拼成一行能查的说明：分片直方图 + 失败码 + 结束原因。 */
function translateFailureText(selection, result) {
  const kinds = Object.entries(result.chunkKinds ?? {}).map(([k, n]) => `${k}×${n}`).join('、') || '无分片';
  const code = result.failure?.code ?? '';
  const message = result.failure?.message ?? '';
  const status = result.failure?.status != null ? `HTTP ${result.failure.status}` : '';
  const why = [code && `失败码 ${code}`, status, message, result.finishReason && `结束原因 ${result.finishReason}`]
    .filter(Boolean).join('；') || '未给出结束原因';
  return `模型没有返回译文（模型 ${selection.provider}/${selection.model}；收到 ${kinds}；${why}）`;
}

/** 半截译文：显示已经译出的部分，但明确标出「被截断」，也别写进缓存。 */
function translateTruncatedText(result) {
  return `译文被截断（结束原因 ${result.finishReason || 'max-tokens'}）：模型在预算用尽前只译出一部分，上面的文字可能不完整。再点一次「译」重试，或缩小选区。`;
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
  /** provider/model + 原文 -> 译文；短时间重复划同一段不再等模型。 */
  const translateCache = new Map();
  const added = new WeakSet();

  const sessionIdOf = (agent) => String(agent?.session?.id ?? '');
  /**
   * The live agent for a session, whichever way this host version exposes it.
   *
   * The event name changed under us: dsh 0.2.2 emits `agent/created` and has no
   * `agent/session-start`, so a listener on the old name never ran — the
   * citation guide was never added and a PDF's relative path had no session
   * cwd to resolve against. The registry lookup is the safety net for sessions
   * that were already live before this plugin mounted.
   */
  const liveAgent = (sessionId) => {
    if (!sessionId) return undefined;
    return agentBySession.get(sessionId) ?? service(ctx, 'agents')?.get?.(sessionId) ?? undefined;
  };
  /** The session's workspace root, as dsh records it in the session header. */
  const cwdOf = (sessionId) => {
    if (!sessionId) return undefined;
    const agent = liveAgent(sessionId);
    const fromAgent = agent?.session?.header?.cwd ?? agent?.session?.cwd;
    if (fromAgent) return fromAgent;
    try {
      // A session can be live without an agent (opened, no turn yet).
      return service(ctx, 'sessions')?.get?.(sessionId)?.header?.cwd;
    } catch {
      return undefined;
    }
  };

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

  /** Keep the id -> agent/ctx maps current; returns false when the agent has no session. */
  const rememberAgent = (agent) => {
    const id = sessionIdOf(agent);
    const agentCtx = agent?.ctx;
    if (!id || !agentCtx) return false;
    agentsBySession.set(id, agentCtx);
    agentBySession.set(id, agent);
    return true;
  };

  const onAgentStarted = (payload) => {
    const agent = payload?.agent;
    const agentCtx = agent?.ctx;
    if (!agentCtx) return;
    rememberAgent(agent);
    if (added.has(agentCtx)) return;
    added.add(agentCtx);
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
  };

  // dsh 0.2.2 起是 agent/created（{ agent, source }）；0.2.1 及更早是
  // agent/session-start。两个都挂：挂一个当前版本不发的名字只是永远不触发。
  if (typeof ctx.on === 'function') {
    ctx.on('agent/created', onAgentStarted);
    ctx.on('agent/session-start', onAgentStarted);
  }

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

  // 客户端读预设提示词、批注颜色与翻译引擎设置。
  //   GET  → { prompts, markColors, translate }（translate 里不含 apiKey）
  //   POST { engine?, provider?, model?, baseURL?, apiKey? } → { translate }
  // apiKey 省略=保持不变；空串=清除。
  const configRoute = (web) => web.register({
    kind: 'exact',
    path: `${BASE}/config`,
    handler: async (req = {}, res) => {
      const method = (req.method || 'GET').toUpperCase();
      if (method === 'GET') {
        return sendJson(res, 200, {
          prompts: promptsForConfig(config),
          markColors: MARK_COLORS,
          translate: publicTranslateSettings(modes.translate()),
        });
      }
      if (method !== 'POST') return sendJson(res, 405, { error: '只支持 GET/POST' });
      const body = await readJson(req, 16 * 1024);
      if (!body || typeof body !== 'object') return sendJson(res, 400, { error: '请求体需要 JSON' });
      const patch = {};
      if ('engine' in body) {
        if (!TRANSLATE_ENGINES.includes(body.engine)) return sendJson(res, 400, { error: 'engine 只能是 session/model/api' });
        patch.engine = body.engine;
      }
      for (const key of ['provider', 'model', 'baseURL']) {
        if (key in body) {
          if (typeof body[key] !== 'string') return sendJson(res, 400, { error: `${key} 必须是字符串` });
          patch[key] = body[key];
        }
      }
      if ('apiKey' in body) {
        if (typeof body.apiKey !== 'string') return sendJson(res, 400, { error: 'apiKey 必须是字符串' });
        patch.apiKey = body.apiKey;
      }
      if ('targetLang' in body) {
        if (!TARGET_LANGS.some(([code]) => code === body.targetLang)) return sendJson(res, 400, { error: 'targetLang 不在支持列表里' });
        patch.targetLang = body.targetLang;
      }
      if ('reasoning' in body) {
        if (!REASONING_LEVELS.includes(body.reasoning)) return sendJson(res, 400, { error: 'reasoning 只能是 auto/off/low/medium/high' });
        patch.reasoning = body.reasoning;
      }
      const merged = normalizeTranslateSettings({ ...modes.translate(), ...patch });
      if (merged.engine === 'model' && (!merged.provider || !merged.model)) {
        return sendJson(res, 400, { error: '指定模型需要同时填 provider 和 model' });
      }
      if (merged.engine === 'api') {
        if (!/^https?:\/\//i.test(merged.baseURL)) return sendJson(res, 400, { error: '自定义 API 的地址要以 http:// 或 https:// 开头' });
        if (!merged.model) return sendJson(res, 400, { error: '自定义 API 需要模型名' });
      }
      const saved = modes.saveTranslate(merged);
      return sendJson(res, 200, { translate: publicTranslateSettings(saved) });
    },
  });

  // 批注：PDF 同级的 marks/<name>.marks.json。
  //   GET    ?session=…&path=…            → { marks }
  //   POST   { session, path, mark }      → { mark }
  //   PATCH  { session, path, id, note }  → { mark }（改文字批注；空串=清掉）
  //   DELETE ?session=…&path=…&id=…       → { ok: true }
  const marksRoute = (web) => web.register({
    kind: 'exact',
    path: `${BASE}/marks`,
    handler: async (req = {}, res) => {
      const method = (req.method || 'GET').toUpperCase();
      const url = new URL(req.url ?? '/', 'http://x');
      let body = null;
      if (method === 'POST' || method === 'PATCH') {
        body = await readJson(req, 128 * 1024);
        if (!body) return sendJson(res, 400, { error: '请求体需要 JSON' });
      }
      const session = typeof body?.session === 'string' ? body.session : (url.searchParams.get('session') ?? '');
      const path = typeof body?.path === 'string' ? body.path : (url.searchParams.get('path') ?? '');
      const pdfPath = resolvePdfPath(path, cwdOf(session));
      if (!pdfPath) {
        return sendJson(res, 400, session
          ? { error: 'PDF 路径缺失或越出会话工作区' }
          : { error: '缺少 session，无法解析 PDF 的相对路径' });
      }
      if (!pdfExists(pdfPath)) return sendJson(res, 404, { error: 'PDF 不在磁盘上（可能已移动或删除）' });
      if (method === 'GET') return sendJson(res, 200, { marks: readMarks(pdfPath) });
      if (method === 'POST') {
        try {
          const mark = addMark(pdfPath, body?.mark);
          if (!mark) return sendJson(res, 400, { error: '批注字段不完整：需要 pageIndex、rect、strokeColor、custom.quote' });
          return sendJson(res, 200, { mark });
        } catch (error) {
          return sendJson(res, 500, { error: `批注没保存：${error?.message ?? error}` });
        }
      }
      if (method === 'PATCH') {
        const id = typeof body?.id === 'string' ? body.id : (url.searchParams.get('id') ?? '');
        if (!id) return sendJson(res, 400, { error: '缺少 id' });
        if (typeof body?.note !== 'string') return sendJson(res, 400, { error: 'note 必须是字符串（空串表示清空）' });
        try {
          const mark = updateMarkNote(pdfPath, id, body.note);
          if (!mark) return sendJson(res, 404, { error: '没有这条批注' });
          return sendJson(res, 200, { mark });
        } catch (error) {
          return sendJson(res, 500, { error: `批注文字没保存：${error?.message ?? error}` });
        }
      }
      if (method === 'DELETE') {
        const id = typeof body?.id === 'string' ? body.id : (url.searchParams.get('id') ?? '');
        if (!id) return sendJson(res, 400, { error: '缺少 id' });
        try {
          if (!removeMark(pdfPath, id)) return sendJson(res, 404, { error: '没有这条批注' });
          return sendJson(res, 200, { ok: true });
        } catch (error) {
          return sendJson(res, 500, { error: `批注没删掉：${error?.message ?? error}` });
        }
      }
      return sendJson(res, 405, { error: '只支持 GET/POST/PATCH/DELETE' });
    },
  });

  if (config.routes !== false) {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (scope) => {
        scope.effect(() => configRoute(scope.webServer), 'dsh-paper-lens: config route');
        scope.effect(() => marksRoute(scope.webServer), 'dsh-paper-lens: marks route');
      });
    } else {
      const web = service(ctx, 'webServer');
      if (web?.register) {
        ctx.effect?.(() => configRoute(web), 'dsh-paper-lens: config route');
        ctx.effect?.(() => marksRoute(web), 'dsh-paper-lens: marks route');
      }
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
      const settings = modes.translate();
      const targetLang = normalizeTargetLang(settings.targetLang);
      // 「自动」沿用插件配置；其余档位由用户在设置里显式选择。
      const reasoningEffort = settings.reasoning === 'auto' ? config.translateReasoning : settings.reasoning;
      // 「自定义 API」是显式选择：不走宿主 llm，也不需要会话凭据。
      const usingApi = settings.engine === 'api' && Boolean(settings.baseURL && settings.model);
      const llm = scope.llm;
      if (!usingApi && typeof llm?.stream !== 'function') return sendJson(res, 503, { error: '模型服务不可用' });
      let selection = null;
      if (settings.engine === 'model' && settings.provider && settings.model) {
        // 显式指定模型：仍然走宿主 llm（因此凭证/代理/审计都在宿主里），只是换 provider/model。
        selection = { provider: settings.provider, model: settings.model };
      } else if (!usingApi) {
        // 否则问「这个会话实际路由到哪个模型」——和官方压缩调用同源（agent.session.requestHeader().config），
        // 它一定带着可用的凭据；应用默认值只作兜底。
        try {
          const routed = agentBySession.get(sessionId)?.session?.requestHeader?.()?.config;
          if (routed?.provider && routed?.model) selection = { provider: routed.provider, model: routed.model };
        } catch { /* 没有该会话时退回默认值 */ }
        selection ??= pickSelection(scope, config);
        if (!selection) {
          return sendJson(res, 503, { error: '没有可用的默认模型：请先在设置里选一个，或在插件配置里写 provider/model' });
        }
      }
      const identity = usingApi ? { provider: `api:${settings.baseURL}`, model: settings.model } : selection;
      // 流式：校验通过后就发头，之后一行一个 JSON 对象（NDJSON）：
      //   {"delta":"…"}  增量文字
      //   {"error":"…"}  失败（含分片直方图与失败码）
      //   {"done":true}  正常结束
      // 用 JSON 行而不是裸文本，因为译文里本来就有换行，裸文本没法区分"内容"与"结束"。
      const cacheKey = translateCacheKey(identity, text, targetLang);
      const cached = translateCache.get(cacheKey);
      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
        ...(cached ? { 'x-dpl-cache': 'hit' } : {}),
      });
      // 先把响应头推给客户端：fetch 不必等到模型首 token 才 resolve。
      res.flushHeaders?.();
      res.socket?.setNoDelay?.(true);
      const push = (payload) => {
        try { res.write(`${JSON.stringify(payload)}\n`); } catch { /* 客户端已断开 */ }
      };
      if (cached) {
        push({ delta: cached });
        push({ done: true });
        try { res.end(); } catch { /* 已经结束 */ }
        return undefined;
      }
      const remember = (translation) => {
        if (!translation) return;
        translateCache.set(cacheKey, translation);
        while (translateCache.size > TRANSLATE_CACHE_MAX) translateCache.delete(translateCache.keys().next().value);
      };
      /** One passage: the explicit API engine streams itself, everything else goes through the host. */
      const runTranslation = (part, onDelta) => {
        const maxTokens = translationMaxTokens(part);
        if (usingApi) {
          return translateViaApi({
            baseURL: settings.baseURL,
            apiKey: settings.apiKey,
            model: settings.model,
            text: part,
            maxTokens,
            targetLang,
            onDelta,
          });
        }
        return translateText(llm, selection, part, {
          sessionId,
          maxTokens,
          reasoningEffort,
          targetLang,
          onDelta,
        });
      };
      try {
        // 多段长选区：各段并行请求，第一段仍实时出字，其余段到了按顺序补。
        // 单段不再切片：实测该模型每个请求都有数秒推理启动开销，三片并行反而更慢
        // （1500 字：首字 6.0s / 整段 39.4s，对比整段单次 8.0s / 11.1s），故退回整段。
        const paragraphs = splitParagraphs(text);
        const groups = paragraphs.length >= 2 && text.length >= 300 ? groupParagraphs(paragraphs, 3) : [];
        if (groups.length >= 2) {
          const buffers = groups.map(() => '');
          const tasks = groups.map((part, i) => runTranslation(part, i === 0 ? (delta) => push({ delta }) : (delta) => { buffers[i] += delta; }));
          const first = await tasks[0];
          if (!first.translation) {
            push({ error: translateFailureText(identity, first) });
          } else if (first.truncated) {
            // 半截译文不写缓存，但已经流到气泡里的文字要留住：给一行 warning 收尾，
            // 让气泡显示「已显示的部分 + 被截断」而不是把看到的一半再抹掉。
            push({ done: true, warning: translateTruncatedText(first) });
          } else {
            let combined = first.translation;
            let warning = null;
            for (let i = 1; i < groups.length; i += 1) {
              const result = await tasks[i];
              if (!result.translation) {
                push({ error: translateFailureText(identity, result) });
                combined = '';
                break;
              }
              if (result.truncated) {
                warning = translateTruncatedText(result);
                break;
              }
              push({ delta: `\n\n${result.translation}` });
              combined += `\n\n${result.translation}`;
            }
            if (warning) push({ done: true, warning });
            else if (combined) {
              remember(combined);
              push({ done: true });
            }
          }
        } else {
          const result = await runTranslation(text, (delta) => push({ delta }));
          if (!result.translation) push({ error: translateFailureText(identity, result) });
          else if (result.truncated) push({ done: true, warning: translateTruncatedText(result) });
          else {
            remember(result.translation);
            push({ done: true });
          }
        }
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
