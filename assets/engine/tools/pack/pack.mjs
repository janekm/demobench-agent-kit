import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createMachine } from '../../scripts/wasm-host.mjs';
import { compressCandidates, decompress, shuffle4, unshuffle4 } from './codec.mjs';
import { decoder } from './stub.mjs';
import { rangeEncode, rangeDecode, rangeDecoder } from './range.mjs';
import { createLinker } from './linker.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const bytesAsm = bytes => Array.from({ length: Math.ceil(bytes.length / 24) }, (_, i) =>
  `.byte ${[...bytes.slice(i * 24, i * 24 + 24)].join(',')}`).join('\n');
const profiles = { 1: 'bootstrap-1', 2: 'gpu-1', 3: 'spu-1', 4: 'dynamic-1' };
let linker;
const getLinker = () => linker ??= createLinker();
const link = source => getLinker().link(source);

export function linkSource(source, load = 0x2c000) {
  if (!Number.isInteger(load) || load < 0x10000 || load >= 0x30000 || load % 4) throw new Error('Load address must be aligned RAM');
  const dynamic = /^\s*\.profile\s+dynamic-1\b/im.test(source);
  const rom = [], ram = [], shared = []; let section = ram, hasEntry = false;
  for (const line of source.split('\n')) {
    const clean = line.split(';')[0].split('//')[0].trim();
    const select = clean.match(/^\.section\s+(rom|ram)$/i);
    if (select) { section = select[1].toLowerCase() === 'rom' ? rom : ram; continue; }
    if (/\.org\b/i.test(clean) || /\b__p\w*/i.test(clean)) throw new Error('`.org` and __p* symbols are reserved for the packer');
    if (/^\.(profile|equ)\b/i.test(clean)) { shared.push(line); continue; }
    if (/^\.entry\b/i.test(clean)) hasEntry = true;
    if (!dynamic && section === ram && /(?:^|:)\s*g\./i.test(clean)) throw new Error('GPU/SPU kernels in RAM require `.profile dynamic-1`; use `.section rom` for old profiles');
    section.push(line);
  }
  const linkedSource = `${shared.join('\n')}\n${hasEntry ? '' : '.entry __p_ram_start'}\n${rom.join('\n')}\n.align 4\n__p_rom_end:\n.org ${load}\n__p_ram_start:\n${ram.join('\n')}\n`;
  const image = link(linkedSource), romEnd = image.symbols.__p_rom_end;
  if (romEnd > 4096) throw new Error(`ROM section alone exceeds 4096 bytes (${romEnd})`);
  if (image.entry < load || image.entry + 4 > image.bytes.length) throw new Error('Packed entry must be a CPU instruction in the RAM section');
  const data = image.bytes.slice(load);
  if (!data.length) throw new Error('RAM section is empty');
  return { ...image, data, rom: image.bytes.slice(0, romEnd), load, linkedSource };
}

