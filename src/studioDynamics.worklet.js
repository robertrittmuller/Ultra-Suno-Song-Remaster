const EPSILON = 1e-12;

function clamp(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

function coefficient(milliseconds) {
  return Math.exp(-1 / (sampleRate * Math.max(0.1, milliseconds) / 1000));
}

function dbToGain(db) {
  return Math.pow(10, db / 20);
}

class Biquad {
  constructor() {
    this.b0 = 1;
    this.b1 = 0;
    this.b2 = 0;
    this.a1 = 0;
    this.a2 = 0;
    this.z1 = 0;
    this.z2 = 0;
  }

  normalize(b0, b1, b2, a0, a1, a2) {
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
  }

  setBandpass(frequency, q) {
    const omega = 2 * Math.PI * Math.min(frequency, sampleRate * 0.45) / sampleRate;
    const alpha = Math.sin(omega) / (2 * Math.max(0.1, q));
    this.normalize(alpha, 0, -alpha, 1 + alpha, -2 * Math.cos(omega), 1 - alpha);
  }

  setPeaking(frequency, q, gainDb) {
    const omega = 2 * Math.PI * Math.min(frequency, sampleRate * 0.45) / sampleRate;
    const alpha = Math.sin(omega) / (2 * Math.max(0.1, q));
    const amplitude = Math.pow(10, gainDb / 40);
    this.normalize(
      1 + alpha * amplitude,
      -2 * Math.cos(omega),
      1 - alpha * amplitude,
      1 + alpha / amplitude,
      -2 * Math.cos(omega),
      1 - alpha / amplitude
    );
  }

  process(input) {
    const output = input * this.b0 + this.z1;
    this.z1 = input * this.b1 - output * this.a1 + this.z2;
    this.z2 = input * this.b2 - output * this.a2;
    return output;
  }
}

class DynamicBand {
  constructor(config = {}) {
    this.detectors = [new Biquad(), new Biquad()];
    this.filters = [new Biquad(), new Biquad()];
    this.envelope = 0;
    this.reductionDb = 0;
    this.lastFilterGain = NaN;
    this.configure(config);
  }

  configure(config = {}) {
    this.enabled = Boolean(config.enabled ?? true);
    this.frequency = clamp(config.frequency, 30, sampleRate * 0.45, 1000);
    this.q = clamp(config.q, 0.2, 10, 1.2);
    this.thresholdDb = clamp(config.thresholdDb, -70, 0, -30);
    this.ratio = clamp(config.ratio, 1, 20, 2);
    this.rangeDb = clamp(config.rangeDb, 0, 18, 3);
    this.attack = coefficient(clamp(config.attackMs, 0.5, 500, 10));
    this.release = coefficient(clamp(config.releaseMs, 5, 2000, 120));
    for (const detector of this.detectors) detector.setBandpass(this.frequency, this.q);
    this.setFilterGain(this.enabled ? this.reductionDb : 0, true);
  }

  setFilterGain(gainDb, force = false) {
    if (!force && Math.abs(gainDb - this.lastFilterGain) < 0.015) return;
    this.lastFilterGain = gainDb;
    for (const filter of this.filters) filter.setPeaking(this.frequency, this.q, gainDb);
  }

  detect(inputs) {
    let detected = 0;
    for (let channel = 0; channel < inputs.length; channel++) {
      detected = Math.max(detected, Math.abs(this.detectors[channel].process(inputs[channel])));
    }
    const smoothing = detected > this.envelope ? this.attack : this.release;
    this.envelope = smoothing * this.envelope + (1 - smoothing) * detected;
    const levelDb = 20 * Math.log10(this.envelope + EPSILON);
    const over = Math.max(0, levelDb - this.thresholdDb);
    const reduction = this.enabled ? Math.min(this.rangeDb, over * (1 - 1 / this.ratio)) : 0;
    this.reductionDb = -reduction;
    this.setFilterGain(this.reductionDb);
  }

  process(inputs) {
    this.detect(inputs);
    return inputs.map((input, channel) => this.filters[channel].process(input));
  }
}

function compressorReduction(levelDb, config) {
  const over = levelDb - config.thresholdDb;
  let reduction = 0;
  if (config.kneeDb > 0 && over > -config.kneeDb / 2 && over < config.kneeDb / 2) {
    const position = over + config.kneeDb / 2;
    reduction = (1 - 1 / config.ratio) * position * position / (2 * config.kneeDb);
  } else if (over >= config.kneeDb / 2) {
    reduction = Math.max(0, over * (1 - 1 / config.ratio));
  }
  return Math.min(config.maxReductionDb, reduction);
}

class StudioDynamicsProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.dynamicBands = [];
    this.deEsser = new DynamicBand();
    this.compressorEnvelope = 0;
    this.compressorReductionDb = 0;
    this.framesSinceMeter = 0;
    this.configure(options.processorOptions?.config || {});
    this.port.onmessage = event => {
      if (event.data?.type === 'configure') this.configure(event.data.config || {});
    };
  }

  configure(config) {
    const dynamic = config.dynamicEq || {};
    const bands = Array.isArray(dynamic.bands) ? dynamic.bands : [];
    while (this.dynamicBands.length < bands.length) this.dynamicBands.push(new DynamicBand());
    this.dynamicBands.length = bands.length;
    this.dynamicBands.forEach((band, index) => band.configure({ ...bands[index], enabled: Boolean(dynamic.enabled) }));

    const deEsser = config.deEsser || {};
    this.deEsserAudition = Boolean(deEsser.enabled && deEsser.audition);
    this.deEsser.configure({
      enabled: Boolean(deEsser.enabled),
      frequency: deEsser.frequency,
      q: deEsser.q,
      thresholdDb: deEsser.thresholdDb,
      ratio: deEsser.ratio,
      rangeDb: deEsser.rangeDb,
      attackMs: deEsser.attackMs,
      releaseMs: deEsser.releaseMs
    });

    const compressor = config.compressor || {};
    this.compressor = {
      enabled: Boolean(compressor.enabled),
      thresholdDb: clamp(compressor.thresholdDb, -48, 0, -20),
      ratio: clamp(compressor.ratio, 1, 20, 3),
      attack: coefficient(clamp(compressor.attackMs, 1, 200, 10)),
      release: coefficient(clamp(compressor.releaseMs, 20, 1000, 110)),
      kneeDb: clamp(compressor.kneeDb, 0, 24, 6),
      maxReductionDb: clamp(compressor.maxReductionDb, 0, 18, 6),
      mix: clamp(compressor.mix, 0, 1, 1),
      makeupDb: clamp(compressor.makeupDb, -12, 12, 0)
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input?.length || !output?.length) return true;
    const frames = output[0].length;
    const channels = Math.min(2, output.length);
    let blockCompressorReduction = 0;
    let blockDeEsserReduction = 0;
    const blockDynamicReduction = this.dynamicBands.map(() => 0);

    for (let frame = 0; frame < frames; frame++) {
      const dry = [];
      for (let channel = 0; channel < channels; channel++) {
        const sourceChannel = input[Math.min(channel, input.length - 1)];
        dry[channel] = sourceChannel?.[frame] || 0;
      }

      let processed = dry.slice();
      for (let index = 0; index < this.dynamicBands.length; index++) {
        processed = this.dynamicBands[index].process(processed);
        blockDynamicReduction[index] = Math.max(blockDynamicReduction[index], -this.dynamicBands[index].reductionDb);
      }

      const beforeDeEsser = processed.slice();
      processed = this.deEsser.process(processed);
      blockDeEsserReduction = Math.max(blockDeEsserReduction, -this.deEsser.reductionDb);
      if (this.deEsserAudition) {
        processed = processed.map((sample, channel) => beforeDeEsser[channel] - sample);
      }

      let peak = 0;
      for (const sample of processed) peak = Math.max(peak, Math.abs(sample));
      const smoothing = peak > this.compressorEnvelope ? this.compressor.attack : this.compressor.release;
      this.compressorEnvelope = smoothing * this.compressorEnvelope + (1 - smoothing) * peak;
      const levelDb = 20 * Math.log10(this.compressorEnvelope + EPSILON);
      this.compressorReductionDb = this.compressor.enabled ? compressorReduction(levelDb, this.compressor) : 0;
      blockCompressorReduction = Math.max(blockCompressorReduction, this.compressorReductionDb);
      const wetGain = dbToGain(this.compressor.makeupDb - this.compressorReductionDb);

      for (let channel = 0; channel < output.length; channel++) {
        const sourceIndex = Math.min(channel, channels - 1);
        const wet = processed[sourceIndex] * wetGain;
        output[channel][frame] = this.compressor.enabled
          ? processed[sourceIndex] * (1 - this.compressor.mix) + wet * this.compressor.mix
          : processed[sourceIndex];
      }
    }

    this.framesSinceMeter += frames;
    if (this.framesSinceMeter >= 1024) {
      this.framesSinceMeter = 0;
      this.port.postMessage({
        type: 'meter',
        compressorReductionDb: blockCompressorReduction,
        dynamicReductionDb: blockDynamicReduction,
        deEsserReductionDb: blockDeEsserReduction
      });
    }
    return true;
  }
}

registerProcessor('studio-dynamics', StudioDynamicsProcessor);
