import assert from 'node:assert/strict';
import test from 'node:test';

let RegisteredProcessor = null;
globalThis.sampleRate = 48000;
globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.port = { onmessage: null, postMessage() {} };
  }
};
globalThis.registerProcessor = (_name, Processor) => { RegisteredProcessor = Processor; };
await import('../src/parametricEq.worklet.js');

function runTone(band, phaseRelation = 1, blocks = 400) {
  const processor = new RegisteredProcessor({ processorOptions: { bands: [band] } });
  let phase = 0;
  let inputEnergy = 0;
  let outputEnergy = 0;
  for (let block = 0; block < blocks; block++) {
    const left = new Float32Array(128);
    const right = new Float32Array(128);
    const outputLeft = new Float32Array(128);
    const outputRight = new Float32Array(128);
    for (let frame = 0; frame < 128; frame++) {
      const sample = 0.25 * Math.sin(phase);
      phase += 2 * Math.PI * 1000 / sampleRate;
      left[frame] = sample;
      right[frame] = sample * phaseRelation;
    }
    processor.process([[left, right]], [[outputLeft, outputRight]]);
    if (block >= blocks - 40) {
      for (let frame = 0; frame < 128; frame++) {
        inputEnergy += left[frame] ** 2 + right[frame] ** 2;
        outputEnergy += outputLeft[frame] ** 2 + outputRight[frame] ** 2;
      }
    }
  }
  return Math.sqrt(outputEnergy / inputEnergy);
}

test('actual parametric EQ worklet applies a bell boost at its center frequency', () => {
  const ratio = runTone({
    enabled: true, type: 'peaking', frequency: 1000, gain: 6, q: 2, mode: 'stereo'
  });
  assert.ok(ratio > 1.9 && ratio < 2.1, `expected approximately +6 dB, received ${ratio}`);
});

test('mid/side EQ isolates side energy from a mono-compatible signal', () => {
  const band = { enabled: true, type: 'peaking', frequency: 1000, gain: 6, q: 2, mode: 'side' };
  const monoRatio = runTone(band, 1);
  const sideRatio = runTone(band, -1);
  assert.ok(Math.abs(monoRatio - 1) < 1e-6, `expected mid-only signal to remain unchanged, received ${monoRatio}`);
  assert.ok(sideRatio > 1.9 && sideRatio < 2.1, `expected side signal to receive +6 dB, received ${sideRatio}`);
});

test('stereo processing preserves a legitimately silent right channel', () => {
  const processor = new RegisteredProcessor({ processorOptions: { bands: [] } });
  const left = Float32Array.from([0.25, -0.25, 0.5, -0.5]);
  const right = new Float32Array(4);
  const outputLeft = new Float32Array(4);
  const outputRight = new Float32Array(4);
  processor.process([[left, right]], [[outputLeft, outputRight]]);
  assert.deepEqual(outputLeft, left);
  assert.deepEqual(outputRight, right);
});
