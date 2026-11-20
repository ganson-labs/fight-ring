// Voice slots of the ElevenLabs account are few (30). Every build makes one voice «Ринг · <id> · <fighter>», and
// twice in two days the voices of past builds filled the account, so later builds got «30 / 30 custom voices»
// (pilot 3.0 v4: three of five). The judge frees the slots itself:
//  - after every run of a contestant's agent (build, voice, locker) it deletes that contestant's voice: the lines are
//    files already; voice-id.json keeps the id and the preview and is marked `released`. `voice lines` makes the voice
//    again from the same preview when it is needed (ElevenLabs gives back the same voice_id, checked 18.11.2026);
//  - before a new build it sweeps every «Ринг · <id> · …» voice whose contestant is not running now.
// Only voices named «Ринг · <id> · …» are ever deleted; the voice server checks the name too, next to the key. The
// judge's own voices («Ринг моделей · ведущий», «… · эксперт»), clones and any other voice are never touched.
//   node ring.mjs voices [--sweep] [--dry]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { voiceServer } from '../kit/arena/tools/voice.js';
import { getContestant, registry } from './contestants.js';

export const RING_VOICE = 'Ринг · ';
export const voicePrefix = (id) => `${RING_VOICE}${id} · `;

// the contestant a voice belongs to, or null for any voice that is not a contestant's of the ring
export function ringVoiceOwner(name) {
  const s = String(name || '');
  if (!s.startsWith(RING_VOICE)) return null;
  const id = s.slice(RING_VOICE.length).split(' · ')[0];
  return /^[a-z0-9-]+$/.test(id) && s.startsWith(voicePrefix(id)) ? id : null;
}

const stateFile = (root) => join(root, 'fighter', 'voice', 'voice-id.json');

function markReleased(root, voiceId, at) {
  const f = stateFile(root);
  if (!existsSync(f)) return false;
  const st = JSON.parse(readFileSync(f, 'utf8'));
  if (voiceId && st.voice_id !== voiceId) return false;
  if (st.released) return true;
  writeFileSync(f, JSON.stringify({ ...st, released: at }, null, 2) + '\n');
  return true;
}

const gone = (err) => /HTTP 404|voice_not_found|does not exist/i.test(String(err?.message || err));

// Delete one contestant's voice after its run. Returns { id, voice, deleted | skipped }.
export async function releaseVoice(id, { server = voiceServer, root = null, now = () => new Date().toISOString() } = {}) {
  root ||= getContestant(id).root;
  const f = stateFile(root);
  if (!existsSync(f)) return { id, skipped: 'голоса нет' };
  const st = JSON.parse(readFileSync(f, 'utf8'));
  if (st.released) return { id, voice: st.voice_id, skipped: 'уже освобождён' };
  try {
    await server({ action: 'delete', voice_id: st.voice_id, prefix: voicePrefix(id) }, 60000);
  } catch (err) {
    if (!gone(err)) throw err; // a refusal (not the ring's name) or a failure: the state stays as it is
  }
  markReleased(root, st.voice_id, now());
  return { id, voice: st.voice_id, deleted: true };
}

// Delete every «Ринг · <id> · …» voice whose contestant is not in `active`. dry: only say what would go.
export async function sweepVoices({ server = voiceServer, active = [], dry = false, reg = registry(), now = () => new Date().toISOString() } = {}) {
  const r = await server({ action: 'list' }, 90000);
  const out = { used: r.used, limit: r.limit, deleted: [], kept: [] };
  for (const v of r.voices || []) {
    const owner = ringVoiceOwner(v.name);
    if (!owner) continue; // not a contestant's voice: never touched
    if (active.includes(owner)) {
      out.kept.push(v.name);
      continue;
    }
    if (!dry) {
      try {
        await server({ action: 'delete', voice_id: v.voice_id, prefix: voicePrefix(owner) }, 60000);
      } catch (err) {
        if (!gone(err)) throw err;
      }
      if (reg[owner]?.root) markReleased(reg[owner].root, v.voice_id, now());
    }
    out.deleted.push(v.name);
  }
  return out;
}

// Contestants whose agent runs now: a run started within its own limit and not ended.
export function activeContestants(runs, nowMs = Date.now()) {
  const out = [];
  for (const [id, list] of Object.entries(runs || {})) {
    if (list.some((x) => !x.ended && nowMs - Date.parse(x.started) < ((x.minutes || 300) + 30) * 60000)) out.push(id);
  }
  return out;
}
