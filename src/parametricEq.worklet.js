function clamp(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

class Biquad {
  constructor() {
    this.z1 = 0;
    this.z2 = 0;
    this.b0 = 1;
    this.b1 = 0;
    this.b2 = 0;
    this.a1 = 0;
    this.a2 = 0;
  }

  setCoefficients(b0, b1, b2, a0, a1, a2) {
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
  }

  configure({ type, frequency, gain, q }) {
    const omega = 2 * Math.PI * Math.min(frequency, sampleRate * 0.45) / sampleRate;
    const sine = Math.sin(omega);
    const cosine = Math.cos(omega);
    const safeQ = Math.max(0.1, q);
    const alpha = sine / (2 * safeQ);
    const amplitude = Math.pow(10, gain / 40);
    const shelfSlope = Math.max(0.1, Math.min(2, safeQ));
    const shelfAlpha = sine / 2 * Math.sqrt((amplitude + 1 / amplitude) * (1 / shelfSlope - 1) + 2);
    const beta = 2 * Math.sqrt(amplitude) * shelfAlpha;

    if (type === 'lowpass') {
      this.setCoefficients((1 - cosine) / 2, 1 - cosine, (1 - cosine) / 2, 1 + alpha, -2 * cosine, 1 - alpha);
    } else if (type === 'highpass') {
      this.setCoefficients((1 + cosine) / 2, -(1 + cosine), (1 + cosine) / 2, 1 + alpha, -2 * cosine, 1 - alpha);
    } else if (type === 'notch') {
      this.setCoefficients(1, -2 * cosine, 1, 1 + alpha, -2 * cosine, 1 - alpha);
    } else if (type === 'lowshelf') {
      this.setCoefficients(
        amplitude * ((amplitude + 1) - (amplitude - 1) * cosine + beta),
        2 * amplitude * ((amplitude - 1) - (amplitude + 1) * cosine),
        amplitude * ((amplitude + 1) - (amplitude - 1) * cosine - beta),
        (amplitude + 1) + (amplitude - 1) * cosine + beta,
        -2 * ((amplitude - 1) + (amplitude + 1) * cosine),
        (amplitude + 1) + (amplitude - 1) * cosine - beta
      );
    } else if (type === 'highshelf') {
      this.setCoefficients(
        amplitude * ((amplitude + 1) + (amplitude - 1) * cosine + beta),
        -2 * amplitude * ((amplitude - 1) + (amplitude + 1) * cosine),
        amplitude * ((amplitude + 1) + (amplitude - 1) * cosine - beta),
        (amplitude + 1) - (amplitude - 1) * cosine + beta,
        2 * ((amplitude - 1) - (amplitude + 1) * cosine),
        (amplitude + 1) - (amplitude - 1) * cosine - beta
      );
    } else {
      this.setCoefficients(
        1 + alpha * amplitude,
        -2 * cosine,
        1 - alpha * amplitude,
        1 + alpha / amplitude,
        -2 * cosine,
        1 - alpha / amplitude
      );
    }
  }

  process(input) {
    const output = input * this.b0 + this.z1;
    this.z1 = input * this.b1 - output * this.a1 + this.z2;
    this.z2 = input * this.b2 - output * this.a2;
    return output;
  }
}

class ParametricBand {
  constructor(config) {
    this.filters = [new Biquad(), new Biquad(), new Biquad(), new Biquad()];
    this.configure(config);
  }

  configure(config = {}) {
    this.enabled = config.enabled !== false;
    this.mode = ['stereo', 'mid', 'side'].includes(config.mode) ? config.mode : 'stereo';
    const normalized = {
      type: ['peaking', 'lowshelf', 'highshelf', 'highpass', 'lowpass', 'notch'].includes(config.type) ? config.type : 'peaking',
      frequency: clamp(config.frequency, 20, 20000, 1000),
      gain: clamp(config.gain, -18, 18, 0),
      q: clamp(config.q, 0.1, 18, 1)
    };
    for (const filter of this.filters) filter.configure(normalized);
  }

  process(left, right) {
    if (!this.enabled) return [left, right];
    if (this.mode === 'stereo') {
      return [this.filters[0].process(left), this.filters[1].process(right)];
    }
    let mid = (left + right) * 0.5;
    let side = (left - right) * 0.5;
    if (this.mode === 'mid') mid = this.filters[2].process(mid);
    else side = this.filters[3].process(side);
    return [mid + side, mid - side];
  }
}

class ParametricEqProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.bands = [];
    this.configure(options.processorOptions?.bands || []);
    this.port.onmessage = event => {
      if (event.data?.type === 'configure') this.configure(event.data.bands || []);
    };
  }

  configure(bands) {
    while (this.bands.length < bands.length) this.bands.push(new ParametricBand({ enabled: false }));
    this.bands.length = bands.length;
    this.bands.forEach((band, index) => band.configure(bands[index]));
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input?.length || !output?.length) return true;
    const frames = output[0].length;
    for (let frame = 0; frame < frames; frame++) {
      let left = input[0]?.[frame] || 0;
      let right = input[Math.min(1, input.length - 1)]?.[frame] ?? left;
      for (const band of this.bands) [left, right] = band.process(left, right);
      output[0][frame] = left;
      if (output[1]) output[1][frame] = right;
    }
    return true;
  }
}

registerProcessor('parametric-eq', ParametricEqProcessor);
