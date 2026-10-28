#!/usr/bin/env node
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createEnvironmentManager } from '../src/environment.mjs';

const args = process.argv.slice(2);
const index = args.indexOf('--data-dir');
const dataDir = index < 0 ? join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'video-studio') : resolve(args[index + 1] || '.');
const manager = createEnvironmentManager({ root: resolve(dirname(fileURLToPath(import.meta.url)), '..'), dataDir });
let last;
try {
  let state = await manager.status(true);
  if (args.includes('--install')) {
    if (!state.canInstall) throw new Error(state.installReason || 'Platform runtime unavailable');
    if (!['managed', 'bundled'].includes(state.source) || !state.ready || !state.visionReady) {
      state = await manager.install();
      while (['downloading', 'extracting', 'checking'].includes(state.installation.state)) {
        if (last !== state.installation.state) { process.stdout.write(`${state.installation.message}\n`); last = state.installation.state; }
        await new Promise(resolveWait => setTimeout(resolveWait, 1000));
        state = await manager.status();
      }
      if (state.installation.state === 'failed') throw new Error(state.installation.message);
      state = await manager.status(true);
    }
  }
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
  if (!state.ready) process.exitCode = 1;
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
finally { await manager.close(); }
