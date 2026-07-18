// Conservative, analysis-gated restoration for decoded PCM audio.
// These tools deliberately repair only signal anomalies that pass a local
// statistical test; they are not blanket denoisers or hard-coded fades.

const EPSILON = 1e-9;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

// In-place radix-2 FFT used by the offline restoration path. Keeping the
// transform here avoids a native/FFmpeg dependency and makes preview and
// export use the exact same spectral treatment.
function fft(real, imaginary, inverse = false) {
  const length = real.length;
  let reversed = 0;
  for (let index = 1; index < length; index++) {
    let bit = length >> 1;
    while (reversed & bit) {
      reversed ^= bit;
      bit >>= 1;
    }
    reversed ^= bit;
    if (reversed <= index) continue;
    [real[index], real[reversed]] = [real[reversed], real[index]];
    [imaginary[index], imaginary[reversed]] = [imaginary[reversed], imaginary[index]];
  }

  for (let size = 2; size <= length; size *= 2) {
    const half = size / 2;
    const angle = (inverse ? 2 : -2) * Math.PI / size;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let start = 0; start < length; start += size) {
      let twiddleReal = 1;
      let twiddleImaginary = 0;
      for (let offset = 0; offset < half; offset++) {
        const even = start + offset;
        const odd = even + half;
        const oddReal = real[odd] * twiddleReal - imaginary[odd] * twiddleImaginary;
        const oddImaginary = real[odd] * twiddleImaginary + imaginary[odd] * twiddleReal;
        real[odd] = real[even] - oddReal;
        imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal;
        imaginary[even] += oddImaginary;
        const nextReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary;
        twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal;
        twiddleReal = nextReal;
      }
    }
  }

  if (inverse) {
    for (let index = 0; index < length; index++) {
      real[index] /= length;
      imaginary[index] /= length;
    }
  }
}

function createSineWindow(length) {
  const window = new Float64Array(length);
  for (let index = 0; index < length; index++) {
    // With 50% overlap, adjacent squared sine windows sum to one. Applying
    // this window on analysis and synthesis therefore reconstructs cleanly.
    window[index] = Math.sin(Math.PI * (index + 0.5) / length);
  }
  return window;
}

function frameLinkedRms(channels, start, length) {
  let sum = 0;
  for (const channel of channels) {
    for (let offset = 0; offset < length; offset++) {
      const sample = channel[start + offset];
      sum += sample * sample;
    }
  }
  return Math.sqrt(sum / Math.max(1, length * channels.length));
}

function frameSpectrum(channel, start, window, real, imaginary) {
  const length = window.length;
  real.fill(0);
  imaginary.fill(0);
  for (let offset = 0; offset < length; offset++) {
    const index = start + offset;
    if (index >= 0 && index < channel.length) real[offset] = channel[index] * window[offset];
  }
  fft(real, imaginary);
}

