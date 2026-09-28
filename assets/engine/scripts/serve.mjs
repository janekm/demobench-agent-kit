import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../web/', import.meta.url));
const port = Number(process.env.PORT || 4173);
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.wasm':'application/wasm', '.json':'application/json', '.asm':'text/plain; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.gif':'image/gif' };
createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    let target = resolve(root, '.' + pathname);
    if (target !== root.slice(0, -1) && !target.startsWith(root)) { res.writeHead(403).end(); return; }
    if ((await stat(target)).isDirectory()) target = resolve(target, 'index.html');
    const data = await readFile(target);
    res.writeHead(200, { 'Content-Type': types[extname(target)] || 'application/octet-stream', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff' });
    res.end(data);
  } catch { res.writeHead(404, { 'Content-Type':'text/plain' }).end('Not found'); }
}).listen(port, '127.0.0.1', () => console.log(`demo-bench viewer: http://127.0.0.1:${port}`));
