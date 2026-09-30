# Experimental DB32 packing

Run this optional search on a RAM-only `.profile dynamic-1` source:

```sh
node "$DEMO_BENCH/scripts/compress-research.mjs" ./demo.asm -o ./demo.db32 --load 0x2c000
node "$DEMO_BENCH/scripts/validate.mjs" ./demo.db32 --frames 120 --out ./check
```

The search considers the standard compressor and experimental families. It
selects the smallest complete payload, including the guest decoder, and runs
that cartridge on canonical WASM to check exact extraction, reset registers
and zero RAM outside the image. Sidecars record the selected method, candidates,
module/image/cartridge hashes, RAM layout and extraction ticks. The 4096-byte
payload limit is unchanged. No host decompression or extra runtime data is used.

Only `--load` and `-o` are accepted. Reserve the linked image at the chosen load
address. Temporary models start at `0x10000`, need up to 32768 bytes during the
search, and are cleared before handoff; candidates overlapping the image are
skipped. The selected report gives the actual scratch requirement. The regular
compressor remains the default and supports the broader profile/ROM-section
options described in [packing](packing.md).

## Measured results

The 30 September 2026 frozen corpus produced the following complete payloads:

| Cartridge | Standard | Experimental | Saved |
| --- | ---: | ---: | ---: |
| Koi | 4061 | 3991 | 70 |
| Pelican, 30 Sep | 4045 | 3887 | 158 |
| Pelican on a Bicycle | 4094 | 4032 | 62 |
| Lightcone | 4071 | 4055 | 16 |
| Elsewhere | 4084 | 4068 | 16 |
| Limit Set | 4074 | 4040 | 34 |
| Mega | 4070 | 4013 | 57 |
| Carpet | 4093 | 3990 | 103 |

The useful additions were previous-byte zero/nonzero contexts, range-coded LZ
and shorter decoder instructions. Training probabilities from the decoder's own
machine code saved only 1–9 stream bytes while adding 148 bytes of warmup code.

All eight winners extracted byte-identical images and matched 120 frames of
video/audio against clock-aligned baseline runs. Synthetic tests additionally
cover every experimental model, seeded code, distance settings, scratch cleanup,
register reset and RAM boundaries. This does not establish full-sequence artistic
quality or browser performance; validate the complete intended demo separately.

The largest saving, Pelican's hybrid LZ/range encoding, increases virtual guest
startup from 28.6 ms to 75.4 ms. Most context winners add about 5 ms and use 4096
scratch bytes. These are guest clock costs, not host wall times.

The [full report](https://github.com/janekm/demobench/blob/main/docs/packing-research.md)
and [frozen reproducible corpus](https://github.com/janekm/demobench/tree/main/tools/pack/research-fixtures)
live in the engine repository. This portable kit includes the single-source
search and synthetic tests; its only bundled demo example remains the starter.
