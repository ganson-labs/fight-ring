// Sparring partner «Скала» of the ring. Style below, the brain itself in core.js.
import { makeBrain } from './core.js';

export default makeBrain({
  "range": [
    130,
    220
  ],
  "dash": 0.1,
  "pokes": [
    "jab",
    "low"
  ],
  "mixLow": [
    "sweep"
  ],
  "mixHigh": [
    "heavy",
    "smash"
  ],
  "punish": [
    "upper",
    "heavy",
    "jab"
  ],
  "antiAir": "upper",
  "zoning": [
    "fireball"
  ],
  "specials": [
    {
      "id": "ram",
      "when": "near",
      "rate": 0.02
    },
    {
      "id": "breaker",
      "when": "near",
      "rate": 0.02
    },
    {
      "id": "twin",
      "when": "near",
      "rate": 0.03
    }
  ],
  "superWhen": "punish",
  "parry": 0.45,
  "throwRate": 0.15,
  "techRate": 0.12,
  "jumpIn": 0,
  "patience": 0.75
});
