const reach = {short:125, mid:165, long:220};
const shotSpeed = {slow:6, mid:9, fast:13};
const attack = id => ({attack:id});
const clamp = (x,lo,hi) => Math.max(lo, Math.min(hi,x));
let parryStarted, lastComment, lastHp, guardingTime, activeTime, catalog, habits, lastObserved, previousX, dashSign, seed;

function random() {
  seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
  return seed / 4294967296;
}

function learn(o) {
  const key = o.move ? o.move.id : o.state;
  if (key !== lastObserved || (o.move && o.move.t === 1)) {
    for (const k of Object.keys(habits)) habits[k] *= 0.94;
    habits[key] = (habits[key] || 0) + 1;
  }
  if (o.state === 'dash' && previousX !== o.x) dashSign = Math.sign(o.x - previousX);
  previousX = o.x;
  lastObserved = key;
}
function forecast(o,n,s) {
  let x = o.x;
  if (o.state === 'hitstun' || o.state === 'blockstun') x += o.vx * (1 - Math.pow(.82,n)) / .18;
  else if (o.state === 'dash') {
    const back = o.stateLength === 18, end = Math.min(1,(o.stateTicks+n)/o.stateLength);
    const distance = back ? 140 : o.derived.dashDistance;
    x += (dashSign || o.facing) * distance * (Math.pow(1-o.stateTicks/o.stateLength,2)-Math.pow(1-end,2));
  } else if (o.move && !o.airborne) {
    for (const g of catalog[o.move.id].segments) {
      if (g.advance && o.move.t < g.activeStart) {
        const travel = Math.min(n, g.activeStart-o.move.t) * g.advance / (g.activeStart-g.start);
        x += o.facing * Math.min(travel, Math.max(0,(s.me.x-x)*o.facing-70));
      }
      if (g.type === 'teleport' && o.move.t < g.activeStart && o.move.t+n >= g.activeStart) {
        const target = s.me.x + o.facing*90;
        x = g.to === 'behind' ? (target<s.stage.left || target>s.stage.right ? s.me.x-o.facing*90 : target) : x-o.facing*(g.distance || 300);
      }
    }
  } else x += o.vx * (o.airborne ? n : Math.min(20,n));
  return clamp(x,s.stage.left,s.stage.right);
}
function decide(s) {
  const m=s.me, o=s.opponent, lag=Math.min(s.tick,s.reaction);
  if (!catalog) {
    catalog={};
    for(const move of o.moves) catalog[move.id]=move;
  }
  learn(o);
  activeTime = activeTime*.994 + 1;
  const covered = Boolean(o.guard && (o.state==='neutral' || o.state==='blockstun'));
  guardingTime = guardingTime*.994 + (covered?1:0);
  const entrenched = guardingTime>22 && guardingTime/activeTime>.35;
  const d=Math.abs(forecast(o,lag,s)-m.x);
  const future=n=>Math.abs(forecast(o,lag+n,s)-m.x);
  const mv=o.move && catalog[o.move.id], frame=o.move ? o.move.t+lag : 0;
  let threat=999, zone='mid';
  function danger(t,z) { if(t<threat){threat=t;zone=z;} }
  for(const p of s.projectiles) {
    if(p.mine) continue;
    const t=(m.x-p.x)/p.vx-lag-57/Math.abs(p.vx);
    if(t>=-3) danger(Math.max(0,t),p.zone);
  }
  if(mv) for(const g of mv.segments) {
    if(g.type==='strike' && frame < g.activeEnd && frame+45>=g.activeStart) {
      const eta=Math.max(1,g.activeStart-frame);
      if(future(eta) < (reach[g.reach] || 165)+7) danger(eta,g.zone);
    }
    if(g.type==='projectile' && o.move.t < g.activeStart) {
      const t=g.activeStart-frame+(d-115)/shotSpeed[g.speed];
      if(t>=-2) danger(Math.max(0,t),g.zone);
    }
  }
  const guard=zone==='air'||zone==='overhead'||o.airborne?'high':'low';
  if(m.canAirMove && future(6)<171 && m.y<200) return attack('air_kick');
  if(!m.canAct) return {guard};
  const left=o.stateLength-o.stateTicks-lag;
  const standUp=o.state==='knockdown'? left+20 : o.state==='getup'?left : -100;
  const projectileReady=!m.projectileOut;
  const stale=id=>m.stale[id] || 1;
  const superReady=m.bars>=3;
  const close=future(5), middle=future(10);
  const canThrow=close<127 && !o.airborne;
  const losing=m.hp/m.maxHp+.005<o.hp/o.maxHp;
  const urgent=losing && s.timeLeft<2600;
  const opening= o.state==='parry' || o.state==='throw' || o.state==='staggered' || o.state==='dizzy' ||
    (mv && frame>=mv.firstActive && o.move.duration-frame>=5);
  // Acting again inside a parry window means it connected. The delayed picture
  // may still show the very same projectile coming towards us.
  const parryConfirmed=s.tick>parryStarted && s.tick-parryStarted<=7;
  if(parryConfirmed && d>225 && (losing || superReady) && !o.airborne) {
    if(d<357 && o.posture!=='crouch') return attack('slide');
    return attack('cross');
  }
  if(entrenched && !o.airborne && !o.move && standUp<1 && threat>8) {
    // Pin a stationary guard with mid-height mail. Fire from outside its longest normal.
    if(superReady && d<215 && (o.state==='staggered' && left>=7 || o.state==='dizzy')) return attack('finale');
    if(d<227 && m.x-m.facing*150>s.stage.left && m.x-m.facing*150<s.stage.right) return {dash:'back'};
    if(d<128 && o.guard && o.state==='neutral' && !o.invulnerable) return {throw:true};
    if(projectileReady) return attack('lance');
    if(d>380) return {walk:1};
    return {guard:'high',walk:d<250?-1:0};
  }
  if(mv && mv.segments[0].type==='teleport' && mv.segments[0].to==='behind' && !o.airborne && frame < o.move.duration+4) {
    if(canThrow && mv.slot!=='super' && (frame<=o.move.duration-3 || mv.segments.length>1)) return {throw:true};
    if(close<125 && mv.slot!=='super') return attack('jab');
  }
  if(standUp>0){
    if(d>175 && standUp>18) return {dash:'forward'};
    if(standUp>16) return d>100?{walk:1}:{guard:'low'};
    if(superReady && standUp<=8 && d<218 && o.guard!=='high') return attack('finale');
    if(entrenched && d<216) return {walk:-1,guard:'high'};
    if(standUp<=14 && d<340 && stale('slide')>stale('sweep')+.03) return attack('slide');
    if(standUp<=12 && d<217) return attack('sweep');
    if(standUp<=14 && d>200 && d<360) return attack('slide');
    return {guard:'low'};
  }
  if(superReady && middle<218 && (opening || o.state==='hitstun' || o.airborne || threat<=10 || (!o.guard && d<175))) return attack('finale');
  if(threat<=5 && !(zone==='high' && m.posture==='crouch')) return {parry:true};
  if(zone==='low' && d>390 && threat>=12 && threat<28 && o.projectileOut) return {jump:1};
  if(threat<13) return {guard};
  if(urgent && d>410 && threat>=17 && threat<34 && o.projectileOut) return attack('cross');
  if(urgent && d>420 && (o.projectileOut || o.guard) && !o.invulnerable) return attack('cross');
  if(o.state==='juggle' || o.airborne) {
    const h=o.y+o.vy*(lag+6)-.425*(lag+6)*(lag+7);
    if(close<122 && h>-12) return attack('upper');
    if(middle<205 && h>0) return attack('heavy');
    if(projectileReady && d<650 && h>-45) return attack('spike');
    if(o.state==='juggle' && h<0) return d>165?{dash:'forward'}:{guard:'high'};
  }
  if(s.props.some(p=>p.in<=0 && Math.abs(m.x-p.x)<=p.reach) && d>390 && threat>30) return {use:true};
  if(canThrow && (o.guard || o.state==='parry' || (o.move && o.move.armorLeft>0)) && !o.invulnerable && (o.state!=='parry'||left>=4)) return {throw:true};
  if((habits.blink||0)>1.3 && d>=157 && d<300 && !o.guard && !o.airborne && (!o.canAct || o.stateTicks<35)) {
    if(projectileReady && d>235) return attack('lance');
    return {guard:'low'};
  }
  if(close<123 && (habits.blink||0)>1 && o.posture!=='crouch') return attack('upper');
  if(close<123 && !o.guard && o.posture!=='crouch' && (habits.throw>1 || stale('upper')>.7 || opening)) return attack('upper');
  if(close<123 && habits.throw>1) return attack('jab');
  if(close<128 && opening && !o.invulnerable && o.state!=='throw' && random()<.72) return {throw:true};
  if(close<126 && o.guard!=='low' && (stale('jab')>.85 || d<98) && random()<.56) return attack('jab');
  if(o.guard==='low' && !opening && d<300 && (!mv || frame>=mv.duration)) {
    if(d>127) return d>205?{dash:'forward'}:{walk:1};
    return {throw:true};
  }
  if(d<165 && o.guard==='high') return attack('low');
  if(d<183 && (habits.jab || 0)+(habits.low || 0)>2 && (habits.throw||0)<.6) return attack('breaker');
  if(d<209 && middle<222 && (opening || stale('heavy')>.84) && !o.guard && random()<.73) return attack('heavy');
  if(middle<280 && (!o.guard || opening || stale('cyclone')>.83)) return attack('cyclone');
  if(middle<359 && o.guard!=='low' && (stale('slide')>.71 || !projectileReady)) return attack('slide');
  if(projectileReady && d>150) {
    const fast=o.posture==='crouch'|| (habits.sweep||0)>1 || (habits.slide||0)>1 || (d<390 && !o.airborne);
    return attack(fast || stale('spike')+.07<stale('lance') ? 'lance':'spike');
  }
  if(d>330 && (o.projectileOut || (mv && mv.segments.some(g=>g.type==='projectile'))) && random()<.75) return attack('cross');
  if(d>385) return {dash:'forward'};
  if(d>202) return {walk:1};
  if(d<158 && !o.guard) return attack('knee');
  return attack('heavy');
}
export default {
  init(info) { parryStarted=-100; lastComment=0; lastHp=0; seed=info.seed>>>0; guardingTime=0; activeTime=0; catalog=null; habits={}; previousX=null; dashSign=0; lastObserved=null; },
  tick(s) {
    const action=decide(s);
    if(action.parry) parryStarted=s.tick;
    if(s.tick-lastComment>540 && !action.attack) {
      if(lastHp-s.me.hp>50) action.say='dent';
      else if(s.opponent.state==='staggered' && s.opponent.stateTicks<3) action.say='mark';
      else if(s.distance>600 && s.me.hp/s.me.maxHp>s.opponent.hp/s.opponent.maxHp+.12) action.say='wait';
      if(action.say) lastComment=s.tick;
    }
    lastHp=s.me.hp;
    return action;
  }
};
