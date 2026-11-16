// Loads ability modules with the step meter built in (meter.js). Every own file of the fighter is rewritten before
// it runs: a step check goes into each loop header and at the start of each own function, and own imports point at
// the rewritten copies. The rewrite only adds code on the same lines, so line numbers in errors stay. A small
// tokenizer, no parser: it knows strings, templates, regular expressions, comments and brackets, which is enough
// to find loops, function bodies and arrow bodies. Used the same way by the judge in Node and by the viewer.

const NLS = new Set([10, 13, 8232, 8233]);
const isNL = (c) => NLS.has(c.charCodeAt(0));
const hasNL = (s) => [...s].some(isNL);
const BEFORE_EXPR = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await', 'extends']);
const CONTROL = new Set(['if', 'while', 'for', 'with', 'switch', 'catch']);
const PUNCTS = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>'];
const NUMBER = /(?:0[xXoObB][0-9a-fA-F_]+|(?:\d[\d_]*)?\.?[\d_]*(?:[eE][+-]?\d[\d_]*)?)n?/y;
const isDigit = (c) => c >= '0' && c <= '9';
const isIdStart = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$' || c === '\\' || c > '\x7f';
const isId = (c) => isIdStart(c) || isDigit(c);
// length of a #! first line with its line break, or 0
function hashbang(src) {
  if (!src.startsWith('#!')) return 0;
  let k = 0;
  while (k < src.length && !isNL(src[k])) k++;
  return Math.min(k + 1, src.length);
}

// ---------- tokens ----------

export function tokenize(src) {
  const toks = [];
  const braces = []; // '{' or '${'
  const parens = []; // does this ( belong to if/while/for/with
  const n = src.length;
  let i = hashbang(src);
  let nl = false;
  const push = (t) => {
    t.nl = nl;
    nl = false;
    toks.push(t);
    return t;
  };
  const fail = (what) => {
    throw new SyntaxError(`${what} (строка ${src.slice(0, i).split('\n').length})`);
  };
  const regexOk = () => {
    const t = toks[toks.length - 1];
    if (!t) return true;
    if (t.type === 'name') return BEFORE_EXPR.has(t.value);
    if (t.type === 'tpl') return t.open;
    if (t.type !== 'punct') return false;
    if (t.value === ')') return !!t.ctrl;
    return !(t.value === ']' || t.value === '}' || t.value === '++' || t.value === '--');
  };
  const template = () => {
    while (i < n) {
      const c = src[i];
      if (c === '\\') i += 2;
      else if (c === '`') return (i++, false);
      else if (c === '$' && src[i + 1] === '{') return ((i += 2), true);
      else i++;
    }
    fail('незакрытый шаблон `…`');
  };
  while (i < n) {
    const c = src[i];
    if (isNL(c)) {
      nl = true;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || /\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && !isNL(src[i])) i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) fail('незакрытый комментарий /* … */');
      if (hasNL(src.slice(i, end))) nl = true;
      i = end + 2;
      continue;
    }
    const start = i;
    if (c === '"' || c === "'") {
      i++;
      while (i < n && src[i] !== c) {
        if (src[i] === '\\') i++;
        else if (isNL(src[i])) fail('строка не закрыта до конца строки');
        i++;
      }
      if (i >= n) fail('незакрытая строка');
      i++;
      push({ type: 'str', start, end: i });
      continue;
    }
    if (c === '`' || (c === '}' && braces[braces.length - 1] === '${')) {
      if (c === '}') braces.pop();
      i++;
      const open = template();
      push({ type: 'tpl', start, end: i, open, close: c === '}' });
      if (open) braces.push('${');
      continue;
    }
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      NUMBER.lastIndex = i;
      NUMBER.exec(src);
      i = Math.max(NUMBER.lastIndex, i + 1);
      push({ type: 'num', start, end: i });
      continue;
    }
    if (isIdStart(c) || c === '#') {
      i++;
      while (i < n && isId(src[i])) i += src[i] === '\\' ? 2 : 1;
      push({ type: 'name', value: src.slice(start, i), start, end: i });
      continue;
    }
    if (c === '/' && regexOk()) {
      i++;
      let cls = false;
      while (i < n && (cls || src[i] !== '/')) {
        if (isNL(src[i])) fail('регулярное выражение не закрыто');
        if (src[i] === '\\') i++;
        else if (src[i] === '[') cls = true;
        else if (src[i] === ']') cls = false;
        i++;
      }
      i++;
      while (i < n && isId(src[i])) i++;
      push({ type: 'regex', start, end: i });
      continue;
    }
    let p = PUNCTS.find((x) => src.startsWith(x, i)) || c;
    if (p === '?.' && isDigit(src[i + 2])) p = '?';
    i += p.length;
    const t = push({ type: 'punct', value: p, start, end: i });
    if (p === '{') braces.push('{');
    else if (p === '}') braces.pop();
    else if (p === '(') {
      const b = toks[toks.length - 2];
      parens.push(!!(b && b.type === 'name' && (b.value === 'if' || b.value === 'while' || b.value === 'for' || b.value === 'with')));
    } else if (p === ')') t.ctrl = parens.pop();
  }
  // brackets: opener.to → its closer, closer.from → its opener (a middle template piece `}…${` is both)
  const st = [];
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (isCloser(t)) {
      const o = st.pop();
      if (o === undefined) fail('лишняя закрывающая скобка');
      toks[o].to = k;
      t.from = o;
    }
    if (isOpener(t)) st.push(k);
  }
  if (st.length) fail('незакрытая скобка');
  return toks;
}

