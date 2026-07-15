import { AUDIO_CONSTANTS, validateSettings } from './audioConstants.js';
import { measureLUFS, calculateNormalizationGain } from './lufs.js';
import { encodeWAV } from './wavEncoder.js';
import { createRestoredInputBuffer, repairPrematureEnding } from './audioRestoration.js';
import {
  MONO_BASS_FREQUENCY,
  GLUE_COMPRESSOR_LATENCY_SECONDS,
  configureMasteringNodes,
  connectMasteringGraph,
  createMasteringNodes,
  createRealtimeLimiterNode,
  setLimiterParameters,
  updateMatchedBypassGain
} from './masteringEngine.js';
import { finalizeMaster } from './truePeakLimiter.js';
import {
  STEM_COMPRESSION_PRESETS,
  applyStemCompressionPreset,
  configureStudioDynamicsNode,
  createMasterDynamicsConfig,
  createStemDynamicsConfig,
  createStudioDynamicsNode,
  ensureStudioDynamicsWorklet
} from './studioDynamics.js';

// ─── Settings Persistence ───────────────────────────────────────────────────
const STORAGE_KEY = 'ai-mastering-settings';
const masteringReports = new WeakMap();

function saveSettingsToStorage() {
  try {
    const settings = {
      normalizeLoudness: dom.normalizeLoudness.checked,
      truePeakLimit: dom.truePeakLimit.checked,
      truePeakCeiling: parseFloat(dom.truePeakSlider.value),
      targetLufs: dom.targetLufs ? parseInt(dom.targetLufs.value) : -14,
      inputGain: dom.inputGain ? parseFloat(dom.inputGain.value) : 0,
      stereoWidth: dom.stereoWidth ? parseInt(dom.stereoWidth.value) : 100,
      cleanLowEnd: dom.cleanLowEnd.checked,
      glueCompression: dom.glueCompression.checked,
      centerBass: dom.centerBass.checked,
      cutMud: dom.cutMud.checked,
      addAir: dom.addAir.checked,
      tameHarsh: dom.tameHarsh.checked,
      dynamicEq: dom.dynamicEq.checked,
      dynamicEqAmount: parseInt(dom.dynamicEqAmount.value),
      deEsser: dom.deEsser.checked,
      deEsserFrequency: parseInt(dom.deEsserFrequency.value),
      deEsserRange: parseFloat(dom.deEsserRange.value),
      deEsserAttack: parseFloat(dom.deEsserAttack.value),
      deEsserRelease: parseFloat(dom.deEsserRelease.value),
      deEsserAudition: dom.deEsserAudition.checked,
      repairEdgeArtifacts: dom.repairEdgeArtifacts.checked,
      repairPrematureEnding: dom.repairPrematureEnding.checked,
      repairVocalCrackle: dom.repairVocalCrackle.checked,
      sampleRate: parseInt(dom.sampleRate.value),
      bitDepth: parseInt(dom.bitDepth.value),
      eqLow: parseFloat(dom.eqLow.value),
      eqLowMid: parseFloat(dom.eqLowMid.value),
      eqMid: parseFloat(dom.eqMid.value),
      eqHighMid: parseFloat(dom.eqHighMid.value),
      eqHigh: parseFloat(dom.eqHigh.value),
      activePreset: document.querySelector('.preset-btn.active')?.dataset.preset || 'flat'
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (e) { /* ignore storage errors */ }
}

function loadSettingsFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);

    // Checkboxes
    if (s.normalizeLoudness !== undefined) dom.normalizeLoudness.checked = s.normalizeLoudness;
    if (s.truePeakLimit !== undefined) dom.truePeakLimit.checked = s.truePeakLimit;
    if (s.cleanLowEnd !== undefined) dom.cleanLowEnd.checked = s.cleanLowEnd;
    if (s.glueCompression !== undefined) dom.glueCompression.checked = s.glueCompression;
    if (s.centerBass !== undefined) dom.centerBass.checked = s.centerBass;
    if (s.cutMud !== undefined) dom.cutMud.checked = s.cutMud;
    if (s.addAir !== undefined) dom.addAir.checked = s.addAir;
    if (s.tameHarsh !== undefined) dom.tameHarsh.checked = s.tameHarsh;
    if (s.dynamicEq !== undefined) dom.dynamicEq.checked = s.dynamicEq;
    if (s.deEsser !== undefined) dom.deEsser.checked = s.deEsser;
    if (s.deEsserAudition !== undefined) dom.deEsserAudition.checked = s.deEsserAudition;
    if (s.repairEdgeArtifacts !== undefined) dom.repairEdgeArtifacts.checked = s.repairEdgeArtifacts;
    if (s.repairPrematureEnding !== undefined) dom.repairPrematureEnding.checked = s.repairPrematureEnding;
    if (s.repairVocalCrackle !== undefined) dom.repairVocalCrackle.checked = s.repairVocalCrackle;

    // Sliders / selects
    if (s.truePeakCeiling !== undefined) dom.truePeakSlider.value = s.truePeakCeiling;
    if (s.targetLufs !== undefined && dom.targetLufs) dom.targetLufs.value = s.targetLufs;
    if (s.inputGain !== undefined && dom.inputGain) dom.inputGain.value = s.inputGain;
    if (s.stereoWidth !== undefined && dom.stereoWidth) dom.stereoWidth.value = s.stereoWidth;
    if (s.dynamicEqAmount !== undefined) dom.dynamicEqAmount.value = s.dynamicEqAmount;
    if (s.deEsserFrequency !== undefined) dom.deEsserFrequency.value = s.deEsserFrequency;
    if (s.deEsserRange !== undefined) dom.deEsserRange.value = s.deEsserRange;
    if (s.deEsserAttack !== undefined) dom.deEsserAttack.value = s.deEsserAttack;
    if (s.deEsserRelease !== undefined) dom.deEsserRelease.value = s.deEsserRelease;
    if (s.sampleRate !== undefined) dom.sampleRate.value = s.sampleRate;
    if (s.bitDepth !== undefined) dom.bitDepth.value = s.bitDepth;

    // EQ
    if (s.eqLow !== undefined) dom.eqLow.value = s.eqLow;
    if (s.eqLowMid !== undefined) dom.eqLowMid.value = s.eqLowMid;
    if (s.eqMid !== undefined) dom.eqMid.value = s.eqMid;
    if (s.eqHighMid !== undefined) dom.eqHighMid.value = s.eqHighMid;
    if (s.eqHigh !== undefined) dom.eqHigh.value = s.eqHigh;

    // Preset highlight
    if (s.activePreset) {
      document.querySelectorAll('.preset-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.preset === s.activePreset);
      });
    }

    // Update display values
    if (dom.ceilingValue) dom.ceilingValue.textContent = `${parseFloat(dom.truePeakSlider.value).toFixed(1)} dB`;
    if (dom.targetLufsValue && dom.targetLufs) dom.targetLufsValue.textContent = `${dom.targetLufs.value} LUFS`;
    if (dom.inputGainValue && dom.inputGain) dom.inputGainValue.textContent = `${parseFloat(dom.inputGain.value).toFixed(1)} dB`;
    if (dom.stereoWidthValue && dom.stereoWidth) dom.stereoWidthValue.textContent = `${dom.stereoWidth.value}%`;
    updateAdaptiveDynamicsDisplays();
  } catch (e) { /* ignore parse errors */ }
}

// ─── Undo / Redo ────────────────────────────────────────────────────────────
const undoStack = [];
const redoStack = [];
const MAX_UNDO = 50;

function captureState() {
  return {
    normalizeLoudness: dom.normalizeLoudness.checked,
    truePeakLimit: dom.truePeakLimit.checked,
    truePeakCeiling: parseFloat(dom.truePeakSlider.value),
    targetLufs: dom.targetLufs ? parseInt(dom.targetLufs.value) : -14,
    inputGain: dom.inputGain ? parseFloat(dom.inputGain.value) : 0,
    stereoWidth: dom.stereoWidth ? parseInt(dom.stereoWidth.value) : 100,
    cleanLowEnd: dom.cleanLowEnd.checked,
    glueCompression: dom.glueCompression.checked,
    centerBass: dom.centerBass.checked,
    cutMud: dom.cutMud.checked,
    addAir: dom.addAir.checked,
    tameHarsh: dom.tameHarsh.checked,
    dynamicEq: dom.dynamicEq.checked,
    dynamicEqAmount: parseInt(dom.dynamicEqAmount.value),
    deEsser: dom.deEsser.checked,
    deEsserFrequency: parseInt(dom.deEsserFrequency.value),
    deEsserRange: parseFloat(dom.deEsserRange.value),
    deEsserAttack: parseFloat(dom.deEsserAttack.value),
    deEsserRelease: parseFloat(dom.deEsserRelease.value),
    deEsserAudition: dom.deEsserAudition.checked,
    repairEdgeArtifacts: dom.repairEdgeArtifacts.checked,
    repairPrematureEnding: dom.repairPrematureEnding.checked,
    repairVocalCrackle: dom.repairVocalCrackle.checked,
    eqLow: parseFloat(dom.eqLow.value),
    eqLowMid: parseFloat(dom.eqLowMid.value),
    eqMid: parseFloat(dom.eqMid.value),
    eqHighMid: parseFloat(dom.eqHighMid.value),
    eqHigh: parseFloat(dom.eqHigh.value)
  };
}

function pushUndo() {
  undoStack.push(captureState());
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack.length = 0; // clear redo on new action
}

function applyState(s) {
  dom.normalizeLoudness.checked = s.normalizeLoudness;
  dom.truePeakLimit.checked = s.truePeakLimit;
  dom.truePeakSlider.value = s.truePeakCeiling;
  if (dom.targetLufs) dom.targetLufs.value = s.targetLufs;
  if (dom.inputGain) dom.inputGain.value = s.inputGain;
  if (dom.stereoWidth) dom.stereoWidth.value = s.stereoWidth;
  dom.cleanLowEnd.checked = s.cleanLowEnd;
  dom.glueCompression.checked = s.glueCompression;
  dom.centerBass.checked = s.centerBass;
  dom.cutMud.checked = s.cutMud;
  dom.addAir.checked = s.addAir;
  dom.tameHarsh.checked = s.tameHarsh;
  dom.dynamicEq.checked = s.dynamicEq;
  dom.dynamicEqAmount.value = s.dynamicEqAmount;
  dom.deEsser.checked = s.deEsser;
  dom.deEsserFrequency.value = s.deEsserFrequency;
  dom.deEsserRange.value = s.deEsserRange;
  dom.deEsserAttack.value = s.deEsserAttack;
  dom.deEsserRelease.value = s.deEsserRelease;
  dom.deEsserAudition.checked = s.deEsserAudition;
  dom.repairEdgeArtifacts.checked = s.repairEdgeArtifacts;
  dom.repairPrematureEnding.checked = s.repairPrematureEnding;
  dom.repairVocalCrackle.checked = s.repairVocalCrackle;
  dom.eqLow.value = s.eqLow;
  dom.eqLowMid.value = s.eqLowMid;
  dom.eqMid.value = s.eqMid;
  dom.eqHighMid.value = s.eqHighMid;
  dom.eqHigh.value = s.eqHigh;

  // Refresh display values
  if (dom.ceilingValue) dom.ceilingValue.textContent = `${s.truePeakCeiling.toFixed(1)} dB`;
  if (dom.targetLufsValue) dom.targetLufsValue.textContent = `${s.targetLufs} LUFS`;
  if (dom.inputGainValue) dom.inputGainValue.textContent = `${s.inputGain.toFixed(1)} dB`;
  if (dom.stereoWidthValue) dom.stereoWidthValue.textContent = `${s.stereoWidth}%`;
  updateAdaptiveDynamicsDisplays();

  updateEQ();
  updateAudioChain();
  updateChecklist();
  updateRestorationPreview();
  refreshFaderFills();
  saveSettingsToStorage();
}

function undo() {
  if (undoStack.length === 0) return;
  redoStack.push(captureState());
  applyState(undoStack.pop());
}

function redo() {
  if (redoStack.length === 0) return;
  undoStack.push(captureState());
  applyState(redoStack.pop());
}

// ─── Global State ───────────────────────────────────────────────────────────
const state = {
  file: {
    path: null,
    buffer: null,
    stemSong: null,
    restorationPreviewBuffer: null,
    restorationReport: null,
    duration: 0,
    lufs: null,
    normGain: 1.0
  },
  audio: {
    context: null,
    sourceNode: null,
    stemSourceNodes: [],
    stemNodeControls: new Map(),
    stemMixBus: null,
    masterRestorationDelta: null,
    restorationPreviewRequest: 0,
    analyser: null,
    bypassSplitter: null,
    bypassAnalyserLeft: null,
    bypassAnalyserRight: null,
    bypassMatchGain: 1,
    analyserLeft: null,
    analyserRight: null,
    splitter: null,
    nodes: {}
  },
  playback: {
    isPlaying: false,
    startTime: 0,
    pauseTime: 0,
    isSeeking: false,
    seekInterval: null
  },
  meters: {
    interval: null,
    peakHoldLeft: 0,
    peakHoldRight: 0,
    peakHoldTimeLeft: 0,
    peakHoldTimeRight: 0,
    spectrogramAnim: null,
    preserveSpectrogram: false
  },
  ui: {
    isBypassed: false
  }
};

