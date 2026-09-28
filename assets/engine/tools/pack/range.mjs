// Binary adaptive range coder. Four independent literal trees exploit the four
// byte lanes of DB32 instructions. Models are synthesized in zeroed guest RAM.
export function rangeEncode(data, { lanes = 4, rate = 5 } = {}) {
  const probs = new Uint16Array(lanes * 256).fill(1024), bytes = [];
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
    for (let b = 7; b >= 0; b--) {
      const at = (i % lanes) * 256 + prefix, p = probs[at], bit = (data[i] >>> b) & 1;
      const bound = (range >>> 11) * p;
      if (!bit) { range = bound; probs[at] += (2048 - p) >>> rate; }
      else { low += BigInt(bound); range -= bound; probs[at] -= p >>> rate; }
      prefix = prefix * 2 + bit;
      if (range < 0x1000000) { range *= 256; shift(); }
    }
  }
  for (let i = 0; i < 5; i++) shift();
  return { bytes: Uint8Array.from(bytes), lanes, rate };
}

export function rangeDecode(bytes, length, { lanes = 4, rate = 5 } = {}) {
  if (![1, 2, 4].includes(lanes) || ![3, 4, 5, 6].includes(rate) || !Number.isInteger(length) || length < 1 || length > 131072) throw new Error('Invalid range parameters');
  let pos = 0, code = 0, range = 0xffffffff;
  const read = () => { if (pos === bytes.length) throw new Error('Truncated range stream'); return bytes[pos++]; };
  for (let i = 0; i < 5; i++) code = ((code << 8) | read()) >>> 0;
  const probs = new Uint16Array(lanes * 256).fill(1024), result = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    let prefix = 1;
    for (let b = 0; b < 8; b++) {
      const at = (i % lanes) * 256 + prefix, p = probs[at], bound = (range >>> 11) * p;
      let bit;
      if (code < bound) { bit = 0; range = bound; probs[at] += (2048 - p) >>> rate; }
      else { bit = 1; range -= bound; code -= bound; probs[at] -= p >>> rate; }
      prefix = prefix * 2 + bit;
      if (range < 0x1000000) { range *= 256; code = ((code << 8) | read()) >>> 0; }
    }
    result[i] = prefix;
  }
  return result;
}

export function rangeDecoder({ load, length, entry, modelAddress, lanes, rate }) {
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
    addi r14, r0, ${rate}
    li r15, ${modelAddress}
__p_byte:
    addi r10, r0, 1
${lanes === 1 ? '    mov r12, r15' : `    andi r12, r2, ${lanes - 1}\n    addi r8, r0, 9\n    shl r12, r12, r8\n    add r12, r12, r15`}
__p_symbol:
    add r9, r10, r10
    add r9, r12, r9
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
    shr r8, r6, r14
    sub r6, r6, r8
    add r10, r10, r10
    addi r10, r10, 1
    j __p_update
__p_zero:
    mov r4, r7
    addi r8, r0, 2048
    sub r8, r8, r6
    shr r8, r8, r14
    add r6, r6, r8
    add r10, r10, r10
__p_update:
    sh r6, 0(r9)
    bltu r4, r11, __p_normalize
__p_normalized:
    addi r8, r0, 256
    bltu r10, r8, __p_symbol
    sb r10, 0(r2)
    addi r2, r2, 1
    bltu r2, r3, __p_byte
    li r1, ${modelAddress}
    li r2, ${modelAddress + lanes * 512}
__p_clear:
    sw r0, 0(r1)
    addi r1, r1, 4
    bltu r1, r2, __p_clear
${Array.from({ length: 14 }, (_, i) => `    mov r${i + 1}, r0`).join('\n')}
    lui r15, 0x30
    j ${entry}
__p_normalize:
    li r7, __p_data_end
    beq r1, r7, __p_bad
    addi r8, r0, 8
    shl r4, r4, r8
    shl r5, r5, r8
    lbu r8, 0(r1)
    or r5, r5, r8
    addi r1, r1, 1
    j __p_normalized
__p_bad:
    .word 0xffffffff
__p_data:
`;
}
