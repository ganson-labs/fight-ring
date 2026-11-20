// Sparring partner «Таран» of the ring: one habit — бьёт только приёмами с бронёй и зарядом. Plain on purpose.
export default { tick(s){ const d=s.distance; if(!s.me.canAct) return {guard:'high'}; if(d>230) return {walk:1}; return (s.tick%3)?{attack:'ram'}:{attack:'smash'}; } };
