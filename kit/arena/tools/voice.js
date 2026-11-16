// `arena voice`: a voice from the description in voice.json (ElevenLabs Voice Design) and the lines recorded
// into fighter/voice/<id>.mp3. Requests go from the operator's server over ssh, where the key lives: the key never
// reaches this machine, the contestant folder or the logs. ELEVENLABS_SSH=local runs the same request on this machine
// (python3 / python), the key read from the local file ELEVENLABS_SSH_ENV: still never in the contestant folder or the logs.
//   voice design        three previews of the voice → fighter/voice/design/preview-N.mp3
//   voice pick N        keep preview N as the fighter's voice
//   voice lines [--only id,id] [--force]   record the lines
//   voice status
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { ensure, spend, serviceEnv, ringConfig } from './ring.js';
import { resolveFighterDir } from './load.js';

const SERVER_SCRIPT = String.raw`
import base64, json, sys, urllib.request, urllib.error
P = json.loads(__PARAMS__)
key = None
try:
    with open(P["env_file"], encoding="utf-8") as fh:
        for line in fh:
            k, sep, v = line.strip().partition("=")
            k = k.strip()
            if k.startswith("export "):
                k = k[7:].strip()
            if sep and k == "ELEVENLABS_API_KEY":
                key = v.strip().strip('"').strip("'")
except OSError as exc:
    sys.stderr.write("key file is not readable: %s\n" % type(exc).__name__); sys.exit(3)
if not key:
    sys.stderr.write("no ELEVENLABS_API_KEY in the key file\n"); sys.exit(3)
def call(path, body=None, raw=False):
    req = urllib.request.Request("https://api.elevenlabs.io" + path, data=None if body is None else json.dumps(body).encode("utf-8"),
        method="GET" if body is None else "POST", headers={"xi-api-key": key, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            data = r.read()
    except urllib.error.HTTPError as exc:
        msg = exc.read()[:600].decode("utf-8", "replace").replace(key, "***")
        sys.stderr.write("ElevenLabs HTTP %s: %s\n" % (exc.code, msg)); sys.exit(4)
    except Exception as exc:
        sys.stderr.write("ElevenLabs: %s\n" % str(exc).replace(key, "***")[:300]); sys.exit(4)
    return data if raw else json.loads(data.decode("utf-8"))
a = P["action"]
if a == "subscription":
    s = call("/v1/user/subscription")
    out = {k: s.get(k) for k in ("tier", "status", "character_count", "character_limit")}
elif a == "design":
    body = {"voice_description": P["description"], "model_id": P.get("model") or "eleven_ttv_v3"}
    if P.get("text"): body["text"] = P["text"]
    else: body["auto_generate_text"] = True
    r = call("/v1/text-to-voice/design?output_format=mp3_44100_128", body)
    out = {"text": r.get("text"), "previews": [{"id": p["generated_voice_id"], "audio": p["audio_base_64"], "seconds": p.get("duration_secs")} for p in r.get("previews", [])]}
elif a == "create":
    r = call("/v1/text-to-voice", {"voice_name": P["name"], "voice_description": P["description"], "generated_voice_id": P["generated_voice_id"]})
    out = {"voice_id": r.get("voice_id")}
elif a == "tts":
    body = {"text": P["text"], "model_id": P.get("model") or "eleven_v3"}
    if P.get("language"): body["language_code"] = P["language"]
    data = call("/v1/text-to-speech/%s?output_format=mp3_44100_128" % P["voice_id"], body, raw=True)
    out = {"audio": base64.b64encode(data).decode("ascii")}
else:
    sys.stderr.write("unknown action\n"); sys.exit(2)
sys.stdout.write(json.dumps(out))
`;

function settings() {
  const env = serviceEnv();
  const host = env.ELEVENLABS_SSH;
  const file = env.ELEVENLABS_SSH_ENV;
  if (!host || !file) throw new Error('голос не настроен на этой машине: нужен файл ~/.config/fight-ring/services.env с ELEVENLABS_SSH (ssh-имя сервера или local) и ELEVENLABS_SSH_ENV (файл с ELEVENLABS_API_KEY), настраивает оператор ринга (README)');
  if (host.toLowerCase() === 'off') throw new Error('голос выключен оператором ринга (ELEVENLABS_SSH=off)');
  return { host, file };
}

function server(params, timeoutMs = 240000) {
  const { host, file } = settings();
  return new Promise((resolveP, reject) => {
    const local = host.toLowerCase() === 'local';
    const p = local
      ? spawn(process.platform === 'win32' ? 'python' : 'python3', ['-'], { windowsHide: true })
      : spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', host, 'python3', '-'], { windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => p.kill(), timeoutMs);
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`ElevenLabs${local ? '' : ' через сервер'}: ${(err.trim().split('\n').pop() || `код ${code}`).slice(0, 400)}`));
      try {
        resolveP(JSON.parse(out));
      } catch {
        reject(new Error(`сервер голоса ответил не JSON: ${out.slice(0, 160).replace(/[A-Za-z0-9_-]{32,}/g, '…')} ${err.slice(-200)}`));
      }
    });
    p.stdin.end(SERVER_SCRIPT.replace('__PARAMS__', () => JSON.stringify(JSON.stringify({ ...params, env_file: file }))));
  });
}

function mp3Seconds(file) {
  const s = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return Number(s.trim()) || 0;
}

function readVoice(dir) {
  const v = JSON.parse(readFileSync(join(dir, 'voice.json'), 'utf8'));
  if (!v.description || !Array.isArray(v.lines)) throw new Error('voice.json: нужны description и lines (node arena/cli.mjs check)');
  return v;
}

