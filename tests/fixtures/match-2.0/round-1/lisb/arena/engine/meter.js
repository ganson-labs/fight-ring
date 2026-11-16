// Step meter for ability code. The ring rewrites every ability module on load (instrument.js): each loop turn and
// each call of the fighter's own function costs a step. A hook call gets ABILITY.hookSteps steps and at most
// ABILITY.hookDepth nested own calls; past that every further step throws, so the hook ends however it catches.
// Steps, not milliseconds: the same fight stops at the same place on any machine, in Node and in the browser.
import { ABILITY } from './constants.js';

let left = 0;
let depth = 0;
let tripped = null; // 'steps' | 'depth' | null

class MeterError extends Error {}

function trip(kind) {
  if (!tripped) tripped = kind;
  throw new MeterError(meterMessage(tripped));
}

// a loop turn
export function s() {
  if (--left < 0) trip('steps');
  return true;
}

// entering an own function
export function e() {
  if (--left < 0) trip('steps');
  if (depth >= ABILITY.hookDepth) trip('depth');
  depth++;
}

// leaving it
export function x() {
  depth--;
}

// for (… of xs) — one step per item
export function* it(xs) {
  for (const v of xs) {
    s();
    yield v;
  }
}

// for (… in o) — one step per key
export function* keys(o) {
  for (const k in o) {
    s();
    yield k;
  }
}

// a module starts evaluating: its top-level code gets a hook's budget
export function o() {
  meterOpen();
}

export function meterOpen(steps = ABILITY.hookSteps) {
  left = steps;
  depth = 0;
  tripped = null;
}

// Between hooks any stray ability code (a toJSON in api.mem, say) throws at its first step.
export function meterClose() {
  left = 0;
  depth = 0;
}

export function meterTripped() {
  return tripped;
}

export function meterMessage(kind) {
  return kind === 'depth'
    ? `вложенность вызовов своих функций больше ${ABILITY.hookDepth}: похоже на бесконечную рекурсию`
    : `больше ${ABILITY.hookSteps} шагов за вызов (шаг — виток цикла или вызов своей функции): похоже на бесконечный цикл`;
}
