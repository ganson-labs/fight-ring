// Sparring partner «Шквал» of the ring. Style below, the brain itself in core.js.
import { makeBrain } from './core.js';

export default makeBrain({
  "range": [
    100,
    170
  ],
  "dash": 0.9,
  "pokes": [
    "jab",
    "low",
    "knee",
    "heavy"
  ],
  "mixLow": [
    "low",
    "sweep"
  ],
  "mixHigh": [
    "overhead",
    "jab",
    "knee",
    "flurry",
    "twin",
    "cyclone"
  ],
  "punish": [
    "jab",
    "upper",
    "heavy"
  ],
  "antiAir": "upper",
  "specials": [
    {
      "id": "rush",
      "when": "far",
      "rate": 0.03
    },
    {
      "id": "slide",
      "when": "far",
      "rate": 0.02
    },
    {
      "id": "ram",
      "when": "near",
      "rate": 0.02
    }
  ],
  "superWhen": "punish",
  "parry": 0.1,
  "throwRate": 0.25,
  "techRate": 0.06,
  "jumpIn": 0.01,
  "patience": 0.1
});
