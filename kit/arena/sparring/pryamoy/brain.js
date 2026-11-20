// Sparring partner «Прямой» of the ring: one habit — подходит на дальность и бьёт одним дальним ударом. Plain on purpose.
export default { tick(s){ const d=s.distance; if(!s.me.canAct) return {guard:'high'}; if(d>215) return {walk:1}; return {attack:'heavy'}; } };
