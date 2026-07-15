/**
 * ITU-R BS.1770-5 / EBU Mode loudness and true-peak measurement.
 *
 * The K-weighting filters are derived for the buffer's actual sample rate.
 * Integrated loudness uses 400 ms blocks, 75% overlap, and energy-domain
 * absolute/relative gating. True peak uses the 48-tap, four-phase FIR from
 * Annex 2 of BS.1770-5.
 */

const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_LU = -10;
const LRA_RELATIVE_GATE_LU = -20;
const LOUDNESS_OFFSET = -0.691;
const MOMENTARY_SECONDS = 0.4;
const SHORT_TERM_SECONDS = 3;
const HOP_SECONDS = 0.1;

// ITU-R BS.1770-5 Annex 2: order-48, four-phase FIR interpolator.
const TRUE_PEAK_PHASES = [
  [0.0017089843750, 0.0109863281250, -0.0196533203125, 0.0332031250000, -0.0594482421875, 0.1373291015625, 0.9721679687500, -0.1022949218750, 0.0476074218750, -0.0266113281250, 0.0148925781250, -0.0083007812500],
  [-0.0291748046875, 0.0292968750000, -0.0517578125000, 0.0891113281250, -0.1665039062500, 0.4650878906250, 0.7797851562500, -0.2003173828125, 0.1015625000000, -0.0582275390625, 0.0330810546875, -0.0189208984375],
  [-0.0189208984375, 0.0330810546875, -0.0582275390625, 0.1015625000000, -0.2003173828125, 0.7797851562500, 0.4650878906250, -0.1665039062500, 0.0891113281250, -0.0517578125000, 0.0292968750000, -0.0291748046875],
  [-0.0083007812500, 0.0148925781250, -0.0266113281250, 0.0476074218750, -0.1022949218750, 0.9721679687500, 0.1373291015625, -0.0594482421875, 0.0332031250000, -0.0196533203125, 0.0109863281250, 0.0017089843750]
];

const TRUE_PEAK_PHASE_ABS_SUMS = TRUE_PEAK_PHASES.map(phase =>
  phase.reduce((sum, coefficient) => sum + Math.abs(coefficient), 0)
);

function loudnessFromEnergy(energy) {
  return energy > 0 ? LOUDNESS_OFFSET + 10 * Math.log10(energy) : -Infinity;
}

