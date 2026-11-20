// Usage of an agent's run from the judge's journal of it (ledger/runs/<id>-<label>-<time>.jsonl, written by `ring.mjs
// run`): tokens and, when the journal has it, the cost. method.md §1.2: every build records what it spent.
// node scripts/run-usage.mjs <id> [<id> …] [--label build]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('..', import.meta.url)));

export function runUsage(file) {
  const u = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUSD: null, turns: 0 };
  const steps = new Map(); // Antigravity: the last usage of every step
  let resultOut = 0;
  const msgs = new Map(); // Claude Code: the last usage of every assistant message (one line per content block)
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    // Claude Code: usage on every assistant message; a run with background tasks has several `result`s, each with the
    // cost so far — the largest is the run's
    if (o.type === 'assistant' && o.message?.usage && o.message.id) msgs.set(o.message.id, o.message.usage);
    if (o.type === 'result' && Number.isFinite(o.total_cost_usd)) u.costUSD = Math.max(u.costUSD ?? 0, o.total_cost_usd);
    // (the streamed lines carry a partial output count; every `result` has the output of its turn)
    if (o.type === 'result') resultOut += o.usage?.output_tokens || 0;
    // Codex: every turn.completed has the usage of its turn
    if (o.type === 'turn.completed' && o.usage) {
      u.input += (o.usage.input_tokens || 0) - (o.usage.cached_input_tokens || 0);
      u.cacheRead += o.usage.cached_input_tokens || 0;
      u.output += o.usage.output_tokens || 0;
      u.reasoning += o.usage.reasoning_output_tokens || 0;
      u.turns++;
    }
    // Antigravity: usage inside step updates, repeated as a step changes its state
    const su = o.step_update;
    if (su?.usage) steps.set(`${su.conversation_id}:${su.step_index}`, su.usage);
  }
  for (const r of msgs.values()) {
    u.input += r.input_tokens || 0;
    u.output += r.output_tokens || 0;
    u.cacheRead += r.cache_read_input_tokens || 0;
    u.cacheWrite += r.cache_creation_input_tokens || 0;
    u.turns++;
  }
  if (msgs.size && resultOut) u.output = resultOut;
  for (const s of steps.values()) {
    u.input += +s.input_tokens || 0; // (cache reads are counted apart)
    u.cacheRead += +s.cache_read_tokens || 0;
    u.output += +s.output_tokens || 0;
    u.reasoning += +s.thinking_tokens || 0;
    u.turns++;
  }
  return u;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const label = args.includes('--label') ? args[args.indexOf('--label') + 1] : 'build';
  const ids = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--label');
  const runs = existsSync(join(ROOT, 'ledger', 'runs.json')) ? JSON.parse(readFileSync(join(ROOT, 'ledger', 'runs.json'), 'utf8')) : {};
  for (const id of ids) {
    for (const r of (runs[id] || []).filter((x) => x.label === label)) {
      const u = runUsage(r.log);
      console.log(JSON.stringify({ id, label, minutes: r.workMinutes ?? null, exit: r.exit, timedOut: r.timedOut, ...u }));
    }
  }
}
