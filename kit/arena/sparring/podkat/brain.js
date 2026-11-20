// Sparring partner «Подкат» of the ring: one habit — рывок издалека, вблизи подкат и колено. Plain on purpose.
export default { tick(s){ const d=s.distance; if(!s.me.canAct) return {guard:'high'}; if(d>480) return {walk:1}; if(d>250) return {attack:'rush'}; return (s.tick%2)?{attack:'slide',crouch:true}:{attack:'knee'}; } };
