// Conservative, analysis-gated restoration for decoded PCM audio.
// These tools deliberately repair only signal anomalies that pass a local
// statistical test; they are not blanket denoisers or hard-coded fades.

const EPSILON = 1e-9;

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

function linkedQuantile(channels, start, end, quantile) {
  const values = [];
  for (let i = start; i < end; i++) {
    let peak = 0;
    for (const channel of channels) peak = Math.max(peak, Math.abs(channel[i]));
    values.push(peak);
  }
  if (!values.length) return 0;
  values.sort((a, b) => a - b);
  return values[Math.min(values.length - 1, Math.floor((values.length - 1) * quantile))];
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
 * Repairs short, impulsive crackles only in low-level program material. The
 * local curvature threshold adapts to consonants and bright instrumentation;
 * wide-band musical detail is left untouched rather than noise-gated.
 */
export function repairQuietCrackle(channels, sampleRate) {
  const length = channels[0]?.length || 0;
  if (length < sampleRate * 0.1) return 0;

  const frameLength = Math.max(128, Math.round(sampleRate * 0.02));
  const globalRms = linkedRms(channels, 0, length);
  // This is deliberately conservative: "quiet" must be materially below the
  // track RMS and below roughly -26 dBFS, whichever is lower.
  const quietThreshold = Math.min(globalRms * 0.42, 0.05);
  const marks = new Uint8Array(length);

  for (let start = 1; start < length - 1; start += frameLength) {
    const end = Math.min(length - 1, start + frameLength);
    // RMS is deliberately not used here: a single large crackle would make an
    // otherwise silent frame appear loud and evade detection. The 75th
    // percentile describes the underlying programme level instead.
    if (linkedQuantile(channels, start, end, 0.75) > quietThreshold) continue;
    const frameMarks = markImpulses(channels, start, end, 8, 0.004);
    for (let i = start; i < end; i++) marks[i] = frameMarks[i];
  }

  return repairMarkedRuns(channels, marks, 1, length - 1, Math.max(8, Math.round(sampleRate * 0.001)));
}

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

  const report = { edgeSamples: 0, crackleSamples: 0 };
  if (settings.repairEdgeArtifacts) report.edgeSamples = repairEdgeArtifacts(channels, inputBuffer.sampleRate);
  if (settings.repairVocalCrackle) report.crackleSamples = repairQuietCrackle(channels, inputBuffer.sampleRate);
  return { buffer: restored, report };
}
