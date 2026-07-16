import assert from 'node:assert/strict';
import test from 'node:test';
import { repairClicksAndPops } from '../src/audioRestoration.js';
import { sineWave } from './audioTestUtils.js';

const SAMPLE_RATE = 48000;

function seededNoise(length, seed = 123456789) {
  const noise = new Float32Array(length);
  let value = seed >>> 0;
  for (let index = 0; index < length; index++) {
    value = (1664525 * value + 1013904223) >>> 0;
    noise[index] = (value / 0xffffffff) * 2 - 1;
  }
  return noise;
}

test('predictive de-clicker removes an isolated pop from pitched audio', () => {
  const clean = sineWave(SAMPLE_RATE, 0.5, 440, 0.08);
  const damaged = new Float32Array(clean);
  const click = 12000;
  damaged[click] += 0.55;

  const repaired = repairClicksAndPops([damaged], SAMPLE_RATE);

  assert.ok(repaired >= 1, 'expected the injected pop to be detected');
  assert.ok(Math.abs(damaged[click] - clean[click]) < 0.002);
});

test('a one-channel pop does not rewrite the clean stereo channel', () => {
  const left = sineWave(SAMPLE_RATE, 0.5, 330, 0.07);
  const right = sineWave(SAMPLE_RATE, 0.5, 550, 0.06, 0.3);
  const originalRight = new Float32Array(right);
  left[10000] -= 0.48;

  const repaired = repairClicksAndPops([left, right], SAMPLE_RATE);

  assert.ok(repaired >= 1);
  assert.deepEqual(right, originalRight);
});

test('clean tonal audio remains sample-identical', () => {
  const channel = sineWave(SAMPLE_RATE, 0.5, 997, 0.2, 0.17);
  const original = new Float32Array(channel);

  const repaired = repairClicksAndPops([channel], SAMPLE_RATE);

  assert.equal(repaired, 0);
  assert.deepEqual(channel, original);
});

test('a sustained broadband musical onset is preserved', () => {
  const channel = new Float32Array(SAMPLE_RATE / 2);
  const noise = seededNoise(channel.length);
  const onset = 12000;
  for (let index = onset; index < channel.length; index++) {
    const age = (index - onset) / SAMPLE_RATE;
    channel[index] = noise[index] * 0.35 * Math.exp(-age * 18);
  }
  const original = new Float32Array(channel);

  repairClicksAndPops([channel], SAMPLE_RATE);

  assert.deepEqual(channel, original);
});

test('bounded repair cannot overshoot its clean endpoints', () => {
  const channel = sineWave(SAMPLE_RATE, 0.5, 220, 0.05);
  const click = 14000;
  channel[click] = 0.95;
  const low = Math.min(channel[click - 1], channel[click + 1]);
  const high = Math.max(channel[click - 1], channel[click + 1]);

  const repaired = repairClicksAndPops([channel], SAMPLE_RATE);

  assert.ok(repaired >= 1);
  assert.ok(channel[click] >= low && channel[click] <= high);
});

test('adjacent samples in a short pop are reconstructed as one bounded gap', () => {
  const clean = sineWave(SAMPLE_RATE, 0.5, 440, 0.08);
  const damaged = new Float32Array(clean);
  const click = 12000;
  const impulse = [0.3, 0.1, -0.2, 0.25];
  impulse.forEach((value, offset) => { damaged[click + offset] += value; });

  const repaired = repairClicksAndPops([damaged], SAMPLE_RATE);

  assert.ok(repaired >= impulse.length && repaired <= impulse.length + 2);
  for (let offset = 0; offset < impulse.length; offset++) {
    assert.ok(Math.abs(damaged[click + offset] - clean[click + offset]) < 0.001);
  }
});

test('a sparse sequence of alternating crackles is removed without a global denoise pass', () => {
  const clean = new Float32Array(SAMPLE_RATE * 2);
  for (let index = 0; index < clean.length; index++) {
    clean[index] =
      0.09 * Math.sin(2 * Math.PI * 220 * index / SAMPLE_RATE) +
      0.05 * Math.sin(2 * Math.PI * 997 * index / SAMPLE_RATE);
  }
  const damaged = new Float32Array(clean);
  const locations = Array.from({ length: 20 }, (_, index) => 3000 + index * 4300);
  locations.forEach((location, index) => { damaged[location] += index % 2 ? -0.35 : 0.35; });

  const repaired = repairClicksAndPops([damaged], SAMPLE_RATE);

  assert.ok(repaired >= locations.length && repaired <= locations.length * 3);
  for (const location of locations) {
    assert.ok(Math.abs(damaged[location] - clean[location]) < 0.003);
  }
});
