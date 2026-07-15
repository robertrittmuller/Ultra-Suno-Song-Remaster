import { AUDIO_CONSTANTS } from './audioConstants.js';

const loadedWorkletContexts = new WeakSet();
const TRUE_PEAK_WORKLET_URL = new URL('./truePeakLimiter.worklet.js', import.meta.url);
export const MONO_BASS_FREQUENCY = 120;
export const GLUE_COMPRESSOR_LATENCY_SECONDS = 0.006;

export async function createRealtimeLimiterNode(context) {
  if (context.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
    try {
      if (!loadedWorkletContexts.has(context)) {
        await context.audioWorklet.addModule(TRUE_PEAK_WORKLET_URL.href);
        loadedWorkletContexts.add(context);
      }
      return new AudioWorkletNode(context, 'true-peak-limiter', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2]
      });
    } catch (error) {
      console.warn('True-peak AudioWorklet unavailable; using compressor preview fallback.', error);
    }
  }

  const fallback = context.createDynamicsCompressor();
  fallback.isTruePeakFallback = true;
  return fallback;
}

export function createMasteringNodes(context, limiter, options = {}) {
  const nodes = {
    inputGain: context.createGain(),
    gain: context.createGain(),
    normGain: context.createGain(),
    highpass: context.createBiquadFilter(),
    lowshelf: context.createBiquadFilter(),
    highshelf: context.createBiquadFilter(),
    midPeak: context.createBiquadFilter(),
    midPeak2: context.createBiquadFilter(),
    // DynamicsCompressorNode has a fixed 6 ms lookahead even at 1:1. Use a
    // true GainNode bypass when glue is disabled so clean exports are not
    // delayed and truncated merely by passing through an inactive processor.
    compressor: options.glueCompression === false
      ? context.createGain()
      : context.createDynamicsCompressor(),
    limiter: limiter || context.createDynamicsCompressor(),
    stereoSplitter: context.createChannelSplitter(2),
    stereoMerger: context.createChannelMerger(2),
    midGain: context.createGain(),
    sideGain: context.createGain(),
    leftToMid: context.createGain(),
    rightToMid: context.createGain(),
    leftToSide: context.createGain(),
    rightToSide: context.createGain(),
    midToLeft: context.createGain(),
    midToRight: context.createGain(),
    sideToLeft: context.createGain(),
    sideToRight: context.createGain(),
    sideBassHighpass1: context.createBiquadFilter(),
    sideBassHighpass2: context.createBiquadFilter(),
    eqLow: context.createBiquadFilter(),
    eqLowMid: context.createBiquadFilter(),
    eqMid: context.createBiquadFilter(),
    eqHighMid: context.createBiquadFilter(),
    eqHigh: context.createBiquadFilter()
  };
  configureEqNodes(nodes);
  configureMasteringNodes(nodes, {});
  return nodes;
}

export function configureEqNodes(nodes) {
  nodes.eqLow.type = 'lowshelf';
  nodes.eqLow.frequency.value = AUDIO_CONSTANTS.FREQ_LOW;
  nodes.eqLowMid.type = 'peaking';
  nodes.eqLowMid.frequency.value = AUDIO_CONSTANTS.FREQ_LOW_MID;
  nodes.eqLowMid.Q.value = 1;
  nodes.eqMid.type = 'peaking';
  nodes.eqMid.frequency.value = AUDIO_CONSTANTS.FREQ_MID;
  nodes.eqMid.Q.value = 1;
  nodes.eqHighMid.type = 'peaking';
  nodes.eqHighMid.frequency.value = AUDIO_CONSTANTS.FREQ_HIGH_MID;
  nodes.eqHighMid.Q.value = 1;
  nodes.eqHigh.type = 'highshelf';
  nodes.eqHigh.frequency.value = AUDIO_CONSTANTS.FREQ_HIGH;
}

export function setLimiterParameters(limiter, enabled, ceilingDb) {
  // A GainNode is used as a transparent final-stage placeholder during the
  // first (pre-limiter) offline render.
  if (limiter.gain && !limiter.threshold) {
    limiter.gain.value = 1;
    return;
  }
  if (limiter.parameters?.has('ceiling')) {
    limiter.parameters.get('ceiling').value = ceilingDb;
    limiter.parameters.get('enabled').value = enabled ? 1 : 0;
    return;
  }
  limiter.threshold.value = enabled ? ceilingDb : 0;
  limiter.knee.value = 0;
  limiter.ratio.value = enabled ? AUDIO_CONSTANTS.LIMITER_RATIO : 1;
  limiter.attack.value = AUDIO_CONSTANTS.LIMITER_ATTACK;
  limiter.release.value = AUDIO_CONSTANTS.LIMITER_RELEASE;
}

