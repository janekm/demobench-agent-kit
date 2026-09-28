// Compile the cartridge's validated gpu-1 instruction stream to a WebGPU
// program. Each invocation has its own registers and absolute ROM PC.
// This is an accelerated preview: native WGSL float math and overlapping
// cross-invocation stores need not match the deterministic DB32 scheduler.
// allowReadWrite enables SPU state loads from the atomic output mirror.
// Atomics preserve word/byte integrity, not ordering between invocations;
// kernels with cross-invocation state dependencies need the WASM reference path.
const RAM_BASE = 0x10000;
const MIRROR_BYTES = 0x30000;
const MAX_CODE_BYTES = 4096;
const STEP_LIMIT = 8192;
const DOUBLE_WORD = new Set([1, 40, 41, 42]);
const VECTOR_DEST = new Set([28, 29, 30, 32, 33]);
const VECTOR_A = new Set([28, 29, 30, 31, 32, 33, 34]);
const VECTOR_B = new Set([28, 29, 31, 33, 34]);

function requireRange(ok, message) {
  if (!ok) throw new Error(`WebGPU compiler: ${message}`);
}
function uint(value, name) {
  requireRange(Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff, `${name} must be a u32`);
  return value;
}
function validateBindings(bindings, romLength) {
  requireRange(Array.isArray(bindings) && bindings.length === 4, 'expected four binding descriptors');
  const used = bindings.map((raw, index) => {
    const base = uint(raw?.base, `binding ${index} base`);
    const len = uint(raw?.len, `binding ${index} length`);
    const flags = uint(raw?.flags, `binding ${index} flags`);
    requireRange(flags === 0 || flags === 1 || flags === 3, `binding ${index} flags must be 0, 1, or 3`);
    if (flags === 0) {
      requireRange(base === 0 && len === 0, `unused binding ${index} must be zero`);
      return { base, len, flags, index };
    }
    requireRange(len > 0 && base + len <= MIRROR_BYTES, `binding ${index} exceeds guest mirror`);
    const inRom = base < romLength && base + len <= romLength;
    const inRam = base >= RAM_BASE && base + len <= MIRROR_BYTES;
    requireRange(flags === 3 ? inRam : inRom || inRam, `binding ${index} is outside allowed ROM/RAM`);
    return { base, len, flags, index };
  });
  for (let i = 0; i < used.length; i++) {
    if (!used[i].flags) continue;
    for (let j = i + 1; j < used.length; j++) {
      if (!used[j].flags) continue;
      requireRange(used[i].base + used[i].len <= used[j].base || used[j].base + used[j].len <= used[i].base,
        `bindings ${i} and ${j} overlap`);
    }
  }
  return used;
}
function decode(codeBytes, codeBase, codeLength, bindings, allowReadWrite) {
  const end = codeBase + codeLength;
  const view = new DataView(codeBytes.buffer, codeBytes.byteOffset, codeBytes.byteLength);
  const instructions = [];
  const starts = new Set();
  for (let pc = codeBase; pc < end;) {
    requireRange(pc + 4 <= end, `truncated instruction at 0x${pc.toString(16)}`);
    const word = view.getUint32(pc - codeBase, true);
    const op = word & 255;
    const d = (word >>> 8) & 31;
    const a = (word >>> 13) & 31;
    const b = (word >>> 18) & 31;
    const c = (word >>> 23) & 31;
    const tag = `instruction at 0x${pc.toString(16)}`;
    requireRange(op <= 42, `${tag} has unknown opcode ${op}`);
    requireRange((word >>> 28) === 0, `${tag} has nonzero reserved bits`);
    const size = DOUBLE_WORD.has(op) ? 8 : 4;
    requireRange(pc + size <= end, `${tag} has a truncated literal`);
    const literal = size === 8 ? view.getUint32(pc - codeBase + 4, true) : 0;
    if (op === 0 || op === 42) requireRange(d === 0 && a === 0 && b === 0 && c === 0, `${tag} has unused operand bits`);
    else if (op === 1 || op === 40 || op === 41) requireRange(a === 0 && b === 0 && c === 0, `${tag} has unused operand bits`);
    else if (op === 3 || op === 4) {
      requireRange(b === 0 && c === 0, `${tag} has unused operand bits`);
      requireRange(a <= (op === 3 ? 5 : 15), `${tag} has invalid built-in/uniform index`);
    } else if ([2, 22, 23, 24, 25, 32].includes(op)) {
      requireRange(b === 0 && c === 0, `${tag} has unused operand bits`);
    } else if (op === 34) {
      // All four register fields are used.
    } else if (op >= 5 && op <= 21 || op >= 26 && op <= 31 || op === 33 || op >= 35 && op <= 39) {
      requireRange(c === 0, `${tag} has unused operand bits`);
    } else {
      throw new Error(`WebGPU compiler: unsupported opcode ${op} at 0x${pc.toString(16)}`);
    }
    if (VECTOR_DEST.has(op)) requireRange(d >= 1 && d <= 29, `${tag} has invalid vector destination`);
    if (VECTOR_A.has(op)) requireRange(a <= 29, `${tag} has invalid vector source`);
    if (VECTOR_B.has(op)) requireRange(b <= 29, `${tag} has invalid vector source`);
    if (op === 34) requireRange(c <= 28, `${tag} has invalid sphere center`);
    if (op === 39) requireRange(d <= 29, `${tag} has invalid RGB vector source`);
    if (op >= 35 && op <= 39) {
      requireRange(b <= 3, `${tag} has invalid binding index`);
      const binding = bindings[b];
      if (op === 35 || op === 37) {
        requireRange(binding.flags === 1 || allowReadWrite && binding.flags === 3,
          `${tag} reads a writable or unused binding; use WASM fallback`);
      } else {
        requireRange(binding.flags === 3, `${tag} writes a read-only or unused binding; use WASM fallback`);
      }
    }
    starts.add(pc);
    instructions.push({ pc, next: pc + size, op, d, a, b, c, literal });
    pc += size;
  }
  for (const inst of instructions) {
    if (inst.op >= 40) requireRange(starts.has(inst.literal),
      `branch at 0x${inst.pc.toString(16)} targets outside an instruction start`);
  }
  return instructions;
}