// ─── DOM Elements ───────────────────────────────────────────────────────────
const dom = {
  // Window controls
  minimizeBtn: document.getElementById('minimizeBtn'),
  maximizeBtn: document.getElementById('maximizeBtn'),
  closeBtn: document.getElementById('closeBtn'),

  // File zone
  selectFileBtn: document.getElementById('selectFile'),
  changeFileBtn: document.getElementById('changeFile'),
  fileZoneContent: document.getElementById('fileZoneContent'),
  fileLoaded: document.getElementById('fileLoaded'),
  fileName: document.getElementById('fileName'),
  fileMeta: document.getElementById('fileMeta'),
  dropZone: document.getElementById('dropZone'),

  // Player
  playBtn: document.getElementById('playBtn'),
  stopBtn: document.getElementById('stopBtn'),
  playIcon: document.getElementById('playIcon'),
  waveformContainer: document.getElementById('waveformContainer'),
  waveformCanvas: document.getElementById('waveformCanvas'),
  waveformProgress: document.getElementById('waveformProgress'),
  waveformPlayhead: document.getElementById('waveformPlayhead'),
  currentTimeEl: document.getElementById('currentTime'),
  durationEl: document.getElementById('duration'),
  bypassBtn: document.getElementById('bypassBtn'),

  // Level meters
  meterLeft: document.getElementById('meterLeft'),
  meterRight: document.getElementById('meterRight'),
  peakLeft: document.getElementById('peakLeft'),
  peakRight: document.getElementById('peakRight'),
  meterLeftValue: document.getElementById('meterLeftValue'),
  meterRightValue: document.getElementById('meterRightValue'),
  clipLeft: document.getElementById('clipLeft'),
  clipRight: document.getElementById('clipRight'),

  // Vertical loudness meters
  inputGain: document.getElementById('inputGain'),
  inputGainValue: document.getElementById('inputGainValue'),
  inputFill: document.getElementById('inputFill'),
  ceilingFill: document.getElementById('ceilingFill'),

  // Settings
  normalizeLoudness: document.getElementById('normalizeLoudness'),
  truePeakLimit: document.getElementById('truePeakLimit'),
  truePeakSlider: document.getElementById('truePeakCeiling'),
  ceilingValue: document.getElementById('ceilingValue'),
  targetLufs: document.getElementById('targetLufs'),
  targetLufsValue: document.getElementById('targetLufsValue'),
  cleanLowEnd: document.getElementById('cleanLowEnd'),
  glueCompression: document.getElementById('glueCompression'),
  centerBass: document.getElementById('centerBass'),
  stereoWidth: document.getElementById('stereoWidth'),
  stereoWidthValue: document.getElementById('stereoWidthValue'),
  cutMud: document.getElementById('cutMud'),
  addAir: document.getElementById('addAir'),
  tameHarsh: document.getElementById('tameHarsh'),
  dynamicEq: document.getElementById('dynamicEq'),
  dynamicEqAmount: document.getElementById('dynamicEqAmount'),
  dynamicEqAmountValue: document.getElementById('dynamicEqAmountValue'),
  deEsser: document.getElementById('deEsser'),
  deEsserFrequency: document.getElementById('deEsserFrequency'),
  deEsserFrequencyValue: document.getElementById('deEsserFrequencyValue'),
  deEsserRange: document.getElementById('deEsserRange'),
  deEsserRangeValue: document.getElementById('deEsserRangeValue'),
  deEsserAttack: document.getElementById('deEsserAttack'),
  deEsserAttackValue: document.getElementById('deEsserAttackValue'),
  deEsserRelease: document.getElementById('deEsserRelease'),
  deEsserReleaseValue: document.getElementById('deEsserReleaseValue'),
  deEsserAudition: document.getElementById('deEsserAudition'),
  repairEdgeArtifacts: document.getElementById('repairEdgeArtifacts'),
  repairPrematureEnding: document.getElementById('repairPrematureEnding'),
  repairVocalCrackle: document.getElementById('repairVocalCrackle'),
  restorationStatus: document.getElementById('restorationStatus'),
  sampleRate: document.getElementById('sampleRate'),
  bitDepth: document.getElementById('bitDepth'),

  // EQ
  eqLow: document.getElementById('eqLow'),
  eqLowMid: document.getElementById('eqLowMid'),
  eqMid: document.getElementById('eqMid'),
  eqHighMid: document.getElementById('eqHighMid'),
  eqHigh: document.getElementById('eqHigh'),

  // Process
  processBtn: document.getElementById('processBtn'),
  progressContainer: document.getElementById('progressContainer'),
  progressFill: document.getElementById('progressFill'),
  progressText: document.getElementById('progressText'),
  statusMessage: document.getElementById('statusMessage'),

  // Status indicators
  miniLufs: document.getElementById('mini-lufs'),
  miniPeak: document.getElementById('mini-peak'),
  miniFormat: document.getElementById('mini-format'),

  // Tooltip
  tooltip: document.getElementById('tooltip'),
  showTipsCheckbox: document.getElementById('showTips'),
  debugBtn: document.getElementById('debugBtn'),

  // Theme
  themeToggle: document.getElementById('themeToggle'),
  themeIcon: document.getElementById('themeIcon'),

  // Spectrogram
  spectrogramCanvas: document.getElementById('spectrogramCanvas')
};

// ─── Window Controls ────────────────────────────────────────────────────────
dom.minimizeBtn.addEventListener('click', () => window.electronAPI.minimizeWindow());
dom.maximizeBtn.addEventListener('click', () => window.electronAPI.maximizeWindow());
dom.closeBtn.addEventListener('click', () => window.electronAPI.closeWindow());

// ─── Theme Toggle ───────────────────────────────────────────────────────────
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  dom.themeIcon.textContent = theme === 'light' ? '🌙' : '☀️';
  localStorage.setItem('ai-mastering-theme', theme);
}

dom.themeToggle.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  applyTheme(current === 'light' ? 'dark' : 'light');
  restartSpectrogramIfPlaying();
});

// Load saved theme
const savedTheme = localStorage.getItem('ai-mastering-theme') || 'dark';
applyTheme(savedTheme);

// Restart spectrogram on theme change so it picks up new bg color
function restartSpectrogramIfPlaying() {
  if (state.playback.isPlaying && state.audio.analyser && dom.spectrogramCanvas) {
    if (state.meters.spectrogramAnim) {
      cancelAnimationFrame(state.meters.spectrogramAnim);
      state.meters.spectrogramAnim = null;
    }
    startSpectrogram();
  }
}

// ─── Audio Context ──────────────────────────────────────────────────────────
function initAudioContext() {
  if (!state.audio.context) {
    state.audio.context = new AudioContext();
  }
  return state.audio.context;
}

function readMasterDynamicsSettings() {
  return {
    dynamicEq: dom.dynamicEq.checked,
    dynamicEqAmount: parseInt(dom.dynamicEqAmount.value),
    deEsser: dom.deEsser.checked,
    deEsserFrequency: parseInt(dom.deEsserFrequency.value),
    deEsserRange: parseFloat(dom.deEsserRange.value),
    deEsserAttack: parseFloat(dom.deEsserAttack.value),
    deEsserRelease: parseFloat(dom.deEsserRelease.value),
    deEsserAudition: dom.deEsserAudition.checked
  };
}

function updateAdaptiveDynamicsDisplays() {
  if (!dom.dynamicEqAmount) return;
  dom.dynamicEqAmountValue.textContent = `${dom.dynamicEqAmount.value}%`;
  dom.deEsserFrequencyValue.textContent = `${(parseInt(dom.deEsserFrequency.value) / 1000).toFixed(1)} kHz`;
  dom.deEsserRangeValue.textContent = `${parseFloat(dom.deEsserRange.value).toFixed(1)} dB`;
  dom.deEsserAttackValue.textContent = `${parseFloat(dom.deEsserAttack.value).toFixed(0)} ms`;
  dom.deEsserReleaseValue.textContent = `${parseFloat(dom.deEsserRelease.value).toFixed(0)} ms`;
}

// ─── Preview Audio Chain ────────────────────────────────────────────────────
async function createAudioChain() {
  const ctx = initAudioContext();

  // Analysers — use smaller FFT for level meters (faster)
  state.audio.analyser = ctx.createAnalyser();
  state.audio.analyser.fftSize = 2048; // keep 2048 for spectrogram
  state.audio.analyser.smoothingTimeConstant = 0.3;

  state.audio.bypassSplitter = ctx.createChannelSplitter(2);
  state.audio.bypassAnalyserLeft = ctx.createAnalyser();
  state.audio.bypassAnalyserRight = ctx.createAnalyser();
  for (const analyser of [state.audio.bypassAnalyserLeft, state.audio.bypassAnalyserRight]) {
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0;
  }
  state.audio.bypassSplitter.connect(state.audio.bypassAnalyserLeft, 0);
  state.audio.bypassSplitter.connect(state.audio.bypassAnalyserRight, 1);

  state.audio.splitter = ctx.createChannelSplitter(2);
  state.audio.analyserLeft = ctx.createAnalyser();
  state.audio.analyserLeft.fftSize = 512;
  state.audio.analyserLeft.smoothingTimeConstant = 0;

  state.audio.analyserRight = ctx.createAnalyser();
  state.audio.analyserRight.fftSize = 512;
  state.audio.analyserRight.smoothingTimeConstant = 0;

  await ensureStudioDynamicsWorklet(ctx);
  const studioDynamics = createStudioDynamicsNode(
    ctx,
    createMasterDynamicsConfig(readMasterDynamicsSettings())
  );
  const limiter = await createRealtimeLimiterNode(ctx);
  state.audio.nodes = createMasteringNodes(ctx, limiter, {
    glueCompression: dom.glueCompression.checked,
    studioDynamics
  });
  const nodes = state.audio.nodes;

  updateAudioChain();
  updateEQ();
}

function updateAudioChain() {
  if (!state.audio.context) return;

  const nodes = state.audio.nodes;
  const bypassed = state.ui.isBypassed;

  configureStudioDynamicsNode(
    nodes.studioDynamics,
    createMasterDynamicsConfig(readMasterDynamicsSettings(), bypassed)
  );

  const inputLinear = Math.pow(10, parseFloat(dom.inputGain.value) / 20);
  const normalizationLinear = dom.normalizeLoudness.checked && state.file.normGain !== 1.0
    ? state.file.normGain
    : 1;
  if (!bypassed) state.audio.bypassMatchGain = inputLinear * normalizationLinear;
  if (nodes.inputGain) {
    nodes.inputGain.gain.value = bypassed ? state.audio.bypassMatchGain : inputLinear;
  }

  nodes.highpass.frequency.value = (dom.cleanLowEnd.checked && !bypassed)
    ? AUDIO_CONSTANTS.HIGHPASS_FREQ : 1;

  nodes.lowshelf.gain.value = (dom.cutMud.checked && !bypassed) ? -3 : 0;
  nodes.highshelf.gain.value = (dom.addAir.checked && !bypassed) ? 2.5 : 0;

  if (dom.tameHarsh.checked && !bypassed) {
    nodes.midPeak.gain.value = AUDIO_CONSTANTS.HARSHNESS_GAIN_4K;
    nodes.midPeak2.gain.value = AUDIO_CONSTANTS.HARSHNESS_GAIN_6K;
  } else {
    nodes.midPeak.gain.value = 0;
    nodes.midPeak2.gain.value = 0;
  }

  if (nodes.compressor.threshold && dom.glueCompression.checked && !bypassed) {
    nodes.compressor.threshold.value = AUDIO_CONSTANTS.GLUE_THRESHOLD;
    nodes.compressor.ratio.value = AUDIO_CONSTANTS.GLUE_RATIO;
  } else if (nodes.compressor.threshold) {
    nodes.compressor.threshold.value = 0;
    nodes.compressor.ratio.value = 1;
  }

  setLimiterParameters(
    nodes.limiter,
    dom.truePeakLimit.checked && !bypassed,
    parseFloat(dom.truePeakSlider.value)
  );

  if (nodes.midGain && nodes.sideGain && dom.stereoWidth) {
    const width = bypassed ? 100 : parseInt(dom.stereoWidth.value);
    const sideLevel = width / 100;
    nodes.sideGain.gain.value = sideLevel;
  }

  if (nodes.sideBassHighpass1 && nodes.sideBassHighpass2) {
    const frequency = dom.centerBass.checked && !bypassed ? MONO_BASS_FREQUENCY : 1;
    nodes.sideBassHighpass1.frequency.value = frequency;
    nodes.sideBassHighpass2.frequency.value = frequency;
  }

  if (nodes.normGain) {
    nodes.normGain.gain.value = bypassed ? 1 : normalizationLinear;
  }
}

function connectAudioChain(source) {
  const nodes = state.audio.nodes;
  source.connect(state.audio.bypassSplitter);
  if (nodes.graphConnected) {
    source.connect(nodes.inputGain);
    return;
  }
  connectMasteringGraph(source, nodes);
  nodes.gain.connect(state.audio.analyser);
  nodes.gain.connect(state.audio.splitter);
  state.audio.splitter.connect(state.audio.analyserLeft, 0);
  state.audio.splitter.connect(state.audio.analyserRight, 1);
  nodes.gain.connect(state.audio.context.destination);
  nodes.graphConnected = true;
}

// ─── EQ ─────────────────────────────────────────────────────────────────────
function updateEQ() {
  const nodes = state.audio.nodes;
  if (!nodes.eqLow) return;

  if (state.ui.isBypassed) {
    nodes.eqLow.gain.value = 0;
    nodes.eqLowMid.gain.value = 0;
    nodes.eqMid.gain.value = 0;
    nodes.eqHighMid.gain.value = 0;
    nodes.eqHigh.gain.value = 0;
  } else {
    nodes.eqLow.gain.value = parseFloat(dom.eqLow.value);
    nodes.eqLowMid.gain.value = parseFloat(dom.eqLowMid.value);
    nodes.eqMid.gain.value = parseFloat(dom.eqMid.value);
    nodes.eqHighMid.gain.value = parseFloat(dom.eqHighMid.value);
    nodes.eqHigh.gain.value = parseFloat(dom.eqHigh.value);
  }

  document.getElementById('eqLowVal').textContent = `${dom.eqLow.value} dB`;
  document.getElementById('eqLowMidVal').textContent = `${dom.eqLowMid.value} dB`;
  document.getElementById('eqMidVal').textContent = `${dom.eqMid.value} dB`;
  document.getElementById('eqHighMidVal').textContent = `${dom.eqHighMid.value} dB`;
  document.getElementById('eqHighVal').textContent = `${dom.eqHigh.value} dB`;

  updateEQFill('eqLow', 'eqLowFill');
  updateEQFill('eqLowMid', 'eqLowMidFill');
  updateEQFill('eqMid', 'eqMidFill');
  updateEQFill('eqHighMid', 'eqHighMidFill');
  updateEQFill('eqHigh', 'eqHighFill');
}

function updateEQFill(sliderId, fillId) {
  const slider = document.getElementById(sliderId);
  const fill = document.getElementById(fillId);
  if (!slider || !fill) return;

  const value = parseFloat(slider.value);
  const min = parseFloat(slider.min);
  const max = parseFloat(slider.max);
  const range = max - min;
  const center = 50;

  const percent = ((value - min) / range) * 100;

  if (value >= 0) {
    fill.style.bottom = `${center}%`;
    fill.style.top = 'auto';
    fill.style.height = `${percent - center}%`;
  } else {
    fill.style.top = `${100 - center}%`;
    fill.style.bottom = 'auto';
    fill.style.height = `${center - percent}%`;
  }
}

const eqPresets = {
  flat: { low: 0, lowMid: 0, mid: 0, highMid: 0, high: 0 },
  vocal: { low: -2, lowMid: -1, mid: 2, highMid: 3, high: 1 },
  bass: { low: 6, lowMid: 3, mid: 0, highMid: -1, high: -2 },
  bright: { low: -1, lowMid: 0, mid: 1, highMid: 3, high: 5 },
  warm: { low: 3, lowMid: 2, mid: 0, highMid: -2, high: -3 },
  suno: { low: 1, lowMid: -2, mid: 1, highMid: -1, high: 2 }
};

document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const preset = eqPresets[btn.dataset.preset];
    if (preset) {
      pushUndo();
      dom.eqLow.value = preset.low;
      dom.eqLowMid.value = preset.lowMid;
      dom.eqMid.value = preset.mid;
      dom.eqHighMid.value = preset.highMid;
      dom.eqHigh.value = preset.high;
      updateEQ();

      document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      saveSettingsToStorage();
    }
  });
});

[dom.eqLow, dom.eqLowMid, dom.eqMid, dom.eqHighMid, dom.eqHigh].forEach(slider => {
  slider.addEventListener('input', () => {
    updateEQ();
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    saveSettingsToStorage();
  });
  // Push undo on mousedown (start of drag)
  slider.addEventListener('mousedown', () => pushUndo());
});

// ─── File Loading ───────────────────────────────────────────────────────────
const AUDIO_FILE_PATTERN = /\.(mp3|wav|flac|aac|m4a|mp4)$/i;
const SUNO_STEMS_ARCHIVE_PATTERN = /\.zip$/i;

function showFileStatus(message, type = 'success') {
  dom.statusMessage.textContent = message;
  dom.statusMessage.className = `status-message ${type} visible`;
  setTimeout(() => dom.statusMessage.classList.remove('visible'), 6000);
}

