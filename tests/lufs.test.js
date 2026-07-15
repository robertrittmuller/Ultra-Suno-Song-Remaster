import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createKWeightingCoefficients,
  measureLUFS,
  measureTruePeak
} from '../src/lufs.js';
import { createAudioBufferMock, sineWave } from './audioTestUtils.js';

test('48 kHz K-weighting matches the BS.1770 reference coefficients', () => {
  const coefficients = createKWeightingCoefficients(48000);
  const expectedShelfB = [1.53512485958697, -2.69169618940638, 1.19839281085285];
  const expectedShelfA = [1, -1.69065929318241, 0.73248077421585];
  const expectedHighPassB = [1, -2, 1];
  const expectedHighPassA = [1, -1.99004745483398, 0.99007225036621];
  for (let index = 0; index < 3; index++) {
    assert.ok(Math.abs(coefficients.highShelf.b[index] - expectedShelfB[index]) < 1e-12);
    assert.ok(Math.abs(coefficients.highShelf.a[index] - expectedShelfA[index]) < 1e-12);
    assert.ok(Math.abs(coefficients.highPass.b[index] - expectedHighPassB[index]) < 1e-12);
    assert.ok(Math.abs(coefficients.highPass.a[index] - expectedHighPassA[index]) < 1e-12);
  }
});

test('a full-scale 997 Hz mono sine measures approximately -3.01 LUFS', () => {
  const sampleRate = 48000;
  const buffer = createAudioBufferMock([sineWave(sampleRate, 4, 997)], sampleRate);
  const result = measureLUFS(buffer, { truePeak: false });
  assert.ok(Math.abs(result.integratedLUFS - (-3.01)) < 0.1, `${result.integratedLUFS} LUFS`);
});

test('dual-mono 997 Hz adds 3.01 LU over mono', () => {
  const sampleRate = 44100;
  const channel = sineWave(sampleRate, 4, 997);
  const mono = measureLUFS(createAudioBufferMock([channel], sampleRate), { truePeak: false });
  const stereo = measureLUFS(createAudioBufferMock([channel, new Float32Array(channel)], sampleRate), { truePeak: false });
  assert.ok(Math.abs((stereo.integratedLUFS - mono.integratedLUFS) - 3.0103) < 0.05);
});

test('Annex-2 FIR detects an inter-sample peak missed by a sample-peak scan', () => {
  const sampleRate = 48000;
  const channel = sineWave(sampleRate, 1, sampleRate / 4, 1, Math.PI / 4);
  const buffer = createAudioBufferMock([channel], sampleRate);
  const result = measureTruePeak(buffer);
  const samplePeak = Math.max(...channel.map(Math.abs));
  assert.ok(samplePeak < 0.71);
  assert.ok(result.truePeak > 0.95, `${result.truePeak} linear true peak`);
});

test('silence returns stable empty-program values', () => {
  const buffer = createAudioBufferMock([new Float32Array(48000)], 48000);
  const result = measureLUFS(buffer);
  assert.equal(result.integratedLUFS, -Infinity);
  assert.equal(result.truePeak, 0);
  assert.equal(result.loudnessRange, 0);
});

test('relative gating rejects quiet programme blocks in the energy domain', () => {
  const sampleRate = 48000;
  const segments = [
    { seconds: 10, loudness: -36 },
    { seconds: 60, loudness: -23 },
    { seconds: 10, loudness: -36 }
  ];
  const channel = new Float32Array(sampleRate * 80);
  let offset = 0;
  for (const segment of segments) {
    // A 997 Hz mono sine reads approximately 3.01 LU below its peak level.
    const peak = Math.pow(10, (segment.loudness + 3.01) / 20);
    const samples = sineWave(sampleRate, segment.seconds, 997, peak);
    channel.set(samples, offset);
    offset += samples.length;
  }
  const result = measureLUFS(createAudioBufferMock([channel], sampleRate), { truePeak: false });
  assert.ok(Math.abs(result.integratedLUFS - (-23)) < 0.15, `${result.integratedLUFS} LUFS`);
});

test('EBU Tech 3342 two-level tone produces its expected 10 LU LRA', () => {
  const sampleRate = 48000;
  const first = sineWave(sampleRate, 20, 1000, Math.pow(10, -20 / 20));
  const second = sineWave(sampleRate, 20, 1000, Math.pow(10, -30 / 20));
  const left = new Float32Array(first.length + second.length);
  left.set(first);
  left.set(second, first.length);
  const result = measureLUFS(
    createAudioBufferMock([left, new Float32Array(left)], sampleRate),
    { truePeak: false }
  );
  assert.ok(Math.abs(result.loudnessRange - 10) <= 1, `${result.loudnessRange} LU LRA`);
});
