// Sparring partner «Круг» of the ring: one habit — подходит и бьёт только круговой подсечкой. Plain on purpose.
export default { tick(s){ const d=s.distance; if(!s.me.canAct) return {guard:'low'}; if(d>215) return {walk:1}; return {attack:'sweep',crouch:true}; } };