const u = n => `${n >>> 0}u`;
const r = n => `r[${u(n)}]`;
const f = n => `bitcast<f32>(${r(n)})`;
const v = n => `vec3<f32>(${f(n)}, ${f(n + 1)}, ${f(n + 2)})`;
const scalar = (d, expr) => d === 0 ? '' : `${r(d)} = ${expr};`;
const vector = (d, expr) => `let result = ${expr};
  ${r(d)} = bitcast<u32>(result.x);
  ${r(d + 1)} = bitcast<u32>(result.y);
  ${r(d + 2)} = bitcast<u32>(result.z);`;
const advance = (body, next) => `${body}\n  pc = ${u(next)};`;

function memoryCode(inst, binding) {
  const { op, d, a } = inst;
  const base = u(binding.base);
  const len = u(binding.len);
  const off = r(a);
  if (op === 35 || op === 36) {
    const check = `let offset = ${off};
      if (${len} < 4u || offset > ${len} - 4u || ((${base} + offset) & 3u) != 0u) { fail(1u); return; }
      let address = ${base} + offset;`;
    return op === 35
      ? `${check}\n      ${scalar(d, binding.flags === 3 ? 'atomicLoad(&outputWords[address >> 2u])' : 'inputWords[address >> 2u]')}`
      : `${check}\n      atomicStore(&outputWords[address >> 2u], ${r(d)});`;
  }
  if (op === 37 || op === 38) {
    const check = `let offset = ${off};
      if (offset >= ${len}) { fail(1u); return; }
      let address = ${base} + offset;`;
    return op === 37
      ? `${check}\n      ${scalar(d, binding.flags === 3 ? 'loadOutputByte(address)' : 'loadByte(address)')}`
      : `${check}\n      storeByte(address, ${r(d)});`;
  }
  return `let index = ${off};
      if (${len} < 3u || index > (${len} - 3u) / 3u) { fail(1u); return; }
      let address = ${base} + index * 3u;
      let rgb = clamp(${v(d)}, vec3<f32>(0.0), vec3<f32>(1.0)) * 255.0;
      storeByte(address, u32(rgb.x));
      storeByte(address + 1u, u32(rgb.y));
      storeByte(address + 2u, u32(rgb.z));`;
}