const isP = (t, v) => !!t && t.type === 'punct' && t.value === v;
const isName = (t, v) => !!t && t.type === 'name' && t.value === v;
function isOpener(t) {
  return t.type === 'punct' ? t.value === '(' || t.value === '[' || t.value === '{' : t.type === 'tpl' && t.open;
}
function isCloser(t) {
  return t.type === 'punct' ? t.value === ')' || t.value === ']' || t.value === '}' : t.type === 'tpl' && t.close;
}
// from an opener to the closer of the whole group (through the middle pieces of a template)
function jump(toks, k) {
  let j = toks[k].to;
  while (isOpener(toks[j])) j = toks[j].to;
  return j;
}
function endsExpr(t) {
  if (t.type === 'name') return !BEFORE_EXPR.has(t.value);
  if (t.type === 'tpl') return !t.open;
  if (t.type === 'punct') return t.value === ')' || t.value === ']' || t.value === '}' || t.value === '++' || t.value === '--';
  return true;
}
function startsStatement(t) {
  if (t.type === 'name') return t.value !== 'in' && t.value !== 'instanceof' && t.value !== 'of';
  if (t.type === 'num' || t.type === 'str') return true;
  return t.type === 'punct' && (t.value === '{' || t.value === '!' || t.value === '~' || t.value === '++' || t.value === '--');
}

// Where the expression body of an arrow that starts at token k ends (index of the first token after it).
function arrowEnd(toks, k) {
  let q = 0;
  for (let j = k; j < toks.length; j++) {
    const t = toks[j];
    if (j > k && t.nl && endsExpr(toks[j - 1]) && startsStatement(t)) return j;
    if (isCloser(t)) return j;
    if (isOpener(t)) {
      j = jump(toks, j);
      continue;
    }
    if (t.type !== 'punct') continue;
    if (t.value === ',' || t.value === ';') return j;
    if (t.value === '?') q++;
    else if (t.value === ':') {
      if (!q) return j;
      q--;
    }
  }
  return toks.length;
}

// The specifiers of import / export … from / import('…') in a module, as written.
export function importSpecs(src) {
  const toks = tokenize(src);
  return specTokens(toks).map((k) => JSON.parse(quoteOf(src, toks[k])));
}
function specTokens(toks) {
  const out = [];
  for (let k = 0; k < toks.length; k++) {
    if (toks[k].type !== 'str') continue;
    const a = toks[k - 1];
    if (isName(a, 'from') || isName(a, 'import') || (isP(a, '(') && isName(toks[k - 2], 'import') && isP(toks[k + 1], ')'))) out.push(k);
  }
  return out;
}
const quoteOf = (src, t) => {
  const s = src.slice(t.start, t.end);
  return s[0] === "'" ? `"${s.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"')}"` : s;
};

// ---------- the rewrite ----------

const N = { s: '__ring$s', e: '__ring$e', x: '__ring$x', it: '__ring$it', keys: '__ring$k', o: '__ring$o' };
const BODY_OPEN = `${N.e}();try{`;
const BODY_CLOSE = `}finally{${N.x}()}`;

