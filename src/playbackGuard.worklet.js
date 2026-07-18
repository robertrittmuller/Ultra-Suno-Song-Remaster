class PlaybackGuardProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.mode = 'silent';
    this.gain = 0;
    this.fadeStep = 1;
    this.port.onmessage = event => {
      if (event.data?.type === 'arm') {
        const fadeSeconds = Math.max(0.001, Number(event.data.fadeSeconds) || 0.02);
        this.fadeStep = 1 / Math.max(1, Math.round(sampleRate * fadeSeconds));
        this.gain = 0;
        this.mode = 'waiting';
      } else if (event.data?.type === 'silence') {
        this.gain = 0;
        this.mode = 'silent';
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output?.length) return true;

    const frameCount = output[0].length;
    for (let frame = 0; frame < frameCount; frame++) {
      let peak = 0;
      for (let channel = 0; channel < output.length; channel++) {
        const sourceChannel = input[Math.min(channel, Math.max(0, input.length - 1))];
        peak = Math.max(peak, Math.abs(sourceChannel?.[frame] || 0));
      }

      if (this.mode === 'waiting' && peak > 1e-8) this.mode = 'fading';
      const frameGain = this.mode === 'open' ? 1 : this.mode === 'fading' ? this.gain : 0;
      for (let channel = 0; channel < output.length; channel++) {
        const sourceChannel = input[Math.min(channel, Math.max(0, input.length - 1))];
        output[channel][frame] = (sourceChannel?.[frame] || 0) * frameGain;
      }

      if (this.mode === 'fading') {
        this.gain = Math.min(1, this.gain + this.fadeStep);
        if (this.gain >= 1) this.mode = 'open';
      }
    }
    return true;
  }
}

registerProcessor('playback-guard', PlaybackGuardProcessor);
