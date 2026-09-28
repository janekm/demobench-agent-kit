import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { root, manifest } from './manifest.mjs';

const current = manifest();
writeFileSync(join(root, 'manifest.json'), JSON.stringify(current, null, 2) + '\n');
const staging = mkdtempSync(join(tmpdir(), 'demo-bench-package-'));
try {
  for (const name of [...Object.keys(current.files), 'manifest.json']) {
    const target = join(staging, 'demo-bench', name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, name), target);
  }
  mkdirSync(join(root, 'artifacts'), { recursive: true });
  const archive = join(root, 'artifacts/demo-bench-skill.tar.gz');
  const result = spawnSync('tar', ['-czf', archive, '-C', staging, 'demo-bench'],
    { stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' } });
  if (result.status !== 0) throw new Error('Could not create skill archive (requires tar)');
  console.log(`Bundled ${Object.keys(current.files).length} files\n${archive}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