function estimateNoiseProfile(channels, window, hopSize) {
  const fftSize = window.length;
  const binCount = fftSize / 2 + 1;
  const candidates = [];
  for (let start = 0; start + fftSize <= channels[0].length; start += hopSize) {
    const rms = frameLinkedRms(channels, start, fftSize);
    // Do not learn digital silence as the noise floor. Conversely, ignoring
    // material below -100 dBFS keeps a clean source sample-identical.
    if (rms > 1e-5) candidates.push({ start, rms });
  }
  if (!candidates.length) return null;

  candidates.sort((left, right) => left.rms - right.rms);
  const selectionCount = Math.min(32, Math.max(4, Math.ceil(candidates.length * 0.08)));
  const selected = candidates.slice(0, selectionCount);
  const spectra = selected.map(() => new Float64Array(binCount));
  const real = new Float64Array(fftSize);
  const imaginary = new Float64Array(fftSize);

  selected.forEach((frame, frameIndex) => {
    for (const channel of channels) {
      frameSpectrum(channel, frame.start, window, real, imaginary);
      for (let bin = 0; bin < binCount; bin++) {
        spectra[frameIndex][bin] +=
          (real[bin] * real[bin] + imaginary[bin] * imaginary[bin]) / channels.length;
      }
    }
  });

  const power = new Float64Array(binCount);
  const binValues = new Array(selected.length);
  for (let bin = 0; bin < binCount; bin++) {
    for (let frame = 0; frame < selected.length; frame++) binValues[frame] = spectra[frame][bin];
    binValues.sort((left, right) => left - right);
    // A median is robust to a quiet frame that still contains a note or a
    // short transient, while retaining tonal hum in the learned profile.
    const middle = Math.floor(binValues.length / 2);
    power[bin] = binValues.length % 2
      ? binValues[middle]
      : (binValues[middle - 1] + binValues[middle]) * 0.5;
  }

  const representativeRms = selected[Math.floor(selected.length / 2)].rms;
  const typicalRms = candidates[Math.floor(candidates.length / 2)].rms;
  let averagePower = 0;
  for (let bin = 1; bin < binCount; bin++) averagePower += power[bin];
  averagePower /= Math.max(1, binCount - 1);
  let averageLogPower = 0;
  for (let bin = 1; bin < binCount; bin++) {
    averageLogPower += Math.log(Math.max(power[bin], averagePower * 1e-12, EPSILON));
  }
  const spectralFlatness = Math.exp(averageLogPower / Math.max(1, binCount - 1)) /
    Math.max(averagePower, EPSILON);
  const quietSeparationDb = 20 * Math.log10(
    Math.max(EPSILON, representativeRms) / Math.max(EPSILON, typicalRms)
  );

  // A persistent pitched source with no quieter passage is not a trustworthy
  // noise profile: it is more likely sustained music than hum. Broadband noise
  // can still be learned from a constant-level recording because its spectral
  // flatness makes the distinction reliable.
  if (spectralFlatness < 0.08 && quietSeparationDb > -6) return null;
  return {
    power,
    frameCount: selected.length,
    floorDb: 20 * Math.log10(Math.max(EPSILON, representativeRms))
  };
}

/**
 * Reduces steady broadband noise and hum with an automatically learned noise
 * profile, a soft Wiener mask, and stereo-linked time/frequency smoothing.
 * A common gain mask preserves the stereo image; 50%-overlapped sine windows
 * avoid block boundaries and the conservative floor prevents hollow artifacts.
 */
