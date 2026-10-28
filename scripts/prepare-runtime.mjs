#!/usr/bin/env node
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, rename, rm } from 'node:fs/promises';
import { createEnvironmentManager } from '../src/environment.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, 'runtime/.prepared');
const manager = createEnvironmentManager({ root, dataDir });
try {
  let status = await manager.status(true);
  if (status.source !== 'bundled') {
    await manager.install();
    do {
      await new Promise(resolveWait => setTimeout(resolveWait, 1000));
      status = await manager.status();
    } while (['downloading', 'extracting', 'checking'].includes(status.installation.state));
    if (status.installation.state === 'failed') throw new Error(status.installation.message);
    status = await manager.status(true);
    if (!status.ready || !status.visionReady || status.source !== 'managed') throw new Error('Prepared runtime failed its checks');
    await rename(status.directory, join(root, 'runtime', status.platform));
  }
  if (!status.ready || !status.visionReady) throw new Error('Bundled runtime failed its checks');
  process.stdout.write(`Prepared ${status.platform}\n`);
} finally { await manager.close(); await rm(dataDir, { recursive: true, force: true }); }
