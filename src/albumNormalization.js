export function calculateAlbumLoudness(tracks) {
  let weightedEnergy = 0;
  let totalDuration = 0;
  for (const track of tracks) {
    const loudness = Number(track.integratedLUFS);
    const duration = Number(track.duration);
    if (!Number.isFinite(loudness) || !(duration > 0)) continue;
    const energy = Math.pow(10, (loudness + 0.691) / 10);
    weightedEnergy += energy * duration;
    totalDuration += duration;
  }
  if (!(weightedEnergy > 0) || !(totalDuration > 0)) return -Infinity;
  return -0.691 + 10 * Math.log10(weightedEnergy / totalDuration);
}

export function calculateAlbumNormalizationGain(tracks, targetLufs) {
  const albumLufs = calculateAlbumLoudness(tracks);
  return {
    albumLufs,
    gain: Number.isFinite(albumLufs) ? Math.pow(10, (targetLufs - albumLufs) / 20) : 1,
    gainDb: Number.isFinite(albumLufs) ? targetLufs - albumLufs : 0
  };
}