const stateFile = (dir) => join(dir, 'voice', 'voice-id.json');

async function design(dir) {
  const v = readVoice(dir);
  ensure('voiceDesigns', 1);
  let text = v.lines.map((l) => l.text).join(' ');
  while (text.length < 100) text += ' ' + v.lines.map((l) => l.text).join(' ');
  text = text.slice(0, 1000);
  console.log('Создаю голос по описанию из voice.json (три варианта)…');
  const r = await server({ action: 'design', description: v.description, text, model: 'eleven_ttv_v3' });
  const led = spend('voiceDesigns', 1, v.description.slice(0, 120));
  const out = join(dir, 'voice', 'design');
  mkdirSync(out, { recursive: true });
  const previews = r.previews.map((p, i) => {
    const file = join(out, `preview-${i + 1}.mp3`);
    writeFileSync(file, Buffer.from(p.audio, 'base64'));
    return { n: i + 1, file: relative(dir, file).split('\\').join('/'), generated_voice_id: p.id, seconds: p.seconds };
  });
  writeFileSync(join(out, 'design.json'), JSON.stringify({ description: v.description, text: r.text, previews, at: new Date().toISOString() }, null, 2) + '\n');
  for (const p of previews) console.log(`  вариант ${p.n}: ${p.file} (${(p.seconds || 0).toFixed(1)} с)`);
  console.log(`Разбор вариантов: node arena/cli.mjs voice listen. Выбор: node arena/cli.mjs voice pick <номер>. Создание голоса: ${led.used} из ${led.limit}.`);
}

async function pick(dir, n) {
  const d = JSON.parse(readFileSync(join(dir, 'voice', 'design', 'design.json'), 'utf8'));
  const p = d.previews.find((x) => x.n === Number(n));
  if (!p) throw new Error(`нет варианта ${n}: есть ${d.previews.map((x) => x.n).join(', ')}`);
  const name = JSON.parse(readFileSync(join(dir, 'fighter.json'), 'utf8')).name || 'fighter';
  const cfg = ringConfig();
  const r = await server({ action: 'create', name: `Ринг · ${cfg.id} · ${name}`.slice(0, 60), description: d.description, generated_voice_id: p.generated_voice_id });
  writeFileSync(stateFile(dir), JSON.stringify({ voice_id: r.voice_id, from: p.file, description: d.description, at: new Date().toISOString() }, null, 2) + '\n');
  console.log(`Голос бойца — вариант ${p.n}. Теперь: node arena/cli.mjs voice lines`);
}

async function lines(dir, { only = null, force = false } = {}) {
  const v = readVoice(dir);
  if (!existsSync(stateFile(dir))) throw new Error('голоса ещё нет: node arena/cli.mjs voice design, затем voice pick <номер>');
  const { voice_id } = JSON.parse(readFileSync(stateFile(dir), 'utf8'));
  const want = v.lines.filter((l) => (!only || only.includes(l.id)) && (force || !existsSync(join(dir, 'voice', `${l.id}.mp3`))));
  if (!want.length) return console.log('Все реплики уже записаны (перезаписать: --force).');
  const estimate = want.reduce((s, l) => s + Math.max(1, l.text.length / 13), 0);
  ensure('voiceSeconds', Math.min(estimate, 1));
  let total = 0;
  for (const l of want) {
    ensure('voiceSeconds', Math.max(0.5, l.text.length / 16));
    const r = await server({ action: 'tts', voice_id, text: l.text, model: v.model || 'eleven_v3', language: v.language });
    const file = join(dir, 'voice', `${l.id}.mp3`);
    writeFileSync(file, Buffer.from(r.audio, 'base64'));
    const sec = mp3Seconds(file);
    total += sec;
    const led = spend('voiceSeconds', sec, `${l.id}: ${l.text.slice(0, 80)}`);
    console.log(`  ${l.id} (${l.kind}): ${sec.toFixed(1)} с → voice/${l.id}.mp3   [озвучка ${led.used.toFixed(1)} из ${led.limit} с]`);
  }
  console.log(`Записано ${want.length} реплик, ${total.toFixed(1)} с.`);
}

function status(dir) {
  const v = readVoice(dir);
  const has = existsSync(stateFile(dir));
  console.log(`Голос: ${has ? 'выбран' : 'не создан'}; описание: ${v.description}`);
  for (const l of v.lines) {
    const f = join(dir, 'voice', `${l.id}.mp3`);
    console.log(`  ${existsSync(f) ? '✓' : '·'} ${l.id} (${l.kind}): ${l.text}${existsSync(f) ? ` — ${mp3Seconds(f).toFixed(1)} с` : ''}`);
  }
}

export async function cmdVoice(opts, here) {
  const dir = resolveFighterDir(opts.fighter || 'fighter', here);
  const sub = opts._[1] || 'status';
  if (sub === 'design') return design(dir);
  if (sub === 'pick') return pick(dir, opts._[2]);
  if (sub === 'listen') return (await import('./look.js')).listen(dir, opts._.slice(2));
  if (sub === 'lines') return lines(dir, { only: typeof opts.only === 'string' ? opts.only.split(',') : null, force: !!opts.force });
  if (sub === 'status') return status(dir);
  if (sub === 'account') {
    const s = await server({ action: 'subscription' }, 60000);
    return console.log(`ElevenLabs: тариф ${s.tier}, статус ${s.status}, знаков ${s.character_count} из ${s.character_limit}`);
  }
  throw new Error('voice design | listen [N] | pick <N> | lines [--only id,id] [--force] | status');
}

// the operator's ElevenLabs over ssh, for the judge's own voices (the commentators)
export { server as voiceServer, mp3Seconds };
