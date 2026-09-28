// CPU, assembly and video stay in WASM. Eligible guest GPU kernels can yield to
// the asynchronous WebGPU compiler/backend; published frames still come from video.
import { WebGpuBackend } from './gpu-webgpu.js';
const FRAME_TICKS = 204_800;
const FRAME_BYTES = 160 * 120 * 4;
const STATUS = ["empty", "running", "halted", "fault", "waiting"];
const GPU_STATUS = ["idle", "busy", "done", "fault"];
const PROFILE = { 1: "bootstrap-1", 2: "gpu-1", 3: "spu-1", 4: "dynamic-1" };

let wasm;
let memory;
let playing = false;
let timer = null;
let nextFrameAt = 0;
let activeCartridge = null;
let accelerator = null;
let unavailableReason = null;
let requestedBackend = 'auto';
let activeBackend = 'wasm';
let fallbackReason = null;
let dispatchMs = null;
let fps = null;
let fpsStart = 0;
let fpsFrames = 0;
let tasks = Promise.resolve();
let audioEpoch = 0;
let spuBackend = 'wasm';
let spuDispatchMs = null;
let spuReason = null;

function enqueue(task) {
  tasks = tasks.then(task).catch(error => {
    stop();
    self.postMessage({ type: 'error', message: error.message || String(error) });
    if (wasm) snapshot(false);
  });
}

function configureBackend() {
  activeBackend = requestedBackend !== 'wasm' && accelerator && !accelerator.lost && wasm.db_profile() >= 2 ? 'webgpu' : 'wasm';
  fallbackReason = requestedBackend === 'wasm' || wasm.db_profile() < 2 ? null : accelerator?.lost || unavailableReason;
  spuBackend = wasm.db_profile() >= 3 ? activeBackend : 'wasm';
  spuDispatchMs = null;
  spuReason = fallbackReason;
  dispatchMs = null;
  fps = null;
  fpsStart = performance.now();
  fpsFrames = 0;
  if (wasm.db_gpu_set_external(activeBackend === 'webgpu' ? 1 : 0) !== 0) throw new Error(machineError());
  if (wasm.db_spu_set_external(spuBackend === 'webgpu' ? 1 : 0) !== 0) throw new Error(machineError());
}

function ticks() {
  return (BigInt(wasm.db_ticks_hi() >>> 0) << 32n) | BigInt(wasm.db_ticks_lo() >>> 0);
}

