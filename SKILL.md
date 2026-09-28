---
name: demo-bench
description: Write and iterate on tiny DB32 demo-bench assembly cartridges, including GPU visuals and SPU audio, using a bundled local WASM engine for validation and preview.
---

# Demo-bench

Create a self-contained `.asm` demo for DB32. All rendering, synthesis, tables and sequencing belong in the guest cartridge. Use the bundled engine as the target; keep host-side generation out of the running demo.

## Machine

Read [CPU, assembler and video](references/machine.md). For compute graphics also read [GPU](references/gpu.md); for audio read both GPU and [SPU](references/spu.md). These describe the implemented machine, not a proposed architecture.

- Select `.profile bootstrap-1`, `gpu-1`, `spu-1` (includes GPU), or `dynamic-1` (GPU/SPU code in RAM). Payload is **4,096 bytes**, plus a 32-byte header; RAM is **128 KiB** at `0x10000..0x2ffff`.
- Screen: **160×120**, indexed 1/2/4/8-bit or RGB888. Video COMMIT latches at vblank; allow a further frame for scanout. CPU HALT leaves peripherals running.
- CPU has integer arithmetic. GPU/SPU share `g.*` kernels; there are no built-in oscillators, instruments or drawing primitives. No DMA or general IRQ controller is implemented.
- Plan buffer ranges and kernel budgets before coding. Avoid CPU access to active GPU writable bindings and GPU/SPU binding conflicts. Persistent DSP state belongs in RAM, not registers.
- For compressed or runtime-generated kernels, read [dynamic-1](references/dynamic.md). GPU code is snapshotted at dispatch; SPU code is snapshotted per audio block. RAM kernels can be up to 64 KiB; existing work budgets still apply.

## Write and validate

Set `DEMO_BENCH` to the absolute directory containing this SKILL.md. Requires **Node.js 22+**; no install, Rust build, network or external packages are needed. The only example is [a tiny RGB starter](assets/starter.asm); copy it into the working directory if useful.

```sh
node "$DEMO_BENCH/scripts/validate.mjs" ./demo.asm --frames 120 --out ./check
node "$DEMO_BENCH/scripts/viewer.mjs"
```

To fit a larger program, read [packing and RAM layout](references/packing.md):

```sh
node "$DEMO_BENCH/scripts/compress.mjs" ./demo.asm -o ./demo.db32
node "$DEMO_BENCH/scripts/validate.mjs" ./demo.db32 --frames 120 --out ./check
```

The compressor links labels at their final RAM addresses and chooses a guest
decoder plus compressed stream within the 4,096-byte payload limit. It uses a
bundled WASM linker, so compression also needs only Node. Use `dynamic-1` to
compress GPU/SPU kernels. Reserve the image (`--load`, default `0x2c000`) and
temporary scratch (`--scratch`, default `0x10000`) in the memory plan. Scratch
is cleared before handoff. The generated `.packed.asm` can be pasted into the
viewer or deployed Studio. Validate the packed cartridge for its full sequence;
successful extraction alone does not prove safe later buffer use or good output.

Validation also accepts `.db32`. It runs the reference WASM engine and writes `demo.db32`, sampled PNGs, `report.json`, and stereo `audio.wav` for SPU cartridges. `--frames` is virtual 60 Hz frames (1–3600); choose enough to cover startup and the intended sequence. Exit failure means assembly, load, runtime or capture failure. Success means only that the requested interval ran: inspect the images and audition audio for the requested artistic result. Check payload, GPU work and audio peaks/overruns in the report.

The viewer serves on localhost:4173 (`PORT=4174` selects another port). Paste the source into its editor and **Assemble & run**; **Sound on** enables audio. WASM is canonical. WebGPU is a faster preview with different arithmetic/timing; verify the reported active backend if acceleration matters. GPU loads from writable bindings fall back to WASM; SPU permits each invocation to access its own persistent state. Avoid dependencies between concurrent invocations.

Deliver the source, compiled cartridge, representative captures and validation report. State the tested duration and backend; neither a single screenshot nor virtual ticks establish real-time performance.
