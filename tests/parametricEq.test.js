import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyEqPreset,
  cloneDefaultEqBands,
  sanitizeEqBands
} from '../src/parametricEq.js';

test('parametric EQ sanitizes ranges and migrates legacy five-band gains', () => {
  const migrated = sanitizeEqBands(undefined, {
    eqLow: 1,
    eqLowMid: -2,
    eqMid: 3,
    eqHighMid: -4,
    eqHigh: 5
  });
  assert.deepEqual(migrated.map(band => band.gain), [1, -2, 3, -4, 5]);

  const sanitized = sanitizeEqBands([{
    enabled: false,
    type: 'invalid',
    frequency: 100000,
    gain: -100,
    q: 0,
    mode: 'invalid'
  }]);
  assert.deepEqual(sanitized[0], {
    enabled: false,
    type: 'lowshelf',
    frequency: 20000,
    gain: -18,
    q: 0.1,
    mode: 'stereo'
  });
});

test('EQ presets preserve band topology and update only musical gains', () => {
  const custom = cloneDefaultEqBands();
  custom[2] = { ...custom[2], type: 'notch', frequency: 785, q: 8, mode: 'side' };
  const preset = applyEqPreset(custom, 'vocal');
  assert.deepEqual(preset.map(band => band.gain), [-2, -1, 2, 3, 1]);
  assert.equal(preset[2].type, 'notch');
  assert.equal(preset[2].frequency, 785);
  assert.equal(preset[2].q, 8);
  assert.equal(preset[2].mode, 'side');
});
