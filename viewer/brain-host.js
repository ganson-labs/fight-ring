// Main-thread side of a brain worker. The ring's rule is the same as in the sandbox: a tick that took longer
// than BRAIN_TICK_MS is dropped and the previous action repeats; no answer for HANG_MS — the brain is cut off.
export const BRAIN_TICK_MS = 5;
const HANG_MS = 3000;

export class BrainHost {
  constructor(url, label) {
    this.url = url;
    this.label = label;
    this.worker = null;
    this.seq = 0;
    this.pending = new Map();
    this.last = null;
    this.stats = { calls: 0, slow: 0, errors: 0, msMax: 0, msSum: 0, cut: false, lastError: '' };
  }

  async load() {
    this.worker = new Worker(new URL('./brain-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => {
      const cb = this.pending.get(e.data.id);
      if (cb) {
        this.pending.delete(e.data.id);
        cb(e.data);
      }
    };
    const r = await this.request({ type: 'load', url: `${this.url}?v=${Date.now()}` }, 15000);
    if (!r?.ok) throw new Error(`${this.label}: мозги не загрузились — ${r?.error || 'нет ответа'}`);
  }

  request(msg, timeout) {
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(undefined);
      }, timeout);
      this.pending.set(id, (v) => {
        clearTimeout(timer);
        resolve(v);
      });
      this.worker.postMessage({ ...msg, id });
    });
  }

  note(r) {
    if (r.error) {
      this.stats.errors++;
      this.stats.lastError = r.error;
      if (this.stats.errors <= 3) console.warn(`[${this.label}]`, r.error);
    }
  }

  async init(info) {
    const r = await this.request({ type: 'init', info }, 2000);
    if (r) this.note(r);
  }

  async tick(view) {
    if (this.stats.cut) return null;
    const r = await this.request({ type: 'tick', view }, HANG_MS);
    if (!r) {
      this.stats.cut = true;
      this.stats.lastError = `мозги не отвечали ${HANG_MS / 1000} с и отключены`;
      this.worker.terminate();
      return null;
    }
    const s = this.stats;
    s.calls++;
    s.msSum += r.ms;
    s.msMax = Math.max(s.msMax, r.ms);
    this.note(r);
    if (r.error) return (this.last = null);
    if (r.ms > BRAIN_TICK_MS) {
      s.slow++;
      return this.last;
    }
    return (this.last = r.action);
  }

  dispose() {
    this.worker?.terminate();
    this.pending.clear();
  }
}
