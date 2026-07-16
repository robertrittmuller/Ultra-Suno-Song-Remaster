import { calculateNormalizationGain, measureLUFS, measureTruePeak } from './lufs.js';

const DEFAULT_LOOKAHEAD_MS = 5;
const DEFAULT_RELEASE_MS = 80;
const TRUE_PEAK_SAFETY_DB = 0.02;

function dbToGain(decibels) {
  return Math.pow(10, decibels / 20);
}

function gainToDb(gain) {
  return gain > 0 ? 20 * Math.log10(gain) : -Infinity;
}

export function applyLinearGain(audioBuffer, gain) {
  if (!Number.isFinite(gain) || gain === 1) return;
  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
    const samples = audioBuffer.getChannelData(channel);
    for (let index = 0; index < samples.length; index++) samples[index] *= gain;
  }
}

function sampleAt(samples, index) {
  return index >= 0 && index < samples.length ? samples[index] : 0;
}

function catmullRom(p0, p1, p2, p3, position) {
  const position2 = position * position;
  const position3 = position2 * position;
  return 0.5 * (
    2 * p1 +
    (-p0 + p2) * position +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * position2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * position3
  );
}

/** Four-times inter-sample prediction, stereo-linked across every channel. */
function estimateLinkedPeak(audioBuffer, frame) {
  let peak = 0;
  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
    const samples = audioBuffer.getChannelData(channel);
    const p0 = sampleAt(samples, frame - 1);
    const p1 = sampleAt(samples, frame);
    const p2 = sampleAt(samples, frame + 1);
    const p3 = sampleAt(samples, frame + 2);
    peak = Math.max(peak, Math.abs(p1), Math.abs(p2));
    peak = Math.max(peak, Math.abs(catmullRom(p0, p1, p2, p3, 0.25)));
    peak = Math.max(peak, Math.abs(catmullRom(p0, p1, p2, p3, 0.5)));
    peak = Math.max(peak, Math.abs(catmullRom(p0, p1, p2, p3, 0.75)));
  }
  return peak;
}

/**
 * Applies a linked, lookahead limiter in place. The detector predicts four
 * points per source interval. An Annex-2 measurement then applies a tiny
 * global safety trim if gain modulation created any residual dBTP overshoot.
 */
export function applyTruePeakLimiter(audioBuffer, options = {}) {
  const ceilingDb = Number.isFinite(options.ceilingDb) ? options.ceilingDb : -1;
  const ceilingGain = dbToGain(ceilingDb - TRUE_PEAK_SAFETY_DB);
  const lookaheadFrames = Math.max(1, Math.round(
    audioBuffer.sampleRate * (options.lookaheadMs ?? DEFAULT_LOOKAHEAD_MS) / 1000
  ));
  const releaseSeconds = Math.max(0.001, (options.releaseMs ?? DEFAULT_RELEASE_MS) / 1000);
  const releaseCoefficient = Math.exp(-1 / (releaseSeconds * audioBuffer.sampleRate));
  const length = audioBuffer.length;
  const dequeCapacity = lookaheadFrames + 3;
  const dequeIndices = new Int32Array(dequeCapacity);
  const dequeValues = new Float32Array(dequeCapacity);
  let head = 0;
  let tail = 0;
  let envelope = 1;
  let minimumGain = 1;

  for (let scan = 0; scan < length + lookaheadFrames; scan++) {
    if (scan < length) {
      const predictedPeak = estimateLinkedPeak(audioBuffer, scan);
      const requiredGain = predictedPeak > ceilingGain ? ceilingGain / predictedPeak : 1;
      while (tail > head && dequeValues[(tail - 1) % dequeCapacity] >= requiredGain) tail--;
      dequeIndices[tail % dequeCapacity] = scan;
      dequeValues[tail % dequeCapacity] = requiredGain;
      tail++;
    }

    const outputFrame = scan - lookaheadFrames;
    if (outputFrame < 0) continue;
    while (tail > head && dequeIndices[head % dequeCapacity] < outputFrame) head++;
    const desiredGain = tail > head ? dequeValues[head % dequeCapacity] : 1;

    if (desiredGain < envelope) {
      envelope = desiredGain;
    } else {
      envelope = 1 - (1 - envelope) * releaseCoefficient;
      envelope = Math.min(envelope, desiredGain);
    }
    minimumGain = Math.min(minimumGain, envelope);
    for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
      audioBuffer.getChannelData(channel)[outputFrame] *= envelope;
    }
  }

  const measured = measureTruePeak(audioBuffer);
  const requestedCeiling = dbToGain(ceilingDb);
  let safetyTrimGain = 1;
  if (measured.truePeak > requestedCeiling) {
    safetyTrimGain = requestedCeiling / measured.truePeak;
    applyLinearGain(audioBuffer, safetyTrimGain);
  }

  return {
    lookaheadMs: lookaheadFrames / audioBuffer.sampleRate * 1000,
    maxGainReductionDb: -gainToDb(minimumGain),
    safetyTrimDb: gainToDb(safetyTrimGain),
    finalTruePeak: measured.truePeak * safetyTrimGain,
    finalTruePeakDb: gainToDb(measured.truePeak * safetyTrimGain)
  };
}

