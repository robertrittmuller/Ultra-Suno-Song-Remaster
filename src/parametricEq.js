const loadedContexts = new WeakSet();
const failedContexts = new WeakSet();
const PARAMETRIC_EQ_WORKLET_URL = new URL('./parametricEq.worklet.js', import.meta.url);

export const PARAMETRIC_EQ_TYPES = Object.freeze([
  'peaking', 'lowshelf', 'highshelf', 'highpass', 'lowpass', 'notch'
]);
export const PARAMETRIC_EQ_MODES = Object.freeze(['stereo', 'mid', 'side']);

export const DEFAULT_PARAMETRIC_EQ_BANDS = Object.freeze([
  Object.freeze({ enabled: true, type: 'lowshelf', frequency: 80, gain: 0, q: 0.7, mode: 'stereo' }),
  Object.freeze({ enabled: true, type: 'peaking', frequency: 250, gain: 0, q: 1, mode: 'stereo' }),
  Object.freeze({ enabled: true, type: 'peaking', frequency: 1000, gain: 0, q: 1, mode: 'stereo' }),
  Object.freeze({ enabled: true, type: 'peaking', frequency: 4000, gain: 0, q: 1, mode: 'stereo' }),
  Object.freeze({ enabled: true, type: 'highshelf', frequency: 12000, gain: 0, q: 0.7, mode: 'stereo' })
]);

const presetGains = {
  flat: [0, 0, 0, 0, 0],
  vocal: [-2, -1, 2, 3, 1],
  bass: [6, 3, 0, -1, -2],
  bright: [-1, 0, 1, 3, 5],
  warm: [3, 2, 0, -2, -3],
  suno: [1, -2, 1, -1, 2]
};

function clamp(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

export function cloneDefaultEqBands() {
  return DEFAULT_PARAMETRIC_EQ_BANDS.map(band => ({ ...band }));
}

export function sanitizeEqBands(bands, legacySettings = {}) {
  const legacyGains = [
    legacySettings.eqLow,
    legacySettings.eqLowMid,
    legacySettings.eqMid,
    legacySettings.eqHighMid,
    legacySettings.eqHigh
  ];
  return DEFAULT_PARAMETRIC_EQ_BANDS.map((fallback, index) => {
    const source = Array.isArray(bands) ? (bands[index] || {}) : {};
    const legacyGain = Number.isFinite(Number(legacyGains[index])) ? Number(legacyGains[index]) : fallback.gain;
    return {
      enabled: source.enabled !== false,
      type: PARAMETRIC_EQ_TYPES.includes(source.type) ? source.type : fallback.type,
      frequency: clamp(source.frequency, 20, 20000, fallback.frequency),
      gain: clamp(source.gain, -18, 18, legacyGain),
      q: clamp(source.q, 0.1, 18, fallback.q),
      mode: PARAMETRIC_EQ_MODES.includes(source.mode) ? source.mode : fallback.mode
    };
  });
}

export function applyEqPreset(bands, presetName) {
  const gains = presetGains[presetName] || presetGains.flat;
  return sanitizeEqBands(bands).map((band, index) => ({ ...band, enabled: true, gain: gains[index] }));
}

export async function ensureParametricEqWorklet(context) {
  if (loadedContexts.has(context)) return true;
  if (failedContexts.has(context) || !context.audioWorklet || typeof AudioWorkletNode === 'undefined') return false;
  try {
    await context.audioWorklet.addModule(PARAMETRIC_EQ_WORKLET_URL.href);
    loadedContexts.add(context);
    return true;
  } catch (error) {
    failedContexts.add(context);
    console.warn('Parametric EQ AudioWorklet unavailable; EQ will be bypassed.', error);
    return false;
  }
}

export function createParametricEqNode(context, bands) {
  if (!loadedContexts.has(context) || typeof AudioWorkletNode === 'undefined') {
    const fallback = context.createGain();
    fallback.isParametricEqFallback = true;
    return fallback;
  }
  return new AudioWorkletNode(context, 'parametric-eq', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: { bands: sanitizeEqBands(bands) }
  });
}

export function configureParametricEqNode(node, bands, bypassed = false) {
  if (node?.port) {
    node.port.postMessage({
      type: 'configure',
      bands: sanitizeEqBands(bands).map(band => ({ ...band, enabled: band.enabled && !bypassed }))
    });
  }
}
