import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { createMachine, WIDTH, HEIGHT } from './wasm-host.mjs';
import { png } from './png.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const saveJson = (file, data) => writeFileSync(file, JSON.stringify(data, null, 2) + '\n');

function wav(samples, rate) {
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 4, 28);
  bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    bytes.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32768))), 44 + i * 2);
  }
  return bytes;
}

let out, machine, report;
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    frames: { type: 'string', default: '120' }, out: { type: 'string', default: './validation' },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log('Usage: node validate-demo.mjs demo.asm|demo.db32 [--frames 120] [--out ./validation]\nRuns reference WASM; writes cartridge, sampled PNGs, JSON and SPU WAV. Frames: 1..3600 at 60 Hz.');
    process.exit(0);
  }
  if (positionals.length !== 1) throw new Error('Supply exactly one .asm or .db32 file (see --help).');
  const frames = Number(values.frames);
  if (!Number.isInteger(frames) || frames < 1 || frames > 3600) throw new Error('--frames must be 1..3600');
  const source = resolve(positionals[0]);
  if (!['.asm', '.db32'].includes(extname(source).toLowerCase())) throw new Error('Input must end with .asm or .db32');
  out = resolve(values.out);
  // Reset the report before assembly; its file list identifies this run's captures.
  mkdirSync(out, { recursive: true });
  report = { ok: false, backend: 'wasm-reference', source, requestedFrames: frames,
    requestedSeconds: frames / 60, host: process.version, images: [], outputDirectory: out };
  saveJson(join(out, 'report.json'), report);
  machine = createMachine();
  const input = readFileSync(source);
  report.inputSha256 = hash(input);
  report.wasmSha256 = machine.wasmHash;
  const cartridge = extname(source).toLowerCase() === '.asm' ? machine.assemble(input.toString('utf8')) : input;
  machine.load(cartridge);
  writeFileSync(join(out, 'demo.db32'), cartridge);
  report.cartridgeSha256 = hash(cartridge);
  const initial = machine.info();
  const audioEnabled = initial.profileCode >= 3;
  // Three spread-out observations; a two-frame capture includes a fully scanned image.
  const captureFrames = new Set([Math.min(2, frames), Math.max(1, Math.round(frames / 2)), frames]);
  const chunks = [];
  let sampleCount = 0, peak = 0, energy = 0, dc = 0, clippedSamples = 0, maxBlockTicks = 0;
  const started = performance.now();
  for (let frame = 1; frame <= frames; frame++) {
    machine.runFrames(1);
    // Drain every video frame, even for silent SPU blocks, to avoid the bounded queue overflowing.
    const samples = machine.audio();
    if (audioEnabled) {
      maxBlockTicks = Math.max(maxBlockTicks, machine.exports.db_spu_last_ticks());
      for (const sample of samples) {
        if (!Number.isFinite(sample)) throw new Error('Nonfinite PCM');
        peak = Math.max(peak, Math.abs(sample)); energy += sample * sample; dc += sample;
        if (Math.abs(sample) >= 1) clippedSamples++;
      }
      chunks.push(samples); sampleCount += samples.length;
    }
    if (captureFrames.has(frame)) {
      const rgba = machine.frame();
      const file = `frame-${String(frame).padStart(6, '0')}.png`;
      writeFileSync(join(out, file), png(WIDTH, HEIGHT, rgba));
      report.images.push({ frame, file, rgbaSha256: hash(rgba) });
    }
  }
  report.wallMs = performance.now() - started;
  report.machine = machine.info();
  if (report.machine.audio.overruns) throw new Error(`SPU capture overran by ${report.machine.audio.overruns} sample frames`);
  if (audioEnabled) {
    const pcm = new Float32Array(sampleCount);
    let offset = 0;
    for (const chunk of chunks) { pcm.set(chunk, offset); offset += chunk.length; }
    const bytes = wav(pcm, initial.audio.rate);
    writeFileSync(join(out, 'audio.wav'), bytes);
    report.audio = { file: 'audio.wav', rate: initial.audio.rate, sampleFrames: sampleCount / 2,
      seconds: sampleCount / 2 / initial.audio.rate, peak, rms: Math.sqrt(energy / Math.max(1, sampleCount)),
      dcOffset: dc / Math.max(1, sampleCount), clippedSamples, maxObservedBlockTicks: maxBlockTicks,
      pcmFloat32Sha256: hash(new Uint8Array(pcm.buffer)), wavSha256: hash(bytes) };
  }
  report.ok = true;
  saveJson(join(out, 'report.json'), report);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (report) {
    report.ok = false; report.error = error.message;
    if (machine) report.machine = machine.info();
    saveJson(join(out, 'report.json'), report);
  }
  console.error(`Validation failed: ${error.message}`);
  process.exitCode = 1;
}
