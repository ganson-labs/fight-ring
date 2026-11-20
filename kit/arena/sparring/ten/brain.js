// Sparring partner «Тень» of the ring: one habit — заходит за спину и чередует удар в середину и вниз. Plain on purpose.
export default { tick(s){ const d=s.distance, me=s.me, op=s.opponent; if(!me.canAct) return {guard:'high'};
 if(d>160) return {attack:'blink'}; return (s.tick%2)?{attack:'jab'}:{attack:'low',crouch:true}; } };
