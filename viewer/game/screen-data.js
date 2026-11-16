// What the screens between rounds say, without drawing: the 2–3 numbers of a round worth showing big, a version's
// changes as cards, the model's words cut for a screen. Plain functions (tests/screens.test.mjs), the drawing is
// viewer/game/screens.js.
const STAT_RU = { health: 'Здоровье', power: 'Сила', speed: 'Скорость', defense: 'Защита' };

// A model's own words (its locker-room reply) come in Markdown: **bold** and `code` are shown as such, not as stars
// and backticks (found on the rehearsal). saidPlain — the same without the marks, for a short line.
const escHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const MD = [
  [/^#{1,4}\s+/gm, ''],
  [/^\s*[-*]\s+/gm, '• '],
];
export function saidHtml(text) {
  let s = escHtml(text).replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>').replace(/`([^`\n]+?)`/g, '<code>$1</code>');
  for (const [re, to] of MD) s = s.replace(re, to);
  return s;
}

export function saidPlain(text) {
  let s = String(text ?? '').replace(/\*\*([^*\n]+?)\*\*/g, '$1').replace(/`([^`\n]+?)`/g, '$1');
  for (const [re, to] of MD) s = s.replace(re, to);
  return s;
}

export const plainSay = (t, max = 240) => {
  const s = String(t || '').replace(/[`*_#>]/g, '').replace(/\s+/g, ' ').trim();
  let out = '';
  for (const p of s.split(/(?<=[.!?])\s+/)) {
    if ((out + ' ' + p).trim().length > max) break;
    out = (out + ' ' + p).trim();
  }
  if (!out) out = s.length > max ? s.slice(0, max - 1) + '…' : s;
  return out;
};

// the 2–3 numbers of a round worth showing big
export function keyNumbers(st, winner) {
  if (!st?.counters) return [];
  const c = st.counters;
  const out = [];
  const end = st.hp?.[st.hp.length - 1];
  if (winner !== null && end) out.push({ label: 'Здоровья осталось', one: Math.round(end[winner + 1] * 100), fmt: 'pct', side: winner });
  else out.push({ label: 'Попадания', pair: [c[0].hits, c[1].hits] });
  const combo = Math.max(c[0].maxCombo || 0, c[1].maxCombo || 0);
  if (combo >= 3) {
    const s = c[0].maxCombo >= c[1].maxCombo ? 0 : 1;
    out.push({ label: 'Лучшая серия', one: combo, fmt: 'x', side: s });
  } else if (winner !== null) out.push({ label: 'Попадания', pair: [c[0].hits, c[1].hits] });
  else if (c[0].supers + c[1].supers) out.push({ label: 'Суперприёмы', pair: [c[0].supers, c[1].supers] });
  if (st.juicy) out.push({ label: 'Самый сочный удар', one: st.juicy.damage, side: st.juicy.side, sub: `«${st.juicy.name}»` });
  return out.slice(0, 3);
}

const MOVE_WHAT = { '+': 'Новый приём', '−': 'Приём убран', '~': 'Приём изменён' };
const AB_WHAT = { '+': 'Новая способность', '−': 'Способность убрана', '~': 'Способность изменена' };

// The changes of a version as cards: { kind, title, main, detail, delta }
export function changeCards(ch, statsBefore = null, statsAfter = null) {
  if (!ch) return [];
  const out = [];
  for (const x of ch.stats || []) {
    const m = x.match(/^(\S+)\s+(\d+)\s*→\s*(\d+)/);
    if (!m) continue;
    const key = Object.entries(STAT_RU).find(([, v]) => v.toLowerCase() === m[1])?.[0] || m[1];
    const a = Number(m[2]);
    const b = Number(m[3]);
    out.push({ kind: 'stat', title: 'Характеристика', main: STAT_RU[key] || m[1], from: a, to: b, delta: b - a });
  }
  for (const x of ch.moves || []) {
    const sign = x[0];
    const body = x.replace(/^[+−~]\s*/, '');
    const name = body.split(/\s\(|:/)[0];
    const detail = body.includes(':') ? body.split(':').slice(1).join(':').trim() : null;
    out.push({ kind: 'move', title: MOVE_WHAT[sign] || 'Приём', main: name, detail, delta: sign === '+' ? 1 : sign === '−' ? -1 : 0 });
  }
  for (const x of ch.abilities || []) {
    const sign = x[0];
    const body = x.replace(/^[+−~]\s*/, '');
    out.push({ kind: 'ability', title: AB_WHAT[sign] || 'Способность', main: body.split(':')[0], detail: body.includes(':') ? body.split(':').slice(1).join(':').trim() : null, delta: sign === '+' ? 1 : sign === '−' ? -1 : 0 });
  }
  if (ch.brain) {
    const bl = ch.brainLines;
    out.push({ kind: 'brain', title: bl?.count === 1 ? 'Мозги · одна строка' : bl?.count ? `Мозги · строк: ${bl.count}` : 'Мозги переписаны', main: null, code: bl ? { removed: bl.removed.slice(0, 2), added: bl.added.slice(0, 2) } : null, delta: 0 });
  }
  for (const x of ch.card || []) out.push({ kind: 'card', title: 'Карточка', main: x.replace(/^~\s*/, ''), delta: 0 });
  return out;
}

