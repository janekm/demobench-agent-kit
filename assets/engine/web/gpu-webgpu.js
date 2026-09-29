import { compileKernel, kernelBytes } from './gpu-compiler.js';

const MIRROR_BYTES = 0x30000;
const RAM_BASE = 0x10000;
const MAX_PIPELINES = 8;

async function deadline(promise, milliseconds, message, onTimeout = () => {}) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => { onTimeout(); reject(new Error(message)); }, milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

// WebGPU is a fast preview backend for DB32 kernels, not a second scene renderer.
// Only validated guest writable bindings are returned to the WASM machine.
export class WebGpuBackend {
  static async create() {
    if (!globalThis.navigator?.gpu) return { backend: null, reason: 'WebGPU is unavailable in this browser.' };
    try {
      const adapter = await deadline(navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }), 3000, 'WebGPU adapter request timed out.');
      if (!adapter) return { backend: null, reason: 'No WebGPU adapter is available.' };
      let expired = false;
      const request = adapter.requestDevice().then(device => { if (expired) device.destroy(); return device; });
      const device = await deadline(request, 3000, 'WebGPU device request timed out.', () => { expired = true; });
      return { backend: new WebGpuBackend(device), reason: null };
    } catch (error) {
      return { backend: null, reason: `WebGPU unavailable: ${error.message || error}` };
    }
  }

  constructor(device) {
    this.device = device;
    this.lost = null;
    this.cache = new Map();
    this.mirror = new Uint8Array(MIRROR_BYTES);
    this.params = new Uint32Array(20);
    this.input = device.createBuffer({ size: MIRROR_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    this.output = device.createBuffer({ size: MIRROR_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    this.uniform = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.status = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    this.readback = device.createBuffer({ size: MIRROR_BYTES + 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    device.lost.then(info => { this.lost = `WebGPU device lost: ${info.message || info.reason}`; });
    device.addEventListener('uncapturederror', event => { this.lost = `WebGPU error: ${event.error.message}`; });
  }

  async pipeline(descriptor) {
    // Code and descriptor identity are exact, not a collision-prone short hash.
    const { codeBase, codeLength, bindings, width, height, allowReadWrite = false, allowRamCode = false, processor = 'gpu' } = descriptor;
    const key = JSON.stringify([codeBase, codeLength, width, height, bindings, allowReadWrite, allowRamCode, processor,
      descriptor.rom.length, Array.from(kernelBytes(descriptor))]);
    if (this.cache.has(key)) return this.cache.get(key);
    const compiled = compileKernel(descriptor);
    const device = this.device;
    device.pushErrorScope('validation');
    let pipeline, bindGroup, exception;
    try {
      const shader = device.createShaderModule({ label: 'DB32 translated kernel', code: compiled.code });
      const info = await shader.getCompilationInfo();
      const errors = info.messages.filter(message => message.type === 'error');
      if (errors.length) throw new Error(errors.map(e => `WGSL ${e.lineNum}:${e.linePos}: ${e.message}`).join('\n'));
      // Explicit layout keeps unused bindings legal for small custom kernels.
      const layout = device.createBindGroupLayout({ entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ] });
      pipeline = await device.createComputePipelineAsync({
        label: 'DB32 fast kernel', layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: { module: shader, entryPoint: 'main' },
      });
      bindGroup = device.createBindGroup({ layout, entries: [this.input, this.output, this.uniform, this.status]
        .map((buffer, binding) => ({ binding, resource: { buffer } })) });
    } catch (error) { exception = error; }
    const validation = await device.popErrorScope();
    if (exception) throw exception;
    if (validation) throw new Error(validation.message);
    const entry = { pipeline, bindGroup, compiled };
    if (this.cache.size >= MAX_PIPELINES) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(key, entry);
    return entry;
  }

  async dispatch(descriptor, ram, uniforms) {
    if (this.lost) throw new Error(this.lost);
    const expire = message => { this.lost = message; this.device.destroy(); };
    const entry = await deadline(this.pipeline(descriptor), 15000, 'WebGPU compilation timed out.',
      () => expire('WebGPU compilation timed out.'));
    const start = performance.now(); // Excludes compilation; includes upload, execution, readback.
    const device = this.device;
    this.mirror.fill(0);
    this.mirror.set(descriptor.rom);
    this.mirror.set(ram, RAM_BASE);
    this.params[0] = descriptor.width;
    this.params[1] = descriptor.height;
    this.params.set(uniforms, 4);
    device.queue.writeBuffer(this.input, 0, this.mirror);
    device.queue.writeBuffer(this.uniform, 0, this.params);
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(this.input, 0, this.output, 0, MIRROR_BYTES);
    encoder.clearBuffer(this.status);
    const pass = encoder.beginComputePass();
    pass.setPipeline(entry.pipeline);
    pass.setBindGroup(0, entry.bindGroup);
    pass.dispatchWorkgroups(Math.ceil(descriptor.width * descriptor.height / 64));
    pass.end();
    encoder.copyBufferToBuffer(this.output, 0, this.readback, 0, MIRROR_BYTES);
    encoder.copyBufferToBuffer(this.status, 0, this.readback, MIRROR_BYTES, 4);
    device.queue.submit([encoder.finish()]);
    await deadline(this.readback.mapAsync(GPUMapMode.READ), 2000, 'WebGPU readback timed out.',
      () => expire('WebGPU readback timed out.'));
    let writes;
    try {
      const mapped = this.readback.getMappedRange();
      const fault = new DataView(mapped).getUint32(MIRROR_BYTES, true);
      if (fault) throw new Error(`Accelerated kernel declined (bounds/budget flag ${fault}); using WASM.`);
      writes = descriptor.bindings.filter(b => b.flags === 3).map(b => ({
        offset: b.base - RAM_BASE, bytes: new Uint8Array(mapped, b.base, b.len).slice(),
      }));
    } finally { this.readback.unmap(); }
    if (this.lost) throw new Error(this.lost);
    return { writes, dispatchMs: performance.now() - start };
  }
}