async function runMachineFrame() {
  const end = ticks() + BigInt(FRAME_TICKS);
  let dispatches = 0;
  while (ticks() < end || wasm.db_gpu_external_pending() || wasm.db_spu_external_pending()) {
    if (wasm.db_gpu_external_pending()) {
      // Bound host work too: hostile CPU programs can submit tiny dispatches in a loop.
      if (++dispatches > 64) {
        wasm.db_gpu_set_external(0);
        activeBackend = 'wasm';
        fallbackReason = 'Too many dispatches per frame; using WASM.';
        continue;
      }
      const read = offset => wasm.db_gpu_read_reg(offset) >>> 0;
      const descriptor = {
        rom: copyBytes(wasm.db_rom_ptr(), wasm.db_rom_len()),
        ram: copyBytes(wasm.db_ram_ptr(), wasm.db_ram_len()), allowRamCode: wasm.db_profile() === 4,
        codeBase: read(0), codeLength: read(4), width: read(8), height: read(12),
        bindings: Array.from({ length: 4 }, (_, i) => ({ base: read(0x40 + 16 * i), len: read(0x44 + 16 * i), flags: read(0x48 + 16 * i) })),
      };
      let result;
      try {
        result = await accelerator.dispatch(descriptor, descriptor.ram,
          Uint32Array.from({ length: 16 }, (_, i) => read(0x100 + 4 * i)));
        // Validate every range before copying any result. A failure publishes nothing.
        const ramLength = wasm.db_ram_len();
        for (const write of result.writes) {
          if (write.offset < 0 || write.offset + write.bytes.length > ramLength) throw new Error('Invalid accelerated output range.');
        }
      } catch (error) {
        // No shader output is published on compilation, bounds, device or budget errors.
        // Continue the still-pending original dispatch in the reference interpreter.
        if (wasm.db_gpu_set_external(0) !== 0) throw new Error(machineError());
        activeBackend = 'wasm';
        fallbackReason = error.message || String(error);
        dispatchMs = null;
        continue;
      }
      const ram = new Uint8Array(memory.buffer, wasm.db_ram_ptr(), wasm.db_ram_len());
      for (const write of result.writes) ram.set(write.bytes, write.offset);
      if (wasm.db_gpu_external_complete() !== 0) throw new Error(machineError());
      dispatchMs = result.dispatchMs;
      continue;
    }
    if (wasm.db_spu_external_pending()) {
      const read = offset => wasm.db_spu_read_reg(offset) >>> 0;
      const descriptor = {
        rom: copyBytes(wasm.db_rom_ptr(), wasm.db_rom_len()),
        ram: copyBytes(wasm.db_ram_ptr(), wasm.db_ram_len()), allowRamCode: wasm.db_profile() === 4,
        codeBase: read(0), codeLength: read(4), width: read(8), height: read(12), allowReadWrite: true,
        bindings: Array.from({ length: 4 }, (_, i) => ({ base: read(0x40 + 16 * i), len: read(0x44 + 16 * i), flags: read(0x48 + 16 * i) })),
      };
      let result;
      try {
        result = await accelerator.dispatch(descriptor, descriptor.ram,
          Uint32Array.from({ length: 16 }, (_, i) => read(0x100 + 4 * i)));
        const ramLength = wasm.db_ram_len();
        for (const write of result.writes) {
          if (write.offset < 0 || write.offset + write.bytes.length > ramLength) throw new Error('Invalid accelerated SPU output range.');
        }
        // Validate PCM before publishing any writable state, so invalid hardware
        // output can still fall back to the untouched pending reference job.
        const output = (wasm.db_spu_output_base() >>> 0) - 0x10000;
        const block = result.writes.find(write => write.offset <= output && output + 2048 <= write.offset + write.bytes.length);
        if (!block) throw new Error('Missing accelerated SPU output.');
        const pcm = new DataView(block.bytes.buffer, block.bytes.byteOffset + output - block.offset, 2048);
        for (let i = 0; i < 512; i++) {
          if (!Number.isFinite(pcm.getFloat32(i * 4, true))) throw new Error('Nonfinite accelerated PCM; using WASM.');
        }
      } catch (error) {
        spuBackend = 'wasm';
        spuReason = error.message || String(error);
        spuDispatchMs = null;
        if (wasm.db_spu_external_fallback() !== 0) throw new Error(machineError());
        continue;
      }
      const ram = new Uint8Array(memory.buffer, wasm.db_ram_ptr(), wasm.db_ram_len());
      for (const write of result.writes) ram.set(write.bytes, write.offset);
      if (wasm.db_spu_external_complete() !== 0) throw new Error(machineError());
      spuDispatchMs = result.dispatchMs;
      continue;
    }
    const remaining = end - ticks();
    if (remaining <= 0n) break;
    const code = wasm.db_run(Number(remaining));
    if (code === 3 || code === 0) return code;
  }
  return wasm.db_status();
}

function stop() {
  playing = false;
  if (timer !== null) clearTimeout(timer);
  timer = null;
  audioEpoch++;
  if (wasm) wasm.db_audio_clear();
  self.postMessage({ type: 'audio-reset', epoch: audioEpoch });
}

function drainAudio() {
  const len = wasm.db_audio_len();
  if (!len) return;
  if (playing) {
    const samples = new Float32Array(copyBytes(wasm.db_audio_ptr(), len * 4).buffer);
    self.postMessage({ type: 'audio', samples, rate: wasm.db_audio_rate(), epoch: audioEpoch }, [samples.buffer]);
  }
  wasm.db_audio_clear();
}

function copyBytes(ptr, len) {
  if (!Number.isSafeInteger(ptr) || !Number.isSafeInteger(len) || ptr < 0 || len < 0 || ptr + len > memory.buffer.byteLength) {
    throw new Error("The machine returned an invalid memory range.");
  }
  return new Uint8Array(memory.buffer.slice(ptr, ptr + len));
}

function machineError() {
  const bytes = copyBytes(wasm.db_error_ptr(), wasm.db_error_len());
  return new TextDecoder().decode(bytes) || "The machine reported an error.";
}

