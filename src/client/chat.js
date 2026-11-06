// dsh-paper-lens — getting a PDF selection into the chat you are in, and reading
// [p.N] page citations back out of replies.
//
// The current chat is the Session Controller's current selection
// (ctx.sessions.list.getSnapshot().current). Its composer is reached through
// the conversation service's per-session input facade:
//   ctx.conversation.input.for(ctx.sessions.scope(id))
// whose state carries the live draft and whose setDraft() replaces it. A quote
// is appended under whatever is already typed, never over it.

/** How the model is asked to cite pages, so the citations become links. */
export const CITE_HINT = 'Cite places in the PDF as [file.pdf p.N "exact words"].';

/** Collapse a PDF text-layer selection into clean prose; keep paragraph breaks. */
export function cleanSelection(text) {
  return String(text ?? '')
    .replace(/­/g, '') // soft hyphens
    .replace(/\r\n?/g, '\n')
    .replace(/(\w)-\s*\n\s*(\w)/g, '$1$2') // words hyphenated across a line break
    .replace(/[ \t]*\n[ \t]*\n[ \t]*/g, '\u0000') // protect blank-line paragraphs
    .replace(/[ \t]*\n[ \t]*/g, ' ') // single line breaks are just layout
    .replace(/\u0000/g, '\n\n')
    .replace(/[ \t ]{2,}/g, ' ')
    .trim();
}

/**
 * The block a selection puts into the composer.
 *
 * `prompt` is optional: empty means a plain quote. A preset prompt comes from
 * the caret/long-press menu, whose entries are configurable in the plugin.
 */
export function formatQuote({ file, page, text, prompt = '' }) {
  const passage = cleanSelection(text);
  const where = page ? `${file} · p.${page}` : file;
  const quote = `> **${where}:** "${passage}"`;
  const trail = String(prompt ?? '').trim();
  if (!trail) return `${quote}\n\n(${CITE_HINT})\n\n`;
  return `${quote}\n\n(${CITE_HINT})\n\n${trail}\n`;
}

/** Append a block to an existing draft, leaving one blank line between them. */
export function appendToDraft(draft, block) {
  const head = String(draft ?? '').replace(/\s+$/, '');
  return head === '' ? block : `${head}\n\n${block}`;
}

function snapshotOf(store) {
  if (!store) return undefined;
  if (typeof store.getSnapshot === 'function') return store.getSnapshot();
  if (typeof store.get === 'function') return store.get();
  return store.value ?? store.current;
}

/**
 * Put a block into the current chat's composer.
 *
 * `sessions.list` has no selection at all on dsh 0.2.x, so a chat's top bar is the only
 * place that reliably knows which chat is open; the caller passes that id in as
 * `fallbackSessionId` (chip.js's lastSessionId). Without it, quoting from a PDF opened in
 * the Files tab always fails with "no chat to send this to".
 *
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function insertIntoChat(ctx, block, fallbackSessionId) {
  let sessions;
  let conversation;
  try {
    sessions = ctx.sessions;
    conversation = ctx.conversation;
  } catch {
    return { ok: false, reason: '聊天服务没能用上（插件未挂载）' };
  }
  const current = snapshotOf(sessions?.list)?.current ?? fallbackSessionId;
  if (!current) return { ok: false, reason: '先打开一个会话——现在没有可以发送的窗口' };
  const scope = sessions.scope?.(current);
  if (!scope) return { ok: false, reason: '当前会话还在加载，稍等一下再试' };
  let input;
  try {
    input = conversation.input.for(scope);
  } catch (error) {
    return { ok: false, reason: `连不上会话的输入框：${error?.message ?? error}` };
  }
  const state = snapshotOf(input.state);
  if (state && state.phase !== undefined && state.phase !== 'plain') {
    return { ok: false, reason: '输入框正在发送消息，等它发完再试' };
  }
  input.setDraft(appendToDraft(state?.draft, block));
  focusComposer();
  return { ok: true };
}

/** Put the caret at the end of the composer, best effort. */
export function focusComposer(doc = typeof document === 'undefined' ? undefined : document) {
  if (!doc) return;
  const editor = doc.querySelector('[data-lexical-editor="true"][contenteditable="true"]')
    ?? doc.querySelector('form [contenteditable="true"], [role="textbox"][contenteditable="true"]');
  if (!editor) return;
  setTimeout(() => {
    try {
      editor.focus();
      const range = doc.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      const selection = doc.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    } catch { /* focus is a nicety */ }
  }, 30);
}

/**
 * PDF citations in text. Every part is optional, but there must be a PDF or a
 * page, and nothing else may sit between the brackets:
 *   [p.17]  [pp.4-5]  [main.pdf p.9]  [main.pdf "exact words"]
 *   [build/main.pdf p.7 "exact words"]  [p.3, p.8]  [main.pdf · p.7: "words"]
 * Returns { index, length, page?, file?, quote? } per citation.
 */
export function findPageCitations(text) {
  const out = [];
  const outer = /\[([^[\]\n]{1,420})\]/g;
  let match;
  while ((match = outer.exec(text)) !== null) {
    const parsed = parseCitation(match[1]);
    if (parsed) out.push({ index: match.index, length: match[0].length, ...parsed });
  }
  return out;
}

const QUOTE = /["“”]([^"“”]{2,400})["“”]/;
const FILE = /^\s*([^\s"“”·,;:][^"“”·,;]*?\.pdf)(?=$|[\s·,;:])/i;
const PAGE = /\b(?:pp?|pages?)\.?\s?(\d{1,4})(?:\s*[-–]\s*\d{1,4})?/gi;
const SEPARATORS_ONLY = /^[\s·,;:–—-]*$/;

/** The parts of one citation's inside, or null when it is not a PDF citation. */
export function parseCitation(inner) {
  let rest = inner;
  let quote;
  const quoted = QUOTE.exec(rest);
  if (quoted) {
    quote = quoted[1].trim();
    rest = `${rest.slice(0, quoted.index)} ${rest.slice(quoted.index + quoted[0].length)}`;
  }
  let file;
  const named = FILE.exec(rest);
  if (named) {
    file = named[1].trim().replace(/\\/g, '/');
    rest = rest.slice(named.index + named[0].length);
  }
  const pages = [];
  rest = rest.replace(PAGE, (_m, n) => {
    pages.push(Number(n));
    return ' ';
  });
  // A bare number after a page in a list: [p.3, 8]
  if (pages.length) rest = rest.replace(/(^|[,;])\s*\d{1,4}(?=\s*($|[,;]))/g, '$1 ');
  // Nothing but separators may be left: otherwise this is ordinary bracketed prose.
  if (!SEPARATORS_ONLY.test(rest)) return null;
  const page = pages[0];
  if (!file && page === undefined) return null;
  if (page !== undefined && !(Number.isInteger(page) && page >= 1)) return null;
  return { ...(page !== undefined ? { page } : {}), ...(file ? { file } : {}), ...(quote ? { quote } : {}) };
}
