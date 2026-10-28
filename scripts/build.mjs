import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'dist');
const entries = [
  'package.json', 'package-lock.json', 'index.mjs', 'client.js', 'icon.svg',
  'cordis.patch.yml', 'LICENSE', 'README.md', 'README.zh-CN.md',
  'THIRD_PARTY_NOTICES.md', 'requirements-vision.txt',
  'src', 'web', 'worker', 'adapters', 'bundles', 'plugins', 'scripts',
];
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const entry of entries) {
  const source = join(root, entry);
  if (!await stat(source).catch(() => null)) continue;
  await cp(source, join(output, entry), {
    recursive: true,
    filter: path => !path.split(/[\\/]/).some(part =>
      part === '__pycache__' || part.startsWith('.') || /\.py[cod]$/.test(part)),
  });
}
process.stdout.write(`${manifest.name}@${manifest.version}: ${output}\n`);
