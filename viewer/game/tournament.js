// «Турнир» — the console for the day of a shoot: a new match, the agents' windows and the build, a round shown live,
// the locker room by the clock, the final with the reel and the montage pack. Every action is a call to the ring's
// local server (judge/tournament.js); the state lives there, so the console picks up where it was after a restart.
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const mmss = (s) => (s === null || s === undefined ? '—' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`);
const STEPS = [['setup', 'Новый матч'], ['build', 'Сборка'], ['round', 'Раунд'], ['locker', 'Раздевалка'], ['final', 'Финал']];
const CORNER = { red: 'Красный угол', blue: 'Синий угол' };

async function call(path, init) {
  const r = await fetch(`/api/t/${path}`, init);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
// reading the console's state, and its actions (always POST: the server takes an action only that way)
const get = (path) => call(path, { cache: 'no-store' });
const post = (path, body = {}) => call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const t = document.createElement('textarea');
    t.value = text;
    document.body.appendChild(t);
    t.select();
    const ok = document.execCommand('copy');
    t.remove();
    return ok;
  }
}

// mount(html, opts) → section element; ctx: { go, watch(matchId, n), refresh(), toast(text) }
export function tournamentScreen({ mount, ctx, backIn }) {
  let alive = true;
  let opts = null;
  let s = null;
  let timer = 0;
  let form = null;
  let counting = false; // the judge is counting a round: the console says so until the round is ready
  const el = mount(`<div class="head"><div class="left"><span class="kicker">День съёмки</span><h1 class="title slab">Турнир</h1></div></div>
    <ol class="t-steps"></ol><div class="t-body"><div class="empty">…</div></div>`, { id: 'tournament', backIn });
  const steps = el.querySelector('.t-steps');
  const bodyEl = el.querySelector('.t-body');
  const stop = () => {
    alive = false;
    clearInterval(timer);
  };
  ctx.onLeave(stop);
  const act = async (btn, fn) => {
    if (btn) btn.disabled = true;
    try {
      await fn();
    } catch (e) {
      ctx.toast(e.message);
    } finally {
      if (btn) btn.disabled = false;
      await load();
    }
  };

  const draw = () => {
    if (!alive || !s) return;
    const cur = s.step;
    steps.innerHTML = STEPS.map(([k, t], i) => `<li class="${k === cur ? 'on' : STEPS.findIndex((x) => x[0] === cur) > i ? 'done' : ''}"><b>${i + 1}</b>${t}</li>`).join('');
    const keep = document.activeElement?.dataset?.k;
    if (counting) {
      bodyEl.dataset.view = 'counting';
      bodyEl.innerHTML = `<div class="t-big">Судья считает раунд ${s.matchInfo?.next || ''}…</div>`;
      return;
    }
    if (cur === 'setup') drawSetup();
    else if (cur === 'build') drawBuild();
    else if (cur === 'round') drawRound();
    else if (cur === 'locker') drawLocker();
    else drawFinal();
    if (keep) bodyEl.querySelector(`[data-k="${keep}"]`)?.focus();
  };

  // ---------- 1: new match ----------
  const drawSetup = () => {
    if (bodyEl.dataset.view === 'setup') return; // the form keeps what was typed between refreshes
    bodyEl.dataset.view = 'setup';
    if (!opts) return (bodyEl.innerHTML = '<div class="empty">Модели на машине…</div>');
    form ||= {
      red: { agent: 'claude', agentModel: 'claude-opus-5-5', effort: 'high', color: '#e8825a' },
      blue: { agent: 'codex', agentModel: opts.agents.find((a) => a.id === 'codex')?.models[0]?.id || '', effort: 'high', color: '#4fc3c9' },
      firstTo: 2, minutes: 20, stages: opts.stages.slice(0, 3).map((x) => x.id),
    };
    const corner = (k) => {
      const c = form[k];
      const ag = opts.agents.find((a) => a.id === c.agent);
      const model = ag.models.find((m) => m.id === c.agentModel) || ag.models[0];
      return `<div class="t-corner" style="--a:${c.color}"><div class="t-ch"><span class="plate">${CORNER[k]}</span></div>
        <label>Агент<select data-k="${k}.agent">${opts.agents.map((a) => `<option value="${a.id}" ${a.id === c.agent ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
        <label>Модель<select data-k="${k}.agentModel">${ag.models.map((m) => `<option value="${esc(m.id)}" ${m.id === model?.id ? 'selected' : ''}>${esc(m.name)} · ${esc(m.id)}</option>`).join('')}</select></label>
        <label>Сила рассуждения<select data-k="${k}.effort">${(model?.efforts || ['high']).map((e) => `<option ${e === c.effort ? 'selected' : ''}>${e}</option>`).join('')}</select></label>
        <label>Имя на экране<input data-k="${k}.model" value="${esc(c.model || model?.name || '')}"></label>
        <label>Цвет<input type="color" data-k="${k}.color" value="${esc(c.color)}"></label></div>`;
    };
    bodyEl.innerHTML = `<div class="t-pair">${corner('red')}${corner('blue')}</div>
      <div class="t-match"><label>До побед<select data-k="firstTo">${[1, 2, 3].map((n) => `<option ${n === form.firstTo ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <label>Минут на раздевалку<input type="number" min="1" max="120" data-k="minutes" value="${form.minutes}"></label>
      <div class="t-stages">${opts.stages.map((st) => `<label class="chip"><input type="checkbox" data-stage="${st.id}" ${form.stages.includes(st.id) ? 'checked' : ''}>${esc(st.name)}</label>`).join('')}</div></div>
      <div class="t-actions"><button class="btn primary" data-nav data-do="new">Создать матч</button></div>`;
    bodyEl.querySelectorAll('[data-k]').forEach((i) => (i.onchange = () => {
      const [a, b] = i.dataset.k.split('.');
      if (b) {
        form[a][b] = i.value;
        if (b === 'agent') {
          const ag = opts.agents.find((x) => x.id === i.value);
          form[a].agentModel = ag.models[0]?.id || '';
          form[a].model = ag.models[0]?.name || '';
        }
        if (b === 'agentModel') form[a].model = opts.agents.find((x) => x.id === form[a].agent).models.find((m) => m.id === i.value)?.name || form[a].model;
      } else form[a] = a === 'minutes' || a === 'firstTo' ? Number(i.value) : i.value;
      bodyEl.dataset.view = '';
      drawSetup();
    }));
    bodyEl.querySelectorAll('[data-stage]').forEach((i) => (i.onchange = () => {
      form.stages = [...bodyEl.querySelectorAll('[data-stage]:checked')].map((x) => x.dataset.stage);
    }));
    bodyEl.querySelector('[data-do="new"]').onclick = (e) => act(e.currentTarget, async () => {
      const ag = (k) => opts.agents.find((a) => a.id === form[k].agent);
      const corners = Object.fromEntries(['red', 'blue'].map((k) => [k, { ...form[k], model: form[k].model || ag(k).models.find((m) => m.id === form[k].agentModel)?.name || form[k].agentModel }]));
      await post('new', { corners, firstTo: form.firstTo, minutes: form.minutes, stages: form.stages.length ? form.stages : ['rooftop'] });
      bodyEl.dataset.view = '';
      await ctx.refresh();
    });
  };

  const status = (st, { clock = true } = {}) => {
    if (!st) return '';
    const chip = (ok, on, off) => `<span class="t-st ${ok ? 'ok' : ''}">${ok ? on : off}</span>`;
    return `<div class="t-sts">${chip(st.window, 'окно открыто', 'окна нет')}${chip(st.working, 'работает', 'ждёт')}${chip(st.check, `«${esc(st.name)}» проходит check`, 'боец не проходит check')}${st.ready ? '<span class="t-st ok hot">готов</span>' : ''}</div>
      <div class="t-nums">${clock ? `<div><b class="slab">${mmss(st.sinceStart)}</b><em>с начала</em></div>` : ''}<div><b class="slab">${st.pictures[0]}${st.pictures[1] !== null ? `/${st.pictures[1]}` : ''}</b><em>картинок</em></div><div><b class="slab">${st.voice[0]}${st.voice[1] !== null ? `/${st.voice[1]}` : ''}</b><em>с голоса</em></div></div>`;
  };

  // ---------- 2: build ----------
  const drawBuild = () => {
    bodyEl.dataset.view = 'build';
    const card = (k) => {
      const st = s.status[k];
      return `<div class="t-corner" style="--a:${esc(st?.color || '#fff')}"><div class="t-ch"><span class="plate">${CORNER[k]}</span><b class="slab">${esc(st?.model || '')}</b></div>${status(st)}
        <div class="t-row"><button class="btn" data-nav data-k="win-${k}" data-win="${k}">Открыть окно агента</button><button class="btn" data-nav data-k="cp-${k}" data-copy="fighter">Скопировать промпт</button></div></div>`;
    };
    const both = s.status.red?.check && s.status.blue?.check;
    bodyEl.innerHTML = `<div class="t-pair">${card('red')}${card('blue')}</div>
      <div class="t-actions"><button class="btn" data-nav data-k="win-both" data-win="both">Открыть оба окна</button><button class="btn primary" data-nav data-k="round" data-do="round" ${both ? '' : 'disabled'}>Начать раунд 1</button></div>`;
    wire();
  };

  const wire = () => {
    bodyEl.querySelectorAll('[data-win]').forEach((b) => (b.onclick = () => act(b, () => post('window', { corner: b.dataset.win }))));
    bodyEl.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = () => act(b, async () => {
      const p = await get(`prompts?n=${s.locker?.n || ''}`);
      const text = b.dataset.copy === 'locker' ? p.locker : p.fighter;
      ctx.toast((await copy(text)) ? 'Промпт скопирован' : 'Не скопировалось');
    })));
    bodyEl.querySelector('[data-do="round"]')?.addEventListener('click', (e) => act(e.currentTarget, async () => {
      counting = true;
      draw();
      const r = await post('round', {}).finally(() => (counting = false));
      await ctx.refresh();
      ctx.watch(r.match, r.n);
    }));
    bodyEl.querySelector('[data-do="locker"]')?.addEventListener('click', (e) => act(e.currentTarget, () => post('locker', {})));
    bodyEl.querySelector('[data-do="take"]')?.addEventListener('click', (e) => act(e.currentTarget, () => post('take', {})));
    bodyEl.querySelector('[data-do="watch"]')?.addEventListener('click', () => ctx.watch(s.match, s.round.n));
    bodyEl.querySelectorAll('[data-retry]').forEach((a) => (a.onclick = (e) => {
      e.preventDefault();
      act(null, () => post('retry', { job: a.dataset.retry }));
    }));
    bodyEl.querySelectorAll('[data-open]').forEach((a) => (a.onclick = (e) => {
      e.preventDefault();
      act(null, () => post('open', { job: a.dataset.open }));
    }));
    bodyEl.querySelector('[data-do="reel"]')?.addEventListener('click', (e) => act(e.currentTarget, () => post('reel', {})));
    bodyEl.querySelector('[data-do="pack"]')?.addEventListener('click', (e) => act(e.currentTarget, () => post('pack', {})));
    bodyEl.querySelector('[data-do="reset"]')?.addEventListener('click', (e) => act(e.currentTarget, async () => {
      form = null;
      bodyEl.dataset.view = '';
      await post('reset', {});
    }));
  };

  const jobLine = (name, what) => {
    const j = s.jobs?.[name];
    if (!j) return '';
    return `<div class="t-job ${j.status}">${what}: ${j.status === 'queued' ? 'в очереди…' : j.status === 'running' ? 'идёт…' : j.status === 'done' ? `готово${j.video ? ` · <a href="${esc(j.video)}" target="_blank">смотреть</a>` : ''}${j.dir ? ` · <a href="#" data-open="${esc(name)}">открыть папку</a>` : ''}` : `ошибка: ${esc(j.error)} · <a href="#" data-retry="${esc(name)}">повторить</a>`}</div>`;
  };

  // ---------- 3: round ----------
  const drawRound = () => {
    bodyEl.dataset.view = 'round';
    const mi = s.matchInfo;
    const r = s.round;
    const taken = s.locker?.taken && s.locker.n === mi.rounds;
    const score = `<div class="t-score"><span style="color:${esc(s.status.red?.color)}">${esc(mi.models[s.corners.red.id])}</span><b class="slab hot">${mi.score[s.corners.red.id]} : ${mi.score[s.corners.blue.id]}</b><span style="color:${esc(s.status.blue?.color)}">${esc(mi.models[s.corners.blue.id])}</span></div>`;
    const done = r ? `<div class="t-big">Раунд ${r.n}: ${r.winner ? `победа ${esc(mi.models[r.winner])}` : 'ничья'}</div>${jobLine(`round-${r.n}`, 'Ролик раунда и раздевалка')}` : '';
    bodyEl.innerHTML = `${score}${done}
      <div class="t-actions">${r ? '<button class="btn" data-nav data-k="watch" data-do="watch">Смотреть раунд</button>' : ''}
      ${taken ? `<span class="t-st ok">судья забрал бойцов</span><button class="btn primary" data-nav data-k="round" data-do="round">Начать раунд ${mi.next}</button>` : `<button class="btn primary" data-nav data-k="locker" data-do="locker" ${s.locker?.ready ? '' : 'disabled'}>Раздевалка · ${mi.lockerMinutes} мин</button>`}</div>`;
    wire();
  };

  // ---------- 4: locker room ----------
  const drawLocker = () => {
    bodyEl.dataset.view = 'locker';
    const left = Math.max(0, (Date.parse(s.locker.endsAt) - Date.now()) / 1000);
    const card = (k) => `<div class="t-corner" style="--a:${esc(s.status[k]?.color || '#fff')}"><div class="t-ch"><span class="plate">${CORNER[k]}</span><b class="slab">${esc(s.status[k]?.model || '')}</b></div>${status(s.status[k], { clock: false })}
      <div class="t-row"><button class="btn" data-nav data-k="cpl-${k}" data-copy="locker">Скопировать промпт раздевалки</button></div></div>`;
    bodyEl.innerHTML = `<div class="t-clock slab hot">${mmss(left)}</div><div class="t-pair">${card('red')}${card('blue')}</div>
      <div class="t-actions"><button class="btn" data-nav data-k="take" data-do="take">Забрать бойцов сейчас</button></div>`;
    wire();
  };

  // ---------- 5: final ----------
  const drawFinal = () => {
    bodyEl.dataset.view = 'final';
    const mi = s.matchInfo;
    // the reel and the pack take the last round's clip: they wait for it
    const going = (name) => ['queued', 'running'].includes(s.jobs?.[name]?.status);
    const wait = going(`round-${mi.rounds}`);
    const off = (name) => (wait || going(name) ? 'disabled' : '');
    bodyEl.innerHTML = `<div class="t-score"><b class="slab hot">${mi.score[s.corners.red.id]} : ${mi.score[s.corners.blue.id]}</b></div>
      <div class="t-big">${mi.winner ? `Победитель матча: ${esc(mi.models[mi.winner])}` : 'Ничья'}</div>
      ${jobLine(`round-${mi.rounds}`, 'Ролик последнего раунда')}${jobLine('reel', 'Ролик матча')}${jobLine('pack', 'Пакет для монтажа')}
      <div class="t-actions"><button class="btn" data-nav data-k="watch" data-do="watch">Смотреть раунд</button><button class="btn primary" data-nav data-k="reel" data-do="reel" ${off('reel')}>Собрать ролик матча</button><button class="btn primary" data-nav data-k="pack" data-do="pack" ${off('pack')}>Пакет для монтажа</button><button class="btn" data-nav data-k="reset" data-do="reset">Новый матч</button></div>`;
    wire();
  };

  const load = async () => {
    try {
      s = await get('state');
      if (!opts && s.step === 'setup') opts = await get('options');
      draw();
    } catch (e) {
      bodyEl.innerHTML = `<div class="empty">Пульт не отвечает: ${esc(e.message)}</div>`;
    }
  };
  load();
  timer = setInterval(() => alive && load(), 2000);
  return el;
}
