import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PREFS, FONT_RANGE, THEMES, WIDTH_RANGE, PREFS_KEY, loadPrefs, normalizePrefs, savePrefs } from '../src/client/prefs.js';

function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, value),
  };
}

test('display preferences clamp to the supported ranges', () => {
  assert.deepEqual(normalizePrefs({ fontSize: 99, bubbleWidth: 10 }), { theme: 'auto', fontSize: FONT_RANGE.max, bubbleWidth: WIDTH_RANGE.min });
  assert.deepEqual(normalizePrefs({ fontSize: 'bad', bubbleWidth: null }), { ...DEFAULT_PREFS });
  assert.deepEqual(normalizePrefs({ fontSize: 15.7, bubbleWidth: 500 }), { theme: 'auto', fontSize: 16, bubbleWidth: 500 });
});

test('the reader theme is one of auto / light / dark, junk falls back to auto', () => {
  assert.deepEqual(THEMES, ['auto', 'light', 'dark']);
  assert.equal(normalizePrefs({ theme: 'dark' }).theme, 'dark');
  assert.equal(normalizePrefs({ theme: 'light' }).theme, 'light');
  assert.equal(normalizePrefs({ theme: 'neon' }).theme, 'auto');
  assert.equal(normalizePrefs({}).theme, 'auto');
});

test('a saved choice round-trips through storage', () => {
  const storage = fakeStorage();
  const saved = savePrefs({ theme: 'dark', fontSize: 17, bubbleWidth: 520 }, storage);
  assert.deepEqual(saved, { theme: 'dark', fontSize: 17, bubbleWidth: 520 });
  assert.deepEqual(loadPrefs(storage), { theme: 'dark', fontSize: 17, bubbleWidth: 520 });
  assert.ok(storage.getItem(PREFS_KEY));
});

test('preferences saved before the theme existed still load', () => {
  const storage = fakeStorage({ [PREFS_KEY]: JSON.stringify({ fontSize: 18, bubbleWidth: 600 }) });
  assert.deepEqual(loadPrefs(storage), { theme: 'auto', fontSize: 18, bubbleWidth: 600 });
});

test('corrupt or missing storage falls back to the defaults', () => {
  assert.deepEqual(loadPrefs(fakeStorage({ [PREFS_KEY]: '{not json' })), { ...DEFAULT_PREFS });
  assert.deepEqual(loadPrefs(fakeStorage()), { ...DEFAULT_PREFS });
  assert.deepEqual(loadPrefs(undefined), { ...DEFAULT_PREFS });
});
