# DB32 spu-1: audio-clocked signal compute

Cartridge version 3 (`.profile spu-1`) includes CPU, GPU, video and the SPU at `0x000f6000`. Versions 1/2 keep their original absent-SPU behavior. Payload 4096 bytes; RAM 128 KiB. The SPU has **no oscillator, envelope, filter, instrument, voice, mixer, or wavetable register**. Such algorithms are guest kernels operating on ordinary buffers.

## Model

A bounded compute job runs at every audio block boundary. It executes the existing gpu-1 binary instruction set (`g.*`) over a configurable invocation grid, with four checked bindings and sixteen uniforms. Registers reset each invocation; persistent state lives in guest RAM. Independent samples can be separate invocations. Recurrent DSP can instead use one invocation per independent stream and loop over time within that invocation. Guest code performs all interpolation, oscillation, envelopes, filtering, routing, mixing and final stereo writes.

The output contract is 256 interleaved stereo binary32 sample frames in guest RAM (2048 bytes), at 48 kHz. A block event occurs every 65,536 machine ticks, first at 65,536. The completed kernel's output is copied to a bounded host PCM queue. Samples must be finite; final output clamps to [-1,1]. This is an output-format rule, not a synthesis feature. Disabled SPU emits a silent block. CPU parameters are sampled at block boundaries, not individual sample times.

Uniform 14 is the first absolute sample-frame index of the current block, modulo 2^32; uniform 15 is 48000. User uniforms 0..13 are arbitrary raw words. Kernels derive time from these and invocation IDs. The CPU controls sequencing and parameters through normal instructions. Counted ROM/RAM contain all code, tables, samples, state and output. There is no host-generated scene, sound or asset.

## Ordering, bounds, reference execution

At equal machine ticks: CPU commit, GPU commit, SPU block event, video scanout. CPU HALT/WFI does not stop audio; SPU does not wake WFI. Reference SPU jobs execute atomically at their block event, running a separate instance of the shared compute interpreter against guest memory. Their **work limit is 65,536 virtual compute ticks per block**, checked against the interpreter's next-event tick. This is a work quota; it does not advance the central machine clock or overlap CPU execution. Error causes a terminal guest fault and does not publish a partial audio block. Already committed guest memory effects may remain for diagnosis.

SPU bindings cannot conflict with bindings held by an active GPU dispatch: read-only/read-only sharing is allowed; any overlapping writer faults at the SPU event. Kernels/source ranges use the existing gpu-1 validation. Output must be aligned 4, wholly within a writable binding and RAM. No unbounded work or hidden state allocation. A host queue of 8192 stereo frames drops new frames on overflow, incrementing a saturating overrun counter; synthesis state and time still advance.

## MMIO

Aligned 32-bit only; unknown register accesses fault. The reserved word in each binding descriptor is readable/writable storage, but must be zero at validation, matching gpu-1. Configuration is mutable between blocks, but frozen while an external block is pending. CONTROL=1 validates the full configuration before enabling. Block submission validates again, so later bad descriptor edits cannot cause unchecked accesses.

| Offset | Field | Access/meaning |
| ---: | --- | --- |
| 0x00 | CONTROL | RW 0 disabled,1 enabled |
| 0x04 | STATUS | RO 0 disabled,1 enabled/ready,2 pending external,3 fault |
| 0x08 | RATE | RO 48000 |
| 0x0c | BLOCK_FRAMES | RO 256 |
| 0x10 | BLOCKS | RO completed block events low 32 (includes silence) |
| 0x14 | SAMPLES_LO | RO emitted timeline sample frames low 32 |
| 0x18 | SAMPLES_HI | RO high 32 |
| 0x1c | QUEUED | RO stereo frames queued for host |
| 0x20 | OVERRUNS | RO dropped host frames |
| 0x24 | LAST_TICKS | RO reference kernel work, zero for external completion |
| 0x28 | PEAK | RO raw f32 bits, absolute peak of last block |
| 0x2c | WORK_LIMIT | RO 65536 |
| 0x40 | CODE_BASE | RW aligned ROM address |
| 0x44 | CODE_LEN | RW bytes, at most 4096 |
| 0x48 | GRID_X | RW 1..160 |
| 0x4c | GRID_Y | RW 1..120 |
| 0x50 | OUTPUT_BASE | RW interleaved stereo f32 output address |
| 0x100..0x13f | BINDINGS | Four descriptors, stride 16: base,len,flags,reserved (identical to gpu-1) |
| 0x200..0x237 | UNIFORMS0..13 | RW raw words |
| 0x238/0x23c | TIME/RATE | RO current block start index/rate |

## Shared kernel ISA and WebGPU

Use the [gpu-1 instruction encoding](gpu.md). No audio-specific synthesis opcodes. The same compiler lowers kernels to WGSL. Native GPU arithmetic prioritizes speed; it need not reproduce WASM floats or cross-invocation store order. Each invocation may read/write its own state and output; algorithms with cross-invocation dependencies should use reference WASM or explicit phases/blocks. Hardware read/write loads use atomic memory operations, but those do not turn data races into deterministic algorithms. Buffer bounds, tail masking and bounded instruction loops remain enforced. Invalid hardware jobs fall back to the original pending reference job before output is copied.

Hardware output returns to guest RAM, then the SPU validates/copies the same PCM format. The central machine freezes at the block event while awaiting hardware, so later CPU commands cannot race that block. AudioWorklet playback is a separate bounded queue, resampling 48 kHz PCM to the device rate. It starts muted and needs an explicit user gesture. Queue underruns produce silence; pause/reset/rebuild flush playback. Reference WAV capture uses exactly the WASM-generated PCM.

The SPU WebGPU termination guard permits **65,536 instructions per invocation**.
Since each reference instruction costs at least one compute tick, any invocation
in a block that passes the canonical 65,536-tick whole-block budget fits this
guard. It is not divided by the invocation count and does not introduce a
separate authoring limit. Reference validation still defines work acceptance.
