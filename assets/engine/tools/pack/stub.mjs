// Every operation below is ordinary counted guest CPU code. No host decompressor.
export function decoder({ codec = 'dblz', k = 0, load, length, entry, scratch = null }) {
  const output = scratch ?? load;
  const reset = Array.from({ length: 14 }, (_, i) => `mov r${i + 1}, r0`).join('\n');
  const finish = scratch === null ? '' : `
    li r1, ${scratch}
    li r2, ${load}
    li r3, ${length / 4}
    mov r4, r0
    li r5, ${load + length}
__p_unshuffle:
    lbu r6, 0(r1)
    sb r0, 0(r1)
    sb r6, 0(r2)
    addi r1, r1, 1
    addi r2, r2, 4
    bltu r2, r5, __p_unshuffle
    addi r4, r4, 1
    li r2, ${load}
    add r2, r2, r4
    addi r3, r0, 4
    bltu r4, r3, __p_unshuffle
`;
  const common = `
__p_start:
    li r1, __p_data
    li r2, ${output}
    li r3, ${output + length}
`;
  if (codec === 'store') return `${common}
__p_copy:
    lbu r4, 0(r1)
    sb r4, 0(r2)
    addi r1, r1, 1
    addi r2, r2, 1
    bltu r2, r3, __p_copy
${finish}
${reset}
    lui r15, 0x30
    j ${entry}
__p_data:
`;
  return `${common}
    addi r4, r0, 1
    li r5, __p_data_end
    addi r11, r0, 1
    li r15, ${output}
__p_token:
    beq r2, r3, __p_done
    jal r14, __p_bit
    bne r8, r0, __p_match
    mov r7, r0
    addi r6, r0, 8
    jal r13, __p_bits
    sb r7, 0(r2)
    addi r2, r2, 1
    j __p_token
__p_match:
    jal r12, __p_gamma
    addi r10, r7, 1
    add r8, r2, r10
    bltu r3, r8, __p_bad
    jal r12, __p_gamma
${k ? `    addi r6, r0, ${k}\n    jal r13, __p_bits` : ''}
    sub r9, r2, r7
    addi r9, r9, ${(1 << k) - 1}
    bltu r9, r15, __p_bad
__p_match_copy:
    lbu r8, 0(r9)
    sb r8, 0(r2)
    addi r9, r9, 1
    addi r2, r2, 1
    addi r10, r10, -1
    bne r10, r0, __p_match_copy
    j __p_token
__p_gamma:
    addi r7, r0, 1
__p_gamma_loop:
    jal r14, __p_bit
    beq r8, r0, __p_gamma_done
    jal r14, __p_bit
    add r7, r7, r7
    or r7, r7, r8
    j __p_gamma_loop
__p_gamma_done:
    jalr r0, 0(r12)
__p_bits:
    jal r14, __p_bit
    add r7, r7, r7
    or r7, r7, r8
    addi r6, r6, -1
    bne r6, r0, __p_bits
    jalr r0, 0(r13)
__p_bit:
    bne r4, r11, __p_have_bit
    beq r1, r5, __p_bad
    lbu r4, 0(r1)
    addi r1, r1, 1
    ori r4, r4, 256
__p_have_bit:
    andi r8, r4, 1
    shr r4, r4, r11
    jalr r0, 0(r14)
__p_bad:
    .word 0xffffffff
__p_done:
${finish}
${reset}
    lui r15, 0x30
    j ${entry}
__p_data:
`;
}