export function configureMasteringNodes(nodes, settings = {}) {
  nodes.highpass.type = 'highpass';
  nodes.highpass.frequency.value = settings.cleanLowEnd === false ? 1 : AUDIO_CONSTANTS.HIGHPASS_FREQ;
  nodes.highpass.Q.value = 0.7;

  nodes.lowshelf.type = 'peaking';
  nodes.lowshelf.frequency.value = AUDIO_CONSTANTS.MUD_CUT_FREQ;
  nodes.lowshelf.Q.value = 1.5;
  nodes.lowshelf.gain.value = settings.cutMud ? -3 : 0;

  nodes.highshelf.type = 'highshelf';
  nodes.highshelf.frequency.value = AUDIO_CONSTANTS.AIR_FREQ;
  nodes.highshelf.gain.value = settings.addAir ? 2.5 : 0;

  nodes.midPeak.type = 'peaking';
  nodes.midPeak.frequency.value = AUDIO_CONSTANTS.HARSHNESS_FREQ_1;
  nodes.midPeak.Q.value = AUDIO_CONSTANTS.HARSHNESS_Q_4K;
  nodes.midPeak.gain.value = settings.tameHarsh ? AUDIO_CONSTANTS.HARSHNESS_GAIN_4K : 0;

  nodes.midPeak2.type = 'peaking';
  nodes.midPeak2.frequency.value = AUDIO_CONSTANTS.HARSHNESS_FREQ_2;
  nodes.midPeak2.Q.value = AUDIO_CONSTANTS.HARSHNESS_Q_6K;
  nodes.midPeak2.gain.value = settings.tameHarsh ? AUDIO_CONSTANTS.HARSHNESS_GAIN_6K : 0;

  if (nodes.compressor.threshold) {
    nodes.compressor.threshold.value = settings.glueCompression ? AUDIO_CONSTANTS.GLUE_THRESHOLD : 0;
    nodes.compressor.knee.value = 10;
    nodes.compressor.ratio.value = settings.glueCompression ? AUDIO_CONSTANTS.GLUE_RATIO : 1;
    nodes.compressor.attack.value = AUDIO_CONSTANTS.GLUE_ATTACK;
    nodes.compressor.release.value = AUDIO_CONSTANTS.GLUE_RELEASE;
  }

  nodes.sideBassHighpass1.type = 'highpass';
  nodes.sideBassHighpass2.type = 'highpass';
  nodes.sideBassHighpass1.Q.value = 0.7071;
  nodes.sideBassHighpass2.Q.value = 0.7071;
  const monoBassFrequency = settings.centerBass ? MONO_BASS_FREQUENCY : 1;
  nodes.sideBassHighpass1.frequency.value = monoBassFrequency;
  nodes.sideBassHighpass2.frequency.value = monoBassFrequency;

  setLimiterParameters(
    nodes.limiter,
    settings.truePeakLimit !== false,
    Number.isFinite(settings.truePeakCeiling) ? settings.truePeakCeiling : -1
  );
}

export function connectMasteringGraph(source, nodes) {
  source
    .connect(nodes.inputGain)
    .connect(nodes.highpass)
    .connect(nodes.eqLow)
    .connect(nodes.eqLowMid)
    .connect(nodes.eqMid)
    .connect(nodes.eqHighMid)
    .connect(nodes.eqHigh)
    .connect(nodes.lowshelf)
    .connect(nodes.midPeak)
    .connect(nodes.midPeak2)
    .connect(nodes.highshelf)
    .connect(nodes.compressor)
    .connect(nodes.stereoSplitter);

  nodes.stereoSplitter.connect(nodes.leftToMid, 0);
  nodes.stereoSplitter.connect(nodes.rightToMid, 1);
  nodes.leftToMid.gain.value = 0.5;
  nodes.rightToMid.gain.value = 0.5;
  nodes.leftToMid.connect(nodes.midGain);
  nodes.rightToMid.connect(nodes.midGain);

  nodes.stereoSplitter.connect(nodes.leftToSide, 0);
  nodes.stereoSplitter.connect(nodes.rightToSide, 1);
  nodes.leftToSide.gain.value = 0.5;
  nodes.rightToSide.gain.value = -0.5;
  nodes.leftToSide.connect(nodes.sideGain);
  nodes.rightToSide.connect(nodes.sideGain);

  nodes.midToLeft.gain.value = 1;
  nodes.midToRight.gain.value = 1;
  nodes.sideToLeft.gain.value = 1;
  nodes.sideToRight.gain.value = -1;
  nodes.midGain.connect(nodes.midToLeft);
  nodes.midGain.connect(nodes.midToRight);
  nodes.sideGain
    .connect(nodes.sideBassHighpass1)
    .connect(nodes.sideBassHighpass2)
    .connect(nodes.sideToLeft);
  nodes.sideBassHighpass2.connect(nodes.sideToRight);

  nodes.midToLeft.connect(nodes.stereoMerger, 0, 0);
  nodes.sideToLeft.connect(nodes.stereoMerger, 0, 0);
  nodes.midToRight.connect(nodes.stereoMerger, 0, 1);
  nodes.sideToRight.connect(nodes.stereoMerger, 0, 1);

  // Width and mono-bass can create new peaks, so both precede loudness drive
  // and the final true-peak limiter.
  nodes.stereoMerger
    .connect(nodes.normGain)
    .connect(nodes.limiter)
    .connect(nodes.gain);

  return nodes.gain;
}
