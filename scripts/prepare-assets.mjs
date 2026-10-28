#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const executable = process.env.HVP_BUILD_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const child = spawn(executable, [fileURLToPath(new URL('./prepare-assets.py', import.meta.url)), ...process.argv.slice(2)], {
  stdio: 'inherit', env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
});
child.once('error', error => { process.stderr.write(`Resource preparation needs Python 3.10+: ${error.message}\n`); process.exitCode = 1; });
child.once('close', code => { process.exitCode = code ?? 1; });
