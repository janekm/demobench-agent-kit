// PCM transport only. Guest SPU kernels produce every sample in the machine.
export class StereoPcmQueue {
  constructor(outputRate, capacityFrames = 7200, prebufferFrames = 2304) {
    if (!(outputRate > 0)) throw new Error('Invalid audio output rate');
    this.outputRate = outputRate;
    this.capacityFrames = capacityFrames;
    this.prebufferFrames = prebufferFrames;
    this.samples = new Float32Array(capacityFrames * 2);
    this.active = false;
    this.reset(null);
  }

  reset(epoch) {
    this.epoch = epoch;
    this.readIndex = 0;
    this.writeIndex = 0;
    this.queuedFrames = 0;
    this.fraction = 0;
    this.primed = false;
    this.underruns = 0;
    this.playedFrames = 0;
    this.droppedFrames = 0;
    this.peak = 0;
  }

  setActive(active) {
    this.active = !!active;
    if (!this.active) {
      this.readIndex = this.writeIndex;
      this.queuedFrames = 0;
      this.fraction = 0;
      this.primed = false;
      this.peak = 0;
    }
  }

  enqueue(samples, epoch) {
    if (!this.active || epoch !== this.epoch || !(samples instanceof Float32Array) || samples.length % 2) return false;
    const frames = samples.length / 2;
    if (frames > this.capacityFrames - this.queuedFrames) {
      this.droppedFrames += frames;
      return false;
    }
    for (let frame = 0; frame < frames; frame++) {
      const target = this.writeIndex * 2;
      this.samples[target] = Number.isFinite(samples[frame * 2]) ? samples[frame * 2] : 0;
      this.samples[target + 1] = Number.isFinite(samples[frame * 2 + 1]) ? samples[frame * 2 + 1] : 0;
      this.writeIndex = (this.writeIndex + 1) % this.capacityFrames;
    }
    this.queuedFrames += frames;
    return true;
  }

  render(left, right) {
    left.fill(0);
    right.fill(0);
    if (!this.active) return;
    const step = 48000 / this.outputRate;
    for (let i = 0; i < left.length; i++) {
      if (!this.primed && this.queuedFrames >= this.prebufferFrames) {
        this.primed = true;
      }
      if (!this.primed) continue;
      if (this.queuedFrames < 2 && !(this.queuedFrames === 1 && this.fraction === 0)) {
        this.primed = false;
        this.fraction = 0;
        this.underruns++;
        continue;
      }
      const a = this.readIndex * 2;
      const b = this.queuedFrames > 1 ? ((this.readIndex + 1) % this.capacityFrames) * 2 : a;
      const l = this.samples[a] + (this.samples[b] - this.samples[a]) * this.fraction;
      const r = this.samples[a + 1] + (this.samples[b + 1] - this.samples[a + 1]) * this.fraction;
      left[i] = l;
      right[i] = r;
      this.peak = Math.max(this.peak, Math.abs(l), Math.abs(r));
      this.playedFrames++;
      this.fraction += step;
      while (this.fraction >= 1 && this.queuedFrames > 0) {
        this.fraction -= 1;
        this.readIndex = (this.readIndex + 1) % this.capacityFrames;
        this.queuedFrames--;
      }
    }
  }

  metrics() {
    return { epoch: this.epoch, queuedFrames: this.queuedFrames, underruns: this.underruns,
      playedFrames: this.playedFrames, droppedFrames: this.droppedFrames, peak: this.peak };
  }
}

const ProcessorBase = globalThis.AudioWorkletProcessor || class { constructor() { this.port = { postMessage() {}, onmessage: null }; } };

class Db32PcmProcessor extends ProcessorBase {
  constructor() {
    super();
    this.queue = new StereoPcmQueue(globalThis.sampleRate || 48000);
    this.framesUntilReport = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'reset') this.queue.reset(data.epoch);
      else if (data.type === 'active') this.queue.setActive(data.active);
      else if (data.type === 'push') {
        this.queue.enqueue(data.samples, data.epoch);
        this.port.postMessage({ type: 'ack', epoch: data.epoch, packetId: data.packetId });
      }
      if (data.type !== 'push') this.port.postMessage({ type: 'stats', ...this.queue.metrics() });
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || !output[0] || !output[1]) return true;
    this.queue.render(output[0], output[1]);
    this.framesUntilReport -= output[0].length;
    if (this.framesUntilReport <= 0) {
      this.framesUntilReport = Math.max(1, Math.floor(this.queue.outputRate / 10));
      this.port.postMessage({ type: 'stats', ...this.queue.metrics() });
    }
    return true;
  }
}

if (typeof globalThis.registerProcessor === 'function') globalThis.registerProcessor('db32-pcm-output', Db32PcmProcessor);