function createDefaultStemSettings() {
  return {
    gainDb: 0,
    pan: 0,
    width: 100,
    mute: false,
    solo: false,
    cleanLowEnd: false,
    glueCompression: false,
    compressionPreset: 'vocal',
    compressorThreshold: STEM_COMPRESSION_PRESETS.vocal.thresholdDb,
    compressorRatio: STEM_COMPRESSION_PRESETS.vocal.ratio,
    compressorAttack: STEM_COMPRESSION_PRESETS.vocal.attackMs,
    compressorRelease: STEM_COMPRESSION_PRESETS.vocal.releaseMs,
    compressorKnee: STEM_COMPRESSION_PRESETS.vocal.kneeDb,
    compressorMaxReduction: STEM_COMPRESSION_PRESETS.vocal.maxReductionDb,
    compressorMix: STEM_COMPRESSION_PRESETS.vocal.mix,
    compressorMakeup: STEM_COMPRESSION_PRESETS.vocal.makeupDb,
    dynamicEq: false,
    dynamicEqAmount: 50,
    deEsser: false,
    deEsserFrequency: 7000,
    deEsserRange: 4,
    deEsserAttack: 5,
    deEsserRelease: 80,
    deEsserAudition: false,
    cutMud: false,
    addAir: false,
    tameHarsh: false,
    repairEdgeArtifacts: false,
    repairPrematureEnding: false,
    repairVocalCrackle: false,
    eqLow: 0,
    eqLowMid: 0,
    eqMid: 0,
    eqHighMid: 0,
    eqHigh: 0
  };
}

function getStemSongName(archivePath) {
  return archivePath.split(/[\\/]/).pop()
    .replace(/\.zip$/i, '')
    .replace(/\s+stems?$/i, '') || 'Suno Stem Song';
}

function createStemSong(archivePath, extractedStems) {
  return {
    type: 'stem-song',
    path: `stem-song:${archivePath}`,
    archivePath,
    name: getStemSongName(archivePath),
    status: 'pending',
    expanded: false,
    selectedStemIndex: -1,
    metadata: null,
    stems: extractedStems.map(stem => ({
      ...stem,
      buffer: null,
      settings: createDefaultStemSettings()
    }))
  };
}

async function decodeAudioPath(filePath, context = initAudioContext()) {
  const arrayData = await window.electronAPI.readAudioFile(filePath);
  const bytes = new Uint8Array(arrayData);
  const audioData = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return context.decodeAudioData(audioData);
}

async function ensureStemBuffers(song) {
  const context = initAudioContext();
  for (let index = 0; index < song.stems.length; index++) {
    const stem = song.stems[index];
    if (stem.buffer) continue;
    if (state.file.stemSong === song) {
      dom.fileMeta.textContent = `Loading stem ${index + 1}/${song.stems.length}: ${stem.name}`;
    }
    stem.buffer = await decodeAudioPath(stem.path, context);
    await yieldToUI();
  }
}

function connectStemProcessingChain(context, source, stem, audible, destination, allowAudition = true) {
  const settings = stem.settings;
  const gain = context.createGain();
  gain.gain.value = audible ? Math.pow(10, settings.gainDb / 20) : 0;

  const highpass = context.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = settings.cleanLowEnd ? AUDIO_CONSTANTS.HIGHPASS_FREQ : 1;
  highpass.Q.value = 0.7;

  const eqSettings = [
    ['lowshelf', AUDIO_CONSTANTS.FREQ_LOW, settings.eqLow, 1],
    ['peaking', AUDIO_CONSTANTS.FREQ_LOW_MID, settings.eqLowMid, 1],
    ['peaking', AUDIO_CONSTANTS.FREQ_MID, settings.eqMid, 1],
    ['peaking', AUDIO_CONSTANTS.FREQ_HIGH_MID, settings.eqHighMid, 1],
    ['highshelf', AUDIO_CONSTANTS.FREQ_HIGH, settings.eqHigh, 1]
  ];
  const eqNodes = eqSettings.map(([type, frequency, value, q]) => {
    const node = context.createBiquadFilter();
    node.type = type;
    node.frequency.value = frequency;
    node.gain.value = value;
    node.Q.value = q;
    return node;
  });

  const mud = context.createBiquadFilter();
  mud.type = 'peaking';
  mud.frequency.value = AUDIO_CONSTANTS.MUD_CUT_FREQ;
  mud.Q.value = 1.5;
  mud.gain.value = settings.cutMud ? -3 : 0;

  const harsh = context.createBiquadFilter();
  harsh.type = 'peaking';
  harsh.frequency.value = AUDIO_CONSTANTS.HARSHNESS_FREQ_1;
  harsh.Q.value = AUDIO_CONSTANTS.HARSHNESS_Q_4K;
  harsh.gain.value = settings.tameHarsh ? AUDIO_CONSTANTS.HARSHNESS_GAIN_4K : 0;

  const harshHigh = context.createBiquadFilter();
  harshHigh.type = 'peaking';
  harshHigh.frequency.value = AUDIO_CONSTANTS.HARSHNESS_FREQ_2;
  harshHigh.Q.value = AUDIO_CONSTANTS.HARSHNESS_Q_6K;
  harshHigh.gain.value = settings.tameHarsh ? AUDIO_CONSTANTS.HARSHNESS_GAIN_6K : 0;

  const air = context.createBiquadFilter();
  air.type = 'highshelf';
  air.frequency.value = AUDIO_CONSTANTS.AIR_FREQ;
  air.gain.value = settings.addAir ? 2.5 : 0;

  const studioDynamics = createStudioDynamicsNode(
    context,
    createStemDynamicsConfig(settings, allowAudition),
    meter => {
      stem.compressionReductionDb = meter.compressorReductionDb;
      stem.dynamicReductionDb = meter.dynamicReductionDb;
      stem.deEsserReductionDb = meter.deEsserReductionDb;
      updateSelectedStemMeters(stem);
    }
  );

  let current = source.connect(gain).connect(highpass);
  for (const eq of eqNodes) current = current.connect(eq);
  current = current.connect(mud).connect(harsh).connect(harshHigh).connect(air).connect(studioDynamics);

  const splitter = context.createChannelSplitter(2);
  const merger = context.createChannelMerger(2);
  const mid = context.createGain();
  const side = context.createGain();
  const leftMid = context.createGain();
  const rightMid = context.createGain();
  const leftSide = context.createGain();
  const rightSide = context.createGain();
  leftMid.gain.value = rightMid.gain.value = leftSide.gain.value = 0.5;
  rightSide.gain.value = -0.5;
  mid.gain.value = 1;
  side.gain.value = settings.width / 100;

  current.connect(splitter);
  splitter.connect(leftMid, 0).connect(mid);
  splitter.connect(rightMid, 1).connect(mid);
  splitter.connect(leftSide, 0).connect(side);
  splitter.connect(rightSide, 1).connect(side);

  const midLeft = context.createGain();
  const midRight = context.createGain();
  const sideLeft = context.createGain();
  const sideRight = context.createGain();
  sideRight.gain.value = -1;
  mid.connect(midLeft).connect(merger, 0, 0);
  mid.connect(midRight).connect(merger, 0, 1);
  side.connect(sideLeft).connect(merger, 0, 0);
  side.connect(sideRight).connect(merger, 0, 1);

  const panner = context.createStereoPanner();
  panner.pan.value = settings.pan / 100;
  merger.connect(panner).connect(destination);

  return { gain, highpass, eqNodes, mud, harsh, harshHigh, air, studioDynamics, side, panner };
}

function stemIsAudible(song, stem) {
  const hasSolo = song.stems.some(candidate => candidate.settings.solo);
  return !stem.settings.mute && (!hasSolo || stem.settings.solo);
}

function updateLiveStemSettings(song) {
  if (state.file.stemSong !== song || state.audio.stemNodeControls.size === 0) return;
  const now = state.audio.context.currentTime;
  for (const stem of song.stems) {
    const nodes = state.audio.stemNodeControls.get(stem);
    if (!nodes) continue;
    const settings = stem.settings;
    nodes.gain.gain.setTargetAtTime(
      stemIsAudible(song, stem) ? Math.pow(10, settings.gainDb / 20) : 0,
      now,
      0.012
    );
    nodes.panner.pan.setTargetAtTime(settings.pan / 100, now, 0.012);
    nodes.side.gain.setTargetAtTime(settings.width / 100, now, 0.012);
    nodes.highpass.frequency.setTargetAtTime(settings.cleanLowEnd ? AUDIO_CONSTANTS.HIGHPASS_FREQ : 1, now, 0.012);
    nodes.eqNodes.forEach((node, index) => {
      node.gain.setTargetAtTime([settings.eqLow, settings.eqLowMid, settings.eqMid, settings.eqHighMid, settings.eqHigh][index], now, 0.012);
    });
    nodes.mud.gain.setTargetAtTime(settings.cutMud ? -3 : 0, now, 0.012);
    nodes.harsh.gain.setTargetAtTime(settings.tameHarsh ? AUDIO_CONSTANTS.HARSHNESS_GAIN_4K : 0, now, 0.012);
    nodes.harshHigh.gain.setTargetAtTime(settings.tameHarsh ? AUDIO_CONSTANTS.HARSHNESS_GAIN_6K : 0, now, 0.012);
    nodes.air.gain.setTargetAtTime(settings.addAir ? 2.5 : 0, now, 0.012);
    configureStudioDynamicsNode(nodes.studioDynamics, createStemDynamicsConfig(settings));
  }
}

async function renderStemSongMix(song, sampleRate = null, allowAudition = true) {
  await ensureStemBuffers(song);
  const rate = sampleRate || Math.max(...song.stems.map(stem => stem.buffer.sampleRate));
  const duration = Math.max(...song.stems.map(stem => stem.buffer.duration));
  const context = new OfflineAudioContext(2, Math.ceil(duration * rate), rate);
  await ensureStudioDynamicsWorklet(context);
  for (const stem of song.stems) {
    const source = context.createBufferSource();
    const needsRestoration = stem.settings.repairEdgeArtifacts ||
      stem.settings.repairPrematureEnding || stem.settings.repairVocalCrackle;
    if (needsRestoration) {
      const restored = createRestoredInputBuffer(context, stem.buffer, stem.settings);
      if (stem.settings.repairPrematureEnding) {
        repairPrematureEnding(
          Array.from({ length: restored.buffer.numberOfChannels }, (_, channel) => restored.buffer.getChannelData(channel)),
          restored.buffer.sampleRate
        );
      }
      source.buffer = restored.buffer;
    } else {
      source.buffer = stem.buffer;
    }
    const audible = stemIsAudible(song, stem);
    connectStemProcessingChain(context, source, stem, audible, context.destination, allowAudition);
    source.start(0);
  }
  return context.startRendering();
}

async function activateAudioBuffer(buffer, metaPrefix = '') {
  state.file.buffer = buffer;
  state.file.restorationPreviewBuffer = null;
  state.file.restorationReport = null;
  dom.fileMeta.textContent = 'Analyzing loudness...';

  const lufsResult = measureLUFS(buffer, { truePeak: false });
  state.file.lufs = lufsResult.integratedLUFS;
  const targetLufs = dom.targetLufs ? parseInt(dom.targetLufs.value) : AUDIO_CONSTANTS.TARGET_LUFS;
  state.file.normGain = calculateNormalizationGain(state.file.lufs, targetLufs);

  await createAudioChain();
  updateRestorationPreview();
  state.file.duration = buffer.duration;
  dom.durationEl.textContent = formatTime(buffer.duration);
  setPlaybackPosition(0);

  const lufsDisplay = isFinite(state.file.lufs) ? `${state.file.lufs.toFixed(1)} LUFS` : 'N/A';
  const prefix = metaPrefix ? `${metaPrefix} • ` : '';
  dom.fileMeta.textContent = `${prefix}${Math.round(buffer.sampleRate / 1000)}kHz • ${buffer.numberOfChannels}ch • ${formatTime(buffer.duration)} • ${lufsDisplay}`;
  dom.playBtn.disabled = false;
  dom.stopBtn.disabled = false;
  dom.processBtn.disabled = false;
}

async function loadStemSong(song) {
  stopAudio();
  state.playback.pauseTime = 0;
  state.file.path = song.path;
  state.file.stemSong = song;
  dom.fileName.textContent = song.name;
  dom.fileMeta.textContent = `Loading ${song.stems.length} stems...`;
  dom.fileZoneContent.classList.add('hidden');
  dom.fileLoaded.classList.remove('hidden');

  const mix = await renderStemSongMix(song);
  await activateAudioBuffer(mix, `${song.stems.length} stems`);
  updateChecklist();
  renderBatchList();
  drawWaveform();
}

function scheduleStemSongMix(song) {
  // Gain and pan must remain click-free while the user auditions the song.
  // Rebuilding a five-minute multitrack render and measuring LUFS on every
  // slider move competes with real-time playback, so defer that work until
  // export (which always renders the current stem settings from source).
  song.mixDirty = true;
}

async function importSunoStemsArchive(archivePath, loadSong = false) {
  try {
    let song = batchState.queue.find(item => item.type === 'stem-song' && item.archivePath === archivePath);
    if (!song) {
      const stems = await window.electronAPI.importSunoStems(archivePath);
      if (stems.length === 0) throw new Error('No supported audio stems were found in this ZIP.');
      song = createStemSong(archivePath, stems);
      song.expanded = loadSong;
      batchState.queue.push(song);
      updateBatchButtons();
    }
    renderBatchList();
    renderMetaFileList();
    if (loadSong) await loadStemSong(song);

    showFileStatus(`✓ Imported ${song.stems.length} stems as ${song.name}.`, 'success');
    return song;
  } catch (error) {
    console.error('Error importing Suno stems:', error);
    showFileStatus(`✗ Could not import Suno stems: ${error.message}`, 'error');
    return [];
  }
}

async function loadAudioFile(filePath) {
  const ctx = initAudioContext();

  try {
    const buffer = await decodeAudioPath(filePath, ctx);
    state.file.stemSong = null;
    await activateAudioBuffer(buffer);

    return true;
  } catch (error) {
    console.error('Error loading audio:', error);
    dom.statusMessage.textContent = `✗ Error loading audio: ${error.message}`;
    dom.statusMessage.className = 'status-message error visible';
    setTimeout(() => dom.statusMessage.classList.remove('visible'), 6000);
    return false;
  }
}

// ─── Restoration Preview ───────────────────────────────────────────────────
function getRestorationPreviewSettings() {
  return {
    repairEdgeArtifacts: dom.repairEdgeArtifacts.checked,
    repairPrematureEnding: dom.repairPrematureEnding.checked,
    repairVocalCrackle: dom.repairVocalCrackle.checked
  };
}

function getPreviewBuffer() {
  return state.file.restorationPreviewBuffer || state.file.buffer;
}

function updateRestorationStatus(settings, report) {
  if (!dom.restorationStatus) return;
  const messages = [];
  if (settings.repairEdgeArtifacts) {
    messages.push(report.edgeSamples
      ? `edge: ${Math.round(report.edgeSamples / state.file.buffer.sampleRate * 1000)} ms repaired`
      : 'edge: no artifact detected');
  }
  if (settings.repairPrematureEnding) {
    messages.push(report.endingRepaired ? 'ending: fade repaired' : 'ending: no cutoff detected');
  }
  if (settings.repairVocalCrackle) {
    messages.push(report.crackleSamples
      ? `crackle: ${report.crackleSamples} samples repaired`
      : 'crackle: no impulse noise detected');
  }

  dom.restorationStatus.textContent = messages.length ? `Preview: ${messages.join(' · ')}` : 'Preview: restoration off';
  dom.restorationStatus.classList.toggle(
    'detected',
    Boolean(report.edgeSamples || report.crackleSamples || report.endingRepaired)
  );
}

