// Hybrid experiment: DBLZ parses with adaptive arithmetic coding for flags,
// literal trees, gamma lengths/distances, and distance low bits.
export function lzTokens(candidate, length) {
  let at = 0, out = 0;
  const bit = () => (candidate.bytes[at >>> 3] >>> (at++ & 7)) & 1;
  const gamma = () => { let n = 1; while (bit()) n = n * 2 + bit(); return n; };
  const tokens = [];
  while (out < length) {
    if (!bit()) {
      let value = 0; for (let i = 0; i < 8; i++) value = value * 2 + bit();
      tokens.push({ at: out++, value });
    } else {
      const count = gamma() + 1; let distance = gamma() - 1;
      for (let i = 0; i < candidate.k; i++) distance = distance * 2 + bit();
      tokens.push({ at: out, count, distance: distance + 1 }); out += count;
    }
  }
  return tokens;
}

export function lzRangeEncode(tokens, { k, rate = 4 }) {
  const probs = new Uint16Array(1200).fill(1024), bytes = [];
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
  const bit = (at, value) => {
    const p = probs[at], bound = (range >>> 11) * p;
    if (!value) { range = bound; probs[at] += (2048 - p) >>> rate; }
    else { low += BigInt(bound); range -= bound; probs[at] -= p >>> rate; }
    if (range < 0x1000000) { range *= 256; shift(); }
  };
  const gamma = (base, n) => {
    let at = base;
    for (let i = 30 - Math.clz32(n); i >= 0; i--) { bit(at++, 1); bit(at++, (n >>> i) & 1); }
    bit(at, 0);
  };
  for (const t of tokens) {
    bit(0, t.distance ? 1 : 0);
    if (!t.distance) {
      let prefix = 1; const base = 16 + (t.at % 4) * 256;
      for (let b = 7; b >= 0; b--) { const v = (t.value >>> b) & 1; bit(base + prefix, v); prefix = prefix * 2 + v; }
    } else {
      gamma(1040, t.count - 1); gamma(1104, ((t.distance - 1) >>> k) + 1);
      for (let b = k - 1; b >= 0; b--) bit(1168 + k - 1 - b, ((t.distance - 1) >>> b) & 1);
    }
  }
  for (let i = 0; i < 5; i++) shift();
  return Uint8Array.from(bytes);
}

export function lzRangeDecoder({ load, length, entry, k, rate = 4, modelAddress = 0x10000 }) {
  return `
__p_start:
    li r1, __p_data+1
    li r2, ${load}
    li r3, ${load + length}
    addi r4, r0, -1
    mov r5, r0
    addi r6, r0, 4
    addi r8, r0, 8
__p_init:
    shl r5, r5, r8
    lbu r7, 0(r1)
    or r5, r5, r7
    addi r1, r1, 1
    addi r6, r6, -1
    bne r6, r0, __p_init
    lui r11, 0x1000
    li r15, ${modelAddress}
__p_token:
    beq r2, r3, __p_done
    mov r9, r15
    jal r13, __p_bit
    bne r10, r0, __p_match
    andi r14, r2, 3
    addi r8, r0, 9
    shl r14, r14, r8
    addi r14, r14, 32
    add r14, r14, r15
    addi r12, r0, 1
__p_literal:
    add r9, r12, r12
    add r9, r9, r14
    jal r13, __p_bit
    add r12, r12, r12
    or r12, r12, r10
    addi r8, r0, 256
    bltu r12, r8, __p_literal
    sb r12, 0(r2)
    addi r2, r2, 1
    j __p_token
__p_match:
    addi r9, r15, 2080
    jal r14, __p_gamma
    addi r12, r12, 1
    add r8, r2, r12
    bltu r3, r8, __p_bad
    sw r12, 2400(r15)
    addi r9, r15, 2208
    jal r14, __p_gamma
${k ? `    addi r9, r15, 2336
    addi r14, r0, ${k}
__p_low:
    jal r13, __p_bit
    add r12, r12, r12
    or r12, r12, r10
    addi r9, r9, 2
    addi r14, r14, -1
    bne r14, r0, __p_low` : ''}
    sub r12, r2, r12
    addi r12, r12, ${(1 << k) - 1}
    li r8, ${load}
    bltu r12, r8, __p_bad
    lw r10, 2400(r15)
__p_copy:
    lbu r8, 0(r12)
    sb r8, 0(r2)
    addi r12, r12, 1
    addi r2, r2, 1
    addi r10, r10, -1
    bne r10, r0, __p_copy
    j __p_token
__p_gamma:
    addi r12, r0, 1
__p_gamma_loop:
    jal r13, __p_bit
    beq r10, r0, __p_gamma_done
    addi r9, r9, 2
    jal r13, __p_bit
    add r12, r12, r12
    or r12, r12, r10
    addi r9, r9, 2
    j __p_gamma_loop
__p_gamma_done:
    jalr r0, 0(r14)
__p_bit:
    lhu r6, 0(r9)
    bne r6, r0, __p_probability
    addi r6, r0, 1024
__p_probability:
    addi r8, r0, 11
    shr r7, r4, r8
    mul r7, r7, r6
    bltu r5, r7, __p_zero
    sub r5, r5, r7
    sub r4, r4, r7
    addi r8, r0, ${rate}
    shr r8, r6, r8
    sub r6, r6, r8
    addi r10, r0, 1
    j __p_update
__p_zero:
    mov r4, r7
    addi r8, r0, 2048
    sub r8, r8, r6
    addi r7, r0, ${rate}
    shr r8, r8, r7
    add r6, r6, r8
    mov r10, r0
__p_update:
    sh r6, 0(r9)
    bltu r4, r11, __p_normalize
__p_return:
    jalr r0, 0(r13)
__p_normalize:
    li r7, __p_data_end
    beq r1, r7, __p_bad
    addi r8, r0, 8
    shl r4, r4, r8
    shl r5, r5, r8
    lbu r8, 0(r1)
    or r5, r5, r8
    addi r1, r1, 1
    j __p_return
__p_bad:
    .word 0xffffffff
__p_done:
    li r1, ${modelAddress}
    li r2, ${modelAddress + 2404}
__p_clear:
    sw r0, 0(r1)
    addi r1, r1, 4
    bltu r1, r2, __p_clear
${Array.from({ length: 14 }, (_, i) => `    mov r${i + 1}, r0`).join('\n')}
    lui r15, 0x30
    j ${entry}
__p_data:
`;
}
