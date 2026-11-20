// Main-thread side of a brain worker. The ring's rule is the same as in the sandbox: a tick that took longer
// than BRAIN_TICK_MS is dropped and the previous action repeats; no answer for HANG_MS — the brain is cut off.
//
// The brain may be a stranger's (a fighter of the shared roster), so the worker is trusted with nothing: a brain that
// answers every tick just under HANG_MS would hold a fight for hours, one that posts messages in a loop would bury
// the page in them. Both are cut off. Slowness is counted twice: by the time the worker reports above the tick's
// limit (SLOW_MS in all), and by the page's own clock (LATE_MS in all above WAIT_OK a tick) for a brain that
// reports a time it did not take. Both limits are generous: on a busy machine the page stalls and a worker waits for
// a processor, and its own clock counts that wait (limits of 3 and 8 seconds cut off honest brains of the season on
// a loaded computer). A brain that only loses time is already handled: its slow turns are dropped one by one. Messages nobody asked for are counted
// too (STRAY). A brain that failed to load is terminated: a module that never returns would otherwise spin until
// the tab is closed.
export const BRAIN_TICK_MS = 5;
const HANG_MS = 3000;
const SLOW_MS = 20000;
const LATE_MS = 20000;
const WAIT_OK = 1000;
const STRAY = 100;
const short = (s) => String(s ?? '').slice(0, 600);

export class BrainHost {
  constructor(url, label) {
    this.url = url;
    this.label = label;
    this.worker = null;
    this.seq = 0;
    this.pending = new Map();
    this.last = null;
    this.late = 0;
    this.over = 0;
    this.stray = 0;
    this.gone = false;
    this.stats = { calls: 0, slow: 0, errors: 0, msMax: 0, msSum: 0, cut: false, lastError: '' };
  }

  async load() {
    this.worker = new Worker(new URL('./brain-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => {
      const cb = this.pending.get(e.data?.id);
      if (cb) {
        this.pending.delete(e.data.id);
        cb(e.data);
      } else if (++this.stray > STRAY) this.cut('мозги шлют сообщения, которых ринг не просил, и отключены');
    };
    this.worker.onerror = (e) => e.preventDefault?.();
    const r = await this.request({ type: 'load', url: `${this.url}?v=${Date.now()}` }, 15000);
    if (!r?.ok) {
      this.dispose();
      throw new Error(`${this.label}: мозги не загрузились — ${short(r?.error) || 'нет ответа'}`);
    }
  }

  cut(why) {
    if (this.stats.cut) return;
    this.stats.cut = true;
    this.stats.lastError = why;
    console.warn(`[${this.label}]`, why);
    this.dispose();
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
      this.stats.lastError = short(r.error);
      if (this.stats.errors <= 3) console.warn(`[${this.label}]`, short(r.error));
    }
  }

  async init(info) {
    if (this.stats.cut) return;
    const r = await this.request({ type: 'init', info }, 2000);
    if (r) this.note(r);
  }

  async tick(view) {
    if (this.stats.cut || this.gone) return null;
    const t0 = performance.now();
    const r = await this.request({ type: 'tick', view }, HANG_MS);
    if (this.stats.cut || this.gone) return null;
    if (!r) {
      this.cut(`мозги не отвечали ${HANG_MS / 1000} с и отключены`);
      return null;
    }
    const s = this.stats;
    const ms = Number(r.ms) || 0;
    this.over += Math.max(0, ms - BRAIN_TICK_MS);
    this.late += Math.max(0, performance.now() - t0 - WAIT_OK);
    if (this.over > SLOW_MS || this.late > LATE_MS) {
      this.cut('мозги отвечают слишком медленно и отключены');
      return null;
    }
    s.calls++;
    s.msSum += ms;
    s.msMax = Math.max(s.msMax, ms);
    this.note(r);
    if (r.error) return (this.last = null);
    if (ms > BRAIN_TICK_MS) {
      s.slow++;
      return this.last;
    }
    return (this.last = r.action);
  }

  dispose() {
    this.gone = true;
    this.worker?.terminate();
    for (const cb of this.pending.values()) cb(undefined);
    this.pending.clear();
  }
}