// src: module source; meterUrl: absolute URL of meter.js; rewrite(spec) → the specifier to use instead (or as is).
export function instrument(src, { meterUrl, rewrite = (s) => s }) {
  const toks = tokenize(src);
  const edits = [];
  let seq = 0;
  const open = (pos, text) => edits.push({ pos, end: pos, text, rank: 0, seq: seq++ });
  const close = (pos, text) => edits.push({ pos, end: pos, text, rank: 1, seq: -seq++ }); // inner (found later) closes first
  const replace = (t, text) => edits.push({ pos: t.start, end: t.end, text, rank: 2, seq: seq++ });

  for (const k of specTokens(toks)) {
    const spec = JSON.parse(quoteOf(src, toks[k]));
    const to = rewrite(spec);
    if (to !== spec) replace(toks[k], JSON.stringify(to));
  }

  const classBody = new Set();
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    const dotted = isP(toks[k - 1], '.') || isP(toks[k - 1], '?.');
    if (t.type === 'name' && !dotted) {
      if (t.value === 'class') {
        const nx = toks[k + 1];
        if (!nx || !(nx.type === 'name' || isP(nx, '{'))) continue;
        for (let j = k + 1; j < toks.length; j++) {
          if (isP(toks[j], '{')) {
            classBody.add(j);
            break;
          }
          if (isOpener(toks[j])) j = jump(toks, j);
        }
      } else if (t.value === 'while' && isP(toks[k + 1], '(')) {
        open(toks[k + 1].end, `${N.s}()&&(`);
        close(toks[toks[k + 1].to].start, ')');
      } else if (t.value === 'for' && isP(toks[k + 1], '(')) {
        const o = k + 1;
        const c = toks[o].to;
        const semis = [];
        let iter = -1;
        for (let j = o + 1; j < c; j++) {
          const tj = toks[j];
          if (isOpener(tj)) j = jump(toks, j);
          else if (isP(tj, ';')) semis.push(j);
          else if (iter < 0 && (isName(tj, 'of') || isName(tj, 'in')) && j > o + 1) iter = j;
        }
        if (semis.length === 2) {
          const [a, b] = semis;
          if (b === a + 1) open(toks[a].end, `${N.s}()`);
          else {
            open(toks[a].end, `${N.s}()&&(`);
            close(toks[b].start, ')');
          }
        } else if (iter >= 0) {
          if (toks[iter].value === 'in') replace(toks[iter], 'of');
          open(toks[iter].end, ` ${toks[iter].value === 'in' ? N.keys : N.it}(`);
          close(toks[c].start, ')');
        }
      }
    } else if (isP(t, '{') && !classBody.has(k) && isFunctionBody(toks, k)) {
      open(t.end, BODY_OPEN);
      close(toks[t.to].start, BODY_CLOSE);
    } else if (isP(t, '=>') && k + 1 < toks.length && !isP(toks[k + 1], '{')) {
      const end = arrowEnd(toks, k + 1);
      open(t.end, `{${BODY_OPEN}return(`);
      close(toks[end - 1].end, `)${BODY_CLOSE}}`);
    }
  }

  edits.sort((a, b) => a.pos - b.pos || a.rank - b.rank || a.seq - b.seq);
  const head = `import{s as ${N.s},e as ${N.e},x as ${N.x},it as ${N.it},keys as ${N.keys},o as ${N.o}}from${JSON.stringify(meterUrl)};${N.o}();`;
  // a #! line stays first: the meter import goes at the start of the next line
  const bang = hashbang(src);
  let out = src.slice(0, bang) + head;
  let at = bang;
  for (const ed of edits) {
    out += src.slice(at, ed.pos) + ed.text;
    at = ed.end;
  }
  return out + src.slice(at);
}

// Is the { at k the body of a function: an arrow, function, method, getter or setter.
function isFunctionBody(toks, k) {
  const prev = toks[k - 1];
  if (!prev) return false;
  if (isP(prev, '=>')) return true;
  if (!isP(prev, ')')) return false;
  const before = toks[prev.from - 1];
  if (!before) return false;
  if (before.type === 'name') return !CONTROL.has(before.value);
  return isP(before, '*') || isP(before, ']') || before.type === 'str' || before.type === 'num';
}

// ---------- loading ----------

const METER_URL = new URL('./meter.js', import.meta.url).href;

// base: URL of the fighter folder ending with "/"; read(url) → source text; toUrl(source, url) → URL to import()
// the rewritten module from. Own files (inside base) are rewritten, anything else is imported from where it lies.
export function abilityLoader({ base, read, toUrl }) {
  const built = new Map();
  const rel = (u) => (u.startsWith(base) ? u.slice(base.length) : u);
  const build = (href, chain) => {
    if (chain.includes(href)) return Promise.reject(new Error(`циклический импорт ${[...chain.slice(chain.indexOf(href)), href].map(rel).join(' → ')}: свои файлы способности импортируются без циклов`));
    if (built.has(href)) return built.get(href);
    const p = (async () => {
      const src = await read(href);
      const map = new Map();
      for (const spec of importSpecs(src)) {
        if (map.has(spec) || !/^\.{0,2}\//.test(spec)) continue;
        const u = new URL(spec, href);
        u.search = '';
        u.hash = '';
        map.set(spec, u.href.startsWith(base) ? await build(u.href, [...chain, href]) : u.href);
      }
      return toUrl(instrument(src, { meterUrl: METER_URL, rewrite: (s) => map.get(s) ?? s }), href);
    })();
    built.set(href, p);
    return p;
  };
  return async (script) => import(await build(new URL(script, base).href, []));
}
