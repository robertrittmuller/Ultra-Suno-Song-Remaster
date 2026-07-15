import assert from 'node:assert/strict';
import test from 'node:test';
import { measureLUFS, measureTruePeak } from '../src/lufs.js';
import { applyTruePeakLimiter, finalizeMaster } from '../src/truePeakLimiter.js';
import { createAudioBufferMock, sineWave } from './audioTestUtils.js';

test('lookahead limiter enforces the requested true-peak ceiling', () => {
  const sampleRate = 48000;
  const left = sineWave(sampleRate, 1, 997, 1.2);
  const right = Float32Array.from(left, sample => sample * 0.5);
  const buffer = createAudioBufferMock([left, right], sampleRate);
  const report = applyTruePeakLimiter(buffer, { ceilingDb: -1 });
  const result = measureTruePeak(buffer);
  assert.ok(result.truePeakDB <= -0.9, `${result.truePeakDB} dBTP`);
  assert.ok(report.maxGainReductionDb > 0);
  for (let index = 500; index < left.length; index += 5000) {
    if (Math.abs(left[index]) > 1e-5) assert.ok(Math.abs(right[index] / left[index] - 0.5) < 1e-4);
  }
});

test('finalization drives loudness before limiting and passes post-render QC', () => {
  const sampleRate = 48000;
  const channel = sineWave(sampleRate, 4, 997, 0.1);
  const buffer = createAudioBufferMock([channel, new Float32Array(channel)], sampleRate);
  const report = finalizeMaster(buffer, {
    normalizeLoudness: true,
    targetLufs: -14,
    truePeakLimit: true,
    truePeakCeiling: -1
  });
  const result = measureLUFS(buffer);
  assert.ok(Math.abs(result.integratedLUFS - (-14)) < 0.2, `${result.integratedLUFS} LUFS`);
  assert.ok(result.truePeakDB <= -0.9, `${result.truePeakDB} dBTP`);
  assert.equal(report.verification.passed, true);
});
