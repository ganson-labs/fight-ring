// Ring services shared by all contestants: limits and the spending ledger.
// A contestant's ledger lives in its own .ring/ folder; the ring's workshop uses <ring>/ledger/workshop.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { KIT_DIR } from './load.js';

// The operator's home: a contestant's agent may run with its own (Antigravity keeps its profile under the home), the
// launch script then names the operator's home in RING_OPERATOR_HOME
export const operatorHome = () => process.env.RING_OPERATOR_HOME || homedir();

export const DEFAULT_LIMITS = { paint: 40, voiceDesigns: 3, voiceSeconds: 150 };

// A contestant folder holds its own limits and spending ledger in .ring/ (outside fighter/, ignored by its git):
// the folder knows nothing about the ring's location, other contestants or the judge's files.
export function contestant() {
  const file = join(KIT_DIR, 'contestant.json');
  if (existsSync(file)) {
    const c = JSON.parse(readFileSync(file, 'utf8'));
    if (!c.id) throw new Error('contestant.json без id: папку участника создаёт судья (node ring.mjs new)');
    if (c.ring && !existsSync(join(KIT_DIR, '.ring'))) {
      // stage-1 folders kept the ledger in the ring folder
      const ring = resolve(c.ring);
      return { id: c.id, model: c.model || c.id, ledgerFile: join(ring, 'ledger', `${c.id}.json`), limitsFrom: join(ring, 'ring.config.json') };
    }
    return { id: c.id, model: c.model || c.id, ledgerFile: join(KIT_DIR, '.ring', 'ledger.json'), limitsFile: join(KIT_DIR, '.ring', 'limits.json') };
  }
  // the ring's own kit/ (workshop checks by the ring's operator)
  const ring = resolve(KIT_DIR, '..');
  if (existsSync(join(ring, 'ring.config.json'))) return { id: 'workshop', model: 'мастерская ринга', ledgerFile: join(ring, 'ledger', 'workshop.json'), limitsFrom: join(ring, 'ring.config.json') };
  throw new Error('нет contestant.json: папку участника создаёт судья (node ring.mjs new)');
}

const readJSON = (f, fallback = {}) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : fallback);

export function ringConfig() {
  const c = contestant();
  let limits = { ...DEFAULT_LIMITS };
  if (c.limitsFile) limits = { ...limits, ...readJSON(c.limitsFile) };
  if (c.limitsFrom) {
    const cfg = readJSON(c.limitsFrom);
    limits = { ...limits, ...(cfg.limits || {}), ...(cfg.contestants?.[c.id]?.limits || {}) };
  }
  return { ...c, limits };
}

export function readLedger(cfg = ringConfig()) {
  const base = { paint: 0, voiceDesigns: 0, voiceSeconds: 0, log: [] };
  return { ...base, ...readJSON(cfg.ledgerFile) };
}

function writeLedger(cfg, data) {
  const f = cfg.ledgerFile;
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, f);
}

// Throws before spending when the limit would be exceeded.
export function ensure(kind, amount = 1) {
  const cfg = ringConfig();
  const led = readLedger(cfg);
  const left = cfg.limits[kind] - led[kind];
  if (amount > left + 1e-9) {
    const unit = kind === 'voiceSeconds' ? ' с' : '';
    throw new Error(`лимит исчерпан: ${kindName(kind)} — использовано ${fmt(led[kind])}${unit} из ${cfg.limits[kind]}${unit}, нужно ещё ${fmt(amount)}${unit}`);
  }
  return { cfg, left };
}

// Several generations may finish at once: the ledger is updated under a lock directory.
function withLock(cfg, fn) {
  const dir = dirname(cfg.ledgerFile);
  const lock = cfg.ledgerFile.replace(/\.json$/, '') + '.lock';
  mkdirSync(dir, { recursive: true });
  const until = Date.now() + 10000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      if (Date.now() > until) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export function spend(kind, amount, note) {
  const cfg = ringConfig();
  return withLock(cfg, () => {
    const led = readLedger(cfg);
    led[kind] = (led[kind] || 0) + amount;
    led.log.push({ at: new Date().toISOString(), kind, amount, note });
    writeLedger(cfg, led);
    return { used: led[kind], limit: cfg.limits[kind] };
  });
}

const fmt = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
function kindName(k) {
  return { paint: 'генерации картинок', voiceDesigns: 'создание голоса', voiceSeconds: 'секунды озвучки' }[k] || k;
}

export function cmdLimits() {
  const cfg = ringConfig();
  const led = readLedger(cfg);
  console.log(`Участник: ${cfg.id} (${cfg.model})`);
  for (const k of Object.keys(DEFAULT_LIMITS)) {
    const unit = k === 'voiceSeconds' ? ' с' : '';
    console.log(`  ${kindName(k)}: ${fmt(led[k])}${unit} из ${cfg.limits[k]}${unit}, осталось ${fmt(Math.max(0, cfg.limits[k] - led[k]))}${unit}`);
  }
}

// Service settings for the operator's machine (never inside contestant folders or the repository).
export function serviceEnv() {
  const files = [process.env.FIGHT_RING_ENV, join(operatorHome(), '.config', 'fight-ring', 'services.env')].filter(Boolean);
  const out = {};
  for (const f of files) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
  for (const k of Object.keys(out)) if (process.env[k]) out[k] = process.env[k];
  return out;
}
