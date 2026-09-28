# Demo authoring

Read `SKILL.md` before writing a demo. Treat the bundled engine, host tools and contracts as the fixed target for a benchmark task; put candidate code in a separate `.asm` file and captures under `artifacts/`. Use `npm run validate -- <candidate.asm> --frames <count> --out <directory>` for reference execution.

Changes to this kit itself belong to explicit kit-maintenance tasks. After such changes, run `npm run bundle` to refresh its manifest, then `npm test`.
