import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireReleaseAssets } from '../src/resources.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'dist');
const runtimeIndex = process.argv.indexOf('--with-runtime');
const bundledPlatform = runtimeIndex < 0 ? null : process.argv[runtimeIndex + 1];
if (runtimeIndex >= 0 && !['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'].includes(bundledPlatform)) throw new Error('Unknown --with-runtime platform');
const entries = [
  'package.json', 'package-lock.json', 'index.mjs', 'client.js', 'icon.svg',
  'cordis.patch.yml', 'LICENSE', 'README.md', 'README.zh-CN.md',
  'THIRD_PARTY_NOTICES.md', 'requirements-vision.txt',
  'src', 'web', 'worker', 'adapters', 'bundles', 'plugins', 'scripts', 'assets', 'runtime',
];
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const resources = await requireReleaseAssets(root);
if (bundledPlatform) {
  const runtime = JSON.parse(await readFile(join(root, 'runtime', bundledPlatform, 'runtime.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(root, 'runtime/manifest.json'), 'utf8'));
  if (runtime.id !== lock.id || runtime.platform !== bundledPlatform) throw new Error('Missing or mismatched platform runtime');
}
await rm(output, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
await mkdir(output, { recursive: true });
for (const entry of entries) {
  const source = join(root, entry);
  if (!await stat(source).catch(() => null)) continue;
  await cp(source, join(output, entry), {
    recursive: true,
    // npm omits symlinks; materialize Python aliases and shared-library links.
    dereference: true,
    filter: path => {
      const parts = relative(root, path).split(/[\\/]/);
      const payload = parts[0] === 'runtime' && parts[1] === bundledPlatform;
      // Runtime wheels need hidden DLL metadata and Windows .pyd extensions.
      return !parts.some(part => part === '__pycache__' || part === '.DS_Store' || /\.py[co]$/.test(part)
        || part.startsWith('.') && !payload
        || /^(darwin|linux|win32)-(arm64|x64)$/.test(part) && part !== bundledPlatform);
    },
  });
}
if (bundledPlatform) await writeFile(join(output, 'runtime/bundled.json'), JSON.stringify({ platform: bundledPlatform }) + '\n');
process.stdout.write(`${manifest.name}@${manifest.version}: ${output}; ${resources.payloads} LUTs, ${resources.mappings} exact mappings\n`);
