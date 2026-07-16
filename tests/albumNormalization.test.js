import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateAlbumLoudness,
  calculateAlbumNormalizationGain
} from '../src/albumNormalization.js';

test('album loudness uses duration-weighted energy rather than averaging LUFS', () => {
  const tracks = [
    { integratedLUFS: -10, duration: 60 },
    { integratedLUFS: -20, duration: 60 }
  ];
  const expected = -0.691 + 10 * Math.log10((
    Math.pow(10, (-10 + 0.691) / 10) + Math.pow(10, (-20 + 0.691) / 10)
  ) / 2);
  assert.ok(Math.abs(calculateAlbumLoudness(tracks) - expected) < 1e-12);
  assert.notEqual(calculateAlbumLoudness(tracks), -15);
});

test('one shared album gain preserves song-to-song loudness differences', () => {
  const tracks = [
    { integratedLUFS: -12, duration: 180 },
    { integratedLUFS: -16, duration: 180 }
  ];
  const result = calculateAlbumNormalizationGain(tracks, -14);
  const firstAfter = tracks[0].integratedLUFS + result.gainDb;
  const secondAfter = tracks[1].integratedLUFS + result.gainDb;
  assert.ok(Math.abs((firstAfter - secondAfter) - 4) < 1e-12);
  assert.ok(Math.abs(result.albumLufs + 13.554) < 0.01);
});

test('empty album measurements produce a safe unity gain', () => {
  assert.deepEqual(calculateAlbumNormalizationGain([], -14), {
    albumLufs: -Infinity,
    gain: 1,
    gainDb: 0
  });
});
