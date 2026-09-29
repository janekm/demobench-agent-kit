# DB32 dynamic-1: RAM compute kernels

Cartridge version **4**, selected by `.profile dynamic-1`, extends `spu-1` with
GPU and SPU code in RAM. All CPU, video, audio, binding, timing and arithmetic
rules remain unchanged. The cartridge still contains **1..4096 payload bytes**
plus its 32-byte header. RAM remains `0x10000..0x2ffff` (128 KiB). Profiles 1–3
continue to accept only ROM kernels with a 4096-byte code limit.

## Code submission and edits

GPU CODE_BASE / CODE_LEN and SPU CODE_BASE / CODE_LEN accept a complete aligned
range wholly inside ROM or RAM. Length must be nonzero, four-byte aligned, and
at most **65,536 bytes**. ROM cannot extend beyond the actual cartridge payload.
Gaps, crossing the ROM/RAM boundary, overflow, and crossing RAM_END fault.

At GPU START the engine validates every instruction, literal, operand and branch
boundary, then snapshots the decoded code. The entire dispatch uses that
snapshot, including later waves. CPU or GPU edits to the backing RAM affect the
**next submission**, never an instruction already submitted. Code itself holds
no implicit memory lease. Ordinary binding leases still apply when the same
RAM is also bound as data. GPU writes may generate another kernel for submission
after that dispatch finishes. A kernel may overwrite its own backing bytes;
the current instruction snapshot remains fixed.

The SPU validates its configured kernel when enabled, then validates and takes
a new snapshot at **each audio block boundary**. Edits between blocks therefore
change subsequent synthesis. Hardware fallback resumes the original snapshot.
SPU enable and each block's code read conflict with an active GPU writable
binding over that range, even if code is not declared as an SPU data binding.
Existing SPU/GPU data-binding conflicts remain enforced.

GPU branches still use absolute guest addresses and must target instruction
starts inside the submitted range. A literal word cannot be a branch target.
GPU dispatch work remains capped at 1,048,576 ticks; SPU work remains capped at
65,536 ticks per block. A larger code limit does not enlarge these work budgets.
GPU FEATURE_ID is `0x00010002` in this profile; older profiles retain `0x00010001`.

## WebGPU preview

The machine freezes at external submission. The worker copies ROM and RAM at
that point, and the compiler decodes the selected range at its absolute guest
address. Pipeline cache identity includes the exact kernel bytes, addresses and
descriptors, so rewriting a literal at the same RAM address recompiles it.
Shader code is immutable for the submitted dispatch. Ordinary bounds checks,
arithmetic limitations and WASM fallback still apply. The per-invocation
termination guards are 1,048,576 instructions for GPU jobs and 65,536 for SPU
jobs, derived from the reference work budgets; there is no separate 8,192-step
limit. Native WebGPU floating-point results remain a preview, not canonical
WASM equivalence.

## Authoring

See [dynamic-kernel.asm](../examples/dynamic-kernel.asm) for a CPU that copies a
kernel into RAM and patches a literal every frame. No compression is required
to use this feature. See [self-extracting cartridges](../docs/packing.md) for
packing an entire CPU/GPU/SPU image, including sources larger than 4096 bytes.

Runtime code occupies ordinary guest RAM. Reserve it explicitly alongside
framebuffers, sample output, data, persistent state and the stack. Two RGB888
pages alone consume 115,200 bytes, leaving 15,872 bytes for everything else.
