// The one place the site reads the ring from: published seasons (../seasons/<id>/) and the kit's move set.
// Everything on the pages comes from these files at build time; a missing file means a missing section, never
// a made-up number.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The ring's root: the folder with seasons/, kit/, stages/. `node ring.mjs site` passes it in RING_ROOT. */
export const RING = resolve(process.env.RING_ROOT || join(process.cwd(), '..'));

// ---------- what the files hold (only the fields the site uses) ----------

interface RawColors { primary: string; secondary: string; accent: string }
interface RawRoundRef { match: string; round: number; num: number; rerun: boolean }
interface RawChanges {
  added: string[];
  removed: string[];
  changed: { file: string; lines: string }[];
  name?: [string, string];
}
interface RawVersion {
  v: number;
  url: string;
  name: string;
  at: string;
  rounds: RawRoundRef[];
  note: { round: number; text: string; at: string } | null;
  changes: RawChanges | null;
  abilities: { move: string; name: string; slot?: string; about: string | null }[];
}
interface RawFighter {
  id: string;
  cid?: string;
  model: string;
  color: string;
  colors: RawColors;
  name: string;
  versions: RawVersion[];
  agent?: string;
  agentModel?: string;
  effort?: string;
  author?: string;
  training?: boolean;
}
interface RawRound {
  n: number;
  num: number;
  rerun: boolean;
  left: string;
  right: string;
  stage: string;
  winner: string | null;
  reason: 'ko' | 'time';
  final: boolean;
  names: Record<string, string>;
  versions: Record<string, number>;
}
interface RawMatch {
  id: string;
  created: string;
  red: string;
  blue: string;
  models: Record<string, string>;
  score: Record<string, number>;
  over: boolean;
  winner: string | null;
  firstTo: number;
  rounds: RawRound[];
  stats?: { rounds?: { n: number; result?: { seconds?: number } }[] } | null;
}
interface RawGame {
  season: { title: string; published: string; ring?: Record<string, string> };
  fighters: RawFighter[];
  matches: RawMatch[];
}
interface RawCard {
  name: string;
  motto?: string;
  story?: string;
  portrait?: string;
  stats?: Partial<Record<StatKey, number>>;
}
interface RawLeague {
  at: string;
  fights: number;
  table: { entries: { id: string; kind: 'build' | 'ref'; model: string; name: string; rating: number; range: [number, number]; fights: number; share: number; kos: number }[] };
}
interface RawSpend {
  note?: string;
  rows: { key: string; model: string; ring: [number, string, string] | null; locker: number | null }[];
}

// ---------- what the pages get ----------

export type StatKey = 'health' | 'power' | 'speed' | 'defense';
export type MoveSlot = 'normal' | 'special' | 'super';

export interface Move {
  id: string;
  name: string;
  command: string | null;
  slot: MoveSlot | null;
  /** the name of this move in the ring's shared set */
  kitName: string | null;
}

export interface Version {
  v: number;
  at: string;
  /** the path of the version's folder under the site root, with a trailing slash */
  dir: string;
  rounds: { match: Match; round: Round }[];
  /** what the model said in the locker room before this version went out, as safe HTML */
  note: { afterRound: number; html: string } | null;
  changes: { file: string; lines: string }[];
  added: string[];
  removed: string[];
  renamed: [string, string] | null;
  abilities: { name: string; about: string | null }[];
}

/** A fighter's card. The same shape serves the fighters of a season and, later, the fighters of the community. */
export interface Fighter {
  /** the address of the fighter on the site: fighters/<id>/ */
  id: string;
  /** the id the game knows the fighter by (play/?screen=play&vs=…) */
  gameId: string;
  season: string;
  name: string;
  /** the model that made the fighter, as shown on screen */
  model: string;
  /** the agent the model worked in: its tool and the model's id there */
  agent: { tool: string; model: string | null; effort: string | null } | null;
  /** the person who entered the fighter; the fighters of the first season have none */
  author: string | null;
  color: string;
  colors: RawColors;
  motto: string | null;
  story: string | null;
  /** the portrait's file on disk, for the image pipeline */
  portraitFile: string | null;
  stats: Record<StatKey, number> | null;
  moves: Move[];
  versions: Version[];
  matches: Match[];
}

