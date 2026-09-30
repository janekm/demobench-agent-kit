// Experimental range models. Kept separate from the production candidate search.
import { rangeDecoder } from './range.mjs';

export function modelBytes({ context = 'lane', bits = 2, lanes = 4 } = {}) {
  return lanes * 512 * (context === 'lane' ? 1 : 2 ** bits);
}

function contextIndex(data, i, { context = 'lane', bits = 2, lanes = 4 }) {
  const lane = i % lanes, mask = (1 << bits) - 1;
  if (context === 'lane') return lane;
  let previous;
  if (['prev-byte', 'prev-low', 'prev-zero'].includes(context)) previous = data[i - 1] ?? 0;
  else if (context === 'prev-lane') previous = data[i - 4] ?? 0;
  else previous = data[i - ((i & 3) || 4)] ?? 0;
  return lane * (1 << bits) + (context === 'prev-zero' ? Number(previous !== 0) : ['opcode-low', 'prev-low'].includes(context) ? previous & mask : previous >>> (8 - bits));
}

export function researchEncode(data, options = {}) {
  const { rate = 3, rates, seed = new Uint8Array() } = options;
  const probs = new Uint16Array(modelBytes(options) / 2).fill(1024), bytes = [];
  const train = (input) => {
    for (let i = 0; i < input.length; i++) {
      let prefix = 1;
      const base = contextIndex(input, i, options) * 256, speed = rates?.[i % 4] ?? rate;
      for (let b = 7; b >= 0; b--) {
        const at = base + prefix, p = probs[at], bit = (input[i] >>> b) & 1;
        probs[at] = bit ? p - (p >>> speed) : p + ((2048 - p) >>> speed);
        prefix = prefix * 2 + bit;
      }
    }
  };
  train(seed);
  let low = 0n, range = 0xffffffff, cache = 0, pending = 1;
  const shift = () => {
    const bottom = Number(low & 0xffffffffn), carry = Number(low >> 32n);
    if (bottom < 0xff000000 || carry) {
      let byte = cache;
      do { bytes.push((byte + carry) & 255); byte = 255; } while (--pending);
      cache = bottom >>> 24;
    }
    pending++; low = BigInt((bottom << 8) >>> 0);
  };
  for (let i = 0; i < data.length; i++) {
    let prefix = 1;
    const base = contextIndex(data, i, options) * 256, speed = rates?.[i % 4] ?? rate;
    for (let b = 7; b >= 0; b--) {
      const at = base + prefix, p = probs[at], bit = (data[i] >>> b) & 1;
      const bound = (range >>> 11) * p;
      if (!bit) { range = bound; probs[at] += (2048 - p) >>> speed; }
      else { low += BigInt(bound); range -= bound; probs[at] -= p >>> speed; }
      prefix = prefix * 2 + bit;
      if (range < 0x1000000) { range *= 256; shift(); }
    }
  }
  for (let i = 0; i < 5; i++) shift();
  return Uint8Array.from(bytes);
}

export function transform(data, filter = 'none', inverse = false) {
  const out = Uint8Array.from(data);
  if (filter === 'none') return out;
  if (!['xor4', 'sub4'].includes(filter)) throw new Error(`Unknown research filter ${filter}`);
  for (let i = 4; i < data.length; i++) {
    const prev = inverse ? out[i - 4] : data[i - 4];
    out[i] = filter === 'xor4' ? data[i] ^ prev : inverse ? data[i] + prev : data[i] - prev;
  }
  return out;
}

