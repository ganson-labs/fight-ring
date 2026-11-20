// The sound player on a slow device: one loop is asked for while the previous one is still loading.
import test from 'node:test';
import assert from 'node:assert/strict';

test('смена музыки, пока прежняя ещё грузится, не роняет игру', async () => {
  const param = () => ({ value: 0, setTargetAtTime() {}, setValueAtTime() {}, linearRampToValueAtTime() {} });
  const node = () => ({ gain: param(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(), connect(x) { return x; } });
  let started = 0;
  globalThis.AudioContext = class {
    constructor() { this.currentTime = 0; this.state = 'running'; this.destination = node(); }
    createGain() { return node(); }
    createDynamicsCompressor() { return node(); }
    createBufferSource() { return { connect(x) { return x; }, start() { started++; }, stop() {} }; }
    resume() {}
  };
  globalThis.window = globalThis;
  globalThis.addEventListener ??= () => {};
  globalThis.document ??= { addEventListener() {}, hidden: false };
  const { Sfx } = await import('../viewer/sfx.js');
  const sfx = new Sfx();
  sfx.unlock();
  let release;
  const slow = new Promise((r) => (release = r));
  sfx.buffer = () => slow; // the files of both loops are still on their way
  sfx.bed({ music: 'music-menu' });
  assert.doesNotThrow(() => sfx.bed({ music: 'music-temple' })); // the round starts before the menu music arrived
  assert.doesNotThrow(() => sfx.bed({}));
  sfx.bed({ music: 'music-menu' });
  release({ duration: 10 });
  await slow;
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(started, 1, 'играет только последняя запрошенная петля');
});
