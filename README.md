# Demo-bench agent kit

A standalone kit for agents writing small audiovisual programs for the DB32 benchmark machine. It includes the authoring skill, machine contracts, pinned WASM engine and linker, a self-extracting compressor, local validation tools and a browser viewer. The only example is a 22-line RGB starter.

Requires **Node.js 22+**. No package installation, Rust toolchain, network service or engine source checkout is needed.

## Use

Clone the [agent kit](https://github.com/janekm/demobench-agent-kit):

```sh
git clone https://github.com/janekm/demobench-agent-kit.git
cd demobench-agent-kit
```

Read [SKILL.md](SKILL.md) for authoring guidance. From this directory:

```sh
npm test
npm run validate -- ./assets/starter.asm --frames 120 --out ./artifacts/starter
npm run compress -- ./demo.asm -o ./demo.db32
npm run viewer
```

Open http://127.0.0.1:4173 and paste your assembly into the editor. Use `PORT=4174 npm run viewer` to choose another port. The viewer supports WASM reference execution and optional WebGPU acceleration.

To validate a candidate, pass its `.asm` or `.db32` path instead of the starter. The output directory contains the cartridge, sampled PNGs, a JSON report and, for SPU programs, stereo WAV audio. Only files listed in the latest report belong to that run.

Use `.profile dynamic-1` for fully compressed demos or GPU/SPU kernels generated
and changed in RAM. The compressor links the RAM image, tries DBLZ, byte-lane
filtering and adaptive range coding, and verifies guest extraction before
writing the cartridge. Decoder bytes count toward the 4 KiB payload. Read
[packing](references/packing.md) for RAM placement and [dynamic-1](references/dynamic.md)
for kernel snapshots and budgets. Compression, validation and preview all run
offline with Node; no Rust compiler or engine checkout is needed.

## Give to an agent

Share this repository and ask the agent to follow `SKILL.md`. It can run the tools directly, or install a copy of the kit as the `demo-bench` folder in its skills directory. Paths are resolved relative to the kit, so it can be cloned or extracted anywhere.

Keep the supplied engine, host tools and machine contracts fixed for a benchmark run. Put candidate source and captured output in separate working files. The report records source, cartridge and engine hashes, tested duration, faults and resource use. Reference WASM results are canonical; WebGPU preview intentionally allows different arithmetic and timing. This kit provides execution and evidence collection; it does not implement benchmark scoring or an agent security sandbox.

## Maintain and distribute

`manifest.json` pins the distributed files and WASM hash. `npm test` verifies those hashes and exercises the local validator. Commit the prebuilt `assets/engine/web/machine.wasm` along with the host tools and contracts so a fresh clone can run immediately.

```sh
npm run bundle
```

This explicitly refreshes the manifest and creates `artifacts/demo-bench-skill.tar.gz`, with a top-level `demo-bench` skill folder. Run `npm test` after refreshing the bundle.

Engine development happens in the separate [demobench repository](https://github.com/janekm/demobench). Maintainers can build and refresh this kit from that project with `npm run skill:pack -- --kit /absolute/path/to/this/repo`. This copies the engine, viewer and current author-facing contracts while retaining the kit's skill and maintenance files. Agent use and distribution do not depend on that checkout.
