import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MONO_BASS_FREQUENCY,
  configureMasteringNodes,
  connectMasteringGraph,
  createMasteringNodes
} from '../src/masteringEngine.js';

function parameter(value = 0) {
  return { value };
}

class FakeNode {
  constructor(kind) {
    this.kind = kind;
    this.connections = [];
    this.gain = kind === 'gain' ? parameter(1) : (kind === 'filter' ? parameter(0) : undefined);
    this.frequency = kind === 'filter' ? parameter(0) : undefined;
    this.Q = kind === 'filter' ? parameter(1) : undefined;
    this.threshold = kind === 'compressor' ? parameter(0) : undefined;
    this.knee = kind === 'compressor' ? parameter(0) : undefined;
    this.ratio = kind === 'compressor' ? parameter(1) : undefined;
    this.attack = kind === 'compressor' ? parameter(0) : undefined;
    this.release = kind === 'compressor' ? parameter(0) : undefined;
  }

  connect(destination) {
    this.connections.push(destination);
    return destination;
  }
}

function fakeContext() {
  return {
    createGain: () => new FakeNode('gain'),
    createBiquadFilter: () => new FakeNode('filter'),
    createDynamicsCompressor: () => new FakeNode('compressor'),
    createChannelSplitter: () => new FakeNode('splitter'),
    createChannelMerger: () => new FakeNode('merger')
  };
}

test('mono bass removes side energy below the configured crossover', () => {
  const context = fakeContext();
  const nodes = createMasteringNodes(context, new FakeNode('gain'), { glueCompression: false });
  configureMasteringNodes(nodes, { centerBass: true, truePeakLimit: false });
  assert.equal(nodes.sideBassHighpass1.frequency.value, MONO_BASS_FREQUENCY);
  assert.equal(nodes.sideBassHighpass2.frequency.value, MONO_BASS_FREQUENCY);
  configureMasteringNodes(nodes, { centerBass: false, truePeakLimit: false });
  assert.equal(nodes.sideBassHighpass1.frequency.value, 1);
  assert.equal(nodes.sideBassHighpass2.frequency.value, 1);
});

test('width and mono bass precede normalization and final limiting', () => {
  const context = fakeContext();
  const limiter = new FakeNode('gain');
  const nodes = createMasteringNodes(context, limiter, { glueCompression: false });
  connectMasteringGraph(new FakeNode('source'), nodes);
  assert.equal(nodes.stereoMerger.connections[0], nodes.normGain);
  assert.equal(nodes.normGain.connections[0], limiter);
  assert.equal(limiter.connections[0], nodes.gain);
  assert.equal(nodes.sideGain.connections[0], nodes.sideBassHighpass1);
});

test('disabled glue uses a latency-free gain bypass', () => {
  const context = fakeContext();
  const nodes = createMasteringNodes(context, new FakeNode('gain'), { glueCompression: false });
  assert.equal(nodes.compressor.kind, 'gain');
});