function instructionCode(inst, bindings, writePc = true) {
  const { op, d, a, b, c, literal, next } = inst;
  let body;
  switch (op) {
    case 0: return 'return;';
    case 1: body = scalar(d, u(literal)); break;
    case 2: body = scalar(d, r(a)); break;
    case 3: body = scalar(d, [ 'x', 'y', 'id', 'id & 63u', 'width', 'height' ][a]); break;
    case 4: body = scalar(d, `params.words[${u(1 + Math.floor(a / 4))}][${u(a % 4)}]`); break;
    case 5: body = scalar(d, `${r(a)} + ${r(b)}`); break;
    case 6: body = scalar(d, `${r(a)} - ${r(b)}`); break;
    case 7: body = scalar(d, `${r(a)} * ${r(b)}`); break;
    case 8: body = scalar(d, `${r(a)} & ${r(b)}`); break;
    case 9: body = scalar(d, `${r(a)} | ${r(b)}`); break;
    case 10: body = scalar(d, `${r(a)} ^ ${r(b)}`); break;
    case 11: body = scalar(d, `${r(a)} << (${r(b)} & 31u)`); break;
    case 12: body = scalar(d, `${r(a)} >> (${r(b)} & 31u)`); break;
    case 13: body = scalar(d, `bitcast<u32>(bitcast<i32>(${r(a)}) >> (${r(b)} & 31u))`); break;
    case 14: body = scalar(d, `select(0u, 1u, bitcast<i32>(${r(a)}) < bitcast<i32>(${r(b)}))`); break;
    case 15: body = scalar(d, `select(0u, 1u, ${r(a)} < ${r(b)})`); break;
    case 16: body = scalar(d, `bitcast<u32>(${f(a)} + ${f(b)})`); break;
    case 17: body = scalar(d, `bitcast<u32>(${f(a)} - ${f(b)})`); break;
    case 18: body = scalar(d, `bitcast<u32>(${f(a)} * ${f(b)})`); break;
    case 19: body = scalar(d, `bitcast<u32>(${f(a)} / ${f(b)})`); break;
    case 20: body = scalar(d, `bitcast<u32>(min(${f(a)}, ${f(b)}))`); break;
    case 21: body = scalar(d, `bitcast<u32>(max(${f(a)}, ${f(b)}))`); break;
    case 22: body = scalar(d, `bitcast<u32>(sqrt(${f(a)}))`); break;
    case 23: body = scalar(d, `bitcast<u32>(inverseSqrt(${f(a)}))`); break;
    case 24: body = scalar(d, `bitcast<u32>(f32(bitcast<i32>(${r(a)})))`); break;
    case 25: body = scalar(d, `bitcast<u32>(i32(clamp(${f(a)}, -2147483648.0, 2147483520.0)))`); break;
    case 26: body = scalar(d, `select(0u, 1u, ${f(a)} < ${f(b)})`); break;
    case 27: body = scalar(d, `select(0u, 1u, ${f(a)} <= ${f(b)})`); break;
    case 28: body = vector(d, `${v(a)} + ${v(b)}`); break;
    case 29: body = vector(d, `${v(a)} - ${v(b)}`); break;
    case 30: body = vector(d, `${v(a)} * ${f(b)}`); break;
    case 31: body = scalar(d, `bitcast<u32>(dot(${v(a)}, ${v(b)}))`); break;
    case 32: body = `let source = ${v(a)};
      if (dot(source, source) == 0.0) {
        ${r(d)} = 0u; ${r(d + 1)} = 0u; ${r(d + 2)} = 0u;
      } else { ${vector(d, 'normalize(source)')} }`; break;
    case 33: body = vector(d, `reflect(${v(a)}, ${v(b)})`); break;
    case 34: body = `let origin = ${v(a)};
      let direction = ${v(b)};
      let center = ${v(c)};
      let radius = ${f(c + 3)};
      let qa = dot(direction, direction);
      if (qa == 0.0 || radius < 0.0) { fail(4u); return; }
      let delta = origin - center;
      let qb = dot(delta, direction);
      let qc = dot(delta, delta) - radius * radius;
      let disc = qb * qb - qa * qc;
      var t = -1.0;
      if (disc >= 0.0) {
        let root = sqrt(disc);
        let near = (-qb - root) / qa;
        let far = (-qb + root) / qa;
        if (near >= 0.0009765625) { t = near; }
        else if (far >= 0.0009765625) { t = far; }
      }
      ${scalar(d, 'bitcast<u32>(t)')}`; break;
    case 35: case 36: case 37: case 38: case 39:
      body = memoryCode(inst, bindings[b]); break;
    case 40: body = `if (${r(d)} == 0u) { pc = ${u(literal)}; } else { pc = ${u(next)}; }`; return body;
    case 41: body = `if (${r(d)} != 0u) { pc = ${u(literal)}; } else { pc = ${u(next)}; }`; return body;
    case 42: return `pc = ${u(literal)};`;
    default: throw new Error(`WebGPU compiler: unsupported opcode ${op}`);
  }
  return writePc ? advance(body, next) : body;
}

function basicBlocks(instructions) {
  const leaders = new Set([instructions[0].pc]);
  for (const inst of instructions) {
    if (inst.op >= 40) leaders.add(inst.literal);
    if (inst.op === 0 || inst.op >= 40) leaders.add(inst.next);
  }
  const blocks = [];
  let current = [];
  for (const inst of instructions) {
    if (current.length && leaders.has(inst.pc)) {
      blocks.push(current);
      current = [];
    }
    current.push(inst);
    if (inst.op === 0 || inst.op >= 40) {
      blocks.push(current);
      current = [];
    }
  }
  if (current.length) blocks.push(current);
  return blocks;
}

