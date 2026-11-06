// dsh-paper-lens — the small set of display preferences a reader may want to
// change (theme, translation bubble width and font size). Kept in localStorage,
// so a choice survives restarts and applies to every PDF in this browser.

export const PREFS_KEY = 'dsh-paper-lens:ui';
export const DEFAULT_PREFS = Object.freeze({ theme: 'auto', fontSize: 13, bubbleWidth: 420 });
export const FONT_RANGE = Object.freeze({ min: 11, max: 20 });
export const WIDTH_RANGE = Object.freeze({ min: 280, max: 640 });
/** `auto` follows the app's own theme; the other two pin the reader's colours. */
export const THEMES = Object.freeze(['auto', 'light', 'dark']);

const clamp = (value, { min, max }, fallback) => {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
};

const theme = (value) => (THEMES.includes(value) ? value : DEFAULT_PREFS.theme);

/** Always a usable triple, even when storage held junk. */
export function normalizePrefs(raw) {
  return {
    theme: theme(raw?.theme),
    fontSize: clamp(raw?.fontSize, FONT_RANGE, DEFAULT_PREFS.fontSize),
    bubbleWidth: clamp(raw?.bubbleWidth, WIDTH_RANGE, DEFAULT_PREFS.bubbleWidth),
  };
}

function browserStorage(storage) {
  if (storage !== undefined) return storage;
  try { return globalThis.localStorage; } catch { return undefined; }
}

export function loadPrefs(storage) {
  try {
    const raw = browserStorage(storage)?.getItem(PREFS_KEY);
    return normalizePrefs(raw ? JSON.parse(raw) : undefined);
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(prefs, storage) {
  const clean = normalizePrefs(prefs);
  try { browserStorage(storage)?.setItem(PREFS_KEY, JSON.stringify(clean)); } catch { /* a preference is a nicety */ }
  return clean;
}
