// The match protocol: which ring played it (version, engine hash), who built each fighter (model and its id,
// agent, reasoning effort), how long the build and every locker room took, what they spent (pictures, voice
// seconds, tokens and cost when the agent's journal has them), and a check that every recorded round replays
// frame for frame on the engine snapshot kept with it (round-N/<id>/arena/engine).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { RING, registry, transcriptFiles } from './contestants.js';
import { loadMatch, matchDir } from './match.js';
import { expandSteps } from '../kit/arena/tools/load.js';

const readJSON = (f, fb = null) => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return fb;
  }
};

// one hash for a folder of code: the same engine gives the same hash
export function folderHash(dir) {
  const h = createHash('sha1');
  const walk = (d) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else h.update(relative(dir, p).split(sep).join('/')).update(readFileSync(p));
    }
  };
  if (existsSync(dir)) walk(dir);
  return h.digest('hex').slice(0, 12);
}

// ---------- journals: time and tokens ----------

// Entries of an agent journal with a time: { at (ms), tokens: { input, output, cacheRead, cacheWrite, reasoning }, cost }
export function journalEntries(file) {
  const out = [];
  // Claude Code writes one line per content block of a message (thinking, text, tool call), each with the whole
  // message's usage: counted once per message id, from its last line. Codex may repeat a token_count event.
  const byMessage = new Map();
  let lastTotal = null;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const at = Date.parse(o.timestamp || o.created_at || '');
    if (!Number.isFinite(at)) continue;
    const e = { at, tokens: null, cost: null };
    // Claude Code: usage on every assistant message, costUSD in some versions
    const u = o.message?.usage;
    if (o.type === 'assistant' && u) {
      e.tokens = { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, reasoning: 0 };
      const id = o.message.id;
      if (id) {
        const prev = byMessage.get(id);
        if (prev) prev.tokens = null;
        byMessage.set(id, e);
      }
    }
    if (Number.isFinite(o.costUSD)) e.cost = o.costUSD;
    // Antigravity: usage on every PLANNER_RESPONSE step, as strings
    if (o.type === 'PLANNER_RESPONSE' && o.input_tokens != null) e.tokens = { input: +o.input_tokens || 0, output: +o.output_tokens || 0, cacheRead: +o.cache_read_tokens || 0, cacheWrite: 0, reasoning: +o.thinking_tokens || 0 };
    // Codex: token_count events with the usage of the last turn
    const t = o.payload?.type === 'token_count' ? o.payload.info?.last_token_usage : null;
    const total = t ? JSON.stringify(o.payload.info?.total_token_usage || null) : null;
    if (t && total !== 'null' && total === lastTotal) continue;
    if (t) lastTotal = total;
    if (t) e.tokens = { input: (t.input_tokens || 0) - (t.cached_input_tokens || 0), output: t.output_tokens || 0, cacheRead: t.cached_input_tokens || 0, cacheWrite: 0, reasoning: t.reasoning_output_tokens || 0 };
    out.push(e);
  }
  return out;
}

// work inside [from, to): active time (gaps over 5 minutes do not count), first and last moment, tokens, cost
export function workIn(files, from, to) {
  const all = files.flatMap(journalEntries).filter((e) => e.at >= from && e.at < to).sort((a, b) => a.at - b.at);
  if (!all.length) return null;
  let active = 0;
  for (let i = 1; i < all.length; i++) {
    const gap = all[i].at - all[i - 1].at;
    if (gap < 5 * 60000) active += gap;
  }
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  let anyTokens = false;
  let cost = 0;
  let anyCost = false;
  for (const e of all) {
    if (e.tokens) {
      anyTokens = true;
      for (const k of Object.keys(tokens)) tokens[k] += e.tokens[k];
    }
    if (e.cost !== null) {
      anyCost = true;
      cost += e.cost;
    }
  }
  return { from: new Date(all[0].at).toISOString(), to: new Date(all[all.length - 1].at).toISOString(), activeMinutes: +(active / 60000).toFixed(1), tokens: anyTokens ? tokens : null, costUSD: anyCost ? +cost.toFixed(4) : null };
}

