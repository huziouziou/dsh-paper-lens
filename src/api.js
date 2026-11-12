// dsh-paper-lens — the optional "bring your own API" translation engine.
//
// The default path routes through the host's llm service and therefore the
// credentials of the chat you are in. This module is the escape hatch: an
// OpenAI-compatible /chat/completions endpoint the reader configures in the
// settings panel (for example a local model, or a fast non-reasoning model the
// host does not have). It is only used when the engine is explicitly set to
// "api"; nothing here runs otherwise.

import { translatePrompt } from './index.js';

/** The endpoint to POST to: a base URL, or a full /chat/completions URL. */
export function chatCompletionsUrl(baseURL) {
  const base = String(baseURL ?? '').trim().replace(/\/+$/, '');
  if (!base) return '';
  return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
}

/**
 * Translate one passage through an OpenAI-compatible streaming endpoint.
 *
 * Returns the same shape as translateText(): { translation, finishReason,
 * truncated }. Deltas go out through onDelta as they arrive so the bubble keeps
 * streaming; only `choices[].delta.content` is shown, never reasoning.
 */
export async function translateViaApi(options, env = {}) {
  const {
    baseURL, apiKey, model, text, maxTokens, onDelta, signal,
  } = options;
  const fetchImpl = env.fetchImpl ?? fetch;
  const url = chatCompletionsUrl(baseURL);
  if (!url) throw new Error('自定义 API 还没有填地址');
  if (!model) throw new Error('自定义 API 还没有填模型名');

  const headers = { 'content-type': 'application/json', accept: 'text/event-stream' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      stream: true,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: translatePrompt(String(text ?? '')) }],
    }),
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`自定义 API 返回 HTTP ${response.status}${detail ? `：${detail.slice(0, 200)}` : ''}`);
  }

  const type = response.headers?.get?.('content-type') ?? '';
  // Some gateways ignore stream:true and answer with one JSON object.
  if (!/event-stream/i.test(type) || !response.body) {
    const data = await response.json().catch(() => null);
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('自定义 API 没有返回译文');
    onDelta?.(content);
    return { translation: content.trim(), finishReason: 'stop', truncated: false };
  }

  let translation = '';
  let finishReason = '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const handleLine = (line) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      return;
    }
    if (chunk?.error) {
      const message = typeof chunk.error === 'string' ? chunk.error : (chunk.error?.message ?? '自定义 API 出错');
      throw new Error(message);
    }
    const choice = chunk?.choices?.[0];
    const piece = choice?.delta?.content;
    if (typeof piece === 'string' && piece) {
      translation += piece;
      onDelta?.(piece);
    }
    if (choice?.finish_reason) finishReason = String(choice.finish_reason);
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      handleLine(buffer.slice(0, nl).trim());
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
    }
  }
  if (buffer.trim()) handleLine(buffer.trim());

  return {
    translation: translation.trim(),
    finishReason,
    truncated: /length|max[-_]?tokens/i.test(finishReason),
  };
}
