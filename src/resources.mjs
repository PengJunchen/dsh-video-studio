import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** Packaged defaults; explicit external catalogs continue to take precedence. */
export async function packagedAssets(root, supplied = {}) {
  const overrides = Object.fromEntries(Object.entries(supplied).filter(([, value]) => value != null && value !== ''));
  if (overrides.catalog_path || overrides.lut_root) return overrides;
  const directory = join(root, 'assets');
  if (!await stat(join(directory, 'catalog.json')).catch(() => null)
      || !(await stat(join(directory, 'luts')).catch(() => null))?.isDirectory()) return overrides;
  return { catalog_path: join(directory, 'catalog.json'), library_path: join(directory, 'library.json'),
    lut_root: join(directory, 'luts'), ...overrides };
}

/** A release build must contain exact payloads, never an empty LUT directory. */
export async function requireReleaseAssets(root) {
  const directory = join(root, 'assets');
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  const catalog = JSON.parse(await readFile(join(directory, 'catalog.json'), 'utf8'));
  const library = JSON.parse(await readFile(join(directory, 'library.json'), 'utf8'));
  if (manifest.schema !== 1 || !Array.isArray(manifest.payloads) || !manifest.payloads.length
      || catalog.version !== 2 || !Array.isArray(catalog.entries)
      || library.schema !== 1 || !Array.isArray(library.assets)) throw new Error('Invalid packaged LUT manifests');
  const identities = new Map();
  for (const entry of manifest.payloads) {
    if (!/^[a-f0-9]{64}$/.test(entry.sha256) || entry.file !== `sha256-${entry.sha256}.cube`
        || !Number.isInteger(entry.grid) || entry.grid < 2 || entry.grid > 129) throw new Error('Invalid locked LUT identity');
    let bytes;
    try { bytes = await readFile(join(directory, 'luts', entry.file)); }
    catch { throw new Error(`Missing ${entry.file}; run npm run assets:prepare -- --download or --source /path/to/luts`); }
    if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error(`LUT bytes differ from the resource lock: ${entry.file}`);
    const header = bytes.toString('utf8').split(/\r?\n/).slice(0, 256).join('\n');
    if (Number(header.match(/^\s*LUT_3D_SIZE\s+(\d+)/m)?.[1]) !== entry.grid) throw new Error(`LUT grid differs: ${entry.file}`);
    identities.set(entry.sha256, entry);
  }
  for (const entry of [...catalog.entries, ...library.assets]) {
    const locked = identities.get(entry.sha256);
    if (!locked || entry.file !== locked.file || entry.grid !== locked.grid) throw new Error('LUT catalog references an unlocked payload');
  }
  return { mappings: catalog.entries.length, payloads: identities.size,
    bytes: manifest.payloads.reduce((sum, entry) => sum + entry.bytes, 0) };
}
