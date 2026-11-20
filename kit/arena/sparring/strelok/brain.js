// Sparring partner «Стрелок» of the ring. Style below, the brain itself in core.js.
import { makeBrain } from './core.js';

export default makeBrain({
  "range": [
    380,
    520
  ],
  "dash": 0.5,
  "pokes": [
    "heavy"
  ],
  "mixLow": [
    "low"
  ],
  "mixHigh": [
    "jab"
  ],
  "punish": [
    "heavy",
    "jab"
  ],
  "antiAir": "upper",
  "zoning": [
    "fireball",
    "wave",
    "spike",
    "lance"
  ],
  "specials": [
    {
      "id": "retreat",
      "when": "near",
      "rate": 0.05
    }
  ],
  "superWhen": "any",
  "parry": 0.15,
  "throwRate": 0.1,
  "techRate": 0.08,
  "jumpIn": 0,
  "patience": 0.35
});
