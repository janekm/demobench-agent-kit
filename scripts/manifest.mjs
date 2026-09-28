import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function manifest() {
  const files = {};
  function collect(path) {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = resolve(path, entry.name);
      if (entry.isDirectory()) collect(full);
      else if (entry.isFile()) files[relative(root, full).split('\\').join('/')] = hash(readFileSync(full));
      else throw new Error(`Unsupported package entry: ${full}`);
    }
  }
  // An explicit inventory excludes candidate demos, captures, VCS data and local dependencies.
  for (const name of ['.gitignore', 'AGENTS.md', 'README.md', 'SKILL.md', 'package.json']) {
    files[name] = hash(readFileSync(resolve(root, name)));
  }
  for (const name of ['agents', 'assets', 'references', 'scripts']) collect(resolve(root, name));
  return { format: 1, engineSha256: files['assets/engine/web/machine.wasm'], files };
}
