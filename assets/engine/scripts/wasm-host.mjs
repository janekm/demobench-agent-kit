import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
export const FRAME_TICKS = 204800;
export const WIDTH = 160;
export const HEIGHT = 120;
const GPU_STATUS = ['idle', 'busy', 'done', 'fault'];
const PROFILE = { 1: 'bootstrap-1', 2: 'gpu-1', 3: 'spu-1', 4: 'dynamic-1' };
export const modulePath = fileURLToPath(new URL('../web/machine.wasm', import.meta.url));
export function createMachine() {
  const bytes = readFileSync(modulePath);
  const module = new WebAssembly.Module(bytes);
  if (WebAssembly.Module.imports(module).length) throw new Error('Machine must have no WASM imports');
  const e = new WebAssembly.Instance(module, {}).exports;
  if (e.db_abi_version() !== 1) throw new Error('Unsupported machine ABI');
  for (const name of ['db_profile', 'db_gpu_status', 'db_gpu_ticks', 'db_gpu_dispatches', 'db_gpu_invocations', 'db_gpu_pc', 'db_gpu_last_ticks']) {
    if (typeof e[name] !== 'function') throw new Error(`Machine telemetry export ${name} is missing`);
  }
  const text = (ptr, len) => new TextDecoder().decode(new Uint8Array(e.memory.buffer, ptr, len));
  const error = () => text(e.db_error_ptr(), e.db_error_len());
  const upload = (input) => {
    if (input.length > e.db_input_capacity()) throw new Error('Upload exceeds capacity');
    // The first pointer call may initialize the Rust host and grow memory.
    const ptr = e.db_input_ptr();
    new Uint8Array(e.memory.buffer, ptr, input.length).set(input);
  };
  return {
    exports: e,
    wasmHash: createHash('sha256').update(bytes).digest('hex'),
    assemble(source) {
      const input = new TextEncoder().encode(source); upload(input);
      if (e.db_assemble(input.length) !== 0) throw new Error(error());
      const ptr=e.db_assembled_ptr(), len=e.db_assembled_len();
      return new Uint8Array(e.memory.buffer, ptr, len).slice();
    },
    load(cartridge) { upload(cartridge); if (e.db_load(cartridge.length) !== 0) throw new Error(error()); },
    run(ticks) { const status = e.db_run(ticks); if (status === 3) throw new Error(error()); return status; },
    runFrames(count) { for (let i=0; i<count; i++) this.run(FRAME_TICKS); },
    frame() { const ptr=e.db_frame_ptr(), len=e.db_frame_len(); return new Uint8Array(e.memory.buffer, ptr, len).slice(); },
    audio() {
      const ptr=e.db_audio_ptr(),len=e.db_audio_len();
      const samples=new Float32Array(e.memory.buffer,ptr,len).slice();
      e.db_audio_clear();
      return samples;
    },
    info() {
      const profileCode = e.db_profile() >>> 0;
      const gpuStatusCode = e.db_gpu_status() >>> 0;
      const gpuLastTicks = e.db_gpu_last_ticks() >>> 0;
      const gpuDispatches = e.db_gpu_dispatches() >>> 0;
      return { profile: PROFILE[profileCode] ?? `unknown (${profileCode})`, profileCode,
      audio: { rate:e.db_audio_rate(), samples:(e.db_spu_samples_hi()>>>0)*4294967296+(e.db_spu_samples_lo()>>>0),
        blocks:e.db_spu_blocks(), peak:e.db_spu_peak(), overruns:e.db_audio_overruns(), lastTicks:e.db_spu_last_ticks() },
      gpu: { statusCode: gpuStatusCode, status: GPU_STATUS[gpuStatusCode] ?? `unknown (${gpuStatusCode})`,
        ticks: e.db_gpu_ticks() >>> 0, dispatches: gpuDispatches, invocations: e.db_gpu_invocations() >>> 0,
        pc: e.db_gpu_pc() >>> 0, lastTicks: gpuLastTicks,
        frameBudgetPercent: gpuDispatches ? gpuLastTicks / FRAME_TICKS * 100 : null },
      wasmSha256:this.wasmHash, frames:e.db_frame_count(),
      ticks: e.db_ticks_hi() * 4294967296 + (e.db_ticks_lo() >>> 0), pc:e.db_pc(),
      status:e.db_status(), format:e.db_format(), payloadBytes:e.db_payload_size(),
      rgbaSha256:createHash('sha256').update(this.frame()).digest('hex') }; },
  };
}