function energyMean(values) {
  if (!values.length) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/** Derives the De Man K-weighting filters at any practical PCM sample rate. */
export function createKWeightingCoefficients(sampleRate) {
  if (!Number.isFinite(sampleRate) || sampleRate < 8000) {
    throw new RangeError(`Unsupported sample rate: ${sampleRate}`);
  }

  const shelfFrequency = 1681.974450955533;
  const shelfGainDb = 3.999843853973347;
  const shelfQ = 0.7071752369554196;
  const shelfK = Math.tan(Math.PI * shelfFrequency / sampleRate);
  const shelfVh = Math.pow(10, shelfGainDb / 20);
  const shelfVb = Math.pow(shelfVh, 0.4996667741545416);
  const shelfA0 = 1 + shelfK / shelfQ + shelfK * shelfK;
  const highShelf = {
    b: [
      (shelfVh + shelfVb * shelfK / shelfQ + shelfK * shelfK) / shelfA0,
      2 * (shelfK * shelfK - shelfVh) / shelfA0,
      (shelfVh - shelfVb * shelfK / shelfQ + shelfK * shelfK) / shelfA0
    ],
    a: [
      1,
      2 * (shelfK * shelfK - 1) / shelfA0,
      (1 - shelfK / shelfQ + shelfK * shelfK) / shelfA0
    ]
  };

  const highPassFrequency = 38.13547087602444;
  const highPassQ = 0.5003270373238773;
  const highPassK = Math.tan(Math.PI * highPassFrequency / sampleRate);
  const highPassA0 = 1 + highPassK / highPassQ + highPassK * highPassK;
  const highPass = {
    // BS.1770 specifies unity numerator coefficients; only the feedback
    // coefficients are derived from the analogue prototype.
    b: [1, -2, 1],
    a: [
      1,
      2 * (highPassK * highPassK - 1) / highPassA0,
      (1 - highPassK / highPassQ + highPassK * highPassK) / highPassA0
    ]
  };

  return { highShelf, highPass };
}

function applyBiquadInPlace(samples, coefficients) {
  const { b, a } = coefficients;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;

  for (let index = 0; index < samples.length; index++) {
    const x0 = samples[index];
    const y0 = b[0] * x0 + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2;
    samples[index] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
}

function applyKWeighting(samples, sampleRate) {
  const filtered = new Float32Array(samples);
  const coefficients = createKWeightingCoefficients(sampleRate);
  applyBiquadInPlace(filtered, coefficients.highShelf);
  applyBiquadInPlace(filtered, coefficients.highPass);
  return filtered;
}

function getChannelWeight(channel, channelCount) {
  // Web Audio's canonical 5.1 order is L, R, C, LFE, SL, SR.
  if (channelCount === 6) return [1, 1, 1, 0, 1.41, 1.41][channel];
  if (channelCount === 5) return [1, 1, 1, 1.41, 1.41][channel];
  return 1;
}

function accumulateWindowEnergies(samples, windowLength, hopLength, weight, destination) {
  if (samples.length < windowLength) return;
  let sum = 0;
  for (let index = 0; index < windowLength; index++) sum += samples[index] * samples[index];

  let block = 0;
  for (let start = 0; start + windowLength <= samples.length; start += hopLength) {
    destination[block++] += weight * sum / windowLength;
    const nextStart = start + hopLength;
    if (nextStart + windowLength > samples.length) break;
    for (let index = start; index < nextStart; index++) {
      sum -= samples[index] * samples[index];
      const entering = index + windowLength;
      sum += samples[entering] * samples[entering];
    }
  }
}

function percentile(sortedValues, probability) {
  if (!sortedValues.length) return -Infinity;
  if (sortedValues.length === 1) return sortedValues[0];
  const position = probability * (sortedValues.length - 1);
  const lower = Math.floor(position);
  const fraction = position - lower;
  return sortedValues[lower] + (sortedValues[Math.min(lower + 1, sortedValues.length - 1)] - sortedValues[lower]) * fraction;
}

function calculateIntegratedLoudness(blockEnergies) {
  const absoluteGated = blockEnergies.filter(energy => loudnessFromEnergy(energy) > ABSOLUTE_GATE_LUFS);
  if (!absoluteGated.length) return -Infinity;
  const relativeThreshold = loudnessFromEnergy(energyMean(absoluteGated)) + RELATIVE_GATE_LU;
  const finalGated = absoluteGated.filter(energy => loudnessFromEnergy(energy) > relativeThreshold);
  return loudnessFromEnergy(energyMean(finalGated));
}

function calculateLoudnessRange(shortTermEnergies) {
  const absoluteGated = shortTermEnergies.filter(energy => loudnessFromEnergy(energy) > ABSOLUTE_GATE_LUFS);
  if (!absoluteGated.length) return 0;
  const relativeThreshold = loudnessFromEnergy(energyMean(absoluteGated)) + LRA_RELATIVE_GATE_LU;
  const loudnessValues = absoluteGated
    .map(loudnessFromEnergy)
    .filter(value => value > relativeThreshold)
    .sort((left, right) => left - right);
  if (loudnessValues.length < 2) return 0;
  return percentile(loudnessValues, 0.95) - percentile(loudnessValues, 0.10);
}

function measureChannelTruePeak(samples) {
  let peak = 0;
  for (let index = 0; index < samples.length; index++) {
    peak = Math.max(peak, Math.abs(samples[index]));
  }
  if (peak === 0) return 0;

  const history = new Float64Array(12);
  let writeIndex = 0;
  let localMaximum = 0;

  // Zero padding flushes the linear-phase FIR at both boundaries.
  for (let inputIndex = -11; inputIndex < samples.length + 12; inputIndex++) {
    const leaving = Math.abs(history[writeIndex]);
    const next = inputIndex >= 0 && inputIndex < samples.length ? samples[inputIndex] : 0;
    history[writeIndex] = next;
    writeIndex = (writeIndex + 1) % history.length;

    const nextAbs = Math.abs(next);
    if (nextAbs >= localMaximum) {
      localMaximum = nextAbs;
    } else if (leaving >= localMaximum - Number.EPSILON) {
      localMaximum = 0;
      for (const value of history) localMaximum = Math.max(localMaximum, Math.abs(value));
    }

    for (let phaseIndex = 0; phaseIndex < TRUE_PEAK_PHASES.length; phaseIndex++) {
      // Triangle inequality gives a cheap, safe skip for windows incapable of
      // exceeding the best peak already found.
      if (localMaximum * TRUE_PEAK_PHASE_ABS_SUMS[phaseIndex] <= peak) continue;
      const phase = TRUE_PEAK_PHASES[phaseIndex];
      let interpolated = 0;
      for (let tap = 0; tap < phase.length; tap++) {
        interpolated += phase[tap] * history[(writeIndex + tap) % history.length];
      }
      peak = Math.max(peak, Math.abs(interpolated));
    }
  }
  return peak;
}

/** Measures Annex-2 true peak and returns both linear and dBTP values. */
export function measureTruePeak(audioBuffer) {
  let truePeak = 0;
  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
    truePeak = Math.max(truePeak, measureChannelTruePeak(audioBuffer.getChannelData(channel)));
  }
  return {
    truePeak,
    truePeakDB: truePeak > 0 ? 20 * Math.log10(truePeak) : -Infinity
  };
}

/**
 * Measures integrated, momentary, short-term, LRA, sample peak, and true peak.
 */
export function measureLUFS(audioBuffer, options = {}) {
  const sampleRate = audioBuffer.sampleRate;
  const channelCount = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;
  const momentaryLength = Math.max(1, Math.round(sampleRate * MOMENTARY_SECONDS));
  const shortTermLength = Math.max(1, Math.round(sampleRate * SHORT_TERM_SECONDS));
  const hopLength = Math.max(1, Math.round(sampleRate * HOP_SECONDS));
  const momentaryCount = length >= momentaryLength
    ? Math.floor((length - momentaryLength) / hopLength) + 1
    : 0;
  const shortTermCount = length >= shortTermLength
    ? Math.floor((length - shortTermLength) / hopLength) + 1
    : 0;
  const momentaryEnergies = new Float64Array(momentaryCount);
  const shortTermEnergies = new Float64Array(shortTermCount);
  let samplePeak = 0;

  for (let channel = 0; channel < channelCount; channel++) {
    const input = audioBuffer.getChannelData(channel);
    for (let index = 0; index < input.length; index++) samplePeak = Math.max(samplePeak, Math.abs(input[index]));
    const filtered = applyKWeighting(input, sampleRate);
    const weight = getChannelWeight(channel, channelCount);
    if (weight === 0) continue;
    accumulateWindowEnergies(filtered, momentaryLength, hopLength, weight, momentaryEnergies);
    accumulateWindowEnergies(filtered, shortTermLength, hopLength, weight, shortTermEnergies);
  }

  const integratedLUFS = calculateIntegratedLoudness(Array.from(momentaryEnergies));
  let momentaryMax = -Infinity;
  for (const energy of momentaryEnergies) momentaryMax = Math.max(momentaryMax, loudnessFromEnergy(energy));
  let shortTermMax = -Infinity;
  for (const energy of shortTermEnergies) shortTermMax = Math.max(shortTermMax, loudnessFromEnergy(energy));
  const loudnessRange = calculateLoudnessRange(Array.from(shortTermEnergies));
  const truePeakResult = options.truePeak === false
    ? {
        truePeak: samplePeak,
        truePeakDB: samplePeak > 0 ? 20 * Math.log10(samplePeak) : -Infinity
      }
    : measureTruePeak(audioBuffer);

  return {
    integratedLUFS,
    momentaryMax,
    shortTermMax,
    loudnessRange,
    samplePeak,
    samplePeakDB: samplePeak > 0 ? 20 * Math.log10(samplePeak) : -Infinity,
    truePeak: truePeakResult.truePeak,
    truePeakDB: truePeakResult.truePeakDB
  };
}

export function calculateNormalizationGain(currentLUFS, targetLUFS = -14) {
  if (!Number.isFinite(currentLUFS) || currentLUFS < ABSOLUTE_GATE_LUFS) return 1;
  return Math.pow(10, (targetLUFS - currentLUFS) / 20);
}
