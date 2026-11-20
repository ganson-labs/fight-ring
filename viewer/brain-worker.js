// Runs one fighter's brain in isolation. The brain never sees the engine, the other brain or the page.
// On the site this file is served with a policy of its own (judge/site.js → _headers): no address to talk to, no
// code from a string, no workers of its own. An action is a handful of short fields: a longer answer is not passed on.
let brain = null;
const ACTION_MAX = 4000;
const describe = (err) => String((err && err.stack) || err).slice(0, 2000);

self.onmessage = async ({ data: m }) => {
  if (m.type === 'load') {
    try {
      const mod = await import(m.url);
      brain = mod.default ?? mod;
      self.postMessage({ id: m.id, ok: typeof brain?.tick === 'function' });
    } catch (err) {
      self.postMessage({ id: m.id, ok: false, error: describe(err) });
    }
    return;
  }
  const t0 = performance.now();
  let value = null;
  let error = null;
  try {
    value = m.type === 'init' ? brain?.init?.(m.info) : brain.tick(m.view);
  } catch (err) {
    error = describe(err);
  }
  let action = null;
  if (m.type === 'tick') {
    try {
      const text = value && typeof value === 'object' ? JSON.stringify(value) : null;
      action = text && text.length <= ACTION_MAX ? JSON.parse(text) : null;
    } catch {
      action = null;
    }
  }
  self.postMessage({ id: m.id, action, ms: performance.now() - t0, error });
};
