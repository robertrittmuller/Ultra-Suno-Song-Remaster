import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STEM_COMPRESSION_PRESETS,
  applyStemCompressionPreset,
  calculateDownwardReductionDb,
  createMasterDynamicsConfig,
  createStemDynamicsConfig
} from '../src/studioDynamics.js';

test('three-band dynamic EQ uses conservative frequency-specific ranges', () => {
  const config = createMasterDynamicsConfig({ dynamicEq: true, dynamicEqAmount: 50 });
  assert.equal(config.dynamicEq.enabled, true);
  assert.deepEqual(config.dynamicEq.bands.map(band => band.frequency), [120, 350, 3800]);
  assert.deepEqual(config.dynamicEq.bands.map(band => band.rangeDb), [1.5, 1.25, 1.75]);
});

test('master bypass disables adaptive processing and de-esser audition', () => {
  const config = createMasterDynamicsConfig({
    dynamicEq: true,
    deEsser: true,
    deEsserAudition: true
  }, true);
  assert.equal(config.dynamicEq.enabled, false);
  assert.equal(config.deEsser.enabled, false);
  assert.equal(config.deEsser.audition, false);
});

test('de-esser controls and compressor safety limits are clamped', () => {
  const config = createStemDynamicsConfig({
    glueCompression: true,
    deEsser: true,
    deEsserFrequency: 20000,
    deEsserRange: 40,
    compressorRatio: 100,
    compressorMaxReduction: 30,
    compressorMix: 140
  });
  assert.equal(config.deEsser.frequency, 10000);
  assert.equal(config.deEsser.rangeDb, 10);
  assert.equal(config.compressor.ratio, 20);
  assert.equal(config.compressor.maxReductionDb, 12);
  assert.equal(config.compressor.mix, 1);
});

test('de-esser audition is excluded from export configurations', () => {
  const settings = { deEsser: true, deEsserAudition: true };
  assert.equal(createStemDynamicsConfig(settings, true).deEsser.audition, true);
  assert.equal(createStemDynamicsConfig(settings, false).deEsser.audition, false);
});

test('compression presets expose every requested studio control', () => {
  for (const name of ['vocal', 'bass', 'drums', 'music']) {
    const settings = applyStemCompressionPreset({}, name);
    const preset = STEM_COMPRESSION_PRESETS[name];
    assert.equal(settings.compressionPreset, name);
    assert.equal(settings.compressorThreshold, preset.thresholdDb);
    assert.equal(settings.compressorRatio, preset.ratio);
    assert.equal(settings.compressorAttack, preset.attackMs);
    assert.equal(settings.compressorRelease, preset.releaseMs);
    assert.equal(settings.compressorKnee, preset.kneeDb);
    assert.equal(settings.compressorMaxReduction, preset.maxReductionDb);
    assert.equal(settings.compressorMix, preset.mix);
    assert.equal(settings.compressorMakeup, preset.makeupDb);
  }
});

test('downward compression obeys knee and maximum gain-reduction range', () => {
  const settings = { thresholdDb: -20, ratio: 4, kneeDb: 6, maxReductionDb: 5 };
  assert.equal(calculateDownwardReductionDb(-30, settings), 0);
  assert.ok(calculateDownwardReductionDb(-20, settings) > 0);
  assert.equal(calculateDownwardReductionDb(0, settings), 5);
});