/** Rebuilds an audition-only copy immediately when restoration changes. */
function updateRestorationPreview() {
  if (!state.file.buffer || !state.audio.context) {
    if (dom.restorationStatus) dom.restorationStatus.textContent = 'Preview: load a file to analyze';
    return;
  }

  const settings = getRestorationPreviewSettings();
  if (!settings.repairEdgeArtifacts && !settings.repairPrematureEnding && !settings.repairVocalCrackle) {
    state.file.restorationPreviewBuffer = null;
    state.file.restorationReport = { edgeSamples: 0, crackleSamples: 0, endingRepaired: false };
    updateRestorationStatus(settings, state.file.restorationReport);
    drawWaveform();
    return;
  }

  const restored = createRestoredInputBuffer(state.audio.context, state.file.buffer, settings);
  const report = { ...restored.report, endingRepaired: false };
  if (settings.repairPrematureEnding) {
    report.endingRepaired = repairPrematureEnding(
      Array.from({ length: restored.buffer.numberOfChannels }, (_, channel) => restored.buffer.getChannelData(channel)),
      restored.buffer.sampleRate
    );
  }
  state.file.restorationPreviewBuffer = restored.buffer;
  state.file.restorationReport = report;
  updateRestorationStatus(settings, report);
  drawWaveform();
}

function removeLiveMasterRestoration(fade = true) {
  const active = state.audio.masterRestorationDelta;
  if (!active) return;

  state.audio.masterRestorationDelta = null;
  const now = state.audio.context?.currentTime || 0;
  try {
    active.gain.gain.cancelScheduledValues(now);
    active.gain.gain.setValueAtTime(active.gain.gain.value, now);
    active.gain.gain.linearRampToValueAtTime(0, now + (fade ? 0.025 : 0));
    setTimeout(() => {
      try {
        active.source.stop();
        active.source.disconnect();
        active.gain.disconnect();
      } catch (e) { /* already stopped */ }
    }, fade ? 40 : 0);
  } catch (e) { /* audio context was already closed */ }
}

function createMasterRestorationDelta(buffer, settings) {
  const context = state.audio.context;
  const restored = createRestoredInputBuffer(context, buffer, settings);
  const report = { ...restored.report, endingRepaired: false };
  if (settings.repairPrematureEnding) {
    report.endingRepaired = repairPrematureEnding(
      Array.from({ length: restored.buffer.numberOfChannels }, (_, channel) => restored.buffer.getChannelData(channel)),
      restored.buffer.sampleRate
    );
  }

  const delta = context.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const original = buffer.getChannelData(channel);
    const repaired = restored.buffer.getChannelData(channel);
    const difference = delta.getChannelData(channel);
    for (let index = 0; index < difference.length; index++) {
      difference[index] = repaired[index] - original[index];
    }
  }
  return { delta, report };
}

async function updateLiveMasterRestorationPreview() {
  const song = state.file.stemSong;
  if (!song || !state.playback.isPlaying || !state.audio.stemMixBus) return;

  const settings = getRestorationPreviewSettings();
  const request = ++state.audio.restorationPreviewRequest;
  if (!settings.repairEdgeArtifacts && !settings.repairPrematureEnding && !settings.repairVocalCrackle) {
    removeLiveMasterRestoration();
    updateRestorationStatus(settings, { edgeSamples: 0, crackleSamples: 0, endingRepaired: false });
    return;
  }

  removeLiveMasterRestoration(false);
  if (dom.restorationStatus) dom.restorationStatus.textContent = 'Preview: preparing live restoration…';
  await yieldToUI();

  // This is a correction layer: repaired mix minus original mix. It is added
  // before the song master bus, so live stem gain/pan changes remain intact.
  const { delta, report } = createMasterRestorationDelta(state.file.buffer, settings);
  if (request !== state.audio.restorationPreviewRequest ||
      state.file.stemSong !== song ||
      !state.playback.isPlaying ||
      !state.audio.stemMixBus) return;

  const context = state.audio.context;
  const offset = Math.max(0, context.currentTime - state.playback.startTime);
  if (offset >= delta.duration) return;
  const source = context.createBufferSource();
  const gain = context.createGain();
  source.buffer = delta;
  gain.gain.value = 0;
  source.connect(gain).connect(state.audio.stemMixBus);
  source.start(0, offset);
  gain.gain.linearRampToValueAtTime(1, context.currentTime + 0.025);
  const active = { source, gain };
  state.audio.masterRestorationDelta = active;
  source.onended = () => {
    if (state.audio.masterRestorationDelta === active) state.audio.masterRestorationDelta = null;
  };
  updateRestorationStatus(settings, report);
}

// ─── Waveform ───────────────────────────────────────────────────────────────
function drawWaveform() {
  const previewBuffer = getPreviewBuffer();
  if (!previewBuffer || !dom.waveformCanvas) return;

  const canvas = dom.waveformCanvas;
  const ctx = canvas.getContext('2d');

  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * window.devicePixelRatio;
  canvas.height = rect.height * window.devicePixelRatio;
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

  const width = rect.width;
  const height = rect.height;

  ctx.fillStyle = 'rgba(0, 0, 0, 0)';
  ctx.fillRect(0, 0, width, height);

  const data = previewBuffer.getChannelData(0);
  const step = Math.ceil(data.length / width);
  const amp = height / 2;

  ctx.fillStyle = '#a855f7';

  for (let i = 0; i < width; i++) {
    let min = 1.0;
    let max = -1.0;

    for (let j = 0; j < step; j++) {
      const datum = data[(i * step) + j];
      if (datum < min) min = datum;
      if (datum > max) max = datum;
    }

    const y1 = (1 + min) * amp;
    const y2 = (1 + max) * amp;

    ctx.fillRect(i, y1, 1, Math.max(1, y2 - y1));
  }
}

// ─── Playback ───────────────────────────────────────────────────────────────
function setPlaybackPosition(time) {
  const duration = state.file.duration;
  const safeTime = Math.max(0, Math.min(time || 0, duration || 0));
  const progress = duration > 0 ? (safeTime / duration) * 100 : 0;

  dom.waveformProgress.style.width = `${progress}%`;
  dom.waveformPlayhead.style.left = `${progress}%`;
  dom.currentTimeEl.textContent = formatTime(safeTime);
  dom.waveformContainer.setAttribute('aria-valuenow', progress.toFixed(1));
  dom.waveformContainer.setAttribute('aria-valuetext', `${formatTime(safeTime)} of ${formatTime(duration || 0)}`);
}

function finishPlayback() {
  if (!state.playback.isPlaying) return;
  state.playback.isPlaying = false;
  state.playback.pauseTime = 0;
  dom.playIcon.textContent = '▶';
  setPlaybackPosition(0);
  clearInterval(state.playback.seekInterval);
  stopLevelMeters();
}

function startSingleSourcePlayback(offset) {
  state.audio.sourceNode = state.audio.context.createBufferSource();
  state.audio.sourceNode.buffer = getPreviewBuffer();
  connectAudioChain(state.audio.sourceNode);
  state.audio.sourceNode.onended = finishPlayback;
  state.audio.sourceNode.start(0, offset);
  return true;
}

function getStemLivePlaybackBuffer(context, stem) {
  // Song restoration is a post-mix treatment. Applying it to each live stem
  // changes the balance and can make a repair detector mistake musical detail
  // for an artifact. Only explicit per-stem restoration belongs in this path.
  const settings = stem.settings;
  const needsRestoration = settings.repairEdgeArtifacts ||
    settings.repairPrematureEnding || settings.repairVocalCrackle;
  if (!needsRestoration) return stem.buffer;

  const restored = createRestoredInputBuffer(context, stem.buffer, settings);
  if (settings.repairPrematureEnding) {
    repairPrematureEnding(
      Array.from({ length: restored.buffer.numberOfChannels }, (_, channel) => restored.buffer.getChannelData(channel)),
      restored.buffer.sampleRate
    );
  }
  return restored.buffer;
}

function startLiveStemPlayback(offset) {
  const song = state.file.stemSong;
  if (!song || !song.stems.every(stem => stem.buffer)) return false;

  const context = state.audio.context;
  const mixBus = context.createGain();
  state.audio.stemMixBus = mixBus;
  state.audio.stemSourceNodes = [];
  state.audio.stemNodeControls.clear();
  connectAudioChain(mixBus);

  let remaining = 0;
  for (const stem of song.stems) {
    if (offset >= stem.buffer.duration) continue;
    const source = context.createBufferSource();
    source.buffer = getStemLivePlaybackBuffer(context, stem);
    const controls = connectStemProcessingChain(context, source, stem, stemIsAudible(song, stem), mixBus);
    state.audio.stemNodeControls.set(stem, controls);
    state.audio.stemSourceNodes.push(source);
    remaining++;
    source.onended = () => {
      remaining--;
      if (remaining === 0) finishPlayback();
    };
    source.start(0, offset);
  }
  return remaining > 0;
}

function startPlaybackAt(offset) {
  if (!state.file.buffer || !state.audio.context) return;
  if (state.audio.context.state === 'suspended') state.audio.context.resume();

  const liveStems = state.file.stemSong;
  const started = liveStems ? startLiveStemPlayback(offset) : startSingleSourcePlayback(offset);
  if (!started) return;

  state.playback.startTime = state.audio.context.currentTime - offset;
  state.playback.isPlaying = true;
  dom.playIcon.textContent = '⏸';
  if (liveStems) void updateLiveMasterRestorationPreview();
  const preserveSpectrogram = state.meters.preserveSpectrogram;
  startLevelMeters({ preserveSpectrogram });
  startSeekUpdate();
  startSpectrogram({ preserve: preserveSpectrogram });
  state.meters.preserveSpectrogram = false;
}

function playAudio() {
  if (!state.file.buffer || !state.audio.context) return;
  stopAudio({ preserveSpectrogram: state.meters.preserveSpectrogram });
  startPlaybackAt(state.playback.pauseTime);
}

function pauseAudio() {
  if (!state.playback.isPlaying) return;
  state.playback.pauseTime = state.audio.context.currentTime - state.playback.startTime;
  stopAudio({ preserveSpectrogram: true });
}

function stopAudio({ preserveSpectrogram = false } = {}) {
  state.audio.restorationPreviewRequest++;
  removeLiveMasterRestoration(false);
  if (state.audio.sourceNode) {
    try {
      state.audio.sourceNode.onended = null;
      state.audio.sourceNode.stop();
      state.audio.sourceNode.disconnect();
    } catch (e) { /* already stopped */ }
    state.audio.sourceNode = null;
  }
  state.audio.stemSourceNodes.forEach(source => {
    try {
      source.onended = null;
      source.stop();
      source.disconnect();
    } catch (e) { /* already stopped */ }
  });
  state.audio.stemSourceNodes = [];
  state.audio.stemNodeControls.clear();
  if (state.audio.stemMixBus) {
    try { state.audio.stemMixBus.disconnect(); } catch (e) { /* already disconnected */ }
    state.audio.stemMixBus = null;
  }
  state.playback.isPlaying = false;
  dom.playIcon.textContent = '▶';
  clearInterval(state.playback.seekInterval);
  stopLevelMeters({ clearSpectrogram: !preserveSpectrogram });
  state.meters.preserveSpectrogram = preserveSpectrogram;
}

function startSeekUpdate() {
  clearInterval(state.playback.seekInterval);

  state.playback.seekInterval = setInterval(() => {
    if (state.playback.isPlaying && state.file.buffer && !state.playback.isSeeking) {
      const currentTime = state.audio.context.currentTime - state.playback.startTime;
      if (currentTime >= state.file.duration) {
        stopAudio();
        state.playback.pauseTime = 0;
        setPlaybackPosition(0);
      } else {
        setPlaybackPosition(currentTime);
      }
    }
  }, 100);
}

function seekTo(time, { resume = state.playback.isPlaying } = {}) {
  time = Math.max(0, Math.min(time, state.file.duration));

  // Set seeking flag to prevent race conditions
  state.playback.isSeeking = true;
  state.playback.pauseTime = time;

  setPlaybackPosition(time);

  if (state.playback.isPlaying) {
    stopAudio();
  }
  if (resume) {
    startPlaybackAt(time);
  }

  // Clear seeking flag after a short delay to avoid race conditions
  setTimeout(() => { state.playback.isSeeking = false; }, 50);
}

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// ─── Level Meters ───────────────────────────────────────────────────────────
function startLevelMeters({ preserveSpectrogram = false } = {}) {
  if (!state.audio.analyserLeft || !state.audio.analyserRight) return;

  stopLevelMeters({ clearSpectrogram: !preserveSpectrogram });

  const bufferLength = state.audio.analyserLeft.frequencyBinCount;
  const dataArrayLeft = new Uint8Array(bufferLength);
  const dataArrayRight = new Uint8Array(bufferLength);
  const bypassReferenceLeft = new Uint8Array(bufferLength);
  const bypassReferenceRight = new Uint8Array(bufferLength);

  state.meters.interval = setInterval(() => {
    if (!state.playback.isPlaying) return;

    state.audio.analyserLeft.getByteTimeDomainData(dataArrayLeft);
    state.audio.analyserRight.getByteTimeDomainData(dataArrayRight);
    state.audio.bypassAnalyserLeft?.getByteTimeDomainData(bypassReferenceLeft);
    state.audio.bypassAnalyserRight?.getByteTimeDomainData(bypassReferenceRight);

    let peakL = 0;
    let peakR = 0;
    let wetEnergy = 0;
    let dryEnergy = 0;

    for (let i = 0; i < bufferLength; i++) {
      const normalizedL = (dataArrayLeft[i] - 128) / 128;
      const normalizedR = (dataArrayRight[i] - 128) / 128;
      const normalizedDryLeft = (bypassReferenceLeft[i] - 128) / 128;
      const normalizedDryRight = (bypassReferenceRight[i] - 128) / 128;
      peakL = Math.max(peakL, Math.abs(normalizedL));
      peakR = Math.max(peakR, Math.abs(normalizedR));
      wetEnergy += (normalizedL * normalizedL + normalizedR * normalizedR) * 0.5;
      dryEnergy += (normalizedDryLeft * normalizedDryLeft + normalizedDryRight * normalizedDryRight) * 0.5;
    }

    if (!state.ui.isBypassed) {
      state.audio.bypassMatchGain = updateMatchedBypassGain(
        state.audio.bypassMatchGain,
        wetEnergy / bufferLength,
        dryEnergy / bufferLength,
        0.95
      );
    }

    const dbL = peakL > 0 ? 20 * Math.log10(peakL) : -Infinity;
    const dbR = peakR > 0 ? 20 * Math.log10(peakR) : -Infinity;

    const percentL = Math.max(0, Math.min(100, ((dbL + 60) / 60) * 100));
    const percentR = Math.max(0, Math.min(100, ((dbR + 60) / 60) * 100));

    dom.meterLeft.style.width = `${percentL}%`;
    dom.meterRight.style.width = `${percentR}%`;

    const now = Date.now();

    if (percentL > state.meters.peakHoldLeft || now - state.meters.peakHoldTimeLeft > 1500) {
      state.meters.peakHoldLeft = percentL;
      state.meters.peakHoldTimeLeft = now;
    }

    if (percentR > state.meters.peakHoldRight || now - state.meters.peakHoldTimeRight > 1500) {
      state.meters.peakHoldRight = percentR;
      state.meters.peakHoldTimeRight = now;
    }

    if (state.meters.peakHoldLeft > 0) {
      dom.peakLeft.style.left = `${state.meters.peakHoldLeft}%`;
      dom.peakLeft.classList.add('visible');
    } else {
      dom.peakLeft.classList.remove('visible');
    }

    if (state.meters.peakHoldRight > 0) {
      dom.peakRight.style.left = `${state.meters.peakHoldRight}%`;
      dom.peakRight.classList.add('visible');
    } else {
      dom.peakRight.classList.remove('visible');
    }

    const displayDbL = dbL === -Infinity ? '-∞' : dbL.toFixed(1);
    const displayDbR = dbR === -Infinity ? '-∞' : dbR.toFixed(1);

    dom.meterLeftValue.textContent = `${displayDbL} dB`;
    dom.meterRightValue.textContent = `${displayDbR} dB`;

    const isClippingL = dbL > -0.5;
    const isClippingR = dbR > -0.5;

    dom.meterLeftValue.classList.toggle('overload', isClippingL);
    dom.meterRightValue.classList.toggle('overload', isClippingR);

    if (dom.clipLeft) dom.clipLeft.classList.toggle('visible', isClippingL);
    if (dom.clipRight) dom.clipRight.classList.toggle('visible', isClippingR);
  }, 50);
}