export function packSource(source, { load = 0x2c000, scratch = 0x10000, chainLimit = 256, filter = 'auto', codec = 'auto' } = {}) {
  if (!['auto', 'none', 'shuffle4'].includes(filter) || !['auto', 'store', 'dblz', 'range'].includes(codec)) throw new Error('Invalid codec/filter');
  if (filter === 'shuffle4' && !['auto', 'dblz'].includes(codec)) throw new Error('The shuffle4 filter requires the DBLZ codec');
  if (!Number.isInteger(chainLimit) || chainLimit < 1 || chainLimit > 65536) throw new Error('Chain limit must be 1..65536');
  const image = linkSource(source, load), machine = createMachine();
  const candidates = [];
  const add = (data, shuffled) => {
    for (const candidate of [
      ...(['auto', 'store'].includes(codec) && !shuffled ? [{ bytes: data, codec: 'store', k: 0 }] : []),
      ...(['auto', 'dblz'].includes(codec) ? compressCandidates(data, { chainLimit }).map(c => ({ ...c, codec: 'dblz' })) : []),
    ]) {
      const params = { ...candidate, load, length: data.length, entry: image.entry, scratch: shuffled ? scratch : null };
      const stub = decoder(params);
      const stubBytes = machine.assemble(`.equ __p_data_end, 0\n${stub}`).length - 32;
      candidates.push({ ...candidate, filter: shuffled ? 'shuffle4' : 'none', decoded: data, stub, stubBytes,
        scratch: params.scratch, payloadBytes: image.rom.length + stubBytes + candidate.bytes.length });
    }
  };
  if (filter !== 'shuffle4') add(image.data, false);
  if (filter !== 'shuffle4' && ['auto', 'range'].includes(codec)) {
    for (const lanes of [1, 2, 4]) for (const rate of [3, 4, 5, 6]) {
      const modelBytes = lanes * 512;
      if (!Number.isInteger(scratch) || scratch % 4 || scratch < 0x10000 || scratch + modelBytes > 0x30000 ||
        !(scratch + modelBytes <= load || scratch >= load + image.data.length)) continue;
      const candidate = rangeEncode(image.data, { lanes, rate });
      const stub = rangeDecoder({ load, length: image.data.length, entry: image.entry, modelAddress: scratch, lanes, rate });
      const stubBytes = machine.assemble(`.equ __p_data_end, 0\n${stub}`).length - 32;
      candidates.push({ ...candidate, codec: 'range', k: 0, filter: 'none', decoded: image.data, stub, stubBytes, scratch,
        scratchBytes: modelBytes, payloadBytes: image.rom.length + stubBytes + candidate.bytes.length });
    }
  }
  const paddedLength = Math.ceil(image.data.length / 4) * 4;
  const scratchValid = Number.isInteger(scratch) && scratch >= 0x10000 && scratch + paddedLength <= 0x30000 &&
    (scratch + paddedLength <= load || scratch >= load + paddedLength) && load + paddedLength <= 0x30000;
  if (filter !== 'none' && ['auto', 'dblz'].includes(codec) && scratchValid) add(shuffle4(image.data), true);
  else if (filter === 'shuffle4') throw new Error('Shuffle scratch and padded image must fit in disjoint RAM spans');
  candidates.sort((a, b) => a.payloadBytes - b.payloadBytes || a.stubBytes - b.stubBytes);
  const best = candidates[0];
  if (!best) throw new Error('No encoding candidates');
  let recovered = best.codec === 'store' ? best.bytes : best.codec === 'range' ? rangeDecode(best.bytes, best.decoded.length, best) : decompress(best.bytes, best.decoded.length, best.k);
  if (best.filter === 'shuffle4') recovered = unshuffle4(recovered);
  if (!Buffer.from(recovered.slice(0, image.data.length)).equals(image.data)) throw new Error('Internal compression round-trip mismatch');
  const packedSource = `; DB32 guest self-extracting cartridge; generated by tools/pack/pack.mjs\n.profile ${profiles[image.profile]}\n.entry __p_start\n${bytesAsm(image.rom)}\n${best.stub}\n${bytesAsm(best.bytes)}\n__p_data_end:\n`;
  const report = {
    format: 'db32-self-extract-v1', profile: profiles[image.profile], codec: best.codec, filter: best.filter,
    distanceLowBits: best.k, sourceBytes: image.rom.length + image.data.length, ramImageBytes: image.data.length,
    decodedBytes: best.decoded.length, romBytes: image.rom.length, decoderBytes: best.stubBytes,
    compressedBytes: best.bytes.length, payloadBytes: best.payloadBytes, freeBytes: 4096 - best.payloadBytes,
    savedBytes: image.rom.length + image.data.length - best.payloadBytes,
    loadAddress: load, entryAddress: image.entry, scratchAddress: best.scratch,
    scratchBytes: best.scratch === null ? 0 : best.scratchBytes ?? best.decoded.length,
    rangeLanes: best.lanes ?? null, rangeAdaptationRate: best.rate ?? null,
    ramImageSha256: hash(image.data), canonicalWasmSha256: machine.wasmHash, linkerWasmSha256: getLinker().sha256,
    chainLimit, candidates: candidates.map(c => ({ codec: c.codec, filter: c.filter, k: c.k, compressedBytes: c.bytes.length,
      decoderBytes: c.stubBytes, payloadBytes: c.payloadBytes, lanes: c.lanes, rate: c.rate })),
  };
  if (best.payloadBytes > 4096) {
    const error = new Error(`Packed payload is ${best.payloadBytes} bytes (${best.payloadBytes - 4096} over the 4096-byte limit; ROM ${image.rom.length}, decoder ${best.stubBytes}, stream ${best.bytes.length})`);
    error.report = report; throw error;
  }
  const cartridge = machine.assemble(packedSource);
  if (cartridge.length - 32 !== best.payloadBytes) throw new Error('Decoder size accounting mismatch');
  report.cartridgeSha256 = hash(cartridge);
  // Stop at the exact handoff instruction, before the original program executes.
  machine.load(cartridge);
  const deadline = 50_000_000;
  let ticks = 0;
  while (machine.exports.db_pc() !== image.entry && ticks < deadline) {
    machine.run(1); ticks++;
    if (ticks % 204800 === 0) machine.audio();
  }
  if (ticks === deadline) throw new Error('Guest extraction exceeded 50 million ticks');
  const ramView = () => new Uint8Array(machine.exports.memory.buffer, machine.exports.db_ram_ptr(), 131072);
  if (!Buffer.from(ramView().slice(load - 0x10000, load - 0x10000 + image.data.length)).equals(image.data)) throw new Error('Guest extraction mismatch');
  for (let i = 1; i < 16; i++) if ((machine.exports.db_register(i) >>> 0) !== (i === 15 ? 0x30000 : 0)) throw new Error(`Decoder did not restore r${i}`);
  const before = load - 0x10000, after = before + best.decoded.length;
  if (ramView().slice(0, before).some(x => x) || ramView().slice(after).some(x => x)) throw new Error('Decoder modified RAM outside the image');
  report.verification = { backend: 'canonical-wasm', exactRamImage: true, resetRegisters: true, otherRamZero: true,
    extractionTicks: ticks, extractionFrames: ticks / 204800, virtualMilliseconds: ticks / 12288,
    note: 'The machine clock advances during guest extraction. This is not a host performance measurement.' };
  return { cartridge, packedSource, report, image, machine };
}

