import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PREFS, FONT_RANGE, WIDTH_RANGE, PREFS_KEY, loadPrefs, normalizePrefs, savePrefs } from '../src/client/prefs.js';

function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, value),
  };
}

test('display preferences clamp to the supported ranges', () => {
  assert.deepEqual(normalizePrefs({ fontSize: 99, bubbleWidth: 10 }), { fontSize: FONT_RANGE.max, bubbleWidth: WIDTH_RANGE.min });
  assert.deepEqual(normalizePrefs({ fontSize: 'bad', bubbleWidth: null }), { ...DEFAULT_PREFS });
  assert.deepEqual(normalizePrefs({ fontSize: 15.7, bubbleWidth: 500 }), { fontSize: 16, bubbleWidth: 500 });
});

test('a saved choice round-trips through storage', () => {
  const storage = fakeStorage();
  const saved = savePrefs({ fontSize: 17, bubbleWidth: 520 }, storage);
  assert.deepEqual(saved, { fontSize: 17, bubbleWidth: 520 });
  assert.deepEqual(loadPrefs(storage), { fontSize: 17, bubbleWidth: 520 });
  assert.ok(storage.getItem(PREFS_KEY));
});

test('corrupt or missing storage falls back to the defaults', () => {
  assert.deepEqual(loadPrefs(fakeStorage({ [PREFS_KEY]: '{not json' })), { ...DEFAULT_PREFS });
  assert.deepEqual(loadPrefs(fakeStorage()), { ...DEFAULT_PREFS });
  assert.deepEqual(loadPrefs(undefined), { ...DEFAULT_PREFS });
});