// pictures and voice spent by a contestant inside [from, to) (the ring's ledger)
export function spentIn(id, from, to) {
  const root = registry()[id]?.root;
  const l = readJSON(join(RING, 'ledger', `${id}.json`)) || (root && readJSON(join(root, '.ring', 'ledger.json'))) || { log: [] };
  const out = { paint: 0, voiceDesigns: 0, voiceSeconds: 0 };
  for (const e of l.log || []) {
    const at = Date.parse(e.at);
    if (at >= from && at < to && e.kind in out) out[e.kind] += e.amount;
  }
  out.voiceSeconds = +out.voiceSeconds.toFixed(1);
  return out;
}

// ---------- the protocol ----------

export function protocol(id) {
  const m = loadMatch(id);
  const reg = registry();
  const people = {};
  for (const cid of [m.red, m.blue]) {
    const c = reg[cid] || {};
    const files = (() => {
      try {
        return transcriptFiles(cid);
      } catch {
        return [];
      }
    })();
    // periods: the build before round 1, then every locker room between two snapshots
    const snapAt = m.rounds.map((r) => Date.parse(r.snapshot?.[cid]?.at || r.at || '')).filter(Number.isFinite);
    const periods = [];
    const start = Date.parse(c.created || '') || 0;
    if (snapAt.length) periods.push({ what: 'сборка', from: start, to: snapAt[0] });
    for (let i = 1; i < snapAt.length; i++) periods.push({ what: `раздевалка ${i}`, from: snapAt[i - 1], to: snapAt[i] });
    people[cid] = {
      model: m.models[cid] || c.model || cid,
      modelId: c.agentModel || null,
      agent: { codex: 'Codex', claude: 'Claude Code', gemini: 'Antigravity' }[c.agent] || c.agent || null,
      effort: c.effort || null,
      periods: periods.map((p) => ({ what: p.what, from: new Date(p.from).toISOString(), to: new Date(p.to).toISOString(), work: workIn(files, p.from, p.to), spent: spentIn(cid, p.from, p.to) })),
    };
  }
  const rounds = m.rounds.map((r) => ({ n: r.n, ring: r.ring || null, engine: r.engine || null, hash: r.hash, stage: r.stage, winner: r.winner, reason: r.reason }));
  return { match: m.id, created: m.created, ring: m.ring || null, people, rounds };
}

// ---------- replay on the round's own engine ----------

// The fighter of a snapshot checked and compiled by that snapshot's engine (abilities loaded with its meter).
export async function loadWith(E, I, dir) {
  const input = {};
  for (const f of ['fighter', 'body', 'moves', 'voice']) input[f] = readJSON(join(dir, `${f}.json`));
  const res = E.checkFighter(input);
  if (!res.ok) throw new Error(`${dir}: ${res.errors.slice(0, 3).join('; ')}`);
  const def = res.fighter;
  if (!def.abilityScripts?.length) {
    def.abilities = {};
    return def;
  }
  const load = I.abilityLoader({
    base: pathToFileURL(dir).href.replace(/\/?$/, '/'),
    read: async (u) => readFileSync(fileURLToPath(u), 'utf8'),
    toUrl: (src, u) => `data:text/javascript;charset=utf-8,${encodeURIComponent(src + '\n//# ' + u + '#verify')}`,
  });
  const modules = {};
  for (const s of def.abilityScripts) modules[s] = await load(s);
  const prep = E.prepareAbilities(def, modules, { verify: false });
  if (!prep.ok) throw new Error(`${dir}: ${prep.errors.slice(0, 3).join('; ')}`);
  return def;
}