export function reduceBroadbandNoise(channels, sampleRate, options = {}) {
  const length = channels[0]?.length || 0;
  const amount = clamp(Number(options.amount ?? options.noiseReductionAmount ?? 50), 0, 100);
  const emptyReport = { noiseReductionDb: 0, noiseFloorDb: -Infinity, noiseFrames: 0 };
  if (!length || !channels.length || amount <= 0 || length < sampleRate * 0.1) return emptyReport;

  const fftSize = sampleRate >= 88200 ? 4096 : 2048;
  if (length < fftSize) return emptyReport;
  const hopSize = fftSize / 2;
  const binCount = fftSize / 2 + 1;
  const window = createSineWindow(fftSize);
  const profile = estimateNoiseProfile(channels, window, hopSize);
  if (!profile || profile.floorDb < -96) return emptyReport;

  const output = channels.map(() => new Float64Array(length));
  const normalization = new Float64Array(length);
  const real = channels.map(() => new Float64Array(fftSize));
  const imaginary = channels.map(() => new Float64Array(fftSize));
  const rawGain = new Float64Array(binCount);
  const gain = new Float64Array(binCount);
  const previousGain = new Float64Array(binCount);
  previousGain.fill(1);

  const minimumGain = Math.pow(10, -(6 + amount * 0.14) / 20);
  const subtraction = 0.8 + amount * 0.014;
  let firstFrame = true;
  let inputPower = 0;
  let outputPower = 0;

  for (let start = -fftSize / 2; start < length; start += hopSize) {
    for (let channel = 0; channel < channels.length; channel++) {
      frameSpectrum(channels[channel], start, window, real[channel], imaginary[channel]);
    }

    for (let bin = 0; bin < binCount; bin++) {
      let linkedPower = 0;
      for (let channel = 0; channel < channels.length; channel++) {
        linkedPower += real[channel][bin] ** 2 + imaginary[channel][bin] ** 2;
      }
      linkedPower /= channels.length;
      const cleanFraction = Math.max(0, 1 - subtraction * profile.power[bin] / (linkedPower + EPSILON));
      rawGain[bin] = Math.max(minimumGain, Math.sqrt(cleanFraction));
      inputPower++;
    }

    // Fill narrow gain holes rather than cutting isolated bins. This preserves
    // tonal peaks and suppresses the metallic "musical noise" of hard gates.
    for (let bin = 0; bin < binCount; bin++) {
      const neighborAverage = (
        rawGain[Math.max(0, bin - 1)] + rawGain[bin] * 2 + rawGain[Math.min(binCount - 1, bin + 1)]
      ) / 4;
      const target = Math.max(rawGain[bin], neighborAverage);
      if (firstFrame) {
        gain[bin] = target;
      } else {
        // Reduction engages slowly but releases quickly for transients.
        const blend = target < previousGain[bin] ? 0.28 : 0.62;
        gain[bin] = previousGain[bin] + (target - previousGain[bin]) * blend;
      }
      previousGain[bin] = gain[bin];
    }
    firstFrame = false;

    for (let channel = 0; channel < channels.length; channel++) {
      for (let bin = 0; bin < binCount; bin++) {
        real[channel][bin] *= gain[bin];
        imaginary[channel][bin] *= gain[bin];
        if (bin > 0 && bin < fftSize / 2) {
          real[channel][fftSize - bin] *= gain[bin];
          imaginary[channel][fftSize - bin] *= gain[bin];
        }
      }
      fft(real[channel], imaginary[channel], true);
      for (let offset = 0; offset < fftSize; offset++) {
        const index = start + offset;
        if (index < 0 || index >= length) continue;
        const windowed = real[channel][offset] * window[offset];
        output[channel][index] += windowed;
        if (channel === 0) normalization[index] += window[offset] * window[offset];
      }
    }
    for (let bin = 0; bin < binCount; bin++) outputPower += gain[bin] * gain[bin];
  }

  for (let channel = 0; channel < channels.length; channel++) {
    for (let index = 0; index < length; index++) {
      channels[channel][index] = output[channel][index] / Math.max(EPSILON, normalization[index]);
    }
  }

  // Report mask attenuation, not the song's level change. It remains useful
  // even when loud musical bins dominate total signal power.
  const averageGainPower = outputPower / Math.max(1, inputPower);
  const noiseReductionDb = clamp(-10 * Math.log10(Math.max(EPSILON, averageGainPower)), 0, 99);
  return {
    noiseReductionDb,
    noiseFloorDb: profile.floorDb,
    noiseFrames: profile.frameCount
  };
}

function median(values) {
  if (!values.length) return 0;
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

function linkedCurvature(channels, index) {
  let value = 0;
  for (const channel of channels) {
    value = Math.max(value, Math.abs(channel[index] - (channel[index - 1] + channel[index + 1]) * 0.5));
  }
  return value;
}

function linkedRms(channels, start, end) {
  let sum = 0;
  const length = Math.max(1, end - start) * channels.length;
  for (const channel of channels) {
    for (let i = start; i < end; i++) sum += channel[i] * channel[i];
  }
  return Math.sqrt(sum / length);
}

function quantile(values, amount) {
  if (!values.length) return 0;
  values.sort((a, b) => a - b);
  return values[Math.min(values.length - 1, Math.floor((values.length - 1) * amount))];
}

function solveLinearSystem(matrix, vector) {
  const size = vector.length;
  const rows = matrix.map((row, index) => [...row, vector[index]]);

  for (let column = 0; column < size; column++) {
    let pivot = column;
    for (let row = column + 1; row < size; row++) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    }
    if (Math.abs(rows[pivot][column]) < EPSILON) return null;
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];

    const divisor = rows[column][column];
    for (let entry = column; entry <= size; entry++) rows[column][entry] /= divisor;
    for (let row = 0; row < size; row++) {
      if (row === column) continue;
      const factor = rows[row][column];
      for (let entry = column; entry <= size; entry++) {
        rows[row][entry] -= factor * rows[column][entry];
      }
    }
  }
  return rows.map(row => row[size]);
}

