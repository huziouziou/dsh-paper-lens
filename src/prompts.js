// dsh-paper-lens — preset prompts and display defaults shared by both halves.
//
// The selection toolbar has one 「引用」 button. The old four buttons (引用 /
// 提问 / 解释 / 挑错) all inserted the same quote; only the trailing prompt
// differed. Presets are now optional: they sit behind the caret (or a long
// press) and their text can be replaced from the plugin config.

/** Built-in presets. Keep ids stable: a config can override just the prompt. */
export const DEFAULT_PROMPTS = Object.freeze([
  Object.freeze({ id: 'ask', label: '提问', title: '就这段提问——光标停在「问题：」后面', prompt: '问题：' }),
  Object.freeze({
    id: 'explain',
    label: '解释',
    title: '解释这段在讲什么',
    prompt: '解释这段：它说了什么，为什么在这篇论文里重要。',
  }),
  Object.freeze({
    id: 'check',
    label: '挑错',
    title: '检查这段有无错误与无依据的说法',
    prompt: '检查这段：每个说法是否有论文依据、是否与论文其他地方一致、表述是否清楚？列出具体问题和改法。',
  }),
]);

const MAX_PROMPTS = 8;
const MAX_PROMPT_CHARS = 2000;

function cleanPrompt(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  const prompt = String(raw.prompt ?? '').trim().slice(0, MAX_PROMPT_CHARS);
  if (!prompt) return null;
  const id = String(raw.id ?? `preset-${index + 1}`).trim().slice(0, 40) || `preset-${index + 1}`;
  const label = String(raw.label ?? id).trim().slice(0, 20) || id;
  const title = String(raw.title ?? `带「${label}」提示词引用`).trim().slice(0, 120);
  return { id, label, title, prompt };
}

/**
 * Normalize `config.prompts`.
 *
 * - omitted → the built-in presets;
 * - an array → exactly those entries (an empty array turns presets off);
 * - an object map (`{ ask: '问题：' }` or `{ ask: { label, prompt } }`) → entries in key order.
 *
 * Invalid entries are dropped rather than falling back to the defaults: a
 * typo in one preset should not silently restore all three old buttons.
 */
export function normalizePrompts(input) {
  if (input === undefined) return DEFAULT_PROMPTS.map((p) => ({ ...p }));
  let list;
  if (Array.isArray(input)) list = input;
  else if (input && typeof input === 'object') {
    list = Object.entries(input).map(([id, value]) => (typeof value === 'string' ? { id, prompt: value } : { id, ...(value ?? {}) }));
  } else list = [];
  const out = [];
  for (const [index, raw] of list.slice(0, MAX_PROMPTS).entries()) {
    const cleaned = cleanPrompt(raw, index);
    if (cleaned) out.push(cleaned);
  }
  return out;
}

/** Config route payload; also keeps the client from having to know the defaults. */
export function promptsForConfig(config = {}) {
  return normalizePrompts(config.prompts);
}
