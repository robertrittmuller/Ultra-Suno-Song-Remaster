export function createAudioBufferMock(channels, sampleRate) {
  const data = channels.map(channel => channel instanceof Float32Array ? channel : Float32Array.from(channel));
  return {
    numberOfChannels: data.length,
    sampleRate,
    length: data[0]?.length || 0,
    duration: (data[0]?.length || 0) / sampleRate,
    getChannelData(channel) {
      return data[channel];
    }
  };
}

export function sineWave(sampleRate, seconds, frequency, peak = 1, phase = 0) {
  const samples = new Float32Array(Math.round(sampleRate * seconds));
  for (let index = 0; index < samples.length; index++) {
    samples[index] = peak * Math.sin(2 * Math.PI * frequency * index / sampleRate + phase);
  }
  return samples;
}
