// Sparring partner «Механик» of the ring. Style below, the brain itself in core.js.
import { makeBrain } from './core.js';

export default makeBrain({
  "range": [
    220,
    360
  ],
  "dash": 0.4,
  "pokes": [
    "heavy",
    "low",
    "smash"
  ],
  "mixLow": [
    "low",
    "sweep"
  ],
  "mixHigh": [
    "overhead"
  ],
  "punish": [
    "jab",
    "heavy"
  ],
  "antiAir": "upper",
  "zoning": [
    "fireball"
  ],
  "specials": [
    {
      "id": "blink",
      "when": "far",
      "rate": 0.02
    },
    {
      "id": "cross",
      "when": "far",
      "rate": 0.02
    },
    {
      "id": "slide",
      "when": "far",
      "rate": 0.03
    }
  ],
  "superWhen": "any",
  "parry": 0.2,
  "throwRate": 0.2,
  "techRate": 0.08,
  "jumpIn": 0.02,
  "patience": 0.4
});
