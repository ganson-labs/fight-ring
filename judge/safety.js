// The code of a fighter sent by a stranger, read before it is run: the brains of the roster run on the judge's
// machine, on the robot of the repository and in the browser of every visitor of the site.
//
// The ring already reads the brains once (kit/arena/tools/load.js → scanAbilityModule): words of the clock, timers,
// the network and the host, found by a regular expression in brain.js and the files it imports. That scan says early
// and clearly what a contestant may not use; it was never a fence. What it misses and what is closed here:
//   - a file that brain.js does not import was not read at all            → every .js of the folder is read
//   - self, navigator, postMessage, indexedDB, caches, … were not listed  → listed
//   - fetch is the name fetch for the language and not for a regexp  → a name with an escape is refused
//   - x.constructor.constructor('…') is Function without the word        → constructor, prototype, __proto__, the
//     reflection of Object and Reflect are refused as names and inside strings
//   - x['fetch'], x['\x66etch']                                           → the same words inside strings and
//     templates, and \x, \u and octal escapes in them
// This scan reads tokens (the engine's own tokenizer), so a word in a comment is not an offence and a word glued from
// an escape is.
//
// What reading alone cannot close: a property whose name is put together while the code runs — x['con' + 'structor'],
// x[k]. Forbidding x[expr] would forbid arr[i]. That road is shut where the code runs instead: the judge runs foreign
// brains with code generation from strings switched off (ring.mjs → --disallow-code-generation-from-strings), and the
// site gives the brain's worker a policy without eval and without any address to talk to (judge/site.js → _headers).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { tokenize, importSpecs } from '../kit/arena/engine/instrument.js';
import { listFiles } from '../kit/arena/tools/load.js';

const GROUPS = [
  ['сеть и потоки', 'fetch XMLHttpRequest WebSocket EventSource WebTransport RTCPeerConnection RTCDataChannel BroadcastChannel sendBeacon Worker SharedWorker ServiceWorker serviceWorker MessageChannel MessagePort postMessage onmessage importScripts'],
  ['окружение', 'globalThis self window document global process require navigator Deno Bun'],
  ['хранилища', 'localStorage sessionStorage indexedDB caches cookieStore cookie'],
  ['выполнение кода из строки и доступ к устройству языка', 'eval Function constructor prototype __proto__ Reflect Proxy WebAssembly Symbol getPrototypeOf setPrototypeOf defineProperty defineProperties getOwnPropertyDescriptor getOwnPropertyDescriptors getOwnPropertyNames getOwnPropertySymbols __defineGetter__ __defineSetter__ __lookupGetter__ __lookupSetter__ arguments callee caller'],
  ['сборка имён из кодов', 'fromCharCode fromCodePoint atob btoa unescape decodeURI decodeURIComponent'],
  ['часы, таймеры и случайность', 'Date performance setTimeout setInterval setImmediate queueMicrotask requestAnimationFrame async await Promise Atomics SharedArrayBuffer crypto'],
];
const WORDS = new Map(GROUPS.flatMap(([what, list]) => list.split(' ').map((w) => [w, what])));
// inside a string these are looked for as a part of a word too: 'xconstructor'.slice(1)
const PARTS = ['constructor', 'prototype', '__proto__'];
const WORD_RE = new RegExp(`(?<![A-Za-z0-9_$])(${[...WORDS.keys()].join('|').replace(/\$/g, '\\$')})(?![A-Za-z0-9_$])`);

const lineOf = (src, at) => src.slice(0, at).split('\n').length;

// One file. Returns what is wrong, each with its line.
export function scanSource(src, label = 'код') {
  const out = [];
  const say = (t, text) => out.push(`${label}:${lineOf(src, t.start)}: ${text}`);
  let toks;
  try {
    toks = tokenize(src);
  } catch (err) {
    return [`${label}: файл не разобрать — ${err.message}`];
  }
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.type === 'name') {
      if (t.value.includes('\\')) say(t, `имя «${t.value}» записано через \\u: имена пишутся буквами`);
      else if (WORDS.has(t.value)) say(t, `«${t.value}» мозгам недоступно (${WORDS.get(t.value)})`);
      else if (t.value === 'import') {
        const next = toks[k + 1];
        if (next?.type === 'punct' && next.value === '(') say(t, 'import() мозгам недоступен: свои файлы подключаются строкой import … from в начале файла');
        if (next?.type === 'punct' && next.value === '.') say(t, 'import.meta мозгам недоступен');
      } else if (t.value === 'Math' && toks[k + 1]?.value === '.' && toks[k + 2]?.value === 'random') say(t, 'Math.random мозгам недоступен: случайность — свой генератор с зерном info.seed');
    } else if (t.type === 'str' || t.type === 'tpl') {
      const text = src.slice(t.start, t.end);
      if (/\\(?:x|u|[0-7])/.test(text)) say(t, 'в строке кода есть \\x, \\u или восьмеричный код: буквы в строках пишутся как есть');
      const hit = text.match(WORD_RE)?.[1] || PARTS.find((p) => text.includes(p));
      if (hit) say(t, `в строке кода есть «${hit}» (${WORDS.get(hit)}): так достают то, что мозгам недоступно`);
    }
  }
  return out;
}

// Every .js of a fighter folder. Returns { files: [...], errors: [...] }.
export function scanFighterCode(dir) {
  dir = resolve(dir);
  const errors = [];
  const files = [...listFiles(dir)].filter((f) => f.toLowerCase().endsWith('.js')).sort();
  const reached = new Set();
  const visit = (rel) => {
    if (reached.has(rel)) return;
    reached.add(rel);
    const file = join(dir, rel);
    if (!existsSync(file)) return;
    let specs = [];
    try {
      specs = importSpecs(readFileSync(file, 'utf8'));
    } catch {
      return; // scanSource says why
    }
    for (const spec of specs) {
      const target = resolve(dirname(file), spec);
      const inside = /^\.{1,2}\//.test(spec) && target.startsWith(dir + sep);
      // a contestant's kit lets the brains import ../arena/engine/index.js; a fighter of the roster lies in another
      // place of the site and has no such neighbour, so there the import would not load in the browser
      if (!inside) errors.push(`${rel}: импорт «${spec}» — бойцу общего набора можно подключать только свои файлы из своей папки`);
      else if (!target.endsWith('.js')) errors.push(`${rel}: импорт «${spec}» — подключаются только файлы .js`);
      else visit(relative(dir, target).split(sep).join('/'));
    }
  };
  visit('brain.js');
  for (const rel of files) {
    errors.push(...scanSource(readFileSync(join(dir, rel), 'utf8'), rel));
    if (!reached.has(rel)) errors.push(`${rel}: мозги (brain.js) этот файл не подключают — убери его из папки бойца`);
  }
  return { files, errors };
}
