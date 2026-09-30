import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { linkSource, packSource, writePacked } from './pack.mjs';
import { createLinker } from './linker.mjs';
import { createMachine } from '../../scripts/wasm-host.mjs';
import { compressCandidates } from './codec.mjs';
import { decoder } from './stub.mjs';
import { researchEncode, researchDecoder, modelBytes, transform, compactStub } from './research-range.mjs';
import { lzTokens, lzRangeEncode, lzRangeDecoder } from './research-lzrange.mjs';

export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const byteAsm = bytes => Array.from({ length: Math.ceil(bytes.length / 24) }, (_, i) => `.byte ${[...bytes.slice(i * 24, i * 24 + 24)]}`).join('\n');
const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');

export function verifyExtraction(cartridge, image, maxTicks = 100_000_000) {
  const machine = createMachine(); machine.load(cartridge);
  let ticks = 0;
  while (machine.exports.db_pc() !== image.entry && ticks < maxTicks) {
    machine.run(1); ticks++;
    if (ticks % 204800 === 0) machine.audio();
  }
  assert.ok(ticks < maxTicks, 'Guest extraction deadline');
  const ram = new Uint8Array(machine.exports.memory.buffer, machine.exports.db_ram_ptr(), 131072);
  assert.deepEqual(Buffer.from(ram.slice(image.load - 0x10000, image.load - 0x10000 + image.data.length)), Buffer.from(image.data));
  assert.ok(!ram.slice(0, image.load - 0x10000).some(x => x));
  assert.ok(!ram.slice(image.load - 0x10000 + image.data.length).some(x => x));
  for (let r = 1; r < 16; r++) assert.equal(machine.exports.db_register(r) >>> 0, r === 15 ? 0x30000 : 0);
  return { machine, verification: { exactRamImage: true, resetRegisters: true, otherRamZero: true,
    extractionTicks: ticks, virtualMilliseconds: ticks / 12288, canonicalWasmSha256: machine.wasmHash } };
}

export function scan(source, load) {
  const image = linkSource(source, load), linker = createLinker();
  assert.equal(image.profile, 4, 'Research corpus requires dynamic-1');
  assert.equal(image.rom.length, 0, 'Research corpus uses RAM-only dynamic images');
  const rows = [], artifacts = new Map();
  function add(family, options) {
    const params = { load, length: image.data.length, entry: image.entry, modelAddress: 0x10000, ...options };
    const scratch = modelBytes(params);
    if (0x10000 + scratch > load) return;
    const stub = options.compact ? compactStub(researchDecoder(params)) : researchDecoder(params);
    const linked = linker.link(`.equ __p_data_end, 0\n${stub}`);
    if (options.seeded) params.seed = linked.bytes.slice(0, linked.symbols.__p_seed_end);
    const bytes = researchEncode(transform(image.data, options.filter), params);
    const row = { family, options, decoderBytes: linked.bytes.length, compressedBytes: bytes.length,
      payloadBytes: linked.bytes.length + bytes.length, scratchBytes: scratch,
      ...(options.seeded ? { seedBytes: params.seed.length, seedSha256: sha(params.seed) } : {}) };
    rows.push(row);
    const prior = artifacts.get(family);
    if (!prior || row.payloadBytes < prior.row.payloadBytes) artifacts.set(family, { row, stub, bytes });
  }
  for (const rate of [2, 3, 4, 5, 6, 7]) for (const lanes of [1, 2, 4]) {
    add('range-rate', { rate, lanes });
    add('decoder-seed', { rate, lanes, seeded: true });
  }
  for (const context of ['prev-byte', 'prev-lane', 'opcode-low', 'opcode-high']) {
    for (const bits of [1, 2, 3, 4]) for (const rate of [2, 3, 4, 5, 6]) add(context, { context, bits, rate });
  }
  for (const context of ['prev-low', 'prev-zero']) {
    for (const bits of context === 'prev-zero' ? [1] : [1, 2, 3, 4])
      for (const rate of [2, 3, 4, 5, 6]) add(context, { context, bits, rate });
  }
  for (const filter of ['xor4', 'sub4']) for (const rate of [2, 3, 4, 5, 6]) add(filter, { filter, rate });
  const rates = [0, 1, 2, 3].map(lane => {
    const data = image.data.filter((_, i) => i % 4 === lane);
    return [2, 3, 4, 5, 6].map(rate => ({ rate, size: researchEncode(data, { lanes: 1, rate }).length }))
      .sort((a, b) => a.size - b.size)[0].rate;
  });
  add('lane-rates', { rates });
  // Isolate the decoder footprint improvement from model improvements.
  for (const family of ['range-rate', 'prev-byte', 'prev-low', 'prev-zero', 'decoder-seed']) {
    if (artifacts.has(family)) add(`compact-${family}`, { ...artifacts.get(family).row.options, compact: true });
  }
  // A larger LZ search is a useful control: does more offline work alone help?
  for (const candidate of compressCandidates(image.data, { chainLimit: 4096 })) {
    const stub = decoder({ ...candidate, load, length: image.data.length, entry: image.entry });
    const stubBytes = linker.link(`.equ __p_data_end, 0\n${stub}`).bytes.length;
    const row = { family: 'deep-lz', options: { k: candidate.k, chainLimit: 4096 }, decoderBytes: stubBytes,
      compressedBytes: candidate.bytes.length, payloadBytes: stubBytes + candidate.bytes.length, scratchBytes: 0 };
    rows.push(row);
    if (!artifacts.has(row.family) || row.payloadBytes < artifacts.get(row.family).row.payloadBytes)
      artifacts.set(row.family, { row, stub, bytes: candidate.bytes });
    for (const rate of [2, 3, 4, 5, 6]) {
      if (0x10000 + 2404 > load) continue;
      const options = { k: candidate.k, rate, chainLimit: 4096 };
      const hybridStub = compactStub(lzRangeDecoder({ ...options, load, length: image.data.length, entry: image.entry }));
      const decoderBytes = linker.link(`.equ __p_data_end, 0\n${hybridStub}`).bytes.length;
      const bytes = lzRangeEncode(lzTokens(candidate, image.data.length), options);
      const hybrid = { family: 'lz-range', options: { ...options, compact: true }, decoderBytes, compressedBytes: bytes.length,
        payloadBytes: decoderBytes + bytes.length, scratchBytes: 2404 };
      rows.push(hybrid);
      if (!artifacts.has(hybrid.family) || hybrid.payloadBytes < artifacts.get(hybrid.family).row.payloadBytes)
        artifacts.set(hybrid.family, { row: hybrid, stub: hybridStub, bytes });
    }
  }
  return { image, rows: rows.sort((a, b) => a.payloadBytes - b.payloadBytes), artifacts };
}

