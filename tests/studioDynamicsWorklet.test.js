import assert from 'node:assert/strict';
import test from 'node:test';

const meterMessages = [];
let RegisteredProcessor = null;
globalThis.sampleRate = 48000;
globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.port = {
      onmessage: null,
      postMessage(message) { meterMessages.push(message); }
    };
  }
};
globalThis.registerProcessor = (_name, Processor) => { RegisteredProcessor = Processor; };
await import('../src/studioDynamics.worklet.js');

function runTone(config, frequency, blocks = 500) {
  const processor = new RegisteredProcessor({ processorOptions: { config } });
  let phase = 0;
  let inputEnergy = 0;
  let outputEnergy = 0;
  let measuredFrames = 0;
  for (let block = 0; block < blocks; block++) {
    const left = new Float32Array(128);
    const right = new Float32Array(128);
    const outputLeft = new Float32Array(128);
    const outputRight = new Float32Array(128);
    for (let frame = 0; frame < 128; frame++) {
      const sample = 0.5 * Math.sin(phase);
      phase += 2 * Math.PI * frequency / sampleRate;
      left[frame] = sample;
      right[frame] = sample;
    }
    processor.process([[left, right]], [[outputLeft, outputRight]]);
    if (block > blocks - 50) {
      for (let frame = 0; frame < 128; frame++) {
        inputEnergy += left[frame] * left[frame];
        outputEnergy += outputLeft[frame] * outputLeft[frame];
        measuredFrames++;
      }
    }
  }
  return Math.sqrt(outputEnergy / measuredFrames) / Math.sqrt(inputEnergy / measuredFrames);
}

const disabledDeEsser = { enabled: false };
const disabledDynamicEq = { enabled: false, bands: [] };
const disabledCompressor = { enabled: false };

test('actual worklet dynamic band reduces only after its detector crosses threshold', () => {
  const gain = runTone({
    dynamicEq: {
      enabled: true,
      bands: [{ frequency: 1000, q: 1.5, thresholdDb: -50, ratio: 10, rangeDb: 6, attackMs: 1, releaseMs: 100 }]
    },
    deEsser: disabledDeEsser,
    compressor: disabledCompressor
  }, 1000);
  assert.ok(gain < 0.62, `expected about 6 dB of adaptive reduction, received gain ${gain}`);
});

test('actual worklet compressor never exceeds configured maximum reduction', () => {
  const gain = runTone({
    dynamicEq: disabledDynamicEq,
    deEsser: disabledDeEsser,
    compressor: {
      enabled: true,
      thresholdDb: -40,
      ratio: 20,
      attackMs: 1,
      releaseMs: 100,
      kneeDb: 0,
      maxReductionDb: 3,
      mix: 1,
      makeupDb: 0
    }
  }, 1000);
  assert.ok(gain > 0.69 && gain < 0.73, `expected a 3 dB range limit, received gain ${gain}`);
  assert.ok(meterMessages.some(message => message.type === 'meter' && message.compressorReductionDb <= 3));
});
