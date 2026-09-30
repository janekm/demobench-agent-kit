import assert from 'node:assert/strict';
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packSource, writePacked } from './pack.mjs';
import { createMachine } from '../../scripts/wasm-host.mjs';
import { createLinker } from './linker.mjs';
import { scan, sha, byteAsm, verifyExtraction } from './research.mjs';

// Opt-in authoring entry point. Include the production winner, so expanding the
// search cannot increase payload size. Scratch remains fixed at 0x10000.
export function packResearchSource(source, { load = 0x2c000 } = {}) {
  const { image, rows, artifacts } = scan(source, load);
  let baseline, baselineReport;
  try { baseline = packSource(source, { load }); baselineReport = baseline.report; }
  catch (error) { if (!error.report) throw error; baselineReport = error.report; }
  const best = [...artifacts.values()].sort((a, b) => a.row.payloadBytes - b.row.payloadBytes)[0];
  const research = { candidates: rows, baselinePayloadBytes: baselineReport.payloadBytes, baselineCandidates: baselineReport.candidates };
  if (baseline && baseline.report.payloadBytes <= best.row.payloadBytes) {
    baseline.report.research = { ...research, selected: 'baseline', savedAgainstBaseline: 0 };
    return baseline;
  }
  const { row, stub, bytes } = best;
  if (row.payloadBytes > 4096) {
    const error = new Error(`Best experimental payload is ${row.payloadBytes} bytes (${row.payloadBytes - 4096} over the 4096-byte limit)`);
    error.report = { ...research, best: row }; throw error;
  }
  const packedSource = `; Experimental DB32 guest self-extracting cartridge\n.profile dynamic-1\n.entry __p_start\n${stub}\n${byteAsm(bytes)}\n__p_data_end:\n`;
  const cartridge = createMachine().assemble(packedSource);
  assert.equal(cartridge.length - 32, row.payloadBytes);
  const { machine, verification } = verifyExtraction(cartridge, image);
  const report = { format: 'db32-self-extract-research-v1', profile: 'dynamic-1', codec: row.family,
    filter: row.options.filter ?? 'none', sourceBytes: image.data.length, ramImageBytes: image.data.length,
    decodedBytes: image.data.length, romBytes: 0, decoderBytes: row.decoderBytes, compressedBytes: row.compressedBytes,
    payloadBytes: row.payloadBytes, freeBytes: 4096 - row.payloadBytes, savedBytes: image.data.length - row.payloadBytes,
    loadAddress: load, entryAddress: image.entry, scratchAddress: row.scratchBytes ? 0x10000 : null,
    scratchBytes: row.scratchBytes, options: row.options, ramImageSha256: sha(image.data), sourceSha256: sha(source),
    cartridgeSha256: sha(cartridge), canonicalWasmSha256: machine.wasmHash, linkerWasmSha256: createLinker().sha256,
    verification: { backend: 'canonical-wasm', ...verification, extractionFrames: verification.extractionTicks / 204800,
      note: 'Guest extraction advances the clock; virtual time is not host performance.' },
    research: { ...research, selected: row.family, savedAgainstBaseline: baselineReport.payloadBytes - row.payloadBytes } };
  return { cartridge, packedSource, report, image, machine };
}

export function main(argv = process.argv.slice(2)) {
  try {
    const args = [...argv], input = args.shift(), options = {}; let output;
    if (!input || input === '--help') {
      console.log('Usage: research-pack.mjs SOURCE.asm -o OUTPUT.db32 [--load 0x2c000]\nOpt-in search for RAM-only dynamic-1 images; temporary scratch starts at 0x10000.');
      if (!input) process.exitCode = 1; return;
    }
    while (args.length) {
      const flag = args.shift(), value = args.shift();
      if (value === undefined) throw new Error(`Missing value for ${flag}`);
      if (flag === '-o') output = value;
      else if (flag === '--load') options.load = Number(value);
      else throw new Error(`Unknown option ${flag}`);
    }
    if (!output || !/\.db32$/i.test(output)) throw new Error('Specify -o OUTPUT.db32');
    const stem = output.replace(/\.db32$/i, ''), inputPath = realpathSync(input);
    const outputs = [output, ...['.packed.asm', '.json', '.image.bin', '.listing'].map(ext => stem + ext)];
    if (outputs.some(path => (existsSync(path) ? realpathSync(path) : resolve(path)) === inputPath))
      throw new Error('Input must differ from the cartridge and all output sidecars');
    const result = packResearchSource(readFileSync(input, 'utf8'), options);
    writePacked(result, output);
    const r = result.report;
    console.log(`${r.sourceBytes} -> ${r.payloadBytes} payload bytes; ${r.research.selected}; ${r.research.savedAgainstBaseline} bytes saved against baseline; canonical extraction verified\n${output}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