function stopLevelMeters({ clearSpectrogram = true } = {}) {
  if (state.meters.interval) {
    clearInterval(state.meters.interval);
    state.meters.interval = null;
  }

  if (state.meters.spectrogramAnim) {
    cancelAnimationFrame(state.meters.spectrogramAnim);
    state.meters.spectrogramAnim = null;
  }

  dom.meterLeft.style.width = '0%';
  dom.meterRight.style.width = '0%';
  dom.peakLeft.classList.remove('visible');
  dom.peakRight.classList.remove('visible');
  dom.meterLeftValue.textContent = '-∞ dB';
  dom.meterRightValue.textContent = '-∞ dB';
  dom.meterLeftValue.classList.remove('overload');
  dom.meterRightValue.classList.remove('overload');

  if (dom.clipLeft) dom.clipLeft.classList.remove('visible');
  if (dom.clipRight) dom.clipRight.classList.remove('visible');

  state.meters.peakHoldLeft = 0;
  state.meters.peakHoldRight = 0;
  state.meters.peakHoldTimeLeft = 0;
  state.meters.peakHoldTimeRight = 0;

  // A pause should leave the current visualization visible so playback can
  // continue from the same image when resumed. A true stop clears it.
  if (clearSpectrogram && dom.spectrogramCanvas) {
    const sCtx = dom.spectrogramCanvas.getContext('2d');
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    sCtx.fillStyle = isLight ? '#e8e8f0' : '#0a0a1a';
    sCtx.fillRect(0, 0, dom.spectrogramCanvas.width, dom.spectrogramCanvas.height);
  }
}

// ─── Spectrogram (complete implementation) ──────────────────────────────────
function startSpectrogram({ preserve = false } = {}) {
  if (!state.audio.analyser || !dom.spectrogramCanvas) return;

  // Cancel any existing animation
  if (state.meters.spectrogramAnim) {
    cancelAnimationFrame(state.meters.spectrogramAnim);
    state.meters.spectrogramAnim = null;
  }

  const canvas = dom.spectrogramCanvas;
  const ctx = canvas.getContext('2d');

  // Resizing a canvas clears it. Retain the paused visualization whenever the
  // display size is unchanged, and use it to seed the next render buffer.
  const rect = canvas.getBoundingClientRect();
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  const preserveExisting = preserve && canvas.width === width && canvas.height === height;
  if (!preserveExisting) {
    canvas.width = width;
    canvas.height = height;
  }


  const analyser = state.audio.analyser;
  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  // Create offscreen canvas
  const offscreen = document.createElement('canvas');
  offscreen.width = width;
  offscreen.height = height;
  const offCtx = offscreen.getContext('2d');

  // Start fresh for a new playback, or copy the paused image for a resume.
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const specBg = isLight ? '#e8e8f0' : '#0a0a1a';
  if (preserveExisting) {
    offCtx.drawImage(canvas, 0, 0);
  } else {
    ctx.fillStyle = specBg;
    ctx.fillRect(0, 0, width, height);
    offCtx.fillStyle = specBg;
    offCtx.fillRect(0, 0, width, height);
  }

  // Throttle to ~30fps for performance
  let lastDrawTime = 0;
  const FRAME_INTERVAL = 1000 / 30;

  function getColor(value) {
    const normalized = value / 255;
    let r, g, b;

    if (normalized < 0.2) {
      const t = normalized / 0.2;
      r = 0; g = 0; b = Math.floor(50 + t * 150);
    } else if (normalized < 0.4) {
      const t = (normalized - 0.2) / 0.2;
      r = 0; g = Math.floor(t * 255); b = 200;
    } else if (normalized < 0.6) {
      const t = (normalized - 0.4) / 0.2;
      r = 0; g = 255; b = Math.floor(200 * (1 - t));
    } else if (normalized < 0.8) {
      const t = (normalized - 0.6) / 0.2;
      r = Math.floor(t * 255); g = 255; b = 0;
    } else {
      const t = (normalized - 0.8) / 0.2;
      r = 255; g = Math.floor(255 * (1 - t)); b = 0;
    }

    return `rgb(${r},${g},${b})`;
  }

  function draw(timestamp) {
    if (!state.playback.isPlaying) return;

    state.meters.spectrogramAnim = requestAnimationFrame(draw);

    // Throttle
    if (timestamp - lastDrawTime < FRAME_INTERVAL) return;
    lastDrawTime = timestamp;

    analyser.getByteFrequencyData(dataArray);

    // Shift existing image left by 2 pixels
    offCtx.drawImage(offscreen, -2, 0);

    // Draw new column on the right
    const columnWidth = 2;
    const x = width - columnWidth;

    // Draw frequency bins (logarithmic scale, low freq at bottom)
    for (let i = 0; i < height; i++) {
      const freqRatio = 1 - (i / height);
      const binIndex = Math.floor(Math.pow(freqRatio, 2) * bufferLength * 0.5);
      const value = dataArray[binIndex] || 0;

      offCtx.fillStyle = getColor(value);
      offCtx.fillRect(x, i, columnWidth, 1);
    }

    // Copy to main canvas
    ctx.drawImage(offscreen, 0, 0);
  }

  state.meters.spectrogramAnim = requestAnimationFrame(draw);
}

// ─── File Events ────────────────────────────────────────────────────────────
dom.selectFileBtn.addEventListener('click', async () => {
  const filePath = await window.electronAPI.selectFile();
  if (filePath) await loadFile(filePath);
});

dom.changeFileBtn.addEventListener('click', async () => {
  const filePath = await window.electronAPI.selectFile();
  if (filePath) {
    stopAudio();
    state.playback.pauseTime = 0;
    await loadFile(filePath);
  }
});

async function loadFile(filePath) {
  if (!filePath) return;

  if (SUNO_STEMS_ARCHIVE_PATTERN.test(filePath)) {
    return importSunoStemsArchive(filePath, true);
  }

  state.file.path = filePath;
  state.file.stemSong = null;

  try {
    const name = filePath.split(/[\\/]/).pop();
    dom.fileName.textContent = name;
    dom.fileMeta.textContent = 'Loading...';

    dom.fileZoneContent.classList.add('hidden');
    dom.fileLoaded.classList.remove('hidden');

    await loadAudioFile(filePath);
    updateChecklist();

    // Auto-add to batch queue so metadata can be edited
    ensureFileInQueue(filePath);
    renderBatchList();
  } catch (error) {
    console.error('Error loading file:', error);
    dom.statusMessage.textContent = `✗ Error: ${error.message}`;
    dom.statusMessage.className = 'status-message error visible';
    setTimeout(() => dom.statusMessage.classList.remove('visible'), 6000);
  }
}

dom.dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dom.dropZone.classList.add('drag-over');
});

dom.dropZone.addEventListener('dragleave', () => {
  dom.dropZone.classList.remove('drag-over');
});

dom.dropZone.addEventListener('drop', async (e) => {
  e.preventDefault();
  dom.dropZone.classList.remove('drag-over');

  const file = e.dataTransfer.files[0];
  if (file && (AUDIO_FILE_PATTERN.test(file.name) || SUNO_STEMS_ARCHIVE_PATTERN.test(file.name))) {
    const filePath = window.electronAPI.getPathForFile(file);
    if (filePath) {
      stopAudio();
      state.playback.pauseTime = 0;
      await loadFile(filePath);
    }
  } else {
    showFileStatus('✗ Please drop an audio file or a Suno stems ZIP.', 'error');
  }
});

// ─── Player Controls ────────────────────────────────────────────────────────
dom.playBtn.addEventListener('click', () => {
  state.playback.isPlaying ? pauseAudio() : playAudio();
});

dom.stopBtn.addEventListener('click', () => {
  stopAudio();
  state.playback.pauseTime = 0;
  setPlaybackPosition(0);
});

function getWaveformTime(clientX) {
  const rect = dom.waveformContainer.getBoundingClientRect();
  if (!rect.width || !state.file.duration) return 0;
  const percent = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  return percent * state.file.duration;
}

let activeWaveformPointerId = null;
let resumeAfterWaveformScrub = false;
let waveformScrubTime = 0;

dom.waveformContainer.addEventListener('pointerdown', (e) => {
  if (!state.file.buffer || e.button !== 0) return;

  e.preventDefault();
  activeWaveformPointerId = e.pointerId;
  resumeAfterWaveformScrub = state.playback.isPlaying;
  dom.waveformContainer.setPointerCapture(e.pointerId);
  dom.waveformContainer.classList.add('scrubbing');

  if (resumeAfterWaveformScrub) stopAudio({ preserveSpectrogram: true });
  waveformScrubTime = getWaveformTime(e.clientX);
  setPlaybackPosition(waveformScrubTime);
});

dom.waveformContainer.addEventListener('pointermove', (e) => {
  if (e.pointerId !== activeWaveformPointerId) return;
  waveformScrubTime = getWaveformTime(e.clientX);
  setPlaybackPosition(waveformScrubTime);
});

function finishWaveformScrub(e) {
  if (e.pointerId !== activeWaveformPointerId) return;

  const time = e.type === 'pointercancel' ? waveformScrubTime : getWaveformTime(e.clientX);
  const shouldResume = resumeAfterWaveformScrub;
  activeWaveformPointerId = null;
  resumeAfterWaveformScrub = false;
  dom.waveformContainer.classList.remove('scrubbing');
  seekTo(time, { resume: shouldResume });
}

dom.waveformContainer.addEventListener('pointerup', finishWaveformScrub);
dom.waveformContainer.addEventListener('pointercancel', finishWaveformScrub);

function toggleMatchedBypass() {
  state.ui.isBypassed = !state.ui.isBypassed;
  dom.bypassBtn.textContent = state.ui.isBypassed ? '🔇 FX Off • Matched' : '🔊 FX On';
  dom.bypassBtn.classList.toggle('active', state.ui.isBypassed);
  updateAudioChain();
  updateEQ();
}

dom.bypassBtn.addEventListener('click', toggleMatchedBypass);

// ─── Offline Export: pre-master render, then loudness/true-peak final stage ──
async function processAudioOffline(settings, inputBuffer = state.file.buffer) {
  const targetSampleRate = settings.sampleRate;
  const numChannels = inputBuffer.numberOfChannels;
  const outputLength = Math.ceil(inputBuffer.length * targetSampleRate / inputBuffer.sampleRate);
  const compressorLatencyFrames = settings.glueCompression
    ? Math.ceil(targetSampleRate * GLUE_COMPRESSOR_LATENCY_SECONDS)
    : 0;
  const offlineCtx = new OfflineAudioContext(
    numChannels,
    outputLength + compressorLatencyFrames,
    targetSampleRate
  );
  const source = offlineCtx.createBufferSource();
  // Destructive restoration is performed on an export-only copy. This keeps
  // the loaded source and real-time audition intact while batch and single
  // exports receive exactly the same analysis-gated treatment.
  const restoredInput = createRestoredInputBuffer(offlineCtx, inputBuffer, settings);
  source.buffer = restoredInput.buffer;

  await ensureStudioDynamicsWorklet(offlineCtx);
  const studioDynamics = createStudioDynamicsNode(
    offlineCtx,
    createMasterDynamicsConfig(settings)
  );

  // The first pass uses the exact same corrective, dynamics, width, and
  // mono-bass graph as preview, but deliberately leaves loudness drive and
  // final limiting for the measured second stage below.
  const nodes = createMasteringNodes(offlineCtx, offlineCtx.createGain(), {
    glueCompression: settings.glueCompression,
    studioDynamics
  });
  configureMasteringNodes(nodes, { ...settings, truePeakLimit: false });
  nodes.inputGain.gain.value = Math.pow(10, (settings.inputGain || 0) / 20);
  nodes.eqLow.gain.value = settings.eqLow;
  nodes.eqLowMid.gain.value = settings.eqLowMid;
  nodes.eqMid.gain.value = settings.eqMid;
  nodes.eqHighMid.gain.value = settings.eqHighMid;
  nodes.eqHigh.gain.value = settings.eqHigh;
  nodes.midGain.gain.value = 1;
  nodes.sideGain.gain.value = (settings.stereoWidth ?? 100) / 100;
  nodes.normGain.gain.value = 1;
  connectMasteringGraph(source, nodes).connect(offlineCtx.destination);
  source.start(0);
  const untrimmedBuffer = await offlineCtx.startRendering();
  let renderedBuffer = untrimmedBuffer;
  if (compressorLatencyFrames) {
    renderedBuffer = offlineCtx.createBuffer(numChannels, outputLength, targetSampleRate);
    for (let channel = 0; channel < numChannels; channel++) {
      renderedBuffer.getChannelData(channel).set(
        untrimmedBuffer.getChannelData(channel).subarray(
          compressorLatencyFrames,
          compressorLatencyFrames + outputLength
        )
      );
    }
  }

  // Ending repair only reduces a detected tail, so it belongs before the
  // measured loudness drive and final limiter.
  if (settings.repairPrematureEnding) {
    repairPrematureEnding(
      Array.from({ length: renderedBuffer.numberOfChannels }, (_, channel) => renderedBuffer.getChannelData(channel)),
      renderedBuffer.sampleRate
    );
  }

  const masteringReport = finalizeMaster(renderedBuffer, settings);
  masteringReports.set(renderedBuffer, masteringReport);

  return renderedBuffer;
}

// ─── Export ─────────────────────────────────────────────────────────────────
// Get metadata for the currently loaded file (from batch queue if present)
function getLoadedFileMetadata() {
  if (!state.file.path) return null;
  const queueItem = batchState.queue.find(q => q.path === state.file.path);
  if (queueItem && queueItem.metadata) return queueItem.metadata;
  return null;
}