export function verifyMaster(audioBuffer, settings, limiterReport = null) {
  const analysis = measureLUFS(audioBuffer, { truePeak: false });
  const measuredTruePeak = limiterReport?.finalTruePeak != null
    ? { truePeak: limiterReport.finalTruePeak, truePeakDB: limiterReport.finalTruePeakDb }
    : measureTruePeak(audioBuffer);
  analysis.truePeak = measuredTruePeak.truePeak;
  analysis.truePeakDB = measuredTruePeak.truePeakDB;
  const warnings = [];
  const peakToleranceDb = 0.1;
  let truePeakPassed = true;

  if (settings.truePeakLimit) {
    truePeakPassed = analysis.truePeakDB <= settings.truePeakCeiling + peakToleranceDb;
    if (!truePeakPassed) {
      warnings.push(`true peak ${analysis.truePeakDB.toFixed(2)} dBTP exceeds the ${settings.truePeakCeiling.toFixed(1)} dBTP ceiling`);
    }
  } else if (analysis.truePeakDB > 0) {
    warnings.push(`true peak is ${analysis.truePeakDB.toFixed(2)} dBTP with limiting disabled`);
  }

  if (settings.normalizeLoudness && settings.normalizationMode !== 'album' && Number.isFinite(analysis.integratedLUFS)) {
    const loudnessDelta = analysis.integratedLUFS - settings.targetLufs;
    if (Math.abs(loudnessDelta) > 1) {
      warnings.push(`final loudness is ${analysis.integratedLUFS.toFixed(1)} LUFS (${loudnessDelta > 0 ? '+' : ''}${loudnessDelta.toFixed(1)} LU from target)`);
    }
  }
  if (limiterReport?.maxGainReductionDb > 4) {
    warnings.push(`limiter reached ${limiterReport.maxGainReductionDb.toFixed(1)} dB of gain reduction`);
  }

  return { passed: truePeakPassed, warnings, analysis };
}

/** Applies loudness drive, final limiting, then post-render QC to a buffer. */
export function finalizeMaster(audioBuffer, settings, options = {}) {
  const preAnalysis = measureLUFS(audioBuffer, { truePeak: false });
  const normalizationGain = Number.isFinite(options.normalizationGain)
    ? options.normalizationGain
    : settings.normalizeLoudness
      ? calculateNormalizationGain(preAnalysis.integratedLUFS, settings.targetLufs)
      : 1;
  applyLinearGain(audioBuffer, normalizationGain);

  const limiter = settings.truePeakLimit
    ? applyTruePeakLimiter(audioBuffer, { ceilingDb: settings.truePeakCeiling })
    : { lookaheadMs: 0, maxGainReductionDb: 0, safetyTrimDb: 0 };
  const verification = verifyMaster(audioBuffer, settings, limiter);

  return {
    preAnalysis,
    normalizationGain,
    normalizationGainDb: gainToDb(normalizationGain),
    limiter,
    verification
  };
}