// A short autoregressive model describes pitched and noisy musical material
// much more accurately than raw waveform curvature. A small ridge term keeps
// near-periodic frames numerically stable.
function fitPredictionCoefficients(channel, start, end, order) {
  const correlations = new Float64Array(order + 1);
  let count = 0;
  for (let index = Math.max(start + order, order); index < end; index += 2) {
    for (let lag = 0; lag <= order; lag++) {
      correlations[lag] += channel[index] * channel[index - lag];
    }
    count++;
  }
  if (!count || correlations[0] < EPSILON) return null;

  const ridge = correlations[0] * 1e-4 + EPSILON;
  const matrix = Array.from({ length: order }, (_, row) =>
    Array.from({ length: order }, (_, column) =>
      correlations[Math.abs(row - column)] + (row === column ? ridge : 0)
    )
  );
  return solveLinearSystem(matrix, Array.from({ length: order }, (_, index) => correlations[index + 1]));
}

function predictionError(channel, index, coefficients, direction) {
  let prediction = 0;
  for (let lag = 0; lag < coefficients.length; lag++) {
    prediction += coefficients[lag] * channel[index + direction * (lag + 1)];
  }
  return Math.abs(channel[index] - prediction);
}

function channelRms(channel, start, end) {
  let sum = 0;
  const safeStart = Math.max(0, start);
  const safeEnd = Math.min(channel.length, end);
  for (let index = safeStart; index < safeEnd; index++) sum += channel[index] * channel[index];
  return Math.sqrt(sum / Math.max(1, safeEnd - safeStart));
}

function isMusicalAttack(channel, index, sampleRate) {
  const near = Math.max(8, Math.round(sampleRate * 0.0015));
  const far = Math.max(near, Math.round(sampleRate * 0.006));
  const before = channelRms(channel, index - far, index - near);
  const after = channelRms(channel, index + near, index + far);

  // A real drum/cymbal onset has sustained energy after its first sample. An
  // additive click is locally exceptional but does not create that envelope.
  return after > 0.008 && after > Math.max(before * 2.8, before + 0.012);
}

function markPredictiveImpulses(channel, sampleRate) {
  const length = channel.length;
  const marks = new Uint8Array(length);
  const interpolationOutliers = new Uint8Array(length);
  const frameLength = Math.max(512, Math.round(sampleRate * 0.02));
  const order = 8;
  const padding = Math.max(order + 1, Math.round(sampleRate * 0.004));

  for (let frameStart = padding; frameStart < length - padding; frameStart += frameLength) {
    const frameEnd = Math.min(length - padding, frameStart + frameLength);
    const analysisStart = Math.max(0, frameStart - padding);
    const analysisEnd = Math.min(length, frameEnd + padding);
    const coefficients = fitPredictionCoefficients(channel, analysisStart, analysisEnd, order);
    if (!coefficients) continue;

    const curvatures = [];
    for (let index = frameStart; index < frameEnd; index++) {
      curvatures.push(Math.abs(channel[index] - (channel[index - 1] + channel[index + 1]) * 0.5));
    }
    const curvatureCenter = quantile([...curvatures], 0.5);
    const curvatureDeviations = curvatures.map(value => Math.abs(value - curvatureCenter));
    const curvatureSigma = Math.max(EPSILON, quantile(curvatureDeviations, 0.5) * 1.4826);
    const curvatureThreshold = Math.max(0.00075, curvatureCenter + curvatureSigma * 6);

    // A sparse baseline is enough to estimate normal prediction error. Full
    // bidirectional evaluation is then reserved for curvature outliers, which
    // keeps multi-minute preview generation responsive.
    const predictionScores = [];
    for (let index = frameStart; index < frameEnd; index += 4) {
      const forward = predictionError(channel, index, coefficients, -1);
      const backward = predictionError(channel, index, coefficients, 1);
      predictionScores.push(Math.min(forward, backward));
    }
    const predictionCenter = quantile([...predictionScores], 0.5);
    const predictionDeviations = predictionScores.map(score => Math.abs(score - predictionCenter));
    const predictionSigma = Math.max(EPSILON, quantile(predictionDeviations, 0.5) * 1.4826);
    const localRms = channelRms(channel, frameStart, frameEnd);
    const predictionThreshold = Math.max(
      0.0015,
      localRms * 0.025,
      predictionCenter + predictionSigma * 11
    );

    for (let offset = 0; offset < curvatures.length; offset++) {
      const index = frameStart + offset;
      if (curvatures[offset] <= curvatureThreshold) continue;
      interpolationOutliers[index] = 1;
      const forward = predictionError(channel, index, coefficients, -1);
      const backward = predictionError(channel, index, coefficients, 1);
      // Agreement rejects the error smear that a one-sided predictor creates
      // immediately before or after a defect.
      if (
        Math.min(forward, backward) <= predictionThreshold ||
        isMusicalAttack(channel, index, sampleRate)
      ) continue;
      marks[index] = 1;
    }
  }

  // Adjacent damaged samples can mask one another from a predictor. Once a
  // high-confidence seed is found, include neighboring leave-one-out outliers
  // within the maximum repairable click span.
  const maxCluster = Math.max(3, Math.round(sampleRate * 0.00075));
  const seeds = marks.slice();
  for (let index = 0; index < seeds.length; index++) {
    if (!seeds[index]) continue;
    for (const direction of [-1, 1]) {
      for (let distance = 1; distance < maxCluster; distance++) {
        const neighbor = index + direction * distance;
        if (neighbor <= 0 || neighbor >= length - 1 || !interpolationOutliers[neighbor]) break;
        marks[neighbor] = 1;
      }
    }
  }
  return marks;
}