// every round of the match replayed on the engine kept with it: the hash must be the recorded one
// A recorded round played again on its own engine snapshot, step by step: onStep(fight, acts, events, E) after each
// step (the match pack's thoughts of the fighters, the ghost of the last round). Returns the finished fight.
export async function replayRound(dir, r, onStep = null) {
  const rd = join(dir, `round-${r.n}`);
  const engineDir = join(rd, r.left, 'arena', 'engine');
  const E = await import(pathToFileURL(join(engineDir, 'index.js')).href);
  const I = await import(pathToFileURL(join(engineDir, 'instrument.js')).href);
  const replay = readJSON(join(rd, 'replay.json'));
  const fighters = [];
  for (const cid of [r.left, r.right]) fighters.push(await loadWith(E, I, join(rd, cid, 'fighter')));
  const fight = E.createFight({ fighters, seed: replay.seed ?? E.RING_SEED, start: replay.start });
  for (const acts of expandSteps(replay.steps)) {
    const ev = E.stepFight(fight, acts);
    if (onStep) onStep(fight, acts, ev, E);
  }
  return { fight, fighters, replay, E };
}

export async function verifyMatch(id) {
  return verifyDir(matchDir(id));
}

// the same over any match folder (match.json, round-N/replay.json and the snapshots): tests keep an old one
export async function verifyDir(dir) {
  const m = readJSON(join(dir, 'match.json'));
  const out = [];
  for (const r of m.rounds) {
    const rd = join(dir, `round-${r.n}`);
    const engineDir = join(rd, r.left, 'arena', 'engine');
    const E = await import(pathToFileURL(join(engineDir, 'index.js')).href);
    const I = await import(pathToFileURL(join(engineDir, 'instrument.js')).href);
    const replay = readJSON(join(rd, 'replay.json'));
    const fighters = [];
    for (const cid of [r.left, r.right]) fighters.push(await loadWith(E, I, join(rd, cid, 'fighter')));
    const fight = E.createFight({ fighters, seed: replay.seed ?? E.RING_SEED, start: replay.start });
    for (const acts of expandSteps(replay.steps)) E.stepFight(fight, acts);
    const hash = E.fightHash(fight);
    out.push({ n: r.n, engine: folderHash(engineDir), recorded: replay.hash || r.hash, replayed: hash, same: hash === (replay.hash || r.hash) });
  }
  return out;
}

export function protocolMd(p, verify = null) {
  const L = [`# Протокол матча ${p.match}`, '', `Создан ${p.created}. ${p.ring ? `Версия: ринг ${p.ring.ring} (движок ${p.ring.engine}, правила ${p.ring.rules}, инструменты ${p.ring.tools}).` : 'Версия ринга не записана (матч старше протокола).'}`, ''];
  for (const [cid, x] of Object.entries(p.people)) {
    L.push(`## ${cid}: ${x.model}`, '', `Модель ${x.modelId || '—'}, агент ${x.agent || '—'}, сила рассуждения ${x.effort || '—'}.`, '');
    for (const per of x.periods) {
      const w = per.work;
      const t = w?.tokens;
      L.push(`- **${per.what}**: ${w ? `${w.activeMinutes} мин работы (${w.from.slice(11, 16)}–${w.to.slice(11, 16)})` : 'журнала агента нет'}; картинок ${per.spent.paint}, голосов ${per.spent.voiceDesigns}, секунд голоса ${per.spent.voiceSeconds}${t ? `; токены: вход ${t.input}, выход ${t.output}, кэш ${t.cacheRead + t.cacheWrite}${t.reasoning ? `, рассуждение ${t.reasoning}` : ''}` : ''}${w?.costUSD !== null && w?.costUSD !== undefined ? `; $${w.costUSD}` : ''}`);
    }
    L.push('');
  }
  L.push('## Раунды', '');
  for (const r of p.rounds) {
    const v = verify?.find((x) => x.n === r.n);
    L.push(`- Раунд ${r.n}: ${r.stage}, ${r.winner || 'ничья'} (${r.reason === 'ko' ? 'нокаут' : 'время'}), запись ${r.hash}${r.engine ? `, движок ${r.engine}` : ''}${v ? ` — переигровка на своём движке: ${v.same ? 'совпала' : `НЕ совпала (${v.replayed})`}` : ''}`);
  }
  return L.join('\n') + '\n';
}

export function writeProtocol(id, verify = null) {
  const p = protocol(id);
  if (verify) p.verify = verify;
  writeFileSync(join(matchDir(id), 'protocol.json'), JSON.stringify(p, null, 2) + '\n');
  writeFileSync(join(matchDir(id), 'protocol.md'), protocolMd(p, verify));
  return p;
}
