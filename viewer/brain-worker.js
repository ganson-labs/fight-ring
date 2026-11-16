// Runs one fighter's brain in isolation. The brain never sees the engine, the other brain or the page.
let brain = null;
const describe = (err) => String((err && err.stack) || err);

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
      action = value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : null;
    } catch {
      action = null;
    }
  }
  self.postMessage({ id: m.id, action, ms: performance.now() - t0, error });
};
