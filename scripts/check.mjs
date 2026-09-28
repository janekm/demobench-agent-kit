import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { root, manifest } from './manifest.mjs';

const pinned = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
assert.deepEqual(manifest(), pinned, 'Kit differs from its manifest. For an intentional maintenance change, run npm run bundle.');
const module = new WebAssembly.Module(readFileSync(join(root, 'assets/engine/web/machine.wasm')));
assert.deepEqual(WebAssembly.Module.imports(module), [], 'Engine must be import-free');
assert.equal(JSON.parse(readFileSync(join(root, 'assets/engine/web/build.json'))).sha256, pinned.engineSha256);
assert.deepEqual(readdirSync(join(root, 'assets/engine/web/examples')), ['starter.asm']);
assert.deepEqual(readFileSync(join(root, 'assets/starter.asm')), readFileSync(join(root, 'assets/engine/web/examples/starter.asm')));
const temp = mkdtempSync(join(tmpdir(), 'demo-bench-check-'));
try {
  function validate(source, name, success) {
    const out = join(temp, name);
    const result = spawnSync(process.execPath, [join(root, 'scripts/validate.mjs'), source,
      '--frames', '2', '--out', out], { cwd: temp, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, success ? 0 : 1, result.stderr || String(result.error));
    const report = JSON.parse(readFileSync(join(out, 'report.json')));
    assert.equal(report.ok, success);
    return { out, report };
  }
  const source = validate(join(root, 'assets/starter.asm'), 'source', true);
  assert.equal(source.report.machine.ticks, 409600);
  assert.ok(source.report.machine.payloadBytes <= 4096);
  assert.equal(source.report.wasmSha256, pinned.engineSha256);
  assert.ok(readFileSync(join(source.out, 'frame-000002.png')).length > 100);
  const cartridge = validate(join(source.out, 'demo.db32'), 'cartridge', true);
  assert.equal(cartridge.report.machine.rgbaSha256, source.report.machine.rgbaSha256);
  const bad = join(temp, 'fault.asm');
  writeFileSync(bad, 'sw r0, 0(r0)\n');
  assert.match(validate(bad, 'fault', false).report.error, /read-only/);
  writeFileSync(bad, 'unknown_instruction\n');
  assert.match(validate(bad, 'assembly-error', false).report.error, /unknown/);
  console.log('PASS: pinned files, import-free engine, minimal example, portable source/cartridge validation and fault reporting.');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
