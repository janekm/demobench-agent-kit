import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const linkerPath = new URL('./linker.wasm', import.meta.url);
export function createLinker(bytes = readFileSync(linkerPath)) {
  const module = new WebAssembly.Module(bytes);
  if (WebAssembly.Module.imports(module).length) throw new Error('Linker must have no WASM imports');
  const e = new WebAssembly.Instance(module, {}).exports;
  if (e.db_linker_abi_version() !== 1) throw new Error('Unsupported linker ABI');
  const text = (ptr, len) => new TextDecoder().decode(new Uint8Array(e.memory.buffer, ptr, len));
  return {
    exports: e,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    link(source) {
      const input = new TextEncoder().encode(source);
      if (input.length > e.db_input_capacity()) throw new Error('Source exceeds linker input capacity');
      const ptr = e.db_input_ptr();
      new Uint8Array(e.memory.buffer, ptr, input.length).set(input);
      if (e.db_link(input.length) !== 0) throw new Error(text(e.db_error_ptr(), e.db_error_len()));
      return { ...JSON.parse(text(e.db_metadata_ptr(), e.db_metadata_len())),
        bytes: Buffer.from(new Uint8Array(e.memory.buffer, e.db_image_ptr(), e.db_image_len())),
        listing: text(e.db_listing_ptr(), e.db_listing_len()) };
    },
  };
}