export function researchDecoder({ load, length, entry, modelAddress = 0x10000, context = 'lane', bits = 2,
  lanes = 4, rate = 3, rates, filter = 'none', seeded = false } = {}) {
  if (seeded && (context !== 'lane' || rates || filter !== 'none')) throw new Error('Seed warmup uses a fixed-rate lane model');
  if (context !== 'lane' && lanes !== 4) throw new Error('Context models require four lanes');
  let stub = rangeDecoder({ load, length, entry, modelAddress, lanes, rate });
  const laneCode = lanes === 1 ? '    mov r12, r15' : `    andi r12, r2, ${lanes - 1}\n    addi r8, r0, 9\n    shl r12, r12, r8\n    add r12, r12, r15`;
  if (context !== 'lane') {
    const adjacent = ['prev-byte', 'prev-low', 'prev-zero'].includes(context);
    const read = adjacent ? '    lbu r7, -1(r2)' : context === 'prev-lane' ? '    lbu r7, -4(r2)' : `    andi r8, r2, 3
    bne r8, r0, __p_ctx_offset
    addi r8, r0, 4
__p_ctx_offset:
    sub r8, r2, r8
    lbu r7, 0(r8)`;
    stub = stub.replace(laneCode, `    mov r7, r0
    li r8, ${load + (adjacent ? 1 : 4)}
    bltu r2, r8, __p_ctx_zero
${read}
__p_ctx_zero:
${context === 'prev-zero' ? '    sltu r7, r0, r7' : ['opcode-low', 'prev-low'].includes(context) ? `    andi r7, r7, ${(1 << bits) - 1}` : `    addi r8, r0, ${8 - bits}\n    shr r7, r7, r8`}
    andi r12, r2, 3
    addi r8, r0, ${bits}
    shl r12, r12, r8
    or r12, r12, r7
    addi r8, r0, 9
    shl r12, r12, r8
    add r12, r12, r15`);
    // For opcode contexts bytes 1..3 in the first word already have an opcode.
    if (context.startsWith('opcode')) stub = stub.replace(`li r8, ${load + 4}\n    bltu r2`, `li r8, ${load + 1}\n    bltu r2`);
  }
  if (rates) {
    const packed = rates.reduce((n, r, i) => n | (r << (i * 3)), 0);
    stub = stub.replace(`    addi r14, r0, ${rate}`, '')
      .replace('__p_symbol:', `    andi r8, r2, 3
    add r7, r8, r8
    add r8, r8, r7
    li r14, ${packed}
    shr r14, r14, r8
    andi r14, r14, 7
__p_symbol:`);
  }
  stub = stub.replace(`li r2, ${modelAddress + lanes * 512}`, `li r2, ${modelAddress + modelBytes({ context, bits, lanes })}`);
  if (filter !== 'none') {
    const inverse = `    li r1, ${load + 4}
    li r2, ${load + length}
__p_inverse:
    bltu r1, r2, __p_inverse_body
    j __p_inverse_done
__p_inverse_body:
    lbu r6, 0(r1)
    lbu r7, -4(r1)
    ${filter === 'xor4' ? 'xor' : 'add'} r6, r6, r7
    sb r6, 0(r1)
    addi r1, r1, 1
    j __p_inverse
__p_inverse_done:
`;
    stub = stub.replace(`    li r1, ${modelAddress}\n    li r2,`, inverse + `    li r1, ${modelAddress}\n    li r2,`);
  }
  if (seeded) {
    // Warm up from this decoder's own byte prefix. The prefix ends before the
    // stream-bound immediate, so its contents do not depend on stream length.
    const warmup = `    li r2, __p_start
    li r3, __p_seed_end
    li r15, ${modelAddress}
    addi r14, r0, ${rate}
__p_train_byte:
${laneCode}
    lbu r4, 0(r2)
    addi r5, r0, 7
    addi r10, r0, 1
__p_train_bit:
    add r9, r10, r10
    add r9, r12, r9
    lhu r6, 0(r9)
    bne r6, r0, __p_train_p
    addi r6, r0, 1024
__p_train_p:
    shr r7, r4, r5
    andi r7, r7, 1
    add r10, r10, r10
    or r10, r10, r7
    bne r7, r0, __p_train_one
    addi r8, r0, 2048
    sub r8, r8, r6
    shr r8, r8, r14
    add r6, r6, r8
    j __p_train_update
__p_train_one:
    shr r8, r6, r14
    sub r6, r6, r8
__p_train_update:
    sh r6, 0(r9)
    addi r5, r5, -1
    blt r5, r0, __p_train_next
    j __p_train_bit
__p_train_next:
    addi r2, r2, 1
    bltu r2, r3, __p_train_byte
`;
    stub = stub.replace('__p_start:\n', '__p_start:\n' + warmup).replace('__p_normalize:\n', '__p_seed_end:\n__p_normalize:\n');
  }
  return stub;
}

// Decoder-only peepholes; application code and addresses remain byte-identical.
export function compactStub(stub) {
  return stub.replace(/^(\s*)li (r\d+), ([^\n]+)$/gm, (line, space, reg, value) => {
    if (/^__p_(data(?:\+1|_end)?|start|seed_end)$/.test(value)) return `${space}addi ${reg}, r0, ${value}`;
    const n = Number(value);
    if (!Number.isInteger(n)) return line;
    if (n >= -32768 && n <= 32767) return `${space}addi ${reg}, r0, ${n}`;
    if (n >= 0 && n <= 0xffffffff && n % 4096 === 0) return `${space}lui ${reg}, ${n / 4096}`;
    return line;
  });
}
