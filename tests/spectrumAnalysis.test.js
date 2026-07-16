import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateAverageSpectrum } from '../src/spectrumAnalysis.js';

function toneBuffer(frequency, phaseRelation = 1, length = 8192, sampleRate = 48000) {
  const channels = [new Float32Array(length), new Float32Array(length)];
  for (let index = 0; index < length; index++) {
    const sample = Math.sin(2 * Math.PI * frequency * index / sampleRate);
    channels[0][index] = sample;
    channels[1][index] = sample * phaseRelation;
  }
  return {
    numberOfChannels: 2,
    length,
    sampleRate,
    getChannelData(channel) { return channels[channel]; }
  };
}

test('reference spectrum identifies the strongest tone bin', () => {
  const spectrum = calculateAverageSpectrum(toneBuffer(1000), 2048, 4);
  let strongest = 0;
  for (let index = 1; index < spectrum.decibels.length; index++) {
    if (spectrum.decibels[index] > spectrum.decibels[strongest]) strongest = index;
  }
  const frequency = strongest * spectrum.sampleRate / spectrum.fftSize;
  assert.ok(Math.abs(frequency - 1000) < 30, `expected 1 kHz peak, received ${frequency}`);
});

test('spectrum power does not disappear for anti-phase stereo content', () => {
  const correlated = calculateAverageSpectrum(toneBuffer(1000, 1), 2048, 4);
  const antiPhase = calculateAverageSpectrum(toneBuffer(1000, -1), 2048, 4);
  const peak = Math.round(1000 * 2048 / 48000);
  assert.ok(Math.abs(correlated.decibels[peak] - antiPhase.decibels[peak]) < 0.001);
});