export function writePacked(result, output) {
  mkdirSync(dirname(resolve(output)), { recursive: true });
  writeFileSync(output, result.cartridge);
  const stem = output.replace(/\.db32$/i, '');
  writeFileSync(`${stem}.packed.asm`, result.packedSource);
  writeFileSync(`${stem}.json`, JSON.stringify(result.report, null, 2) + '\n');
  writeFileSync(`${stem}.image.bin`, result.image.data);
  writeFileSync(`${stem}.listing`, result.image.listing);
}

export function main(argv = process.argv.slice(2)) {
  try {
    const args = [...argv], input = args.shift(); let output;
    const options = {};
    if (!input || input === '--help') {
      console.log('Usage: node tools/pack/pack.mjs SOURCE.asm -o OUTPUT.db32 [--load 0x2c000] [--scratch 0x10000] [--filter auto|none|shuffle4] [--codec auto|dblz|range|store] [--chain 256]');
      process.exit(input ? 0 : 1);
    }
    while (args.length) {
      const flag = args.shift(), value = args.shift();
      if (value === undefined) throw new Error(`Missing value for ${flag}`);
      if (flag === '-o') output = value;
      else if (flag === '--load') options.load = Number(value);
      else if (flag === '--scratch') options.scratch = Number(value);
      else if (flag === '--chain') options.chainLimit = Number(value);
      else if (flag === '--filter') options.filter = value;
      else if (flag === '--codec') options.codec = value;
      else throw new Error(`Unknown option ${flag}`);
    }
    if (!output) throw new Error('Specify -o OUTPUT.db32');
    const result = packSource(readFileSync(input, 'utf8'), options);
    writePacked(result, output);
    const r = result.report;
    console.log(`${r.sourceBytes} -> ${r.payloadBytes} payload bytes (${r.savedBytes} saved, ${r.freeBytes} free); ${r.codec}/${r.filter}, ${r.decoderBytes}-byte decoder; verified in ${r.verification.extractionTicks} guest ticks\n${output}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
