import assert from 'node:assert/strict';
import test from 'node:test';

let RegisteredProcessor = null;
globalThis.sampleRate = 1000;
globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.port = { onmessage: null, postMessage() {} };
  }
};
globalThis.registerProcessor = (_name, Processor) => { RegisteredProcessor = Processor; };
await import('../src/playbackGuard.worklet.js');

function process(processor, samples) {
  const input = Float32Array.from(samples);
  const output = new Float32Array(input.length);
  processor.process([[input]], [[output]]);
  return output;
}

test('playback guard begins its fade on the first actual signal sample', () => {
  const processor = new RegisteredProcessor();
  processor.port.onmessage({ data: { type: 'arm', fadeSeconds: 0.004 } });
  const output = process(processor, [0, 0, 0.8, 0.8, 0.8, 0.8, 0.8]);
  const expected = [0, 0, 0, 0.2, 0.4, 0.6, 0.8];
  output.forEach((sample, index) => assert.ok(Math.abs(sample - expected[index]) < 1e-6));
});

test('playback guard silence and re-arm cannot leak a stale first sample', () => {
  const processor = new RegisteredProcessor();
  processor.port.onmessage({ data: { type: 'arm', fadeSeconds: 0.002 } });
  process(processor, [1, 1, 1]);
  processor.port.onmessage({ data: { type: 'silence' } });
  assert.deepEqual(Array.from(process(processor, [1, 1])), [0, 0]);
  processor.port.onmessage({ data: { type: 'arm', fadeSeconds: 0.002 } });
  assert.deepEqual(Array.from(process(processor, [1, 1, 1])), [0, 0.5, 1]);
});
