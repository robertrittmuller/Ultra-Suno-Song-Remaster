import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyDeliveryProfile,
  DELIVERY_PROFILES,
  resolveOutputSampleRate
} from '../src/deliveryProfiles.js';

test('delivery profiles apply complete mastering and format targets', () => {
  const cd = applyDeliveryProfile({ unrelated: true }, 'cd');
  assert.equal(cd.targetLufs, -12);
  assert.equal(cd.truePeakCeiling, -0.3);
  assert.equal(cd.sampleRate, 44100);
  assert.equal(cd.bitDepth, 16);
  assert.equal(cd.deliveryProfile, 'cd');
  assert.equal(cd.unrelated, true);
  assert.equal('label' in cd, false);
  assert.deepEqual(Object.keys(DELIVERY_PROFILES), [
    'custom', 'streamingSafe', 'loudStreaming', 'cd', 'video', 'appleDigitalMasters'
  ]);
});

test('native sample-rate export preserves the decoded source rate', () => {
  assert.equal(resolveOutputSampleRate(0, 88200), 88200);
  assert.equal(resolveOutputSampleRate('48000', 44100), 48000);
  assert.equal(resolveOutputSampleRate(12345, 96000), 96000);
});
