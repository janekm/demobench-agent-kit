// Browser output for SPU-produced stereo PCM. It never generates guest audio.
export class PcmAudioPlayer {
  constructor(onMetrics = () => {}) {
    this.onMetrics = onMetrics;
    this.context = null;
    this.node = null;
    this.gain = null;
    this.enabled = false;
    this.available = false;
    this.playing = false;
    this.accepting = true;
    this.epoch = null;
    this.volume = 0.5;
    this.pendingFrames = 0;
    this.pendingPackets = new Map();
    this.nextPacketId = 1;
    this.mainDroppedFrames = 0;
    this.stats = { queuedFrames: 0, underruns: 0, playedFrames: 0, droppedFrames: 0, peak: 0 };
    this.nodeReady = null;
  }

  metrics() {
    return { enabled: this.enabled, epoch: this.epoch, volume: this.volume,
      outputRate: this.context?.sampleRate ?? null, contextState: this.context?.state ?? null, ...this.stats,
      droppedFrames: this.stats.droppedFrames + this.mainDroppedFrames };
  }

  publish() { this.onMetrics(this.metrics()); }

  setVolume(volume) {
    this.volume = Math.min(1, Math.max(0, Number(volume) || 0));
    if (this.gain) this.gain.gain.setTargetAtTime(this.enabled && this.playing && this.accepting ? this.volume : 0, this.context.currentTime, 0.01);
    this.publish();
  }

  setAvailable(available) {
    this.available = !!available;
    if (!this.available && this.enabled) this.disable();
  }

  setPlaying(playing) {
    const next = !!playing;
    if (this.playing === next) return;
    this.playing = next;
    if (!next) this.invalidate();
    this.node?.port.postMessage({ type: 'active', active: this.enabled && next && this.accepting });
    if (next && this.enabled && this.accepting && this.gain) this.gain.gain.setTargetAtTime(this.volume, this.context.currentTime, 0.01);
  }

  invalidate() {
    this.accepting = false;
    if (this.gain) this.gain.gain.setValueAtTime(0, this.context.currentTime);
    this.epoch = null;
    this.pendingFrames = 0;
    this.pendingPackets.clear();
    this.mainDroppedFrames = 0;
    this.stats = { queuedFrames: 0, underruns: 0, playedFrames: 0, droppedFrames: 0, peak: 0 };
    this.node?.port.postMessage({ type: 'reset', epoch: null });
    this.publish();
  }

  reset(epoch) {
    if (!Number.isSafeInteger(epoch) || epoch < 0) return;
    this.epoch = epoch;
    this.accepting = true;
    this.pendingFrames = 0;
    this.pendingPackets.clear();
    this.mainDroppedFrames = 0;
    this.stats = { queuedFrames: 0, underruns: 0, playedFrames: 0, droppedFrames: 0, peak: 0 };
    this.node?.port.postMessage({ type: 'reset', epoch });
    this.node?.port.postMessage({ type: 'active', active: this.enabled && this.playing });
    this.publish();
  }

  push(samples, rate, epoch) {
    if (!this.enabled || !this.available || !this.playing || !this.accepting || rate !== 48000 || !(samples instanceof Float32Array) || samples.length % 2) return false;
    if (!Number.isSafeInteger(epoch) || epoch < 0) return false;
    if (this.epoch === null) this.reset(epoch);
    if (epoch !== this.epoch || !this.node || (this.context && this.context.state !== 'running')) return false;
    const frames = samples.length / 2;
    if (this.stats.queuedFrames + this.pendingFrames + frames > 7200) {
      this.mainDroppedFrames += frames;
      this.publish();
      return false;
    }
    const copy = samples.slice();
    const packetId = this.nextPacketId++;
    this.pendingFrames += frames;
    this.pendingPackets.set(packetId, frames);
    this.node.port.postMessage({ type: 'push', epoch, packetId, samples: copy }, [copy.buffer]);
    return true;
  }

  // Creates the output context once; before a user gesture it stays suspended until resumed.
  ensureContext() {
    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextClass || !globalThis.AudioWorkletNode) throw new Error('AudioWorklet playback is unavailable in this browser.');
    if (!this.context) {
      this.context = new AudioContextClass({ latencyHint: 'interactive' });
      this.context.onstatechange = () => {
        if (this.context.state !== 'running' && this.enabled) this.disable();
        this.publish();
      };
    }
    return this.context;
  }

  // Loads the worklet and builds the output graph once; concurrent callers share the same promise.
  ensureNode() {
    this.nodeReady ??= this.context.audioWorklet.addModule(new URL('./audio-worklet.js', import.meta.url)).then(() => {
      this.node = new globalThis.AudioWorkletNode(this.context, 'db32-pcm-output', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
      });
      this.gain = this.context.createGain();
      this.gain.gain.value = 0;
      this.node.connect(this.gain);
      this.gain.connect(this.context.destination);
      this.node.port.onmessage = ({ data }) => {
        if (data?.epoch !== this.epoch) return;
        if (data.type === 'ack') {
          const frames = this.pendingPackets.get(data.packetId);
          if (frames !== undefined) {
            this.pendingFrames = Math.max(0, this.pendingFrames - frames);
            this.pendingPackets.delete(data.packetId);
          }
          return;
        }
        if (data.type !== 'stats') return;
        if (this.enabled && this.playing && this.accepting) this.gain.gain.setTargetAtTime(this.volume, this.context.currentTime, 0.01);
        this.stats = { queuedFrames: this.enabled ? data.queuedFrames : 0, underruns: data.underruns,
          playedFrames: data.playedFrames, droppedFrames: data.droppedFrames, peak: this.enabled ? data.peak : 0 };
        this.publish();
      };
      this.node.port.postMessage({ type: 'reset', epoch: this.epoch });
    }, (error) => { this.nodeReady = null; throw error; });
    return this.nodeReady;
  }

  // Optional warm-up before any gesture, so a later enableFromGesture() only has to resume the context.
  async prepare() {
    this.ensureContext();
    await this.ensureNode();
  }

  async enableFromGesture() {
    if (!this.available) throw new Error('Load an SPU cartridge before enabling sound.');
    this.ensureContext();
    // Call resume in the button's user-activation stack, before awaiting module load.
    const resumed = this.context.resume();
    await Promise.all([resumed, this.ensureNode()]);
    this.enabled = true;
    this.gain.gain.setTargetAtTime(this.volume, this.context.currentTime, 0.01);
    this.node.port.postMessage({ type: 'active', active: this.playing && this.accepting });
    this.publish();
  }

  disable() {
    this.enabled = false;
    if (this.gain) this.gain.gain.setValueAtTime(0, this.context.currentTime);
    this.node?.port.postMessage({ type: 'active', active: false });
    this.pendingFrames = 0;
    this.pendingPackets.clear();
    this.stats = { ...this.stats, queuedFrames: 0, peak: 0 };
    this.publish();
  }
}
