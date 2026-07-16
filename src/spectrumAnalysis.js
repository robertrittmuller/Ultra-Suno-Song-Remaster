function fft(real, imaginary) {
  const length = real.length;
  for (let i = 1, j = 0; i < length; i++) {
    let bit = length >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imaginary[i], imaginary[j]] = [imaginary[j], imaginary[i]];
    }
  }
  for (let size = 2; size <= length; size <<= 1) {
    const angle = -2 * Math.PI / size;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let start = 0; start < length; start += size) {
      let rotationReal = 1;
      let rotationImaginary = 0;
      for (let offset = 0; offset < size / 2; offset++) {
        const even = start + offset;
        const odd = even + size / 2;
        const oddReal = real[odd] * rotationReal - imaginary[odd] * rotationImaginary;
        const oddImaginary = real[odd] * rotationImaginary + imaginary[odd] * rotationReal;
        real[odd] = real[even] - oddReal;
        imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal;
        imaginary[even] += oddImaginary;
        const nextReal = rotationReal * stepReal - rotationImaginary * stepImaginary;
        rotationImaginary = rotationReal * stepImaginary + rotationImaginary * stepReal;
        rotationReal = nextReal;
      }
    }
  }
}

export function calculateAverageSpectrum(audioBuffer, fftSize = 2048, windowCount = 24) {
  const bins = fftSize / 2;
  const powers = new Float64Array(bins);
  const channelCount = Math.min(2, audioBuffer.numberOfChannels);
  const maximumStart = Math.max(0, audioBuffer.length - fftSize);
  let usedWindows = 0;
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    const start = windowCount === 1 ? 0 : Math.round(maximumStart * windowIndex / (windowCount - 1));
    for (let channel = 0; channel < channelCount; channel++) {
      const real = new Float64Array(fftSize);
      const imaginary = new Float64Array(fftSize);
      const samples = audioBuffer.getChannelData(channel);
      for (let sample = 0; sample < fftSize; sample++) {
        const value = samples[start + sample] || 0;
        const hann = 0.5 - 0.5 * Math.cos(2 * Math.PI * sample / (fftSize - 1));
        real[sample] = value * hann;
      }
      fft(real, imaginary);
      for (let bin = 0; bin < bins; bin++) powers[bin] += real[bin] ** 2 + imaginary[bin] ** 2;
      usedWindows++;
    }
  }
  const decibels = new Float32Array(bins);
  for (let bin = 0; bin < bins; bin++) {
    decibels[bin] = 10 * Math.log10(powers[bin] / Math.max(1, usedWindows) + 1e-20);
  }
  return { sampleRate: audioBuffer.sampleRate, fftSize, decibels };
}
