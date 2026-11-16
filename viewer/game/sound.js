// Menu sounds from the ring's catalogue (kit/arena/sounds): a soft bleep on move, a confirm on select, a slide on
// back. They go through the menu bus of the shared Sfx, whose level is the "Звуки меню" setting.
export class MenuSound {
  constructor(sfx) {
    this.sfx = sfx;
  }

  unlock() {
    return this.sfx.unlock();
  }

  move() {
    this.sfx.play('menu-move', 1);
  }

  confirm() {
    this.sfx.play('menu-select', 1);
  }

  back() {
    this.sfx.play('menu-back', 1);
  }

  start() {
    this.sfx.play('menu-select', 1.2);
  }
}
