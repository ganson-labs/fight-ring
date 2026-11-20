// Sparring partner «Бросок» of the ring: one habit — только сближается и бросает. Plain on purpose.
export default { tick(s){ const d=s.distance, me=s.me, op=s.opponent; if(!me.canAct) return {guard:'high'};
 if(op.state==='knockdown'||op.state==='getup') return d>110?{walk:1}:{guard:'high'};
 if(d>125) return d>330?{dash:'forward'}:{walk:1};
 return {throw:true}; } };