function snapshot(includeFrame = true) {
  const frameCount = wasm.db_frame_count() >>> 0;
  const tick = ticks().toString();
  const statusCode = wasm.db_status();
  const profileCode = wasm.db_profile() >>> 0;
  const gpuStatusCode = wasm.db_gpu_status() >>> 0;
  const gpuLastTicks = wasm.db_gpu_last_ticks() >>> 0;
  const gpuDispatches = wasm.db_gpu_dispatches() >>> 0;
  const state = {
    type: "state",
    playing,
    status: STATUS[statusCode] || `unknown (${statusCode})`,
    statusCode,
    profileCode,
    profile: PROFILE[profileCode] || `unknown (${profileCode})`,
    backend: { requested: requestedBackend, active: activeBackend, available: !!accelerator && !accelerator.lost,
      reason: fallbackReason, dispatchMs, fps },
    audio: {
      available: profileCode >= 3, samples: (wasm.db_spu_samples_hi() >>> 0) * 4294967296 + (wasm.db_spu_samples_lo() >>> 0),
      blocks: wasm.db_spu_blocks() >>> 0, peak: wasm.db_spu_peak(), overruns: wasm.db_audio_overruns() >>> 0,
      backend: spuBackend, lastTicks: wasm.db_spu_last_ticks() >>> 0, dispatchMs: spuDispatchMs, reason: spuReason,
    },
    gpu: {
      statusCode: gpuStatusCode,
      status: GPU_STATUS[gpuStatusCode] || `unknown (${gpuStatusCode})`,
      ticks: wasm.db_gpu_ticks() >>> 0,
      dispatches: gpuDispatches,
      invocations: wasm.db_gpu_invocations() >>> 0,
      pc: wasm.db_gpu_pc() >>> 0,
      lastTicks: gpuLastTicks,
      frameBudgetPercent: activeBackend === 'wasm' && gpuDispatches ? gpuLastTicks / FRAME_TICKS * 100 : null,
    },
    frameCount,
    tick,
    pc: wasm.db_pc() >>> 0,
    payloadSize: wasm.db_payload_size() >>> 0,
    format: wasm.db_format() >>> 0,
    registers: Array.from({ length: 16 }, (_, i) => wasm.db_register(i) >>> 0),
  };
  if (includeFrame) {
    const len = wasm.db_frame_len();
    if (len !== FRAME_BYTES) throw new Error(`Unexpected frame size: ${len} bytes.`);
    state.frame = copyBytes(wasm.db_frame_ptr(), len);
  }
  self.postMessage(state, state.frame ? [state.frame.buffer] : []);
}

function scheduleFrame() {
  if (!playing) return;
  const wait = Math.max(0, nextFrameAt - performance.now());
  timer = setTimeout(() => enqueue(runFrame), wait);
}

async function runFrame() {
  timer = null;
  if (!playing) return;
  try {
    const code = await runMachineFrame();
    if (code === 3 || code === 0) stop();
    fpsFrames++;
    const elapsed = performance.now() - fpsStart;
    if (elapsed >= 500) { fps = fpsFrames * 1000 / elapsed; fpsFrames = 0; fpsStart = performance.now(); }
    snapshot();
    drainAudio();
    if (code === 3) self.postMessage({ type: "error", message: machineError() });
    if (playing) {
      nextFrameAt = Math.max(nextFrameAt + 1000 / 60, performance.now());
      scheduleFrame();
    }
  } catch (error) {
    stop();
    self.postMessage({ type: "error", message: error.message || String(error) });
  }
}

function upload(bytes) {
  const capacity = wasm.db_input_capacity();
  if (bytes.length > capacity) throw new Error(`Input is ${bytes.length.toLocaleString()} bytes; the machine accepts at most ${capacity.toLocaleString()}.`);
  const ptr = wasm.db_input_ptr();
  if (ptr < 0 || ptr + bytes.length > memory.buffer.byteLength) throw new Error("The machine input workspace is invalid.");
  new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
  return bytes.length;
}

function assemble(source, autoPlay) {
  stop();
  const len = upload(new TextEncoder().encode(source));
  if (wasm.db_assemble(len) !== 0) throw new Error(machineError());
  const nextCartridge = copyBytes(wasm.db_assembled_ptr(), wasm.db_assembled_len());
  if (wasm.db_load_assembled() !== 0) throw new Error(machineError());
  activeCartridge = nextCartridge;
  configureBackend();
  const listing = new TextDecoder().decode(copyBytes(wasm.db_listing_ptr(), wasm.db_listing_len()));
  self.postMessage({ type: "assembled", cartridge: activeCartridge.slice(), listing, payloadSize: wasm.db_payload_size() >>> 0 });
  snapshot();
  if (autoPlay) play();
}

