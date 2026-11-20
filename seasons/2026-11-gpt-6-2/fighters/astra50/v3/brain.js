const reach = {short:125, mid:165, long:220};
const shotSpeed = {slow:6, mid:9, fast:13};
const attack = id => ({attack:id});
const clamp = (x,lo,hi) => Math.max(lo, Math.min(hi,x));
let parryStarted, lastComment, lastHp, guardingTime, activeTime, catalog, habits, lastObserved, previousX, dashSign, seed;
let lastGetup, lastGrab, wakeAttempt, lowBlocks, cleanWakes;
let delayedWakes, guardedWakes, wakePlan, escapedByDash, lateHits;
let guardedLows, lastBlockSeen, spinReplies, blockReplyAt, previousMeter;
let grabTrial, grabFailures, guardedSamples, neutralSamples, lastGetupPlan;
let lastBlocked, lastTech, lastEnemyGetup, earlyWakeAttack;
let shotHp, unansweredShots;

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
// Integer frame on which the airborne hurtbox disappears at the floor.
function landingFrame(o) {
  const v = o.vy - 0.425;
  return Math.ceil((v + Math.sqrt(v * v + 1.7 * o.y)) / 0.85);
}

function wakeStrike(s, id, startup, mode='early') {
  wakeAttempt = { id, mode, contact:s.tick+startup, observeAt: s.tick + startup + s.reaction + 3, hp: s.opponent.hp };
  return attack(id);
}