function formatMasteringQc(report) {
  if (!report?.verification?.analysis) return '';
  const { integratedLUFS, truePeakDB } = report.verification.analysis;
  const measurements = `${integratedLUFS.toFixed(1)} LUFS • ${truePeakDB.toFixed(2)} dBTP`;
  return report.verification.warnings.length
    ? `${measurements} • Warning: ${report.verification.warnings.join('; ')}`
    : measurements;
}

dom.processBtn.addEventListener('click', async () => {
  if (!state.file.path || !state.file.buffer) return;

  const outputPath = await window.electronAPI.saveFile();
  if (!outputPath) return;

  dom.progressContainer.classList.remove('hidden');
  dom.processBtn.disabled = true;
  dom.statusMessage.textContent = '';
  dom.statusMessage.className = 'status-message';

  const settings = validateSettings({
    normalizeLoudness: dom.normalizeLoudness.checked,
    truePeakLimit: dom.truePeakLimit.checked,
    truePeakCeiling: parseFloat(dom.truePeakSlider.value),
    targetLufs: dom.targetLufs ? parseInt(dom.targetLufs.value) : -14,
    inputGain: dom.inputGain ? parseFloat(dom.inputGain.value) : 0,
    stereoWidth: dom.stereoWidth ? parseInt(dom.stereoWidth.value) : 100,
    cleanLowEnd: dom.cleanLowEnd.checked,
    glueCompression: dom.glueCompression.checked,
    centerBass: dom.centerBass.checked,
    cutMud: dom.cutMud.checked,
    addAir: dom.addAir.checked,
    tameHarsh: dom.tameHarsh.checked,
    dynamicEq: dom.dynamicEq.checked,
    dynamicEqAmount: parseInt(dom.dynamicEqAmount.value),
    deEsser: dom.deEsser.checked,
    deEsserFrequency: parseInt(dom.deEsserFrequency.value),
    deEsserRange: parseFloat(dom.deEsserRange.value),
    deEsserAttack: parseFloat(dom.deEsserAttack.value),
    deEsserRelease: parseFloat(dom.deEsserRelease.value),
    // Audition is a monitor path and is never written into an export.
    deEsserAudition: false,
    repairEdgeArtifacts: dom.repairEdgeArtifacts.checked,
    repairPrematureEnding: dom.repairPrematureEnding.checked,
    repairVocalCrackle: dom.repairVocalCrackle.checked,
    sampleRate: parseInt(dom.sampleRate.value),
    bitDepth: parseInt(dom.bitDepth.value),
    eqLow: parseFloat(dom.eqLow.value),
    eqLowMid: parseFloat(dom.eqLowMid.value),
    eqMid: parseFloat(dom.eqMid.value),
    eqHighMid: parseFloat(dom.eqHighMid.value),
    eqHigh: parseFloat(dom.eqHigh.value)
  });

  try {
    updateProgress(10);

    const songInput = state.file.stemSong
      ? await renderStemSongMix(state.file.stemSong, settings.sampleRate, false)
      : state.file.buffer;
    const processedBuffer = await processAudioOffline(settings, songInput);
    const masteringReport = masteringReports.get(processedBuffer);
    if (masteringReport && !masteringReport.verification.passed) {
      throw new Error(`Mastering QC failed: ${masteringReport.verification.warnings.join('; ')}`);
    }
    updateProgress(60);

    const wavBuffer = encodeWAV(processedBuffer, {
      bitDepth: settings.bitDepth,
      dither: settings.bitDepth === 16, // TPDF dithering for 16-bit
      metadata: getLoadedFileMetadata()
    });
    updateProgress(80);

    const uint8Array = new Uint8Array(wavBuffer);
    await window.electronAPI.writeFile(outputPath, Array.from(uint8Array));
    updateProgress(100);

    const qcSummary = formatMasteringQc(masteringReport);
    const hasWarnings = masteringReport?.verification?.warnings.length > 0;
    dom.statusMessage.textContent = `${hasWarnings ? '⚠' : '✓'} Export complete${qcSummary ? ` • ${qcSummary}` : ''}`;
    dom.statusMessage.className = `status-message ${hasWarnings ? 'warning' : 'success'} visible`;
    setTimeout(() => dom.statusMessage.classList.remove('visible'), 4000);
  } catch (error) {
    console.error('Export error:', error);
    dom.statusMessage.textContent = `✗ Error: ${error.message}`;
    dom.statusMessage.className = 'status-message error visible';
    setTimeout(() => dom.statusMessage.classList.remove('visible'), 6000);
  }

  dom.progressContainer.classList.add('hidden');
  dom.progressFill.style.width = '0%';
  dom.progressText.textContent = '0%';
  dom.processBtn.disabled = false;
});

function updateProgress(percent) {
  dom.progressFill.style.width = `${percent}%`;
  dom.progressText.textContent = `${percent}%`;
}

// ─── Checklist / Status ─────────────────────────────────────────────────────
function updateChecklist() {
  if (dom.miniLufs) {
    dom.miniLufs.classList.toggle('active', dom.normalizeLoudness.checked);
    const targetLufs = dom.targetLufs ? parseInt(dom.targetLufs.value) : -14;
    dom.miniLufs.textContent = `• ${targetLufs} LUFS`;
  }
  if (dom.miniPeak) {
    dom.miniPeak.classList.toggle('active', dom.truePeakLimit.checked);
  }
  if (dom.miniFormat) {
    dom.miniFormat.classList.toggle('active', state.file.path !== null);
  }
}

// ─── Settings Change Handlers ───────────────────────────────────────────────
const restorationControls = [
  dom.repairEdgeArtifacts,
  dom.repairPrematureEnding,
  dom.repairVocalCrackle
];

[dom.normalizeLoudness, dom.truePeakLimit, dom.cleanLowEnd, dom.glueCompression,
 dom.centerBass, dom.cutMud, dom.addAir, dom.tameHarsh, dom.dynamicEq, dom.deEsser,
 dom.deEsserAudition, dom.repairEdgeArtifacts, dom.repairPrematureEnding,
 dom.repairVocalCrackle].forEach(el => {
  el.addEventListener('change', async () => {
    pushUndo();
    if (restorationControls.includes(el)) {
      if (state.file.stemSong && state.playback.isPlaying) {
        void updateLiveMasterRestorationPreview();
      } else {
        stopAudio();
        state.playback.pauseTime = 0;
        updateRestorationPreview();
      }
    }
    if (el === dom.glueCompression && state.file.buffer) {
      // A real GainNode bypass avoids the Web Audio compressor's fixed 6 ms
      // latency when glue is off, so changing this mode rebuilds the graph.
      stopAudio();
      state.playback.pauseTime = 0;
      await createAudioChain();
    } else {
      updateAudioChain();
    }
    updateChecklist();
    saveSettingsToStorage();
  });
});

dom.truePeakSlider.addEventListener('mousedown', () => pushUndo());
dom.truePeakSlider.addEventListener('input', () => {
  const ceiling = parseFloat(dom.truePeakSlider.value);
  dom.ceilingValue.textContent = `${ceiling.toFixed(1)} dB`;

  if (dom.ceilingFill) {
    const percent = ((ceiling + 6) / 6) * 100;
    dom.ceilingFill.style.height = `${percent}%`;
  }

  updateAudioChain();
  saveSettingsToStorage();
});

if (dom.inputGain) {
  dom.inputGain.addEventListener('mousedown', () => pushUndo());
  dom.inputGain.addEventListener('input', () => {
    const gain = parseFloat(dom.inputGain.value);
    dom.inputGainValue.textContent = `${gain.toFixed(1)} dB`;

    if (dom.inputFill) {
      const percent = ((gain + 12) / 24) * 100;
      dom.inputFill.style.height = `${percent}%`;
    }

    updateAudioChain();
    saveSettingsToStorage();
  });

  dom.inputGain.addEventListener('dblclick', () => {
    pushUndo();
    dom.inputGain.value = 0;
    dom.inputGainValue.textContent = '0.0 dB';
    if (dom.inputFill) {
      dom.inputFill.style.height = '50%';
    }
    updateAudioChain();
    saveSettingsToStorage();
  });
}

if (dom.stereoWidth) {
  dom.stereoWidth.addEventListener('mousedown', () => pushUndo());
  dom.stereoWidth.addEventListener('input', () => {
    const width = parseInt(dom.stereoWidth.value);
    dom.stereoWidthValue.textContent = `${width}%`;
    updateAudioChain();
    saveSettingsToStorage();
  });
}

if (dom.targetLufs) {
  dom.targetLufs.addEventListener('mousedown', () => pushUndo());
  dom.targetLufs.addEventListener('input', () => {
    const targetLufs = parseInt(dom.targetLufs.value);
    dom.targetLufsValue.textContent = `${targetLufs} LUFS`;

    if (state.file.lufs !== null && isFinite(state.file.lufs)) {
      state.file.normGain = calculateNormalizationGain(state.file.lufs, targetLufs);
      updateAudioChain();
    }

    if (dom.miniLufs) {
      dom.miniLufs.textContent = `• ${targetLufs} LUFS`;
    }
    saveSettingsToStorage();
  });
}

// Save on sample rate / bit depth change
dom.sampleRate.addEventListener('change', saveSettingsToStorage);
dom.bitDepth.addEventListener('change', saveSettingsToStorage);

// ─── Fader Fill Helper ──────────────────────────────────────────────────────
function refreshFaderFills() {
  if (dom.inputFill && dom.inputGain) {
    const percent = ((parseFloat(dom.inputGain.value) + 12) / 24) * 100;
    dom.inputFill.style.height = `${percent}%`;
  }
  if (dom.ceilingFill) {
    const ceiling = parseFloat(dom.truePeakSlider.value);
    const percent = ((ceiling + 6) / 6) * 100;
    dom.ceilingFill.style.height = `${percent}%`;
  }
}

// ─── Tooltips (with boundary clamping) ──────────────────────────────────────
let tooltipTimeout = null;

const savedTipsPref = localStorage.getItem('showTips');
if (savedTipsPref !== null) {
  dom.showTipsCheckbox.checked = savedTipsPref === 'true';
}

dom.showTipsCheckbox.addEventListener('change', () => {
  localStorage.setItem('showTips', dom.showTipsCheckbox.checked);
  if (!dom.showTipsCheckbox.checked) {
    dom.tooltip.classList.remove('visible');
  }
});

document.querySelectorAll('[data-tip]').forEach(el => {
  el.addEventListener('mouseenter', () => {
    if (!dom.showTipsCheckbox.checked) return;

    const tipText = el.getAttribute('data-tip');
    if (!tipText) return;

    clearTimeout(tooltipTimeout);
    tooltipTimeout = setTimeout(() => {
      dom.tooltip.textContent = tipText;

      // Position off-screen first to measure
      dom.tooltip.style.left = '0px';
      dom.tooltip.style.top = '0px';
      dom.tooltip.classList.add('visible');

      const rect = el.getBoundingClientRect();
      const tooltipRect = dom.tooltip.getBoundingClientRect();

      let left = rect.left;
      let top = rect.bottom + 8;

      // Clamp to viewport
      if (left + tooltipRect.width > window.innerWidth - 10) {
        left = window.innerWidth - tooltipRect.width - 10;
      }
      if (left < 10) left = 10;

      if (top + tooltipRect.height > window.innerHeight - 10) {
        top = rect.top - tooltipRect.height - 8;
      }
      if (top < 10) top = 10;

      dom.tooltip.style.left = `${left}px`;
      dom.tooltip.style.top = `${top}px`;
    }, 400);
  });

  el.addEventListener('mouseleave', () => {
    clearTimeout(tooltipTimeout);
    dom.tooltip.classList.remove('visible');
  });
});

// ─── Keyboard Shortcuts ─────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  // Don't trigger shortcuts when typing in inputs
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

  // Space = play/pause
  if (e.code === 'Space') {
    e.preventDefault();
    if (state.file.buffer) {
      state.playback.isPlaying ? pauseAudio() : playAudio();
    }
  }

  // Escape = stop
  if (e.code === 'Escape') {
    stopAudio();
    state.playback.pauseTime = 0;
    setPlaybackPosition(0);
  }

  // B = bypass toggle
  if (e.code === 'KeyB' && !e.ctrlKey && !e.metaKey) {
    toggleMatchedBypass();
  }

  // Ctrl+Z = undo
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ' && !e.shiftKey) {
    e.preventDefault();
    undo();
  }

  // Ctrl+Shift+Z or Ctrl+Y = redo
  if ((e.ctrlKey || e.metaKey) && (e.code === 'KeyZ' && e.shiftKey || e.code === 'KeyY')) {
    e.preventDefault();
    redo();
  }

  // Ctrl+E = export
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyE') {
    e.preventDefault();
    if (!dom.processBtn.disabled) {
      dom.processBtn.click();
    }
  }

  // Left/Right arrow = seek ±5s
  if (e.code === 'ArrowLeft' && state.file.buffer) {
    e.preventDefault();
    const currentTime = state.playback.isPlaying
      ? state.audio.context.currentTime - state.playback.startTime
      : state.playback.pauseTime;
    seekTo(currentTime - 5);
  }
  if (e.code === 'ArrowRight' && state.file.buffer) {
    e.preventDefault();
    const currentTime = state.playback.isPlaying
      ? state.audio.context.currentTime - state.playback.startTime
      : state.playback.pauseTime;
    seekTo(currentTime + 5);
  }
});

// ─── Debug ──────────────────────────────────────────────────────────────────
dom.debugBtn.addEventListener('click', async () => {
  const info = await window.electronAPI.getSystemInfo();
  const infoText = `
System Information:
-------------------
Platform: ${info.platform}
Architecture: ${info.arch}
Is Packaged: ${info.isPackaged}
Electron: ${info.electronVersion}
Node: ${info.nodeVersion}

Audio Processing:
-----------------
Engine: Pure JavaScript (Web Audio API)
LUFS/True Peak: ITU-R BS.1770-5 with post-render QC
WAV Encoder: Native JavaScript (TPDF dithering)
No FFmpeg dependency!

App Path: ${info.appPath}
  `.trim();

  console.log(infoText);
  alert(infoText);
});

// ─── Batch Processing ───────────────────────────────────────────────────────
const batchState = {
  queue: [],       // Array of { path, name, status: 'pending'|'processing'|'done'|'error' }
  isProcessing: false
};

const batchDom = {
  panel: document.getElementById('batchPanel'),
  addBtn: document.getElementById('batchAddFiles'),
  clearBtn: document.getElementById('batchClear'),
  exportBtn: document.getElementById('batchExport'),
  dropZone: document.getElementById('batchDropZone'),
  list: document.getElementById('batchList'),
  progress: document.getElementById('batchProgress'),
  progressText: document.getElementById('batchProgressText'),
  progressPercent: document.getElementById('batchProgressPercent'),
  progressFill: document.getElementById('batchProgressFill'),
  stemEditor: document.getElementById('stemEditor'),
  // Tabs
  tabQueue: document.getElementById('tabQueue'),
  tabMeta: document.getElementById('tabMeta'),
  tabContentQueue: document.getElementById('batchTabQueue'),
  tabContentMeta: document.getElementById('batchTabMeta'),
  // Metadata
  metaFileList: document.getElementById('metaFileList'),
  metaEditor: document.getElementById('metaEditor'),
  metaEmpty: document.getElementById('metaEmpty'),
  metaForm: document.getElementById('metaForm'),
  metaFormTitle: document.getElementById('metaFormTitle'),
  metaTitle: document.getElementById('metaTitle'),
  metaArtist: document.getElementById('metaArtist'),
  metaAlbum: document.getElementById('metaAlbum'),
  metaGenre: document.getElementById('metaGenre'),
  metaYear: document.getElementById('metaYear'),
  metaTrack: document.getElementById('metaTrack'),
  metaComment: document.getElementById('metaComment'),
  metaApplyAll: document.getElementById('metaApplyAll')
};

