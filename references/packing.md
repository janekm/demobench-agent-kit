# Self-extracting cartridges

```sh
node "$DEMO_BENCH/scripts/compress.mjs" demo.asm -o demo.db32
node "$DEMO_BENCH/scripts/validate.mjs" demo.db32 --frames 120 --out check
```

The offline packer links a program at its final RAM addresses and includes an
ordinary DB32 CPU decoder in the cartridge. The VM extracts itself; no host
decompression or external asset file is needed. Node.js 22+ is the only runtime
dependency. Both WASM modules are prebuilt and pinned in the manifest.

Use `.profile dynamic-1` for GPU/SPU code in the compressed image. The previous
profiles permit CPU/data in RAM but require kernels in an explicit `.section rom`.
The default section is `.section ram`; `.equ` and `.profile` are shared. An
explicit `.entry` must name CPU code in the RAM section. `.org` and names
beginning `__p` are reserved for the packer.

The default image address is `0x2c000`, with temporary scratch at `0x10000`.
Change these with `--load` and `--scratch`. Reserve the entire image, its word
padding, buffers, stack, and any generated kernels in your memory map. The
packer verifies bounds, disjoint scratch, exact extracted bytes, reset registers
and zero RAM outside the image at handoff. It cannot infer buffer addresses your
program computes later. Scratch is erased before application entry. Clocks keep
advancing during extraction, so startup consumes guest time.

Labels resolve to final RAM addresses, including GPU absolute branches. Use
`li` for absolute addresses: `addi ..., r0, label` has a signed 16-bit immediate
and cannot hold a RAM address. Bindings still use a base plus byte offsets. When
moving a ROM-wide binding from zero to the RAM image base, subtract the new base
from label-derived offsets and lengths. Copying raw GPU instructions elsewhere
does not relocate their embedded branch addresses.

The packer chooses the smallest complete payload, including the decoder, among
DBLZ matches, four-byte lane shuffling, adaptive range coding and a stored copy.
Use `--codec auto|dblz|range|store`, `--filter auto|none|shuffle4`, and `--chain 256`
to constrain the search. The shuffle filter requires DBLZ and disjoint temporary
RAM as large as the padded image. Range coding needs 512–2048 temporary bytes.
Small or high-entropy demos can grow. Payloads above 4096 bytes are rejected.

Output includes `.db32`, pasteable `.packed.asm`, JSON report, `.image.bin`, and
listing. Reports record all candidates, decoder size, RAM ranges, extraction
ticks and both WASM hashes. Validate the resulting cartridge for the whole
intended sequence, inspect images and audition its audio. Extraction checks,
canonical frame/audio checks, and browser real-time performance are separate.

The same cartridge runs on the updated deployed Studio at
https://demobench.janekm.com/studio. Paste `.packed.asm` there or in the local
viewer. Profiles and snapshot semantics are in [dynamic-1](dynamic.md).

## Experimental search

For RAM-only `dynamic-1` sources, `scripts/compress-research.mjs` (or
`npm run compress:research --`) adds byte contexts, range-coded LZ and decoder
shortening. Its options are `SOURCE.asm -o OUTPUT.db32 [--load 0x2c000]`.
Scratch is fixed at `0x10000`; candidates requiring overlapping scratch are
skipped. It retains the standard packer's result when smaller and verifies
exact guest extraction. It can also rescue images whose baseline pack exceeds
4 KiB. See [experimental packing](packing-research.md) for measured tradeoffs.
