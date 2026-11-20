// Sparring partner «Черепаха» of the ring: one habit — сидит в блоке по тому, что видит, и наказывает восстановление. Plain on purpose.
// block everything by sight, punish recoveries with heavy / jab
export default { tick(s){ const d=s.distance, me=s.me, op=s.opponent, lag=s.reaction; if(!me.canAct && me.state!=='blockstun') return {guard:'low'};
 const mv=op.move&&op.moves.find(m=>m.id===op.move.id);
 if(mv&&op.move.phase==='recovery'&&op.move.duration-op.move.t>lag+5){ if(d<125) return {attack:'jab'}; if(d<215) return {attack:'heavy'}; }
 const zone=mv&&mv.segments.find(g=>g.zone)?.zone; const high=zone==='overhead'||zone==='air'||zone==='high'||op.airborne;
 if(d<130&&op.state==='neutral'&&s.tick%7===0) return {throw:true};
 return {guard:high?'high':'low',crouch:!high}; } };