export interface Round {
  /** the round's place in the match: the number the game's link takes */
  n: number;
  /** the number shown on screen: a rerun keeps the number of the round it replays */
  num: number;
  rerun: boolean;
  winner: string | null;
  reason: 'ko' | 'time';
  seconds: number | null;
  stage: string;
}

export type MatchKind = 'final' | 'semi' | 'show' | 'other';

export interface Match {
  id: string;
  kind: MatchKind;
  title: string;
  sides: [string, string];
  score: [number, number];
  winner: string | null;
  rounds: Round[];
}

export interface LeagueRow {
  id: string;
  isReference: boolean;
  name: string;
  model: string;
  color: string | null;
  rating: number;
  range: [number, number];
  share: number;
  kos: number;
  fights: number;
}

export interface SpendRow {
  model: string;
  color: string | null;
  minutes: number;
  tokens: string;
  price: string;
  lockerMinutes: number | null;
}

export interface Season {
  id: string;
  title: string;
  published: string;
  fighters: Fighter[];
  matches: Match[];
  final: Match | null;
  league: { fights: number; rows: LeagueRow[]; min: number; max: number } | null;
  spend: { note: string | null; rows: SpendRow[] } | null;
}

// ---------- reading ----------

function readJSON<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A locker-room reply is light Markdown: paragraphs, lists, tables, **bold**, *italic*, `code`, links.
 *  Links to files on the contestant's machine go out together with their text; web links stay. */
