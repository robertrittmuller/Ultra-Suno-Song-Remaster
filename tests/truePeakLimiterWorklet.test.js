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
await import('../src/truePeakLimiter.worklet.js');

const parameters = {
  ceiling: new Float32Array([-1]),
  enabled: new Float32Array([1])
};

function processBlock(processor, value) {
  const input = Float32Array.from({ length: 128 }, () => value);
  const left = new Float32Array(128);
  const right = new Float32Array(128);
  processor.process([[input, input]], [[left, right]], parameters);
  return left;
}

test('realtime limiter reset discards buffered audio and restores startup lookahead', () => {
  const processor = new RegisteredProcessor();
  processBlock(processor, 0.5);
  processBlock(processor, 0.5);
  assert.ok(processBlock(processor, 0.5).some(sample => sample !== 0));

  processor.port.onmessage({ data: { type: 'reset' } });
  assert.ok(processBlock(processor, 0.25).every(sample => sample === 0));

  const secondBlock = processBlock(processor, 0.25);
  assert.ok(secondBlock.subarray(0, 112).every(sample => sample === 0));
  assert.ok(secondBlock.subarray(113).some(sample => sample !== 0));
});