function bridgeOneSampleGaps(marks) {
  for (let index = 1; index < marks.length - 1; index++) {
    if (!marks[index] && marks[index - 1] && marks[index + 1]) marks[index] = 1;
  }
}

function repairChannelRuns(channel, marks, maxRunLength) {
  let repaired = 0;
  for (let index = 1; index < marks.length - 1; index++) {
    if (!marks[index]) continue;
    const runStart = index;
    while (index < marks.length - 1 && marks[index]) index++;
    const runEnd = index - 1;
    const runLength = runEnd - runStart + 1;
    if (runLength > maxRunLength) continue;

    const left = channel[runStart - 1];
    const right = channel[runEnd + 1];
    const distance = runLength + 1;
    // Linear interpolation is intentionally bounded by its clean endpoints.
    // For a sub-millisecond gap it is transparent, and unlike an unconstrained
    // cubic it cannot overshoot and manufacture a second pop.
    for (let offset = 1; offset <= runLength; offset++) {
      channel[runStart + offset - 1] = left + (right - left) * (offset / distance);
    }
    repaired += runLength;
  }
  return repaired;
}

function boundaryFrameStats(channels, start, end) {
  let sum = 0;
  let crossings = 0;
  let previous = 0;
  let hasPrevious = false;
  for (let i = start; i < end; i++) {
    let sample = 0;
    for (const channel of channels) sample += channel[i] / channels.length;
    sum += sample * sample;
    if (hasPrevious && sample * previous < 0) crossings++;
    previous = sample;
    hasPrevious = true;
  }
  return { rms: Math.sqrt(sum / Math.max(1, end - start)), crossings };
}

