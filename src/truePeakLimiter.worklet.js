const SAFETY_GAIN = Math.pow(10, -0.05 / 20);

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

class TruePeakLimiterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'ceiling', defaultValue: -1, minValue: -12, maxValue: 0, automationRate: 'k-rate' },
      { name: 'enabled', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
    ];
  }

  constructor() {
    super();
    this.lookaheadFrames = Math.max(128, Math.round(sampleRate * 0.005));
    this.ringLength = this.lookaheadFrames + 256;
    this.rings = [];
    this.histories = [];
    this.port.onmessage = event => {
      if (event.data?.type === 'reset') this.reset();
    };
    this.reset();
  }

  reset() {
    for (const ring of this.rings) ring.fill(0);
    for (const history of this.histories) history.fill(0);
    this.writeIndex = 0;
    this.framesSeen = 0;
    this.envelope = 1;
    this.holdFrames = 0;
    this.releaseCoefficient = Math.exp(-1 / (sampleRate * 0.08));
  }

  ensureChannels(channelCount) {
    while (this.rings.length < channelCount) {
      this.rings.push(new Float32Array(this.ringLength));
      this.histories.push(new Float32Array(4));
    }
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output.length) return true;
    this.ensureChannels(output.length);
    const frameCount = output[0].length;
    const enabled = parameters.enabled[0] >= 0.5;
    const ceiling = Math.pow(10, parameters.ceiling[0] / 20) * SAFETY_GAIN;

    for (let frame = 0; frame < frameCount; frame++) {
      let predictedPeak = 0;
      for (let channel = 0; channel < output.length; channel++) {
        const sample = input[channel]?.[frame] || 0;
        this.rings[channel][this.writeIndex] = sample;
        const history = this.histories[channel];
        history[0] = history[1];
        history[1] = history[2];
        history[2] = history[3];
        history[3] = sample;
        predictedPeak = Math.max(predictedPeak, Math.abs(history[1]), Math.abs(history[2]));
        predictedPeak = Math.max(predictedPeak, Math.abs(catmullRom(history[0], history[1], history[2], history[3], 0.25)));
        predictedPeak = Math.max(predictedPeak, Math.abs(catmullRom(history[0], history[1], history[2], history[3], 0.5)));
        predictedPeak = Math.max(predictedPeak, Math.abs(catmullRom(history[0], history[1], history[2], history[3], 0.75)));
      }

      const requiredGain = enabled && predictedPeak > ceiling ? ceiling / predictedPeak : 1;
      if (requiredGain < this.envelope) {
        this.envelope = requiredGain;
        this.holdFrames = this.lookaheadFrames;
      } else if (this.holdFrames > 0) {
        this.holdFrames--;
      } else {
        this.envelope = 1 - (1 - this.envelope) * this.releaseCoefficient;
      }
      if (!enabled) this.envelope = 1;

      const readIndex = (this.writeIndex - this.lookaheadFrames + this.ringLength) % this.ringLength;
      const ready = this.framesSeen >= this.lookaheadFrames;
      for (let channel = 0; channel < output.length; channel++) {
        output[channel][frame] = ready ? this.rings[channel][readIndex] * this.envelope : 0;
      }
      this.writeIndex = (this.writeIndex + 1) % this.ringLength;
      this.framesSeen++;
    }
    return true;
  }
}

registerProcessor('true-peak-limiter', TruePeakLimiterProcessor);