export function noteHtml(text: string): string {
  const inline = (s: string) =>
    esc(s)
      .replace(/\[([^\]]+)\]\((?:&lt;)?([^)]*?)(?:&gt;)?\)/g, (_m, label: string, url: string) => (/^https?:\/\//.test(url) ? `<a href="${url}" rel="noopener">${label}</a>` : ''))
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>')
      .trim();
  const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c));
  const kind = (line: string) => (/^\s*\|.*\|\s*$/.test(line) ? 'table' : /^\s*\d+[.)]\s+/.test(line) ? 'ol' : /^\s*[-*•]\s+/.test(line) ? 'ul' : /^\s*#+\s+/.test(line) ? 'head' : line.trim() ? 'text' : 'gap');
  const out: string[] = [];
  const lines = text.replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; ) {
    const k = kind(lines[i] ?? '');
    const run: string[] = [];
    // a line that goes on under a list item belongs to that item
    while (i < lines.length && (kind(lines[i] ?? '') === k || ((k === 'ol' || k === 'ul') && kind(lines[i] ?? '') === 'text' && /^\s+/.test(lines[i] ?? '')))) run.push(lines[i++] ?? '');
    if (k === 'gap') continue;
    if (k === 'table') {
      const rows = run.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r)).map(cells);
      const [head, ...body] = rows;
      if (head) out.push(`<div class="scroll"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
    } else if (k === 'ol' || k === 'ul') {
      const items: string[] = [];
      for (const r of run) {
        if (kind(r) === k) items.push(r.replace(/^\s*(\d+[.)]|[-*•])\s+/, ''));
        else items[items.length - 1] += ` ${r.trim()}`;
      }
      out.push(`<${k}>${items.map((it) => `<li>${inline(it)}</li>`).join('')}</${k}>`);
    } else if (k === 'head') {
      for (const r of run) out.push(`<p><strong>${inline(r.replace(/^\s*#+\s+/, ''))}</strong></p>`);
    } else {
      const p = inline(run.join(' '));
      if (p) out.push(`<p>${p}</p>`);
    }
  }
  return out.join('');
}

function matchKind(id: string): { kind: MatchKind; title: string } {
  const semi = id.match(/semi-?(\d+)?/);
  if (/final/.test(id) && !semi) return { kind: 'final', title: 'Финал' };
  if (semi) return { kind: 'semi', title: semi[1] ? `Полуфинал ${semi[1]}` : 'Полуфинал' };
  if (/show/.test(id)) return { kind: 'show', title: 'Показательный бой' };
  return { kind: 'other', title: id };
}

interface KitMove { id: string; name: string; slot: MoveSlot }
let kitMoves: Map<string, KitMove> | null = null;
async function kit(): Promise<Map<string, KitMove>> {
  if (kitMoves) return kitMoves;
  kitMoves = new Map();
  const file = join(RING, 'kit', 'arena', 'engine', 'standard.js');
  if (existsSync(file)) {
    const mod = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as { KIT_MOVES?: KitMove[] };
    for (const m of mod.KIT_MOVES ?? []) kitMoves.set(m.id, m);
  }
  return kitMoves;
}

async function readSeason(id: string): Promise<Season | null> {
  const dir = join(RING, 'seasons', id);
  const game = readJSON<RawGame>(join(dir, 'game.json'));
  if (!game) return null;
  const set = await kit();

  const matches: Match[] = game.matches.map((m) => {
    const seconds = new Map((m.stats?.rounds ?? []).map((r) => [r.n, r.result?.seconds ?? null]));
    return {
      id: m.id,
      ...matchKind(m.id),
      sides: [m.red, m.blue],
      score: [m.score[m.red] ?? 0, m.score[m.blue] ?? 0],
      winner: m.winner || null,
      rounds: m.rounds.map((r) => ({ n: r.n, num: r.num, rerun: r.rerun, winner: r.winner || null, reason: r.reason, seconds: seconds.get(r.n) ?? null, stage: r.stage })),
    };
  });
  const order: Record<MatchKind, number> = { semi: 0, final: 1, show: 2, other: 3 };
  matches.sort((a, b) => order[a.kind] - order[b.kind] || a.id.localeCompare(b.id));
  const matchById = new Map(matches.map((m) => [m.id, m]));

  const fighters: Fighter[] = [];
  for (const f of game.fighters) {
    if (!f.cid || f.training) continue;
    const top = f.versions[f.versions.length - 1];
    if (!top) continue;
    const topDir = join(RING, top.url);
    const card = readJSON<RawCard>(join(topDir, 'fighter.json'));
    const rawMoves = readJSON<{ moves: { id: string; name?: string; command?: string }[] }>(join(topDir, 'moves.json'))?.moves ?? [];
    const portrait = card?.portrait ? join(topDir, card.portrait) : null;
    const stats = card?.stats;
    fighters.push({
      id: f.cid,
      gameId: f.id,
      season: id,
      name: card?.name ?? f.name,
      model: f.model,
      agent: f.agent ? { tool: f.agent, model: f.agentModel ?? null, effort: f.effort ?? null } : null,
      author: f.author ?? null,
      color: f.color,
      colors: f.colors,
      motto: card?.motto ?? null,
      story: card?.story ?? null,
      portraitFile: portrait && existsSync(portrait) ? portrait : null,
      stats: stats ? { health: stats.health ?? 3, power: stats.power ?? 3, speed: stats.speed ?? 3, defense: stats.defense ?? 3 } : null,
      moves: rawMoves.map((m) => ({ id: m.id, name: m.name ?? set.get(m.id)?.name ?? m.id, command: m.command ?? null, slot: set.get(m.id)?.slot ?? null, kitName: set.get(m.id)?.name ?? null })),
      versions: f.versions.map((v) => ({
        v: v.v,
        at: v.at,
        dir: v.url.replace(/^\/+/, ''),
        rounds: v.rounds.flatMap((r) => {
          const match = matchById.get(r.match);
          const round = match?.rounds.find((x) => x.n === r.round);
          return match && round ? [{ match, round }] : [];
        }),
        note: v.note ? { afterRound: v.note.round, html: noteHtml(v.note.text) } : null,
        changes: v.changes?.changed ?? [],
        added: v.changes?.added ?? [],
        removed: v.changes?.removed ?? [],
        renamed: v.changes?.name && v.changes.name[0] !== v.changes.name[1] ? v.changes.name : null,
        abilities: v.abilities.map((a) => ({ name: a.name, about: a.about })),
      })),
      matches: matches.filter((m) => m.sides.includes(f.cid as string)),
    });
  }
  const colorOf = (cid: string) => fighters.find((f) => f.id === cid)?.color ?? null;

  const rawLeague = readJSON<RawLeague>(join(dir, 'league.json'));
  const rows: LeagueRow[] = (rawLeague?.table.entries ?? []).map((e) => ({ id: e.id, isReference: e.kind !== 'build', name: e.name, model: e.model, color: colorOf(e.id), rating: e.rating, range: e.range, share: e.share, kos: e.kos, fights: e.fights }));
  rows.sort((a, b) => b.rating - a.rating);

  const rawSpend = readJSON<RawSpend>(join(dir, 'spend.json'));
  const spendRows: SpendRow[] = (rawSpend?.rows ?? []).flatMap((r) => (r.ring ? [{ model: r.model, color: fighters.find((f) => f.id.startsWith(r.key))?.color ?? null, minutes: r.ring[0], tokens: r.ring[1], price: r.ring[2], lockerMinutes: r.locker }] : []));

  return {
    id,
    title: game.season.title,
    published: game.season.published,
    fighters,
    matches,
    final: matches.find((m) => m.kind === 'final') ?? null,
    league: rawLeague && rows.length ? { fights: rawLeague.fights, rows, min: Math.min(...rows.map((r) => r.range[0])), max: Math.max(...rows.map((r) => r.range[1])) } : null,
    spend: spendRows.length ? { note: rawSpend?.note ?? null, rows: spendRows } : null,
  };
}

let cache: Promise<Season[]> | null = null;

/** Published seasons, the latest first. */
export function seasons(): Promise<Season[]> {
  cache ??= (async () => {
    const root = join(RING, 'seasons');
    const ids = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];
    const all = (await Promise.all(ids.map(readSeason))).filter((s): s is Season => s !== null);
    all.sort((a, b) => b.published.localeCompare(a.published) || b.id.localeCompare(a.id));
    const seen = new Set<string>();
    for (const s of all) for (const f of s.fighters) {
      if (seen.has(f.id)) throw new Error(`боец ${f.id} встречается в двух сезонах: адрес fighters/${f.id}/ должен быть один`);
      seen.add(f.id);
    }
    return all;
  })();
  return cache;
}

