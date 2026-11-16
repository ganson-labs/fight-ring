// The ring's sound catalogue, built by scripts/build-sounds.mjs from scripts/sounds.sources.json (origins and
// licences: README.md here). kind: sfx — a fighter may choose it for a move (moves.json → sounds), ui — menus,
// ambience and music — stage beds that loop. gain: its level in the ring's mix.
export const SOUNDS = {
  "hit-light": {
    "kind": "sfx",
    "what": "лёгкий удар рукой",
    "files": [
      "hit-light-1.ogg",
      "hit-light-2.ogg",
      "hit-light-3.ogg"
    ],
    "gain": 0.8
  },
  "hit-heavy": {
    "kind": "sfx",
    "what": "сильный удар рукой",
    "files": [
      "hit-heavy-1.ogg",
      "hit-heavy-2.ogg"
    ],
    "gain": 1
  },
  "kick": {
    "kind": "sfx",
    "what": "удар ногой",
    "files": [
      "kick.ogg"
    ],
    "gain": 0.9
  },
  "kick-heavy": {
    "kind": "sfx",
    "what": "сильный удар ногой",
    "files": [
      "kick-heavy.ogg"
    ],
    "gain": 1
  },
  "block": {
    "kind": "sfx",
    "what": "удар в блок",
    "files": [
      "block.ogg"
    ],
    "gain": 0.8
  },
  "parry": {
    "kind": "sfx",
    "what": "парирование, звон",
    "files": [
      "parry.ogg"
    ],
    "gain": 0.8
  },
  "grab": {
    "kind": "sfx",
    "what": "захват для броска",
    "files": [
      "grab.ogg"
    ],
    "gain": 0.8
  },
  "bodyfall": {
    "kind": "sfx",
    "what": "падение тела",
    "files": [
      "bodyfall.ogg"
    ],
    "gain": 0.95
  },
  "ko": {
    "kind": "sfx",
    "what": "нокаут",
    "files": [
      "ko.ogg"
    ],
    "gain": 1
  },
  "super-start": {
    "kind": "sfx",
    "what": "запуск суперприёма",
    "files": [
      "super-start.ogg"
    ],
    "gain": 0.9
  },
  "super-hit": {
    "kind": "sfx",
    "what": "попадание суперприёма",
    "files": [
      "super-hit.ogg"
    ],
    "gain": 1
  },
  "projectile": {
    "kind": "sfx",
    "what": "запуск снаряда",
    "files": [
      "projectile.ogg"
    ],
    "gain": 0.8
  },
  "projectile-hit": {
    "kind": "sfx",
    "what": "попадание снаряда",
    "files": [
      "projectile-hit.ogg"
    ],
    "gain": 0.9
  },
  "teleport": {
    "kind": "sfx",
    "what": "телепорт",
    "files": [
      "teleport.ogg"
    ],
    "gain": 0.8
  },
  "teleport-magic": {
    "kind": "sfx",
    "what": "телепорт с искрами",
    "files": [
      "teleport-magic.ogg"
    ],
    "gain": 0.7
  },
  "dash": {
    "kind": "sfx",
    "what": "рывок",
    "files": [
      "dash.ogg"
    ],
    "gain": 0.55
  },
  "jump": {
    "kind": "sfx",
    "what": "прыжок",
    "files": [
      "jump.ogg"
    ],
    "gain": 0.45
  },
  "land": {
    "kind": "sfx",
    "what": "приземление",
    "files": [
      "land.ogg"
    ],
    "gain": 0.5
  },
  "whoosh-light": {
    "kind": "sfx",
    "what": "взмах лёгкого удара",
    "files": [
      "whoosh-light-1.ogg",
      "whoosh-light-2.ogg"
    ],
    "gain": 0.4
  },
  "whoosh-heavy": {
    "kind": "sfx",
    "what": "взмах сильного удара",
    "files": [
      "whoosh-heavy-1.ogg",
      "whoosh-heavy-2.ogg"
    ],
    "gain": 0.5
  },
  "whip": {
    "kind": "sfx",
    "what": "щелчок хлыста",
    "files": [
      "whip.ogg"
    ],
    "gain": 0.6
  },
  "fire": {
    "kind": "sfx",
    "what": "огонь, вспышка пламени",
    "files": [
      "fire.ogg"
    ],
    "gain": 0.8
  },
  "ice": {
    "kind": "sfx",
    "what": "лёд, заморозка",
    "files": [
      "ice.ogg"
    ],
    "gain": 0.8
  },
  "electric": {
    "kind": "sfx",
    "what": "электричество, разряд",
    "files": [
      "electric.ogg"
    ],
    "gain": 0.75
  },
  "magic-impact": {
    "kind": "sfx",
    "what": "магический удар",
    "files": [
      "magic-impact.ogg"
    ],
    "gain": 0.8
  },
  "sparkle": {
    "kind": "sfx",
    "what": "вжух с блёстками",
    "files": [
      "sparkle.ogg"
    ],
    "gain": 0.6
  },
  "glitch": {
    "kind": "sfx",
    "what": "цифровой сбой с треском",
    "files": [
      "glitch.ogg"
    ],
    "gain": 0.6
  },
  "bass-hit": {
    "kind": "sfx",
    "what": "басовый удар",
    "files": [
      "bass-hit.ogg"
    ],
    "gain": 0.8
  },
  "impact-epic": {
    "kind": "sfx",
    "what": "эпичный удар с хвостом",
    "files": [
      "impact-epic.ogg"
    ],
    "gain": 0.9
  },
  "braam": {
    "kind": "sfx",
    "what": "тёмный трейлерный рог",
    "files": [
      "braam.ogg"
    ],
    "gain": 0.7
  },
  "riser": {
    "kind": "sfx",
    "what": "нарастание с ударом",
    "files": [
      "riser.ogg"
    ],
    "gain": 0.6
  },
  "heartbeat": {
    "kind": "sfx",
    "what": "удар сердца",
    "files": [
      "heartbeat.ogg"
    ],
    "gain": 0.8
  },
  "gong": {
    "kind": "sfx",
    "what": "гонг раунда",
    "files": [
      "gong.ogg"
    ],
    "gain": 0.8
  },
  "crowd": {
    "kind": "sfx",
    "what": "публика ликует",
    "files": [
      "crowd-1.ogg",
      "crowd-2.ogg"
    ],
    "gain": 0.55
  },
  "thunder": {
    "kind": "sfx",
    "what": "молния и гром",
    "files": [
      "thunder.ogg"
    ],
    "gain": 0.9
  },
  "title-slam": {
    "kind": "sfx",
    "what": "удар названия: металл, искры, жар",
    "files": [
      "title-slam.ogg"
    ],
    "gain": 1
  },
  "vs-impact": {
    "kind": "sfx",
    "what": "удар экрана VS",
    "files": [
      "vs-impact.ogg"
    ],
    "gain": 0.9
  },
  "vs-whoosh": {
    "kind": "sfx",
    "what": "пролёт половин экрана VS",
    "files": [
      "vs-whoosh.ogg"
    ],
    "gain": 0.6
  },
  "menu-move": {
    "kind": "ui",
    "what": "меню: перемещение",
    "files": [
      "menu-move.ogg"
    ],
    "gain": 0.35
  },
  "menu-select": {
    "kind": "ui",
    "what": "меню: выбор",
    "files": [
      "menu-select.ogg"
    ],
    "gain": 0.5
  },
  "menu-back": {
    "kind": "ui",
    "what": "меню: назад",
    "files": [
      "menu-back.ogg"
    ],
    "gain": 0.45
  },
  "amb-rooftop": {
    "kind": "ambience",
    "what": "фон крыши: ливень над городом",
    "files": [
      "amb-rooftop.ogg"
    ],
    "gain": 0.5,
    "loop": true
  },
  "amb-server": {
    "kind": "ambience",
    "what": "фон серверной: гул и вентиляторы",
    "files": [
      "amb-server.ogg"
    ],
    "gain": 0.5,
    "loop": true
  },
  "amb-foundry": {
    "kind": "ambience",
    "what": "фон литейного цеха: машины и треск металла",
    "files": [
      "amb-foundry.ogg"
    ],
    "gain": 0.5,
    "loop": true
  },
  "amb-temple": {
    "kind": "ambience",
    "what": "фон храма: ветер, птицы, колокольчики",
    "files": [
      "amb-temple.ogg"
    ],
    "gain": 0.5,
    "loop": true
  },
  "music-rooftop": {
    "kind": "music",
    "what": "музыка крыши: синты и тайко",
    "files": [
      "music-rooftop.ogg"
    ],
    "gain": 0.55,
    "loop": true
  },
  "music-server": {
    "kind": "music",
    "what": "музыка серверной: холодная электроника",
    "files": [
      "music-server.ogg"
    ],
    "gain": 0.55,
    "loop": true
  },
  "music-foundry": {
    "kind": "music",
    "what": "музыка литейного цеха: металл и тяжёлые гитары",
    "files": [
      "music-foundry.ogg"
    ],
    "gain": 0.55,
    "loop": true
  },
  "music-temple": {
    "kind": "music",
    "what": "музыка храма: сякухати и тайко",
    "files": [
      "music-temple.ogg"
    ],
    "gain": 0.55,
    "loop": true
  }
};

// names a fighter can use in moves.json → sounds
export const SOUND_NAMES = Object.keys(SOUNDS).filter((n) => SOUNDS[n].kind === 'sfx');
