// dsh-paper-lens — copying text from the reader.
//
// `navigator.clipboard.writeText` needs a secure context and can reject when
// the window is not focused, so there is an `execCommand('copy')` fallback that
// works from a temporary textarea. Both paths are injectable so the logic can
// be tested without a browser.

/**
 * Copy `text` to the clipboard.
 *
 * @param {string} text
 * @param {{ clip?: { writeText?: Function }, document?: Document }} env
 * @returns {Promise<boolean>} whether a copy path reported success
 */
export async function copyText(text, env = {}) {
  const value = String(text ?? '');
  if (!value) return false;
  const clip = env.clip ?? (typeof navigator === 'undefined' ? undefined : navigator.clipboard);
  if (typeof clip?.writeText === 'function') {
    try {
      await clip.writeText(value);
      return true;
    } catch { /* fall through to the textarea path */ }
  }
  const doc = env.document ?? (typeof document === 'undefined' ? undefined : document);
  if (!doc || typeof doc.execCommand !== 'function') return false;
  let area;
  try {
    area = doc.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    doc.body.appendChild(area);
    area.select();
    return doc.execCommand('copy') === true;
  } catch {
    return false;
  } finally {
    try { area?.remove(); } catch { /* the node may already be gone */ }
  }
}
