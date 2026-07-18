const loadedContexts = new WeakSet();
const WORKLET_URL = new URL('./playbackGuard.worklet.js', import.meta.url);

export async function createPlaybackGuardNode(context) {
  if (context.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
    try {
      if (!loadedContexts.has(context)) {
        await context.audioWorklet.addModule(WORKLET_URL.href);
        loadedContexts.add(context);
      }
      const node = new AudioWorkletNode(context, 'playback-guard', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2]
      });
      node.isPlaybackGuard = true;
      return node;
    } catch (error) {
      console.warn('Playback guard AudioWorklet unavailable; using gain fallback.', error);
    }
  }

  return context.createGain();
}

export function armPlaybackGuard(node, fadeSeconds) {
  if (!node?.isPlaybackGuard) return false;
  node.port.postMessage({ type: 'arm', fadeSeconds });
  return true;
}

export function silencePlaybackGuard(node) {
  if (!node?.isPlaybackGuard) return false;
  node.port.postMessage({ type: 'silence' });
  return true;
}
