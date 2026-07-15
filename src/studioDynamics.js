const loadedContexts = new WeakSet();
const failedContexts = new WeakSet();
const STUDIO_DYNAMICS_WORKLET_URL = new URL('./studioDynamics.worklet.js', import.meta.url);

export const STEM_COMPRESSION_PRESETS = Object.freeze({
  vocal: Object.freeze({ thresholdDb: -20, ratio: 3, attackMs: 10, releaseMs: 110, kneeDb: 6, maxReductionDb: 6, mix: 100, makeupDb: 1 }),
  bass: Object.freeze({ thresholdDb: -18, ratio: 4, attackMs: 25, releaseMs: 140, kneeDb: 6, maxReductionDb: 6, mix: 100, makeupDb: 1 }),
  drums: Object.freeze({ thresholdDb: -14, ratio: 4, attackMs: 30, releaseMs: 80, kneeDb: 4, maxReductionDb: 6, mix: 75, makeupDb: 0 }),
  music: Object.freeze({ thresholdDb: -16, ratio: 2, attackMs: 30, releaseMs: 250, kneeDb: 10, maxReductionDb: 3, mix: 100, makeupDb: 0 })
});

export const MASTER_DYNAMIC_EQ_BANDS = Object.freeze([
  Object.freeze({ name: 'Boom', frequency: 120, q: 1.1, thresholdDb: -25, ratio: 2, rangeDb: 3, attackMs: 35, releaseMs: 180 }),
  Object.freeze({ name: 'Box', frequency: 350, q: 1.35, thresholdDb: -27, ratio: 2, rangeDb: 2.5, attackMs: 25, releaseMs: 160 }),
  Object.freeze({ name: 'Harsh', frequency: 3800, q: 1.8, thresholdDb: -29, ratio: 2.5, rangeDb: 3.5, attackMs: 8, releaseMs: 110 })
]);

function clamp(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

export function calculateDownwardReductionDb(levelDb, { thresholdDb, ratio, kneeDb = 0, maxReductionDb = Infinity }) {
  const over = levelDb - thresholdDb;
  const safeRatio = Math.max(1, ratio);
  let reduction = 0;
  if (kneeDb > 0 && over > -kneeDb / 2 && over < kneeDb / 2) {
    const kneePosition = over + kneeDb / 2;
    reduction = (1 - 1 / safeRatio) * kneePosition * kneePosition / (2 * kneeDb);
  } else if (over >= kneeDb / 2) {
    reduction = Math.max(0, over * (1 - 1 / safeRatio));
  }
  return Math.min(Math.max(0, reduction), Math.max(0, maxReductionDb));
}

export function applyStemCompressionPreset(settings, presetName) {
  const preset = STEM_COMPRESSION_PRESETS[presetName] || STEM_COMPRESSION_PRESETS.vocal;
  return {
    ...settings,
    compressionPreset: STEM_COMPRESSION_PRESETS[presetName] ? presetName : 'vocal',
    compressorThreshold: preset.thresholdDb,
    compressorRatio: preset.ratio,
    compressorAttack: preset.attackMs,
    compressorRelease: preset.releaseMs,
    compressorKnee: preset.kneeDb,
    compressorMaxReduction: preset.maxReductionDb,
    compressorMix: preset.mix,
    compressorMakeup: preset.makeupDb
  };
}

export function createMasterDynamicsConfig(settings = {}, bypassed = false) {
  const amount = clamp(settings.dynamicEqAmount, 0, 100, 50) / 100;
  return {
    dynamicEq: {
      enabled: Boolean(settings.dynamicEq) && !bypassed,
      bands: MASTER_DYNAMIC_EQ_BANDS.map(band => ({
        ...band,
        rangeDb: band.rangeDb * amount
      }))
    },
    deEsser: {
      enabled: Boolean(settings.deEsser) && !bypassed,
      frequency: clamp(settings.deEsserFrequency, 4000, 10000, 7000),
      q: 1.6,
      thresholdDb: -30,
      ratio: 4,
      rangeDb: clamp(settings.deEsserRange, 1, 10, 4),
      attackMs: clamp(settings.deEsserAttack, 1, 30, 5),
      releaseMs: clamp(settings.deEsserRelease, 30, 300, 80),
      audition: Boolean(settings.deEsserAudition) && !bypassed
    },
    compressor: { enabled: false }
  };
}

export function createStemDynamicsConfig(settings = {}, allowAudition = true) {
  const amount = clamp(settings.dynamicEqAmount, 0, 100, 50) / 100;
  return {
    dynamicEq: {
      enabled: Boolean(settings.dynamicEq),
      bands: MASTER_DYNAMIC_EQ_BANDS.map(band => ({ ...band, rangeDb: band.rangeDb * amount }))
    },
    deEsser: {
      enabled: Boolean(settings.deEsser),
      frequency: clamp(settings.deEsserFrequency, 4000, 10000, 7000),
      q: 1.6,
      thresholdDb: -30,
      ratio: 4,
      rangeDb: clamp(settings.deEsserRange, 1, 10, 4),
      attackMs: clamp(settings.deEsserAttack, 1, 30, 5),
      releaseMs: clamp(settings.deEsserRelease, 30, 300, 80),
      audition: Boolean(settings.deEsserAudition) && allowAudition
    },
    compressor: {
      enabled: Boolean(settings.glueCompression),
      thresholdDb: clamp(settings.compressorThreshold, -48, 0, -20),
      ratio: clamp(settings.compressorRatio, 1, 20, 3),
      attackMs: clamp(settings.compressorAttack, 1, 200, 10),
      releaseMs: clamp(settings.compressorRelease, 20, 1000, 110),
      kneeDb: clamp(settings.compressorKnee, 0, 24, 6),
      maxReductionDb: clamp(settings.compressorMaxReduction, 1, 12, 6),
      mix: clamp(settings.compressorMix, 0, 100, 100) / 100,
      makeupDb: clamp(settings.compressorMakeup, -6, 6, 1)
    }
  };
}

export async function ensureStudioDynamicsWorklet(context) {
  if (loadedContexts.has(context)) return true;
  if (failedContexts.has(context) || !context.audioWorklet || typeof AudioWorkletNode === 'undefined') return false;
  try {
    await context.audioWorklet.addModule(STUDIO_DYNAMICS_WORKLET_URL.href);
    loadedContexts.add(context);
    return true;
  } catch (error) {
    failedContexts.add(context);
    console.warn('Studio dynamics AudioWorklet unavailable; adaptive dynamics will be bypassed.', error);
    return false;
  }
}

export function createStudioDynamicsNode(context, config, onMeter = null) {
  if (!loadedContexts.has(context) || typeof AudioWorkletNode === 'undefined') {
    const fallback = context.createGain();
    fallback.isStudioDynamicsFallback = true;
    return fallback;
  }
  const node = new AudioWorkletNode(context, 'studio-dynamics', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: { config }
  });
  if (onMeter) {
    node.port.onmessage = event => {
      if (event.data?.type === 'meter') onMeter(event.data);
    };
  }
  return node;
}

export function configureStudioDynamicsNode(node, config) {
  if (node?.port) node.port.postMessage({ type: 'configure', config });
}