export async function latestSeason(): Promise<Season> {
  const [first] = await seasons();
  if (!first) throw new Error(`в ${join(RING, 'seasons')} нет ни одного опубликованного сезона`);
  return first;
}

export async function allFighters(): Promise<Fighter[]> {
  return (await seasons()).flatMap((s) => s.fighters);
}

export function fighterIn(season: Season, id: string): Fighter | null {
  return season.fighters.find((f) => f.id === id) ?? null;
}

// ---------- addresses in the game (play/) ----------

export const watchRound = (match: Match, round: Round) => `play/?match=${encodeURIComponent(match.id)}&auto=round&round=${round.n}`;
export const playAgainst = (f: Fighter) => `play/?screen=play&vs=${encodeURIComponent(f.gameId)}`;
export const PLAY = 'play/?screen=play';

// ---------- words ----------

/** 1 боец, 2 бойца, 5 бойцов */
export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

export function roundOutcome(r: Round, name: (cid: string) => string): string {
  if (!r.winner) return r.reason === 'ko' ? 'Двойной нокаут' : 'Ничья по времени';
  return `${name(r.winner)}, ${r.reason === 'ko' ? 'нокаут' : 'по времени'}`;
}

export const roundTitle = (r: Round) => `Раунд ${r.num}${r.rerun ? ', переигровка' : ''}`;

export const num = (n: number) => new Intl.NumberFormat('ru-RU').format(n);
export const dateRu = (iso: string) => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(iso));

const TOOLS: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Antigravity' };
export const agentName = (tool: string) => TOOLS[tool] ?? tool;
