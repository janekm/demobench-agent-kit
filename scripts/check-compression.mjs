import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, hash } from './manifest.mjs';
import { createMachine } from '../assets/engine/scripts/wasm-host.mjs';
import { createLinker } from '../assets/engine/tools/pack/linker.mjs';

const large = `.profile dynamic-1
.entry start
start:
li r10,0xf3000
li r1,kernel
sw r1,0(r10)
li r1,kernel_end-kernel
sw r1,4(r10)
addi r1,r0,1
sw r1,8(r10)
sw r1,12(r10)
li r1,0x10000
sw r1,64(r10)
addi r1,r0,4
sw r1,68(r10)
addi r1,r0,3
sw r1,72(r10)
addi r1,r0,1
sw r1,16(r10)
wait1: lw r2,20(r10)
beq r1,r2,wait1
li r3,kernel+4
addi r2,r0,29
sw r2,0(r3)
sw r1,16(r10)
wait2: lw r2,20(r10)
beq r1,r2,wait2
li r10,0xf6000
li r1,sound
sw r1,64(r10)
li r1,sound_end-sound
sw r1,68(r10)
addi r1,r0,1
sw r1,72(r10)
sw r1,76(r10)
li r1,0x11000
sw r1,80(r10)
sw r1,256(r10)
li r1,2048
sw r1,260(r10)
addi r1,r0,3
sw r1,264(r10)
addi r1,r0,1
sw r1,0(r10)
halt
kernel: g.li g1,17
${'g.add g1,g1,g0\n'.repeat(1100)}
g.st g1,g0,0
g.end
kernel_end:
sound: g.fli g1,0.25
g.st g1,g0,0
g.end
sound_end:
.word ${Array.from({ length: 900 }, (_, i) => i % 16).join(',')}
`;

const temp = mkdtempSync(join(tmpdir(), 'db32-portable-check-'));
try {
  const linker = createLinker();
  assert.throws(() => linker.link('unknown_instruction'), /unknown/);
  assert.equal(linker.exports.db_image_len(), 0);
  assert.equal(linker.link('.org 0x2d000\n.entry entry\nentry: halt').entry, 0x2d000);
  const source = join(temp, 'dynamic.asm'), cartridge = join(temp, 'dynamic.db32');
  writeFileSync(source, large);
  // Absolute Node executable and empty PATH prove compression does not invoke Cargo or native tools.
  const run = spawnSync(process.execPath, [join(root, 'scripts/compress.mjs'), source, '-o', cartridge],
    { cwd: temp, env: { ...process.env, PATH: '' }, encoding: 'utf8', timeout: 60000 });
  assert.equal(run.status, 0, run.stderr || String(run.error));
  const report = JSON.parse(readFileSync(join(temp, 'dynamic.json')));
  assert.ok(report.sourceBytes > 8000);
  assert.ok(report.payloadBytes <= 4096);
  assert.equal(report.linkerWasmSha256, linker.sha256);
  assert.ok(report.verification.exactRamImage);
  const machine = createMachine(), cart = readFileSync(cartridge);
  assert.equal(report.canonicalWasmSha256, machine.wasmHash);
  assert.equal(hash(machine.assemble(readFileSync(join(temp, 'dynamic.packed.asm'), 'utf8'))), hash(cart));
  machine.load(cart);
  for (let i = 0; i < 3; i++) { machine.runFrames(1); machine.audio(); }
  const ram = new DataView(machine.exports.memory.buffer, machine.exports.db_ram_ptr(), 131072);
  assert.equal(ram.getUint32(0, true), 29);
  assert.equal(machine.info().gpu.dispatches, 2);
  assert.equal(machine.info().audio.peak, 0.25);
  assert.equal(machine.info().audio.overruns, 0);
  const out = join(temp, 'validation');
  const validation = spawnSync(process.execPath, [join(root, 'scripts/validate.mjs'), cartridge, '--frames', '3', '--out', out],
    { cwd: temp, env: { ...process.env, PATH: '' }, encoding: 'utf8', timeout: 60000 });
  assert.equal(validation.status, 0, validation.stderr || String(validation.error));
  const captured = JSON.parse(readFileSync(join(out, 'report.json')));
  assert.equal(captured.machine.profile, 'dynamic-1');
  assert.equal(captured.audio.peak, 0.25);
  assert.ok(readFileSync(join(out, 'audio.wav')).length > 44);
  console.log(`PASS: Node-only compression ${report.sourceBytes} -> ${report.payloadBytes} bytes, RAM kernel edits, SPU audio, packed source and cartridge validation.`);
} finally { rmSync(temp, { recursive: true, force: true }); }
