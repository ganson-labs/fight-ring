// Unattended agent runs: the prompt word for word from prompts/*.md, headless arguments per agent, the session id
// from the journal, and launch scripts that drop the operator's agent session from the environment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promptText, agentArgs, sessionFrom, stdinFor } from '../judge/run.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

test('промпт бойца берётся слово в слово: всё после строки ---, без заголовка', () => {
  const src = readFileSync(join(root, 'prompts', 'fighter.md'), 'utf8').replace(/\r\n/g, '\n');
  const text = promptText(join(root, 'prompts', 'fighter.md'));
  assert.ok(text.startsWith('Ты участвуешь в турнире'));
  assert.ok(!text.includes('черновик'));
  assert.ok(src.includes(text));
});

test('промпт раздевалки получает номер раунда и минуты, пропуск ловится', () => {
  const f = join(root, 'prompts', 'locker.md');
  const text = promptText(f, { N: 2, M: 20 });
  assert.ok(text.startsWith('Раунд 2 окончен.'));
  assert.match(text, /history\/round-2\//);
  assert.match(text, /У тебя 20 минут/);
  assert.throws(() => promptText(f, { N: 2 }), /\{M\}/);
});

test('без человека: Claude Code в -p с журналом stream-json, Codex exec --json без «-»', () => {
  assert.deepEqual(agentArgs('claude'), ['-p', '--output-format', 'stream-json', '--verbose']);
  assert.deepEqual(agentArgs('claude', { resume: 'abc' }).slice(-2), ['--resume', 'abc']);
  const codex = agentArgs('codex', { resume: 'abc' });
  assert.deepEqual(codex.slice(0, 3), ['exec', 'resume', 'abc']);
  // powershell -File takes a lone dash for a parameter name and refuses to start
  assert.ok(!agentArgs('codex').includes('-') && !codex.includes('-'));
  // Antigravity: the prompt as one NDJSON user event on stdin, the locker room continues the conversation by id
  assert.deepEqual(agentArgs('gemini'), ['--input-format', 'stream-json', '--output-format', 'stream-json']);
  assert.deepEqual(agentArgs('gemini', { resume: 'c-3' }).slice(-2), ['--conversation', 'c-3']);
  const line = stdinFor('gemini', 'Раунд 1 окончен.\nУ тебя "20" минут');
  assert.ok(line.endsWith('\n') && !line.slice(0, -1).includes('\n'));
  assert.deepEqual(JSON.parse(line), { event: 'user', message: { content: 'Раунд 1 окончен.\nУ тебя "20" минут' } });
  assert.equal(stdinFor('claude', 'текст'), 'текст');
});

test('id сессии из первой строки журнала обоих агентов', () => {
  assert.equal(sessionFrom('{"type":"system","subtype":"init","session_id":"s-1"}'), 's-1');
  assert.equal(sessionFrom('{"type":"thread.started","thread_id":"t-2"}'), 't-2');
  assert.equal(sessionFrom('{"event":"init","conversation_id":"c-3","init":{"model":"m"}}'), 'c-3');
  assert.equal(sessionFrom('Reading prompt from stdin...'), null);
});

test('снимок судьи берёт из parts/raw только картинки, на которых сидит боец', async () => {
  const { snapshotFilter } = await import('../judge/match.js');
  const { mkdirSync } = await import('node:fs');
  const base = mkdtempSync(join(tmpdir(), 'ring-snap-'));
  try {
    mkdirSync(join(base, 'parts', 'raw'), { recursive: true });
    writeFileSync(join(base, 'body.json'), JSON.stringify({ parts: { head: { image: 'parts/raw/piece-01.png' }, torso: { image: 'parts/torso.png' } } }));
    const keep = snapshotFilter(base);
    assert.ok(keep(join(base, 'parts', 'raw')));
    assert.ok(keep(join(base, 'parts', 'raw', 'piece-01.png')), 'используемая часть из raw');
    assert.ok(!keep(join(base, 'parts', 'raw', 'piece-02.png')), 'неиспользуемая — нет');
    assert.ok(!keep(join(base, 'parts', 'raw', 'index.png')));
    assert.ok(keep(join(base, 'parts', 'torso.png')) && keep(join(base, 'brain.js')));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

