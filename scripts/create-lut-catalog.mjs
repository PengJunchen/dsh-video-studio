import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const usage = 'Usage: node scripts/create-lut-catalog.mjs --file LUT.cube --camera pocket4p --profile dlog2 --look vivid --directory /path/to/luts [--append]';
try {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { process.stdout.write(`${usage}\n`); process.exit(0); }
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--append') { options.append = true; continue; }
    if (!['--file', '--camera', '--profile', '--look', '--directory'].includes(args[i])
        || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Invalid argument: ${args[i]}`);
    options[args[i].slice(2)] = args[++i];
  }
  if (!options.file || !options.directory || !/^[a-z][a-z0-9]{2,30}$/.test(options.camera ?? '')
      || !['dlog', 'dlogm', 'dlog2'].includes(options.profile)
      || !['standard', 'vivid'].includes(options.look)) throw new Error(usage);
  const source = resolve(options.file);
  const size = (await stat(source)).size;
  if (size < 1 || size > 64 * 1024 * 1024) throw new Error('LUT must be between 1 byte and 64 MiB');
  const bytes = await readFile(source);
  const lines = bytes.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  const grids = lines.slice(0, 256).map(line => line.trim().match(/^LUT_3D_SIZE\s+(\d+)\s*(?:#.*)?$/)).filter(Boolean);
  if (grids.length !== 1) throw new Error('LUT must declare one LUT_3D_SIZE in its first 256 lines');
  const grid = Number(grids[0][1]);
  if (!Number.isInteger(grid) || grid < 2 || grid > 129) throw new Error('Unsupported LUT grid');
  let rows = 0;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line || /^(?:TITLE|LUT_3D_SIZE|DOMAIN_MIN|DOMAIN_MAX)\s/.test(line)) continue;
    const fields = line.split(/\s+/);
    if (fields.length !== 3 || fields.some(value => !Number.isFinite(Number(value)))) throw new Error('Expected a three-dimensional numeric CUBE LUT');
    rows++;
  }
  if (rows !== grid ** 3) throw new Error(`LUT has ${rows} rows; expected ${grid ** 3}`);
  const directory = resolve(options.directory);
  await mkdir(directory, { recursive: true });
  const catalogPath = join(directory, 'catalog.json');
  let catalog;
  try {
    catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
    if (!options.append) throw new Error('Catalog already exists; use --append to add another mapping');
    if (catalog.version !== 2 || !Array.isArray(catalog.entries)) throw new Error('Expected a version 2 catalog');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    catalog = { version: 2, entries: [] };
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const file = `sha256-${sha256}.cube`;
  const entry = { camera: options.camera, profile: options.profile, look: options.look,
    version: 'user-supplied', grid, sha256, file, purpose: 'restore', output_color_space: 'rec709',
    title: `${options.camera} ${options.profile} to Rec.709 ${options.look} size${grid}` };
  const sameMapping = catalog.entries.find(item => item.camera === entry.camera && item.profile === entry.profile
    && item.look === entry.look && item.grid === entry.grid);
  if (sameMapping && sameMapping.sha256 !== sha256) throw new Error('This camera/profile/look/grid already maps to a different LUT');
  try { await copyFile(source, join(directory, file), constants.COPYFILE_EXCL); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = createHash('sha256').update(await readFile(join(directory, file))).digest('hex');
    if (existing !== sha256) throw new Error('Existing LUT bytes do not match their filename');
  }
  if (!sameMapping) catalog.entries.push(entry);
  const temporary = join(directory, `.catalog-${randomUUID()}.json`);
  await writeFile(temporary, `${JSON.stringify(catalog, null, 2)}\n`, { flag: 'wx' });
  await rename(temporary, catalogPath);
  process.stdout.write(`${JSON.stringify({ catalogPath, lutRoot: directory, camera: entry.camera,
    profile: entry.profile, look: entry.look, grid, sha256 })}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