function removeBoundaryNoiseBurst(channels, sampleRate, fromStart) {
  const frameLength = Math.max(128, Math.round(sampleRate * 0.01));
  const frameCount = Math.min(25, Math.floor(channels[0].length / frameLength));
  if (frameCount < 5) return 0;

  const length = channels[0].length;
  const frames = Array.from({ length: frameCount }, (_, frame) => {
    const start = fromStart
      ? frame * frameLength
      : length - (frame + 1) * frameLength;
    return boundaryFrameStats(channels, start, start + frameLength);
  });
  let quietStart = -1;
  let noisePeak = 0;
  let noiseCrossings = 0;

  // Find an initial broadband burst that is followed by at least 30 ms of
  // genuine near-silence. This protects intentional intros and ambient beds.
  for (let frame = 0; frame < frameCount - 3; frame++) {
    noisePeak = Math.max(noisePeak, frames[frame].rms);
    noiseCrossings += frames[frame].crossings;
    if (frame < 1) continue;
    const quietThreshold = Math.max(0.00035, noisePeak * 0.18);
    if (
      frames[frame + 1].rms <= quietThreshold &&
      frames[frame + 2].rms <= quietThreshold &&
      frames[frame + 3].rms <= quietThreshold
    ) {
      quietStart = frame + 1;
      break;
    }
  }

  if (quietStart < 0) return 0;
  const burstLength = quietStart * frameLength;
  const averageCrossings = noiseCrossings / Math.max(1, quietStart);
  // A broadband/static burst has a much higher crossing rate than the nearby
  // musical fade in this class of defect. The amplitude floor rejects digital
  // silence and normal dither.
  if (noisePeak < 0.0015 || averageCrossings < frameLength * 0.08) return 0;

  for (const channel of channels) {
    if (fromStart) channel.fill(0, 0, burstLength);
    else channel.fill(0, length - burstLength, length);
  }
  return burstLength;
}

function markImpulses(channels, start, end, thresholdMultiplier, floor) {
  const curvatures = [];
  for (let i = Math.max(1, start); i < Math.min(end, channels[0].length - 1); i++) {
    curvatures.push(linkedCurvature(channels, i));
  }
  const baseline = median(curvatures);
  const threshold = Math.max(floor, baseline * thresholdMultiplier);
  const marks = new Uint8Array(channels[0].length);

  for (let i = Math.max(1, start); i < Math.min(end, channels[0].length - 1); i++) {
    if (linkedCurvature(channels, i) > threshold) marks[i] = 1;
  }
  return marks;
}

function repairMarkedRuns(channels, marks, start, end, maxRunLength) {
  let repaired = 0;
  for (let i = Math.max(2, start); i < Math.min(end, marks.length - 2); i++) {
    if (!marks[i]) continue;
    const runStart = i;
    while (i < end && marks[i]) i++;
    const runEnd = i - 1;
    const runLength = runEnd - runStart + 1;
    if (runLength > maxRunLength || runStart < 2 || runEnd >= marks.length - 2) continue;

    // Cubic Hermite interpolation keeps the slope continuous on both sides of
    // the repaired span, avoiding the dulling introduced by a simple average.
    for (const channel of channels) {
      const leftIndex = runStart - 1;
      const rightIndex = runEnd + 1;
      const left = channel[leftIndex];
      const right = channel[rightIndex];
      const leftSlope = (channel[leftIndex] - channel[leftIndex - 1]);
      const rightSlope = (channel[rightIndex + 1] - channel[rightIndex]);
      const distance = rightIndex - leftIndex;
      for (let j = 1; j < distance; j++) {
        const t = j / distance;
        const t2 = t * t;
        const t3 = t2 * t;
        channel[leftIndex + j] =
          (2 * t3 - 3 * t2 + 1) * left +
          (t3 - 2 * t2 + t) * leftSlope * distance +
          (-2 * t3 + 3 * t2) * right +
          (t3 - t2) * rightSlope * distance;
      }
    }
    repaired += runLength;
  }
  return repaired;
}

/**
 * Removes isolated click/static impulses and silence-bracketed broadband
 * bursts close to the file boundaries. Both channels share the same detection
 * mask, so a stereo image cannot pull to one side when only one channel
 * contains a defect.
 */
export function repairEdgeArtifacts(channels, sampleRate) {
  const length = channels[0]?.length || 0;
  if (length < sampleRate * 0.03) return 0;
  const edgeLength = Math.min(Math.round(sampleRate * 0.08), Math.floor(length / 5));
  const maxRunLength = Math.max(4, Math.round(sampleRate * 0.00075));
  let repaired = removeBoundaryNoiseBurst(channels, sampleRate, true);
  repaired += removeBoundaryNoiseBurst(channels, sampleRate, false);

  for (const [start, end] of [[0, edgeLength], [length - edgeLength, length]]) {
    const marks = markImpulses(channels, start, end, 12, 0.008);
    repaired += repairMarkedRuns(channels, marks, start, end, maxRunLength);
  }
  return repaired;
}