// ─── Batch Tabs ─────────────────────────────────────────────────────────────
batchDom.tabQueue.addEventListener('click', () => {
  batchDom.tabQueue.classList.add('active');
  batchDom.tabMeta.classList.remove('active');
  batchDom.tabQueue.setAttribute('aria-selected', 'true');
  batchDom.tabMeta.setAttribute('aria-selected', 'false');
  batchDom.tabContentQueue.classList.remove('hidden');
  batchDom.tabContentMeta.classList.add('hidden');
});

batchDom.tabMeta.addEventListener('click', () => {
  batchDom.tabMeta.classList.add('active');
  batchDom.tabQueue.classList.remove('active');
  batchDom.tabMeta.setAttribute('aria-selected', 'true');
  batchDom.tabQueue.setAttribute('aria-selected', 'false');
  batchDom.tabContentMeta.classList.remove('hidden');
  batchDom.tabContentQueue.classList.add('hidden');
  renderMetaFileList();
});

// ─── Metadata Editor ────────────────────────────────────────────────────────
let metaSelectedIndex = -1;

function getItemMeta(item) {
  if (!item.metadata) {
    item.metadata = { title: '', artist: '', album: '', genre: '', year: '', track: '', comment: '' };
  }
  return item.metadata;
}

function hasAnyMeta(item) {
  if (!item.metadata) return false;
  return Object.values(item.metadata).some(v => v && v.trim());
}

function renderMetaFileList() {
  batchDom.metaFileList.innerHTML = '';

  if (batchState.queue.length === 0) {
    batchDom.metaEmpty.classList.remove('hidden');
    batchDom.metaForm.classList.add('hidden');
    return;
  }

  batchState.queue.forEach((item, index) => {
    const el = document.createElement('div');
    el.className = 'meta-file-item' + (index === metaSelectedIndex ? ' selected' : '') + (hasAnyMeta(item) ? ' has-meta' : '');
    el.setAttribute('role', 'option');
    el.setAttribute('aria-selected', index === metaSelectedIndex ? 'true' : 'false');
    el.innerHTML = `<span class="meta-dot"></span>${item.name}`;
    el.addEventListener('click', () => selectMetaFile(index));
    batchDom.metaFileList.appendChild(el);
  });

  if (metaSelectedIndex >= 0 && metaSelectedIndex < batchState.queue.length) {
    loadMetaForm(metaSelectedIndex);
  } else {
    batchDom.metaEmpty.classList.remove('hidden');
    batchDom.metaForm.classList.add('hidden');
  }
}

function selectMetaFile(index) {
  // Save current before switching
  if (metaSelectedIndex >= 0 && metaSelectedIndex < batchState.queue.length) {
    saveMetaForm(metaSelectedIndex);
  }
  metaSelectedIndex = index;
  renderMetaFileList();
}

function loadMetaForm(index) {
  const item = batchState.queue[index];
  const meta = getItemMeta(item);

  batchDom.metaEmpty.classList.add('hidden');
  batchDom.metaForm.classList.remove('hidden');
  batchDom.metaFormTitle.textContent = item.name;

  batchDom.metaTitle.value = meta.title || '';
  batchDom.metaArtist.value = meta.artist || '';
  batchDom.metaAlbum.value = meta.album || '';
  batchDom.metaGenre.value = meta.genre || '';
  batchDom.metaYear.value = meta.year || '';
  batchDom.metaTrack.value = meta.track || '';
  batchDom.metaComment.value = meta.comment || '';
}

function saveMetaForm(index) {
  const item = batchState.queue[index];
  if (!item) return;
  const meta = getItemMeta(item);
  meta.title = batchDom.metaTitle.value;
  meta.artist = batchDom.metaArtist.value;
  meta.album = batchDom.metaAlbum.value;
  meta.genre = batchDom.metaGenre.value;
  meta.year = batchDom.metaYear.value;
  meta.track = batchDom.metaTrack.value;
  meta.comment = batchDom.metaComment.value;
}

// Auto-save on input
[batchDom.metaTitle, batchDom.metaArtist, batchDom.metaAlbum, batchDom.metaGenre,
 batchDom.metaYear, batchDom.metaTrack, batchDom.metaComment].forEach(input => {
  input.addEventListener('input', () => {
    if (metaSelectedIndex >= 0) saveMetaForm(metaSelectedIndex);
  });
});

// Apply to All button
batchDom.metaApplyAll.addEventListener('click', () => {
  if (metaSelectedIndex < 0) return;
  saveMetaForm(metaSelectedIndex);
  const source = batchState.queue[metaSelectedIndex].metadata;
  batchState.queue.forEach((item, i) => {
    if (i === metaSelectedIndex) return;
    item.metadata = { ...source };
  });
  renderMetaFileList();
});

function updateBatchButtons() {
  const hasItems = batchState.queue.length > 0;
  batchDom.clearBtn.disabled = !hasItems || batchState.isProcessing;
  batchDom.exportBtn.disabled = !hasItems || batchState.isProcessing;
  batchDom.addBtn.disabled = batchState.isProcessing;
}

function ensureFileInQueue(filePath) {
  const alreadyQueued = batchState.queue.some(q => q.path === filePath);
  if (!alreadyQueued) {
    const name = filePath.split(/[\\/]/).pop();
    batchState.queue.push({ path: filePath, name, status: 'pending' });
    updateBatchButtons();
  }
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  })[character]);
}

function getQueueStatus(item) {
  return {
    icon: item.status === 'done' ? '✓' : item.status === 'error' ? '✗' : item.status === 'processing' ? '⏳' : item.type === 'stem-song' ? '🎛️' : '🎵',
    text: item.status === 'done' ? 'Done' : item.status === 'error' ? 'Error' : item.status === 'processing' ? 'Processing...' : 'Pending',
    className: item.status === 'pending' ? '' : item.status
  };
}

function updateSelectedStemMeters(stem) {
  const meter = batchDom.stemEditor.querySelector('[data-stem-gr-meter]');
  if (!meter || meter.dataset.stemName !== stem.name) return;
  const reduction = Math.max(0, stem.compressionReductionDb || 0);
  const maximum = Math.max(1, stem.settings.compressorMaxReduction || 6);
  meter.querySelector('.stem-gr-fill').style.width = `${Math.min(100, reduction / maximum * 100)}%`;
  meter.querySelector('output').textContent = `-${reduction.toFixed(1)} dB`;
  const adaptive = meter.querySelector('.stem-adaptive-meter');
  if (adaptive) {
    const dynamic = Math.max(0, ...(stem.dynamicReductionDb || [0]));
    const deEsser = Math.max(0, stem.deEsserReductionDb || 0);
    adaptive.textContent = `Dynamic EQ ${dynamic.toFixed(1)} dB • De-esser ${deEsser.toFixed(1)} dB`;
  }
}

function renderStemEditor() {
  const song = batchState.queue.find(item => item.type === 'stem-song' && item.selectedStemIndex >= 0);
  if (!song || !song.stems[song.selectedStemIndex]) {
    batchDom.stemEditor.classList.add('hidden');
    batchDom.stemEditor.innerHTML = '';
    return;
  }

  const stem = song.stems[song.selectedStemIndex];
  const settings = stem.settings;
  const toggle = (key, label, tip) => `
    <label class="stem-editor-toggle" title="${tip}">
      <input type="checkbox" data-stem-editor-setting="${key}" ${settings[key] ? 'checked' : ''}>
      <span>${label}</span>
    </label>`;
  const slider = (key, label, min, max, step, suffix = ' dB') => `
    <label class="stem-editor-slider">
      <span>${label}</span>
      <input type="range" min="${min}" max="${max}" step="${step}" value="${settings[key]}" data-stem-editor-setting="${key}">
      <output>${settings[key]}${suffix}</output>
    </label>`;

  batchDom.stemEditor.classList.remove('hidden');
  batchDom.stemEditor.innerHTML = `
    <div class="stem-editor-header">
      <div><strong>${escapeHTML(stem.name)}</strong><span>Pre-master stem processing</span></div>
      <div class="stem-editor-actions">
        <button class="btn-batch" data-stem-editor-action="reset">Reset</button>
        <button class="stem-editor-close" data-stem-editor-action="close" aria-label="Close stem editor">✕</button>
      </div>
    </div>
    <div class="stem-editor-mixer">
      ${slider('gainDb', 'Gain', -24, 12, 0.1)}
      ${slider('pan', 'Pan', -100, 100, 1, '')}
      ${slider('width', 'Width', 0, 200, 1, '%')}
    </div>
    <div class="stem-editor-toggles">
      ${toggle('cleanLowEnd', 'Clean Low End', 'High-pass this stem below 30Hz.')}
      ${toggle('cutMud', 'Cut Mud', 'Reduce 250Hz buildup on this stem.')}
      ${toggle('addAir', 'Add Air', 'Add a 12kHz shelf to this stem.')}
      ${toggle('tameHarsh', 'Tame Harshness', 'Reduce harsh 4–6kHz energy on this stem.')}
    </div>
    <div class="stem-editor-section-title">Stem EQ</div>
    <div class="stem-editor-eq">
      ${slider('eqLow', '80Hz', -12, 12, 1)}
      ${slider('eqLowMid', '250Hz', -12, 12, 1)}
      ${slider('eqMid', '1kHz', -12, 12, 1)}
      ${slider('eqHighMid', '4kHz', -12, 12, 1)}
      ${slider('eqHigh', '12kHz', -12, 12, 1)}
    </div>
    <div class="stem-editor-section-title">Adaptive Control</div>
    <div class="stem-editor-toggles">
      ${toggle('dynamicEq', '3-Band Dynamic EQ', 'React only when boom, boxiness, or harshness exceeds conservative thresholds.')}
      ${toggle('deEsser', 'Vocal De-Esser', 'Stereo-linked control focused on vocal sibilance.')}
      ${toggle('deEsserAudition', 'Audition Removed S', 'Monitor only the de-esser reduction signal. This is never included in exports.')}
    </div>
    <div class="stem-editor-dynamics">
      ${slider('dynamicEqAmount', 'Dynamic Amount', 0, 100, 1, '%')}
      ${slider('deEsserFrequency', 'De-ess Focus', 4000, 10000, 100, ' Hz')}
      ${slider('deEsserRange', 'De-ess Range', 1, 10, 0.5)}
      ${slider('deEsserAttack', 'De-ess Attack', 1, 30, 1, ' ms')}
      ${slider('deEsserRelease', 'De-ess Release', 30, 300, 5, ' ms')}
    </div>
    <div class="stem-editor-section-title">Stem Compression</div>
    <div class="stem-compression-heading">
      ${toggle('glueCompression', 'Enable Compression', 'Range-limited, stereo-linked compression before the song master bus.')}
      <div class="stem-preset-buttons" role="group" aria-label="Stem compression presets">
        ${Object.keys(STEM_COMPRESSION_PRESETS).map(name => `<button class="stem-preset-btn${settings.compressionPreset === name ? ' active' : ''}" data-stem-compression-preset="${name}">${name[0].toUpperCase() + name.slice(1)}</button>`).join('')}
      </div>
    </div>
    <div class="stem-editor-dynamics stem-compressor-controls">
      ${slider('compressorThreshold', 'Threshold', -48, 0, 1)}
      ${slider('compressorRatio', 'Ratio', 1, 20, 0.5, ':1')}
      ${slider('compressorAttack', 'Attack', 1, 200, 1, ' ms')}
      ${slider('compressorRelease', 'Release', 20, 1000, 5, ' ms')}
      ${slider('compressorKnee', 'Knee', 0, 24, 1)}
      ${slider('compressorMaxReduction', 'Max GR', 1, 12, 0.5)}
      ${slider('compressorMix', 'Mix', 0, 100, 1, '%')}
      ${slider('compressorMakeup', 'Makeup', -6, 6, 0.5)}
    </div>
    <div class="stem-gr-meter" data-stem-gr-meter data-stem-name="${escapeHTML(stem.name)}">
      <span>Gain Reduction</span><div class="stem-gr-track"><div class="stem-gr-fill"></div></div><output>-${(stem.compressionReductionDb || 0).toFixed(1)} dB</output>
      <span class="stem-adaptive-meter">Dynamic EQ ${Math.max(0, ...(stem.dynamicReductionDb || [0])).toFixed(1)} dB • De-esser ${(stem.deEsserReductionDb || 0).toFixed(1)} dB</span>
    </div>
    <div class="stem-editor-section-title">Stem Restoration</div>
    <div class="stem-editor-toggles">
      ${toggle('repairEdgeArtifacts', 'Repair Edges', 'Repair detected boundary clicks or bursts on this stem.')}
      ${toggle('repairPrematureEnding', 'Repair Cutoff', 'Apply a clean release only if this stem ends abruptly.')}
      ${toggle('repairVocalCrackle', 'Repair Crackle', 'Repair detected impulses in quiet passages of this stem.')}
    </div>
    <p class="stem-editor-note">Loudness normalization, true-peak limiting, and export format remain at song level.</p>
  `;

  batchDom.stemEditor.querySelectorAll('[data-stem-editor-setting]').forEach(input => {
    const eventName = input.type === 'checkbox' ? 'change' : 'input';
    input.addEventListener(eventName, () => {
      const key = input.dataset.stemEditorSetting;
      stem.settings[key] = input.type === 'checkbox' ? input.checked : parseFloat(input.value);
      const output = input.parentElement.querySelector('output');
      if (output) {
        const suffix = ['width', 'dynamicEqAmount', 'compressorMix'].includes(key) ? '%'
          : key === 'pan' ? ''
            : key === 'compressorRatio' ? ':1'
              : ['compressorAttack', 'compressorRelease', 'deEsserAttack', 'deEsserRelease'].includes(key) ? ' ms'
                : key === 'deEsserFrequency' ? ' Hz' : ' dB';
        output.textContent = `${input.value}${suffix}`;
      }
      updateLiveStemSettings(song);
      scheduleStemSongMix(song);
    });
  });

  batchDom.stemEditor.querySelectorAll('[data-stem-compression-preset]').forEach(button => {
    button.addEventListener('click', () => {
      stem.settings = applyStemCompressionPreset(stem.settings, button.dataset.stemCompressionPreset);
      updateLiveStemSettings(song);
      renderStemEditor();
      scheduleStemSongMix(song);
    });
  });

  batchDom.stemEditor.querySelector('[data-stem-editor-action="close"]').addEventListener('click', () => {
    song.selectedStemIndex = -1;
    renderBatchList();
  });
  batchDom.stemEditor.querySelector('[data-stem-editor-action="reset"]').addEventListener('click', () => {
    const { mute, solo } = stem.settings;
    stem.settings = { ...createDefaultStemSettings(), mute, solo };
    updateLiveStemSettings(song);
    renderStemEditor();
    renderBatchList();
    scheduleStemSongMix(song);
  });
}

