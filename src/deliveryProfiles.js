export const DELIVERY_PROFILES = Object.freeze({
  custom: Object.freeze({ label: 'Custom' }),
  streamingSafe: Object.freeze({
    label: 'Streaming Safe', normalizeLoudness: true, targetLufs: -14,
    truePeakLimit: true, truePeakCeiling: -1, sampleRate: 0, bitDepth: 24
  }),
  loudStreaming: Object.freeze({
    label: 'Loud Streaming', normalizeLoudness: true, targetLufs: -9,
    truePeakLimit: true, truePeakCeiling: -2, sampleRate: 0, bitDepth: 24
  }),
  cd: Object.freeze({
    label: 'CD', normalizeLoudness: true, targetLufs: -12,
    truePeakLimit: true, truePeakCeiling: -0.3, sampleRate: 44100, bitDepth: 16
  }),
  video: Object.freeze({
    label: 'Video', normalizeLoudness: true, targetLufs: -14,
    truePeakLimit: true, truePeakCeiling: -1, sampleRate: 48000, bitDepth: 24
  }),
  appleDigitalMasters: Object.freeze({
    label: 'Apple 24-bit', normalizeLoudness: true, targetLufs: -16,
    truePeakLimit: true, truePeakCeiling: -1, sampleRate: 0, bitDepth: 24
  })
});

export function applyDeliveryProfile(settings, profileName) {
  const profile = DELIVERY_PROFILES[profileName] || DELIVERY_PROFILES.custom;
  const { label: _label, ...values } = profile;
  return { ...settings, ...values, deliveryProfile: DELIVERY_PROFILES[profileName] ? profileName : 'custom' };
}

export function resolveOutputSampleRate(selectedRate, inputRate) {
  const rate = Number(selectedRate);
  if (rate === 0) return Math.round(inputRate);
  return [44100, 48000, 96000].includes(rate) ? rate : Math.round(inputRate);
}
