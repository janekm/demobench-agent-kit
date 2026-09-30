import assert from 'node:assert/strict';
import { createMachine } from '../../scripts/wasm-host.mjs';
import { createLinker } from './linker.mjs';
import { compressCandidates } from './codec.mjs';
import { rangeEncode } from './range.mjs';
import { researchEncode, researchDecoder, transform, compactStub } from './research-range.mjs';
import { lzTokens, lzRangeEncode, lzRangeDecoder } from './research-lzrange.mjs';
import { verifyExtraction, byteAsm } from './research.mjs';
import { packResearchSource } from './research-pack.mjs';

const linker = createLinker();
let randomState = 0xdbc032, count = 0;
const random = () => { randomState ^= randomState << 13; randomState ^= randomState >>> 17; randomState ^= randomState << 5; return randomState >>> 0; };
const check = (data, options) => {
  // Also exercise output ending at the RAM boundary, with a non-word tail.
  const load = 0x30000 - Math.ceil(data.length / 4) * 4;
  const params = { load, length: data.length, entry: load, ...options };
  const stub = options.compact ? compactStub(researchDecoder(params)) : researchDecoder(params);
  const linked = linker.link(`.equ __p_data_end, 0\n${stub}`);
  if (options.seeded) params.seed = linked.bytes.slice(0, linked.symbols.__p_seed_end);
  const filtered = transform(data, options.filter);
  assert.deepEqual(transform(filtered, options.filter, true), data);
  const bytes = researchEncode(filtered, params);
  const cart = createMachine().assemble(`${stub}\n${byteAsm(bytes)}\n__p_data_end:`);
  verifyExtraction(cart, { data, load, entry: load }); count++;
};
const small = Uint8Array.from({ length: 131 }, () => random() & 255);
const mixed = Uint8Array.from({ length: 3073 }, (_, i) => i % 71 < 55 ? i % 7 : random() & 255);
for (const lanes of [1, 2, 4]) for (const rate of [2, 3, 4, 5, 6, 7]) {
  if (rate >= 3 && rate <= 6) assert.deepEqual(researchEncode(small, { lanes, rate }), rangeEncode(small, { lanes, rate }).bytes);
  for (const seeded of [false, true]) for (const compact of [false, true]) check(small, { lanes, rate, seeded, compact });
}
for (const context of ['prev-byte', 'prev-lane', 'opcode-low', 'opcode-high', 'prev-low', 'prev-zero']) {
  for (const bits of context === 'prev-zero' ? [1] : [1, 2, 3, 4]) {
    for (const rate of [2, 3, 4, 5, 6]) check(small, { context, bits, rate, compact: true });
  }
}
for (const filter of ['xor4', 'sub4']) for (const length of [4, 7, 131]) check(small.slice(0, length), { filter });
check(mixed, { rates: [2, 3, 4, 5], compact: true });
check(new Uint8Array(1027), { context: 'prev-zero', bits: 1, rate: 3, compact: true });
for (const data of [small, mixed]) for (const candidate of compressCandidates(data)) for (const rate of [2, 3, 4, 5, 6]) {
  const load = 0x30000 - Math.ceil(data.length / 4) * 4, params = { load, length: data.length, entry: load, k: candidate.k, rate };
  const stub = compactStub(lzRangeDecoder(params));
  const bytes = lzRangeEncode(lzTokens(candidate, data.length), params);
  const cart = createMachine().assemble(`${stub}\n${byteAsm(bytes)}\n__p_data_end:`);
  verifyExtraction(cart, { data, load, entry: load }); count++;
}
console.log(`ok - ${count} experimental guest decoder checks; exact RAM, cleared scratch, reset registers, boundary/tail cases, and unchanged standard-range bitstreams`);

// Single-source authoring must retain tiny production winners and skip models
// whose scratch would overlap low-loaded images, including the LZ/range hybrid.
for (const load of [0x10000, 0x10800]) {
  const result = packResearchSource('.profile dynamic-1\nhalt', { load });
  assert.equal(result.report.research.selected, 'baseline');
  assert.equal(result.report.research.savedAgainstBaseline, 0);
  assert.ok(result.report.research.candidates.every(c => c.scratchBytes <= load - 0x10000));
  result.machine.run(1); assert.equal(result.machine.info().status, 2);
}
assert.throws(() => packResearchSource('halt'), /requires dynamic-1/);
const entropy = `.profile dynamic-1\nhalt\n.word ${Array.from({ length: 1100 }, () => random()).join(',')}\n`;
assert.throws(() => packResearchSource(entropy), /over the 4096-byte limit/);
console.log('ok - experimental authoring baseline fallback, scratch overlap exclusion, profile restriction and oversize rejection');
