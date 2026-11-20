// Sparring partner «Прыгун» of the ring: one habit — нападает из прыжка, на земле мешает спецприёмы. Plain on purpose.
export default { tick(s){ const d=s.distance, me=s.me; if(me.airborne){ if(me.vy<2&&d<230&&me.canAirMove) return {attack: me.bars>=3?'meteor':'dive'}; return {}; }
 if(!me.canAct) return {guard:'high'}; if(d>420) return {walk:1}; if(d>200) return {jump:1}; const r=s.tick%4; return r===0?{attack:'breaker'}:r===1?{attack:'twin'}:r===2?{attack:'cyclone'}:{attack:'cross'}; } };