function decide(s) {
  const m=s.me, o=s.opponent, lag=Math.min(s.tick,s.reaction);
  if(m.move?.id==='lance' && m.move.t===1) {
    unansweredShots=o.hp===shotHp?unansweredShots+1:0;
    shotHp=o.hp;
  }
  if(o.hp!==shotHp) unansweredShots=0;
  if (!catalog) {
    catalog={};
    for(const move of o.moves) catalog[move.id]=move;
  }
  if(o.state==='blockstun') lastBlockSeen=s.tick;
  if(o.state==='getup') lastEnemyGetup=s.tick;
  const wakeAge=s.tick-lastEnemyGetup;
  if(wakeAge>0 && wakeAge<=17 && (o.move?.t===1 || o.state==='throw' && o.stateTicks===1))
    earlyWakeAttack=clamp(earlyWakeAttack+(wakeAge>=7 && wakeAge<=12?2:-1),0,4);
  if(wakeAge===13 && o.canAct && o.guard) earlyWakeAttack=Math.max(0,earlyWakeAttack-1);
  if(o.move && o.move.t===1 && s.tick-lastBlockSeen<7)
    spinReplies=clamp(spinReplies+(o.move.id==='cyclone'?1.5:-1),0,6);
  if(o.canAct && s.distance<370) {
    neutralSamples=neutralSamples*.985+1;
    guardedSamples=guardedSamples*.985+(o.guard==='low'?1:0);
  }
  const lowSitter=neutralSamples>14 && guardedSamples/neutralSamples>.52;
  learn(o);
  if(m.state==='blockstun') lastBlocked=s.tick;
  if(m.state==='techBreak') lastTech=s.tick;
  if(wakePlan?.grab && s.tick>=wakePlan.end &&
     (m.state==='hitstun' || m.state==='juggle' || m.state==='grabbed')) {
    guardedLows=0; wakePlan=null; grabFailures=2;
  }
  if(grabTrial!==null) {
    if(m.state==='throwing') { grabFailures=0; grabTrial=null; }
    else if(m.state==='techBreak' || m.state==='hitstun' || s.tick-grabTrial>9) {
      grabFailures=3; grabTrial=null;
    }
  }
  // Meter awarded on contact is visible immediately. A short blocked poke
  // gives us time to defend against a spin started on the first free frame.
  const gained=m.meter-previousMeter;
  previousMeter=m.meter;
  if(m.move && (m.move.id==='low' || m.move.id==='jab' || m.move.id==='lance')) {
    const raw=m.move.id==='low'?35:m.move.id==='jab'?25:30;
    if(Math.abs(gained-raw*.075)<.025) {
      const stun=m.move.id==='lance'?13:Math.min(10+Math.floor(raw/10),m.move.duration-m.move.t-2);
      blockReplyAt=s.tick+stun+12;
    }
  }
  if (m.state === 'getup') lastGetup = s.tick;
  if (m.state === 'grabbed') lastGrab = s.tick;
  if (wakeAttempt && m.state==='staggered' && Math.abs(s.tick-wakeAttempt.contact)<=4)
    wakeAttempt.parried=true;
  if (wakeAttempt && s.tick >= wakeAttempt.observeAt) {
    if (wakeAttempt.parried || (o.state==='dash' && o.stateLength===18)) {
      delayedWakes=4;
      escapedByDash=!wakeAttempt.parried;
      cleanWakes=0;
    } else if (o.hp < wakeAttempt.hp && o.state !== 'blockstun') {
      if(wakeAttempt.mode==='early') cleanWakes++;
      else lateHits++;
      lowBlocks = 0;
      if(['slide','sweep'].includes(wakeAttempt.id) || wakeAttempt.mode==='letter')
        guardedLows=Math.max(0,guardedLows-1);
      if(wakeAttempt.mode==='bait') guardedWakes=4;
    } else if (o.state === 'blockstun' && ['slide','sweep'].includes(wakeAttempt.id)) {
      lowBlocks++;
      guardedLows=Math.min(5,guardedLows+2);
      cleanWakes = 0;
      lateHits=0;
      delayedWakes=0;
      guardedWakes=0;
    } else if (o.state==='blockstun' && wakeAttempt.id==='breaker') {
      guardedWakes=4;
      lowBlocks=0;
    } else if(wakeAttempt.mode!=='early') {
      delayedWakes=0;
      guardedWakes=0;
      lateHits=0;
    }
    wakeAttempt = null;
  }
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
  const guard=zone==='air'||zone==='overhead'||(o.airborne && o.state!=='juggle')?'high':'low';
  if(m.canAirMove && future(6)<171 && m.y<200) return attack('air_kick');
  if(!m.canAct) return {guard};
  // The first few free frames are throw-protected. Keep the guard through
  // strikes timed just after getup, including those still hidden by reaction lag.
  if(s.tick-lastGetup <= 5 && d<375) return {guard};
  const left=o.stateLength-o.stateTicks-lag;
  // recordSight stores the pre-action pose. The last observation at tick t-lag
  // is one physics step older than the fighter after that tick.
  const airLeft=o.airborne ? landingFrame(o)-lag-1 : Infinity;
  const landingSoon=o.state==='juggle' && (airLeft<=5 || o.invulnerable);
  const standUp=o.state==='knockdown'? left+20 : o.state==='getup'?left :
    landingSoon ? airLeft+65 : -100;
  const projectileReady=!m.projectileOut;
  const stale=id=>m.stale[id] || 1;
  const superReady=m.bars>=3;
  const close=future(5), middle=future(10);
  const throwProtected=(o.state==='blockstun' || o.state==='hitstun' || o.state==='getup') && left>-6;
  const canThrow=close<127 && !o.airborne;
  const counterGuard=guardedLows>=2 || (guardedLows>=1 && (lowSitter || spinReplies>=1));
  const lethalSuper=o.bars===3 && m.hp<505*o.derived.damageMul*m.derived.takenMul;
  const confirmedGuard=o.canAct && o.guard==='low' && Math.abs(o.vx)<1;
  const losing=m.hp/m.maxHp+.005<o.hp/o.maxHp;
  const urgent=losing && s.timeLeft<2600;
  const opening= o.state==='parry' || o.state==='throw' || o.state==='staggered' || o.state==='dizzy' ||
    (mv && frame>=mv.firstActive && o.move.duration-frame>=5);
  // Acting again inside a parry window means it connected. The delayed picture
  // may still show the very same projectile coming towards us.
  const parryConfirmed=s.tick>parryStarted && s.tick-parryStarted<=7;
  if(parryConfirmed && d<=224 && !o.airborne && !o.projectileOut &&
     !(mv && mv.segments.some(g=>g.type==='projectile'))) {
    if(superReady && middle<218) return attack('finale');
    if(canThrow) return {throw:true};
    if(d<214) return attack('heavy');
    return attack('knee');
  }
  if(parryConfirmed && d>225 && (losing || superReady) && !o.airborne) {
    if(d<357 && o.posture!=='crouch') return attack('slide');
    return attack('cross');
  }
  const baitsWakeAttack=earlyWakeAttack>=2 && (grabFailures>0 || earlyWakeAttack>=4);
  if(standUp>0 && counterGuard && baitsWakeAttack) {
    // Stay outside the throw. A sweep timed just after the guard drops beats
    // the startup of a throw or spin without guessing which one comes next.
    if(standUp>18) {
      if(d>310 && standUp>31) return {dash:'forward'};
      if(d>180) return {walk:1};
      return {guard:'low',walk:d<151?-1:0};
    }
    if(!wakePlan && d<220) wakePlan={end:s.tick+standUp-1,bait:true};
  }
  if(standUp>0 && counterGuard && !wakePlan?.bait && !baitsWakeAttack) {
    const reachForGrab=grabFailures===0 && !lethalSuper;
    // A throw started on the sixth free frame beats a guard held through
    // wake-up. With room to retreat, a blocked shot is safe against cyclone.
    if(standUp>18 && reachForGrab) {
      if(d>253 && standUp>29) return {dash:'forward'};
      return d>104?{walk:1}:{guard:'low'};
    }
    if(standUp>25 && !reachForGrab) {
      if(d>275) return {walk:1};
      return {walk:d<237?-1:0,guard:'high'};
    }
    if(!lastGetupPlan || Math.abs(lastGetupPlan-(s.tick+standUp-1))>6) {
      lastGetupPlan=s.tick+standUp-1;
      wakePlan={end:lastGetupPlan, letter:!reachForGrab || d>145, grab:reachForGrab && d<=145};
    }
  }
  if(wakePlan && (wakePlan.grab || wakePlan.letter)) {
    const age=s.tick-wakePlan.end;
    if(age>13) wakePlan=null;
    else if(wakePlan.grab) {
      if(age<5) return d>110?{walk:1}:{guard:guard};
      wakePlan=null;
      if(close<129) { grabTrial=s.tick; return {throw:true}; }
      return attack('lance');
    } else {
      const travel=9+Math.ceil(Math.max(0,d-118)/13);
      if(age < 1-travel) return {guard:'low'};
      wakePlan=null;
      if(grabFailures>0) grabFailures--;
      if(projectileReady) return wakeStrike(s,'lance',travel,'letter');
      return {guard:'low'};
    }
  }
  // Attack after a predicted parry or backdash. If both heights were blocked,
  // let the opponent leave guard and swing, from outside normal throw range.
  if(guardedWakes>0 && standUp>18) {
    if(d>320 && standUp>35) return {dash:'forward'};
    if(d>184) return {walk:1};
    return {guard:'high',walk:d<158?-1:0};
  }
  if(!wakePlan && standUp>0 && standUp<=18 && d<345 && (delayedWakes>0 || guardedWakes>0)) {
    const spaceBehind=o.facing>0?o.x-s.stage.left:s.stage.right-o.x;
    const impactDistance=d+(escapedByDash && !guardedWakes?Math.min(115,spaceBehind):0);
    wakePlan={end:s.tick+standUp-1, bait:guardedWakes>0,
      super:superReady && lateHits>=1 && o.combo<=1 && impactDistance<213};
  }
  if(wakePlan) {
    const age=s.tick-wakePlan.end;
    if(age>11) wakePlan=null;
    else if(wakePlan.bait) {
      if(o.bars>=3 && age<8) {
        if(age===6 && d<213) return {parry:true};
        return {guard};
      }
      if(age<0) return {guard};
      if(wakePlan.super && age<4) return {guard};
      const useSuper=wakePlan.super;
      wakePlan=null;
      guardedWakes=Math.max(0,guardedWakes-1);
      if(useSuper) return wakeStrike(s,'finale',8,'bait');
      if(d>209) return wakeStrike(s,'slide',14,'bait');
      return wakeStrike(s,'sweep',12,'bait');
    } else {
      if(age < (wakePlan.super?2:-4)) return d>175?{walk:1}:{guard};
      const useSuper=wakePlan.super;
      wakePlan=null;
      if(useSuper) return wakeStrike(s,'finale',8,'evade');
      return wakeStrike(s,'slide',14,'evade');
    }
  }
  if(losing && unansweredShots>=3 && d>224 && !o.airborne && threat>14) {
    unansweredShots=0;
    return d<347?attack('cross'):{dash:'forward'};
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
    if(!guardedWakes && !delayedWakes && lowBlocks>=1 && standUp<=24 && standUp>=19 && d<158)
      return wakeStrike(s,'breaker',24);
    if(standUp>16) return d>100?{walk:1}:{guard:'low'};
    if(superReady && cleanWakes>=2 && o.combo<=1 && d<215) {
      if(standUp>8) return {guard:'low'};
      return wakeStrike(s,'finale',8);
    }
    if(entrenched && d<216) return {walk:-1,guard:'high'};
    if(standUp<=14 && d<340 && stale('slide')>stale('sweep')+.03) return wakeStrike(s,'slide',14);
    if(standUp<=12 && d<217) return wakeStrike(s,'sweep',12);
    if(standUp<=14 && d>200 && d<360) return wakeStrike(s,'slide',14);
    return {guard:'low'};
  }
  const readyIn=mv?o.move.duration-frame-1:0;
  if(mv && (!mv.charge || o.move.phase==='recovery') && !o.airborne && !o.invulnerable && threat>8 && readyIn>=4 &&
     mv.segments.every(g=>frame>=g.activeEnd)) {
    if(superReady && readyIn>=8 && future(8)<218) return attack('finale');
    if(readyIn>=6 && canThrow && !o.guard) return {throw:true};
    if(readyIn>=13 && future(13)<218) return attack('heavy');
    if(readyIn>=10 && future(10)<207) return attack('knee');
    if(readyIn>=7 && close<164) return attack('low');
    if(close<124) return attack('jab');
  }
  if(s.tick-lastBlocked===1 && d<170 && standUp<0 && !o.airborne) {
    if(d<122) return attack('jab');
    if(d<164) return attack('low');
  }
  if(s.tick-lastTech<6 && !o.airborne && d<265) {
    if(close<124) return attack('jab');
    if(close<162) return attack('low');
    return {guard:'low'};
  }
  // A visible parry is already at least a reaction window old. Only spend
  // its remaining recovery on an attack that actually connects in time.
  if(o.state==='parry' && !o.airborne && d<230) {
    if(superReady && left>=8 && d<218) return attack('finale');
    if(left>=5 && close<123 && o.posture!=='crouch') return attack('upper');
    if(left>=6 && canThrow) return {throw:true};
    if(left>=7 && close<165) return attack('low');
    if(left>=4 && close<125) return attack('jab');
    if(lethalSuper && left<9) {
      const behind=m.facing>0?m.x-s.stage.left:s.stage.right-m.x;
      if(behind>108 && d>133) return {dash:'back'};
      return {guard:'low'};
    }
  }
  const replyIn=blockReplyAt-s.tick;
  if(spinReplies>=1 && replyIn>=-2 && replyIn<=16 && d<290) {
    if(replyIn>=0 && replyIn<=4) return {parry:true};
    return {guard};
  }
  if(superReady && airLeft>8 && !o.invulnerable && middle<218 &&
     (opening || (o.state==='hitstun' && left>=6) || o.airborne || threat<=10 || (!o.guard && d<175))) return attack('finale');
  if(threat<=5 && !(zone==='high' && m.posture==='crouch')) return {parry:true};
  if(zone==='low' && d>390 && threat>=12 && threat<28 && o.projectileOut) return {jump:1};
  if(threat<13) return {guard};
  if(urgent && d>410 && threat>=17 && threat<34 && o.projectileOut) return attack('cross');
  if(urgent && d>420 && (o.projectileOut || o.guard) && !o.invulnerable) return attack('cross');
  if(o.state==='juggle' || o.airborne) {
    if(close<122 && airLeft>5 && !o.invulnerable) return attack('upper');
    if(future(13)<215 && airLeft>13 && !o.invulnerable) return attack('heavy');
    const shotTime=12+Math.ceil(Math.max(0,d-115)/13);
    if(projectileReady && d<650 && airLeft>shotTime && !o.invulnerable) return attack('spike');
    if(o.state==='juggle') return d>175?{walk:1}:{guard:'low'};
  }
  if(s.props.some(p=>p.in<=0 && Math.abs(m.x-p.x)<=p.reach) && d>390 && threat>30) return {use:true};
  if(lethalSuper && d<250 && !o.airborne && (o.canAct || left<10 && !mv) && !m.invulnerable) {
    if(o.state==='neutral' && !o.guard && d<122 && (habits.throw||0)>1) return attack('jab');
    const behind=m.facing>0?m.x-s.stage.left:s.stage.right-m.x;
    if(behind>108 && d>133) return {dash:'back'};
    return {guard:'low'};
  }
  if((counterGuard || spinReplies>=2) && !o.airborne && !o.invulnerable &&
     (confirmedGuard || o.state==='blockstun' || (lowSitter && o.canAct))) {
    if(o.state==='neutral' && canThrow && !grabFailures) {grabTrial=s.tick;return {throw:true};}
    if(d<124) return attack('jab');
    if(d<166) return attack('low');
    if(projectileReady) return attack('lance');
    return {guard:'low'};
  }
  if(canThrow && (o.guard || o.state==='parry' || (o.move && o.move.armorLeft>0)) && !o.invulnerable && (o.state!=='parry'||left>=4)) return {throw:true};
  const meetingAtPointBlank=m.vx*m.facing>2 && d<95;
  if(canThrow && o.state==='neutral' && o.vx*o.facing>2 &&
     (meetingAtPointBlank || s.tick-lastGrab<900)) return {throw:true};
  if(o.state==='hitstun' && left<=2 && !o.airborne && d>=127 && d<215) {
    if(d<160) return attack('low');
    if((habits.cyclone||0)+(habits.slide||0)>1) return -left>=7 && -left<=10?{parry:true}:{guard:'low'};
    return attack('sweep');
  }
  if((habits.blink||0)>1.3 && d>=157 && d<300 && !o.guard && !o.airborne && (!o.canAct || o.stateTicks<35)) {
    if(projectileReady && d>235) return attack('lance');
    return {guard:'low'};
  }
  if(close<123 && (habits.blink||0)>1 && o.posture!=='crouch') return attack('upper');
  if(close<123 && !o.guard && o.posture!=='crouch' && (habits.throw>1 || stale('upper')>.7 || opening)) return attack('upper');
  if(close<123 && habits.throw>1) return attack('jab');
  if(close<128 && opening && !o.invulnerable && o.state!=='throw' && random()<.72) return {throw:true};
  if(close<126 && o.guard!=='low' && (stale('jab')>.85 || d<98) && random()<.56) return attack('jab');
  if(o.guard==='low' && !opening && d<300 && (o.canAct || o.state==='blockstun')) {
    if(d>127) return d>205?{dash:'forward'}:{walk:1};
    if(throwProtected) return attack('jab');
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
  init(info) {
    // One prior from the previous bout; new low hits or a different reply
    // immediately weaken it. Other matches start without this observation.
    const rematch=info.options?.round>=3 && info.opponent?.name==='Барон Фонарь';
    guardedLows=rematch?1:0; spinReplies=rematch?1:0;
    lastEnemyGetup=-100; earlyWakeAttack=0;
    shotHp=-1; unansweredShots=0;
    lastBlockSeen=-100; blockReplyAt=-100; lastBlocked=-100; lastTech=-100; previousMeter=0;
    grabTrial=null; grabFailures=0; neutralSamples=0; guardedSamples=0; lastGetupPlan=null;
    guardedWakes=0; delayedWakes=0; wakePlan=null; escapedByDash=false; lateHits=0;
    lastGetup=-100; lastGrab=-1000; wakeAttempt=null; lowBlocks=0; cleanWakes=0;
    parryStarted=-100; lastComment=0; lastHp=0; seed=info.seed>>>0; guardingTime=0; activeTime=0; catalog=null; habits={}; previousX=null; dashSign=0; lastObserved=null;
  },
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