function play() {
  const status = wasm.db_status();
  if (status === 0) throw new Error("Load a program before playing.");
  if (status === 3) throw new Error(machineError());
  if (playing) return;
  audioEpoch++;
  wasm.db_audio_clear();
  self.postMessage({ type: 'audio-reset', epoch: audioEpoch });
  playing = true;
  fpsStart = performance.now();
  fpsFrames = 0;
  nextFrameAt = performance.now();
  snapshot(false);
  scheduleFrame();
}

async function step() {
  stop();
  const status = wasm.db_status();
  if (status === 0) throw new Error("Load a program before stepping.");
  if (status === 3) throw new Error(machineError());
  const result = await runMachineFrame();
  snapshot();
  if (result === 3) self.postMessage({ type: "error", message: machineError() });
  drainAudio();
}

function reset() {
  stop();
  wasm.db_reset();
  // A failed assembly clears the WASM-side assembled buffer. Keep the last
  // successfully loaded cartridge so Reset can still restore that program.
  if (activeCartridge && wasm.db_load(upload(activeCartridge)) !== 0) throw new Error(machineError());
  configureBackend();
  snapshot();
}

async function init() {
  const response = await fetch(new URL("./machine.wasm", import.meta.url));
  if (!response.ok) throw new Error(`Could not load machine.wasm (HTTP ${response.status}).`);
  const bytes = await response.arrayBuffer();
  const result = await WebAssembly.instantiate(bytes, {});
  wasm = result.instance.exports;
  memory = wasm.memory;
  if (!(memory instanceof WebAssembly.Memory)) throw new Error("Machine memory export is missing.");
  if (wasm.db_abi_version() !== 1) throw new Error(`Unsupported machine ABI ${wasm.db_abi_version()}; expected 1.`);
  for (const name of ["db_profile", "db_gpu_status", "db_gpu_ticks", "db_gpu_dispatches", "db_gpu_invocations", "db_gpu_pc", "db_gpu_last_ticks", "db_gpu_set_external", "db_gpu_external_pending", "db_gpu_external_complete", "db_gpu_read_reg", "db_ram_ptr", "db_ram_len", "db_rom_ptr", "db_rom_len"]) {
    if (typeof wasm[name] !== "function") throw new Error(`Machine telemetry export ${name} is missing.`);
  }
  for (const name of ['db_audio_ptr', 'db_audio_len', 'db_audio_clear', 'db_audio_rate', 'db_spu_status', 'db_spu_blocks', 'db_spu_samples_lo', 'db_spu_samples_hi', 'db_spu_peak', 'db_spu_output_base', 'db_audio_overruns', 'db_spu_last_ticks', 'db_spu_set_external', 'db_spu_external_pending', 'db_spu_read_reg', 'db_spu_external_complete', 'db_spu_external_fallback']) {
    if (typeof wasm[name] !== 'function') throw new Error(`SPU export ${name} is missing.`);
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const wasmSha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const gpu = await WebGpuBackend.create();
  accelerator = gpu.backend;
  unavailableReason = gpu.reason;
  self.postMessage({ type: "ready", abiVersion: 1, inputCapacity: wasm.db_input_capacity(), wasmSha256 });
  snapshot();
}

self.onmessage = (event) => enqueue(async () => {
  if (!wasm) return;
  const { type } = event.data || {};
  try {
    switch (type) {
      case "assemble": assemble(event.data.source, event.data.autoPlay !== false); break;
      case "play": play(); break;
      case "pause": stop(); snapshot(false); break;
      case "step": await step(); break;
      case "reset": reset(); break;
      case "backend": {
        if (!['auto', 'wasm', 'webgpu'].includes(event.data.backend)) throw new Error('Unknown GPU backend.');
        const resume = playing;
        requestedBackend = event.data.backend;
        reset();
        if (resume) play();
        break;
      }
      default: throw new Error(`Unknown worker command: ${type}`);
    }
  } catch (error) {
    stop();
    self.postMessage({ type: "error", message: error.message || String(error) });
    snapshot(false);
  }
});

init().catch((error) => self.postMessage({ type: "init-error", message: error.message || String(error) }));