export function runResearch(out = 'artifacts/pack/research', manifestPath = fileURLToPath(new URL('./research-corpus.json', import.meta.url))) {
  mkdirSync(out, { recursive: true });
  const manifest = JSON.parse(readFileSync(manifestPath)), summary = [];
  for (const item of manifest) {
    const sourcePath = resolve(dirname(manifestPath), item.source), reportPath = resolve(dirname(manifestPath), item.report);
    const dir = `${out}/${item.name}`; mkdirSync(dir, { recursive: true });
    // Snapshot once. Later reruns use the same inputs even if authors continue work.
    if (!existsSync(`${dir}/input.asm`)) {
      writeFileSync(`${dir}/input.asm`, readFileSync(sourcePath));
      writeFileSync(`${dir}/original-report.json`, readFileSync(reportPath));
    }
    const source = readFileSync(`${dir}/input.asm`, 'utf8'), old = JSON.parse(readFileSync(`${dir}/original-report.json`));
    assert.equal(sha(linkSource(source, old.loadAddress).data), old.ramImageSha256, `${item.name}: source/report mismatch`);
    const baseline = packSource(source, { load: old.loadAddress });
    assert.equal(baseline.report.ramImageSha256, old.ramImageSha256, `${item.name}: source/report mismatch`);
    writePacked(baseline, `${dir}/baseline.db32`);
    const { image, rows, artifacts } = scan(source, old.loadAddress);
    const bests = [];
    for (const { row, stub, bytes } of artifacts.values()) {
      if (row.payloadBytes <= 4096) {
        const packedSource = `.profile dynamic-1\n.entry __p_start\n${stub}\n${byteAsm(bytes)}\n__p_data_end:\n`;
        const cart = createMachine().assemble(packedSource);
        assert.equal(cart.length - 32, row.payloadBytes);
        const { verification } = verifyExtraction(cart, image);
        row.verification = verification; row.cartridgeSha256 = sha(cart);
        writeFileSync(`${dir}/${row.family}.db32`, cart);
        writeFileSync(`${dir}/${row.family}.packed.asm`, packedSource);
      }
      bests.push(row);
    }
    const record = { name: item.name, source: sourcePath, sourceSha256: sha(source), imageSha256: sha(image.data),
      load: image.load, imageBytes: image.data.length, baseline: baseline.report, bests: bests.sort((a, b) => a.payloadBytes - b.payloadBytes), candidates: rows };
    json(`${dir}/scan.json`, record);
    summary.push({ name: item.name, imageBytes: image.data.length, baselineBytes: baseline.report.payloadBytes,
      bests: record.bests });
    json(`${out}/summary.json`, summary);
    console.log(`${item.name}: baseline ${baseline.report.payloadBytes}; ${record.bests.map(b => `${b.family}=${b.payloadBytes}`).join(', ')}`);
  }
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runResearch(process.argv[2], process.argv[3]);
