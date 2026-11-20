// Sparring partner «Залп» of the ring: one habit — держит дистанцию тремя снарядами и отходит. Plain on purpose.
export default { tick(s){ const d=s.distance, me=s.me, op=s.opponent; if(!me.canAct) return {guard:'high'};
 if(op.airborne && d<260) return {attack:'upper'};
 if(d<200) return me.x>140&&me.x<2060?{attack:'retreat'}:{attack:'heavy'};
 if(me.bars>=3) return {attack:'barrage'};
 if(!me.projectileOut) return (s.tick%3===0)?{attack:'wave',crouch:true}:(s.tick%3===1)?{attack:'spike'}:{attack:'fireball'}; return {walk:-1}; } };