function renderBatchList() {
  batchDom.list.innerHTML = '';
  batchState.queue.forEach((item, index) => {
    if (item.type === 'stem-song') {
      const group = document.createElement('div');
      group.className = 'batch-song-group';
      group.setAttribute('role', 'listitem');
      const isLoaded = state.file.path === item.path;
      const status = getQueueStatus(item);
      group.innerHTML = `
        <div class="batch-item batch-song-item${isLoaded ? ' batch-item-loaded' : ''}">
          <button class="batch-song-expand" data-song-action="expand" data-index="${index}" aria-label="${item.expanded ? 'Collapse' : 'Expand'} ${escapeHTML(item.name)}">${item.expanded ? '▾' : '▸'}</button>
          <span class="batch-item-icon">${status.icon}</span>
          <span class="batch-item-name" title="${escapeHTML(item.name)}">${escapeHTML(item.name)}</span>
          <span class="stem-count-badge">${item.stems.length} stems</span>
          ${isLoaded ? '<span class="batch-item-playing">♦ Loaded mix</span>' : ''}
          ${!batchState.isProcessing ? `<button class="batch-item-preview" data-song-action="preview" data-index="${index}" aria-label="Play combined song ${escapeHTML(item.name)}" title="Load combined song into player">▶ Mix</button>` : ''}
          <span class="batch-item-status ${status.className}">${status.text}</span>
          ${!batchState.isProcessing ? `<button class="batch-item-remove" data-song-action="remove" data-index="${index}" aria-label="Remove ${escapeHTML(item.name)} from queue">✕</button>` : ''}
        </div>`;

      if (item.expanded) {
        const children = document.createElement('div');
        children.className = 'stem-children';
        item.stems.forEach((stem, stemIndex) => {
          const child = document.createElement('div');
          child.className = `stem-row${item.selectedStemIndex === stemIndex ? ' selected' : ''}`;
          child.innerHTML = `
            <span class="stem-branch">└</span>
            <button class="stem-toggle${stem.settings.mute ? ' active mute' : ''}" data-stem-action="mute" data-index="${index}" data-stem-index="${stemIndex}" title="Mute stem">M</button>
            <button class="stem-toggle${stem.settings.solo ? ' active solo' : ''}" data-stem-action="solo" data-index="${index}" data-stem-index="${stemIndex}" title="Solo stem">S</button>
            <span class="stem-row-name" title="${escapeHTML(stem.name)}">${escapeHTML(stem.name.replace(/^\d+\s+/, ''))}</span>
            <label class="stem-inline-control" title="Stem gain"><span>Gain</span><input type="range" min="-24" max="12" step="0.5" value="${stem.settings.gainDb}" data-stem-setting="gainDb" data-index="${index}" data-stem-index="${stemIndex}"><output>${stem.settings.gainDb} dB</output></label>
            <label class="stem-inline-control" title="Stem pan"><span>Pan</span><input type="range" min="-100" max="100" step="1" value="${stem.settings.pan}" data-stem-setting="pan" data-index="${index}" data-stem-index="${stemIndex}"><output>${stem.settings.pan}</output></label>
            <button class="stem-edit" data-stem-action="edit" data-index="${index}" data-stem-index="${stemIndex}">Edit</button>`;
          children.appendChild(child);
        });
        group.appendChild(children);
      }
      batchDom.list.appendChild(group);
      return;
    }

    const el = document.createElement('div');
    const isLoaded = state.file.path === item.path;
    el.className = 'batch-item' + (isLoaded ? ' batch-item-loaded' : '');
    el.setAttribute('role', 'listitem');
    const status = getQueueStatus(item);

    el.innerHTML = `
      <span class="batch-item-icon">${status.icon}</span>
      <span class="batch-item-name" title="${escapeHTML(item.name)}">${escapeHTML(item.name)}</span>
      ${isLoaded ? '<span class="batch-item-playing">♦ Loaded</span>' : ''}
      ${!batchState.isProcessing ? `<button class="batch-item-preview" data-index="${index}" aria-label="Preview ${escapeHTML(item.name)} in player" title="Load into player">▶</button>` : ''}
      <span class="batch-item-status ${status.className}">${status.text}</span>
      ${!batchState.isProcessing ? `<button class="batch-item-remove" data-index="${index}" aria-label="Remove ${escapeHTML(item.name)} from queue">✕</button>` : ''}
    `;
    batchDom.list.appendChild(el);
  });

  batchDom.list.querySelectorAll('[data-song-action]').forEach(button => {
    button.addEventListener('click', async () => {
      const index = parseInt(button.dataset.index);
      const song = batchState.queue[index];
      if (!song) return;
      if (button.dataset.songAction === 'expand') {
        song.expanded = !song.expanded;
        renderBatchList();
      } else if (button.dataset.songAction === 'preview') {
        await loadStemSong(song);
      } else if (button.dataset.songAction === 'remove') {
        batchState.queue.splice(index, 1);
        renderBatchList();
        renderMetaFileList();
        updateBatchButtons();
      }
    });
  });

  batchDom.list.querySelectorAll('[data-stem-action]').forEach(button => {
    button.addEventListener('click', () => {
      const song = batchState.queue[parseInt(button.dataset.index)];
      const stemIndex = parseInt(button.dataset.stemIndex);
      if (!song?.stems[stemIndex]) return;
      if (button.dataset.stemAction === 'edit') {
        batchState.queue.forEach(item => { if (item.type === 'stem-song' && item !== song) item.selectedStemIndex = -1; });
        song.selectedStemIndex = stemIndex;
      } else {
        const key = button.dataset.stemAction;
        song.stems[stemIndex].settings[key] = !song.stems[stemIndex].settings[key];
        updateLiveStemSettings(song);
        scheduleStemSongMix(song);
      }
      renderBatchList();
    });
  });

  batchDom.list.querySelectorAll('[data-stem-setting]').forEach(input => {
    input.addEventListener('input', () => {
      const song = batchState.queue[parseInt(input.dataset.index)];
      const stem = song?.stems[parseInt(input.dataset.stemIndex)];
      if (!stem) return;
      stem.settings[input.dataset.stemSetting] = parseFloat(input.value);
      const output = input.parentElement.querySelector('output');
      output.textContent = input.dataset.stemSetting === 'gainDb' ? `${input.value} dB` : input.value;
      updateLiveStemSettings(song);
      scheduleStemSongMix(song);
    });
  });

  // Attach preview handlers
  batchDom.list.querySelectorAll('.batch-item-preview:not([data-song-action])').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.index);
      const item = batchState.queue[idx];
      if (item) {
        stopAudio();
        state.playback.pauseTime = 0;
        await loadFile(item.path);
        renderBatchList();
      }
    });
  });

  // Attach remove handlers
  batchDom.list.querySelectorAll('.batch-item-remove:not([data-song-action])').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.index);
      batchState.queue.splice(idx, 1);
      if (metaSelectedIndex >= batchState.queue.length) metaSelectedIndex = -1;
      renderBatchList();
      updateBatchButtons();
    });
  });
  renderStemEditor();
}

async function addFilesToBatch(filePaths) {
  const expandedPaths = [];
  let importedArchives = 0;
  try {
    for (const filePath of filePaths) {
      if (SUNO_STEMS_ARCHIVE_PATTERN.test(filePath)) {
        await importSunoStemsArchive(filePath, false);
        importedArchives++;
      } else if (AUDIO_FILE_PATTERN.test(filePath)) {
        expandedPaths.push(filePath);
      }
    }
  } catch (error) {
    console.error('Error importing Suno stems for batch:', error);
    showFileStatus(`✗ Could not import Suno stems: ${error.message}`, 'error');
    return;
  }

  const existing = new Set(batchState.queue.map(q => q.path));
  for (const fp of expandedPaths) {
    if (existing.has(fp)) continue;
    const name = fp.split(/[\\/]/).pop();
    batchState.queue.push({ path: fp, name, status: 'pending' });
    existing.add(fp);
  }
  renderBatchList();
  updateBatchButtons();

  if (importedArchives) {
    showFileStatus(`✓ Added stems from ${importedArchives} Suno ZIP archive${importedArchives === 1 ? '' : 's'} to the batch queue.`, 'success');
  }
}

batchDom.addBtn.addEventListener('click', async () => {
  const files = await window.electronAPI.selectFiles();
  if (files.length) await addFilesToBatch(files);
});

batchDom.clearBtn.addEventListener('click', () => {
  batchState.queue = [];
  metaSelectedIndex = -1;
  renderBatchList();
  updateBatchButtons();
  renderMetaFileList();
});

batchDom.dropZone.addEventListener('click', async () => {
  const files = await window.electronAPI.selectFiles();
  if (files.length) await addFilesToBatch(files);
});

batchDom.dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  batchDom.dropZone.classList.add('drag-over');
});

batchDom.dropZone.addEventListener('dragleave', () => {
  batchDom.dropZone.classList.remove('drag-over');
});

batchDom.dropZone.addEventListener('drop', async (e) => {
  e.preventDefault();
  batchDom.dropZone.classList.remove('drag-over');
  const files = [...e.dataTransfer.files].filter(f => AUDIO_FILE_PATTERN.test(f.name) || SUNO_STEMS_ARCHIVE_PATTERN.test(f.name));
  const paths = files.map(f => window.electronAPI.getPathForFile(f)).filter(Boolean);
  if (paths.length) await addFilesToBatch(paths);
});

[dom.dynamicEqAmount, dom.deEsserFrequency, dom.deEsserRange,
 dom.deEsserAttack, dom.deEsserRelease].forEach(slider => {
  slider.addEventListener('mousedown', () => pushUndo());
  slider.addEventListener('input', () => {
    updateAdaptiveDynamicsDisplays();
    updateAudioChain();
    saveSettingsToStorage();
  });
});

// Helper: yield to the event loop so the UI can repaint
function yieldToUI() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// Write WAV data in chunks to avoid blocking the main thread on large files
async function writeFileChunked(outputPath, wavBuffer) {
  const CHUNK = 2 * 1024 * 1024; // 2 MB per chunk
  const full = new Uint8Array(wavBuffer);
  if (full.length <= CHUNK) {
    await window.electronAPI.writeFile(outputPath, Array.from(full));
    return;
  }
  // For large files, still send as one call but yield before/after to keep UI alive
  await yieldToUI();
  await window.electronAPI.writeFile(outputPath, Array.from(full));
  await yieldToUI();
}

batchDom.exportBtn.addEventListener('click', async () => {
  if (batchState.queue.length === 0 || batchState.isProcessing) return;

  const outputDir = await window.electronAPI.selectDirectory();
  if (!outputDir) return;

  batchState.isProcessing = true;
  updateBatchButtons();
  batchDom.progress.classList.remove('hidden');

  const settings = validateSettings({
    normalizeLoudness: dom.normalizeLoudness.checked,
    truePeakLimit: dom.truePeakLimit.checked,
    truePeakCeiling: parseFloat(dom.truePeakSlider.value),
    targetLufs: dom.targetLufs ? parseInt(dom.targetLufs.value) : -14,
    inputGain: dom.inputGain ? parseFloat(dom.inputGain.value) : 0,
    stereoWidth: dom.stereoWidth ? parseInt(dom.stereoWidth.value) : 100,
    cleanLowEnd: dom.cleanLowEnd.checked,
    glueCompression: dom.glueCompression.checked,
    centerBass: dom.centerBass.checked,
    cutMud: dom.cutMud.checked,
    addAir: dom.addAir.checked,
    tameHarsh: dom.tameHarsh.checked,
    dynamicEq: dom.dynamicEq.checked,
    dynamicEqAmount: parseInt(dom.dynamicEqAmount.value),
    deEsser: dom.deEsser.checked,
    deEsserFrequency: parseInt(dom.deEsserFrequency.value),
    deEsserRange: parseFloat(dom.deEsserRange.value),
    deEsserAttack: parseFloat(dom.deEsserAttack.value),
    deEsserRelease: parseFloat(dom.deEsserRelease.value),
    deEsserAudition: false,
    repairEdgeArtifacts: dom.repairEdgeArtifacts.checked,
    repairPrematureEnding: dom.repairPrematureEnding.checked,
    repairVocalCrackle: dom.repairVocalCrackle.checked,
    sampleRate: parseInt(dom.sampleRate.value),
    bitDepth: parseInt(dom.bitDepth.value),
    eqLow: parseFloat(dom.eqLow.value),
    eqLowMid: parseFloat(dom.eqLowMid.value),
    eqMid: parseFloat(dom.eqMid.value),
    eqHighMid: parseFloat(dom.eqHighMid.value),
    eqHigh: parseFloat(dom.eqHigh.value)
  });

  const total = batchState.queue.length;
  let completed = 0;
  let errors = 0;
  let qcWarnings = 0;

  for (let i = 0; i < total; i++) {
    const item = batchState.queue[i];
    item.status = 'processing';
    renderBatchList();
    batchDom.progressText.textContent = `Processing ${i + 1}/${total}: ${item.name}`;

    // Yield so the UI updates before heavy work
    await yieldToUI();

    try {
      let audioBuffer;
      if (item.type === 'stem-song') {
        audioBuffer = await renderStemSongMix(item, settings.sampleRate, false);
      } else {
        const ctx = new AudioContext();
        audioBuffer = await decodeAudioPath(item.path, ctx);
        await ctx.close();
      }
      await yieldToUI();

      const processedBuffer = await processAudioOffline(settings, audioBuffer);
      const masteringReport = masteringReports.get(processedBuffer);
      if (masteringReport && !masteringReport.verification.passed) {
        throw new Error(`Mastering QC failed: ${masteringReport.verification.warnings.join('; ')}`);
      }
      item.qc = formatMasteringQc(masteringReport);
      if (masteringReport?.verification?.warnings.length) qcWarnings++;
      await yieldToUI();

      const wavBuffer = encodeWAV(processedBuffer, {
        bitDepth: settings.bitDepth,
        dither: settings.bitDepth === 16,
        metadata: item.metadata || null
      });

      // Build output path
      const baseName = item.name.replace(/\.[^.]+$/, '');
      const outputPath = await window.electronAPI.getBatchOutputPath(outputDir, baseName);

      await writeFileChunked(outputPath, wavBuffer);

      item.status = 'done';
      completed++;
    } catch (err) {
      console.error(`Batch error for ${item.name}:`, err);
      item.status = 'error';
      errors++;
    }

    const percent = Math.round(((i + 1) / total) * 100);
    batchDom.progressFill.style.width = `${percent}%`;
    batchDom.progressPercent.textContent = `${percent}%`;
    renderBatchList();

    // Yield between files
    await yieldToUI();
  }

  batchState.isProcessing = false;
  updateBatchButtons();

  batchDom.progressText.textContent = `Done! ${completed} exported${errors ? `, ${errors} failed` : ''}${qcWarnings ? `, ${qcWarnings} QC warnings` : ''}`;

  dom.statusMessage.textContent = `${qcWarnings ? '⚠' : '✓'} Batch complete: ${completed}/${total} files exported${qcWarnings ? ` with ${qcWarnings} QC warning${qcWarnings === 1 ? '' : 's'}` : ''}.`;
  dom.statusMessage.className = `status-message ${qcWarnings ? 'warning' : 'success'} visible`;
  setTimeout(() => dom.statusMessage.classList.remove('visible'), 5000);

  setTimeout(() => {
    batchDom.progress.classList.add('hidden');
    batchDom.progressFill.style.width = '0%';
    batchDom.progressPercent.textContent = '0%';
  }, 3000);
});

// ─── Initialization ─────────────────────────────────────────────────────────
loadSettingsFromStorage();
updateChecklist();
updateEQ();
refreshFaderFills();