/**
 * Repairs sparse, sub-millisecond clicks and pops using bidirectional local
 * prediction. Each channel is detected and repaired independently: a defect
 * on the left cannot rewrite clean audio on the right. Sustained high-frequency
 * texture is deliberately ignored because it requires spectral restoration,
 * not destructive sample interpolation.
 */
export function repairClicksAndPops(channels, sampleRate) {
  const length = channels[0]?.length || 0;
  if (length < sampleRate * 0.1) return 0;

  let repaired = 0;
  const maxRunLength = Math.max(3, Math.round(sampleRate * 0.00075));
  for (const channel of channels) {
    const marks = markPredictiveImpulses(channel, sampleRate);
    bridgeOneSampleGaps(marks);
    repaired += repairChannelRuns(channel, marks, maxRunLength);
  }
  return repaired;
}

// Kept for saved integrations that imported the old name directly.
export const repairQuietCrackle = repairClicksAndPops;

/**
 * Detects a non-decaying signal at the physical end of a song and applies a
 * smooth equal-power release only in that case. It never extends or invents
 * music after a cut; it gives an otherwise abrupt end a natural release.
 */
export function repairPrematureEnding(channels, sampleRate) {
  const length = channels[0]?.length || 0;
  if (length < sampleRate) return false;

  const tailLength = Math.max(32, Math.round(sampleRate * 0.05));
  const referenceLength = Math.max(tailLength, Math.round(sampleRate * 0.25));
  const tailStart = length - tailLength;
  const referenceStart = Math.max(0, tailStart - referenceLength);
  const tailRms = linkedRms(channels, tailStart, length);
  const referenceRms = linkedRms(channels, referenceStart, tailStart);
  const tailToReferenceDb = 20 * Math.log10((tailRms + EPSILON) / (referenceRms + EPSILON));

  // A naturally decaying ending is already at least 8 dB down. A hard-cut
  // candidate is still audible and remains close to its preceding level.
  if (tailRms < 0.006 || tailToReferenceDb < -8) return false;

  const fadeLength = Math.min(Math.round(sampleRate * 0.65), Math.floor(length / 3));
  const fadeStart = length - fadeLength;
  for (const channel of channels) {
    for (let i = fadeStart; i < length; i++) {
      const progress = (i - fadeStart) / Math.max(1, fadeLength - 1);
      // Raised-cosine/equal-power release: flat slope at both ends prevents a
      // secondary click while preserving the musical tail for most of the fade.
      const gain = Math.pow(Math.cos(progress * Math.PI * 0.5), 1.35);
      channel[i] *= gain;
    }
  }
  return true;
}

export function createRestoredInputBuffer(context, inputBuffer, settings) {
  const restored = context.createBuffer(
    inputBuffer.numberOfChannels,
    inputBuffer.length,
    inputBuffer.sampleRate
  );
  const channels = [];
  for (let channel = 0; channel < inputBuffer.numberOfChannels; channel++) {
    const output = restored.getChannelData(channel);
    output.set(inputBuffer.getChannelData(channel));
    channels.push(output);
  }

  const report = {
    edgeSamples: 0,
    impulseSamples: 0,
    crackleSamples: 0,
    noiseReductionDb: 0,
    noiseFloorDb: -Infinity,
    noiseFrames: 0
  };
  if (settings.repairEdgeArtifacts) report.edgeSamples = repairEdgeArtifacts(channels, inputBuffer.sampleRate);
  if (settings.repairVocalCrackle) {
    report.impulseSamples = repairClicksAndPops(channels, inputBuffer.sampleRate);
    report.crackleSamples = report.impulseSamples;
  }
  if (settings.noiseReduction) {
    Object.assign(report, reduceBroadbandNoise(channels, inputBuffer.sampleRate, {
      amount: settings.noiseReductionAmount
    }));
  }
  return { buffer: restored, report };
}