function shader(blocks, codeBase, bindings) {
  const cases = blocks.map(block => {
    const code = block.map((inst, i) => `        {
          ${instructionCode(inst, bindings, i === block.length - 1)}
        }`).join('\n');
    return `      case ${u(block[0].pc)}: {
        if (steps > ${u(STEP_LIMIT - block.length)}) { fail(2u); return; }
        steps += ${u(block.length)};
${code}
      }`;
  }).join('\n');
  return `// DB32 gpu-1 cartridge code compiled from ROM at ${codeBase}.
// group 0: input mirror, atomic output mirror, params, status.
struct Params { words: array<vec4<u32>, 5>, }
@group(0) @binding(0) var<storage, read> inputWords: array<u32>;
@group(0) @binding(1) var<storage, read_write> outputWords: array<atomic<u32>>;
@group(0) @binding(2) var<uniform> params: Params;
@group(0) @binding(3) var<storage, read_write> status: array<atomic<u32>>;

fn fail(flag: u32) { atomicOr(&status[0], flag); }
fn loadByte(address: u32) -> u32 {
  return (inputWords[address >> 2u] >> ((address & 3u) * 8u)) & 255u;
}
fn loadOutputByte(address: u32) -> u32 {
  return (atomicLoad(&outputWords[address >> 2u]) >> ((address & 3u) * 8u)) & 255u;
}
fn storeByte(address: u32, value: u32) {
  let word = address >> 2u;
  let shift = (address & 3u) * 8u;
  let mask = 255u << shift;
  for (var attempt = 0u; attempt < 4096u; attempt += 1u) {
    let old = atomicLoad(&outputWords[word]);
    let updated = (old & ~mask) | ((value & 255u) << shift);
    let result = atomicCompareExchangeWeak(&outputWords[word], old, updated);
    if (result.exchanged) { return; }
  }
  fail(8u);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let id = gid.x;
  let width = params.words[0].x;
  let height = params.words[0].y;
  if (width == 0u || height == 0u || id >= width * height) { return; }
  let x = id % width;
  let y = id / width;
  var r: array<u32, 32>;
  var pc = ${u(codeBase)};
  var steps = 0u;
  loop {
    switch (pc) {
${cases}
      default: { fail(1u); return; }
    }
  }
}`;
}

// Callers snapshot RAM while the WASM machine is suspended at submission.
// The cache must use these exact bytes: an address is not a kernel identity.
export function kernelBytes({ rom, ram, codeBase, codeLength, allowRamCode = false }) {
  requireRange(rom instanceof Uint8Array, 'rom must be Uint8Array payload bytes');
  requireRange(rom.byteLength > 0 && rom.byteLength <= MAX_CODE_BYTES, 'ROM payload must fit 4096 bytes');
  codeBase = uint(codeBase, 'codeBase');
  codeLength = uint(codeLength, 'codeLength');
  requireRange(typeof allowRamCode === 'boolean', 'allowRamCode must be boolean');
  requireRange(codeBase % 4 === 0 && codeLength % 4 === 0 && codeLength > 0 &&
    codeLength <= (allowRamCode ? 65536 : MAX_CODE_BYTES), 'kernel must be a complete aligned ROM range or permitted RAM range');
  if (codeBase + codeLength <= rom.byteLength) return rom.subarray(codeBase, codeBase + codeLength);
  requireRange(allowRamCode && ram instanceof Uint8Array && ram.length === MIRROR_BYTES - RAM_BASE &&
    codeBase >= RAM_BASE && codeBase + codeLength <= MIRROR_BYTES, 'kernel must be a complete aligned ROM range or permitted RAM range');
  return ram.subarray(codeBase - RAM_BASE, codeBase - RAM_BASE + codeLength);
}

export function compileKernel({ rom, ram, codeBase, codeLength, bindings, width, height, allowReadWrite = false, allowRamCode = false }) {
  const codeBytes = kernelBytes({ rom, ram, codeBase, codeLength, allowRamCode });
  width = uint(width, 'width');
  height = uint(height, 'height');
  requireRange(typeof allowReadWrite === 'boolean', 'allowReadWrite must be boolean');
  requireRange(width >= 1 && width <= 160 && height >= 1 && height <= 120, 'grid exceeds 160x120');
  const descriptors = validateBindings(bindings, rom.byteLength);
  const instructions = decode(codeBytes, codeBase, codeLength, descriptors, allowReadWrite);
  const blocks = basicBlocks(instructions);
  return {
    code: shader(blocks, codeBase, descriptors),
    entryPoint: 'main',
    workgroupSize: 64,
    instructionCount: instructions.length,
    blockCount: blocks.length,
    writableBindings: descriptors.filter(b => b.flags === 3).map(({ index, base, len }) => ({ index, base, len })),
    statusFlags: { bounds: 1, budget: 2, arithmetic: 4, contention: 8 },
  };
}
