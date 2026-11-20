// The shared roster: fighters sent by people outside a tournament (docs/roster.md).
//   roster/<id>/entry.json   who sent it: the author's GitHub login and shown name, the model, the agent, the date
//   roster/<id>/fighter/     the fighter itself, without the drafts
// <id> is made of the author's login and the fighter's name in Latin letters, so one author may send several fighters
// and two authors never share a folder.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { RING } from './contestants.js';

export const ROSTER = join(RING, 'roster');

const readJSON = (f, fb = null) => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return fb;
  }
};

const CYR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
// «Главбух Зоя Павловна» → glavbukh-zoya-pavlovna
export const latin = (s) => [...String(s ?? '').toLowerCase()].map((ch) => CYR[ch] ?? ch).join('').normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
export const ROSTER_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;

export function rosterId(login, fighterName) {
  const a = latin(login);
  const b = latin(fighterName);
  if (!a) throw new Error('нужен логин автора на GitHub');
  if (!b) throw new Error('в имени бойца нет ни одной буквы или цифры: из него не получается имя папки');
  return `${a}-${b}`.slice(0, 64).replace(/-+$/, '');
}

// Text that goes to the pages as it is: one line, no markup.
export const plainText = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[<>\u0000-\u001f\u007f]/.test(v);

// What is wrong with an entry.json, in plain words. fighterName — the name in fighter.json, id — the folder's name.
export function checkEntry(entry, { id = null, fighterName = null } = {}) {
  const e = [];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return ['entry.json: нужен объект с полями id, author, model, agent, date'];
  const login = entry.author?.github;
  if (typeof login !== 'string' || !LOGIN.test(login)) e.push('entry.json → author.github: логин автора на GitHub');
  if (!plainText(entry.author?.name, 60)) e.push('entry.json → author.name: имя автора для показа, до 60 знаков, без < и >');
  if (!plainText(entry.model, 60)) e.push('entry.json → model: название модели, до 60 знаков');
  if (!plainText(entry.agent, 40)) e.push('entry.json → agent: агент, в котором работала модель (claude, codex, gemini или своё название), до 40 знаков');
  if (entry.effort !== null && entry.effort !== undefined && !plainText(entry.effort, 20)) e.push('entry.json → effort: уровень рассуждений или null');
  if (typeof entry.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date) || Number.isNaN(Date.parse(entry.date))) e.push('entry.json → date: дата отправки, ГГГГ-ММ-ДД');
  if (typeof entry.id !== 'string' || !ROSTER_ID.test(entry.id)) e.push('entry.json → id: латиница, цифры и дефис');
  else {
    if (id !== null && entry.id !== id) e.push(`entry.json → id: «${entry.id}», а папка называется «${id}»`);
    if (fighterName !== null && typeof login === 'string' && LOGIN.test(login)) {
      let want = null;
      try {
        want = rosterId(login, fighterName);
      } catch (err) {
        e.push(`entry.json → id: ${err.message}`);
      }
      if (want && entry.id !== want) e.push(`entry.json → id: у автора ${login} боец «${fighterName}» получает имя «${want}», а записано «${entry.id}»`);
    }
  }
  return e;
}

// The folders of the roster that hold a fighter: [{ id, dir, fighter, entry, card }]. A folder without entry.json
// or fighter/fighter.json is not a fighter (the roster's own README lies there too).
export function readRoster(root = ROSTER) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const id of readdirSync(root).sort()) {
    const dir = join(root, id);
    if (id.startsWith('.') || !statSync(dir).isDirectory()) continue;
    const entry = readJSON(join(dir, 'entry.json'));
    const card = readJSON(join(dir, 'fighter', 'fighter.json'));
    if (!entry || !card) continue;
    out.push({ id, dir, fighter: join(dir, 'fighter'), entry, card });
  }
  return out;
}

export const TOOLS = { claude: 'Claude Code', codex: 'Codex', gemini: 'Antigravity' };
