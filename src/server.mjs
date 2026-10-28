import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { createMediaRuntime } from './runtime.mjs';

const options = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, args) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), args[index + 1]]);
  return pairs;
}, []));
const api = await createMediaRuntime({
  dataDir: options['data-dir'], allowedRoots: [resolve(options['input-root'] ?? process.cwd())],
  allowUserExportGrants: true,
  python: options.python,
  workerConfig: { assets: { catalog_path: options.catalog ?? process.env.HVP_CATALOG, library_path: options.library ?? process.env.HVP_LIBRARY,
    lut_root: options['lut-root'] ?? process.env.HVP_LUT_ROOT, vision_python: options['vision-python'] ?? process.env.HVP_VISION_PYTHON } },
});
for (const id of ['lut-batch','tone','skin','local-color','finish']) api.registerFeature({ id, version: 1 }, 'standalone-studio');
const server = createServer(async (req, res) => {
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) { res.writeHead(403); res.end('Forbidden host'); return; }
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) { res.writeHead(403); res.end('Forbidden origin'); return; }
  if (req.url === '/') { res.writeHead(302, { location: '/hvp/' }); res.end(); return; }
  if (!await api.handleHttp(req, res)) { res.writeHead(404); res.end(); }
});
server.listen(Number(options.port ?? 4319), '127.0.0.1', () => process.stdout.write(`Video Studio: http://127.0.0.1:${server.address().port}/hvp/\n`));
async function stop() { server.close(); await api.close(); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
