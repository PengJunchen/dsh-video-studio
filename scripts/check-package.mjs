#!/usr/bin/env node
// Release gate: execute the installed, relocated package with only its own tools on PATH.
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const directory = await mkdtemp(join(tmpdir(), 'dsh-package-'));
let runtime;
try {
  execFileSync('tar', ['-xzf', resolve(process.argv[2]), '-C', directory]);
  const root = join(directory, 'package');
  const { createEnvironmentManager } = await import(pathToFileURL(join(root, 'src/environment.mjs')));
  const manager = createEnvironmentManager({ root, dataDir: join(directory, 'data') });
  const health = await manager.status(true);
  if (health.source !== 'bundled' || !health.ready || !health.visionReady) throw new Error(JSON.stringify(health));
  const execution = await manager.execution();
  execFileSync(execution.python, ['-c',
    'import os,sys,cv2; assert os.path.normcase(os.path.realpath(sys.prefix)) == os.path.normcase(os.path.realpath(sys.argv[1])), "Python escaped the package"',
    join(execution.directory, 'python')], { env: execution.env });
  if (process.platform === 'win32') execFileSync(execution.python, ['-c', `
import ctypes, pathlib, sys, cv2
kernel = ctypes.WinDLL('kernel32', use_last_error=True)
kernel.GetModuleHandleW.argtypes = [ctypes.c_wchar_p]
kernel.GetModuleHandleW.restype = ctypes.c_void_p
kernel.GetModuleFileNameW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_uint32]
for name in ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']:
    handle = kernel.GetModuleHandleW(name)
    if handle:
        target = ctypes.create_unicode_buffer(32768)
        assert kernel.GetModuleFileNameW(handle, target, len(target))
        assert pathlib.Path(target.value).resolve().is_relative_to(pathlib.Path(sys.prefix).resolve()), name + ' loaded from the system'
`], { env: execution.env });
  process.env.PATH = [join(execution.directory, 'bin'), join(execution.directory, process.platform === 'win32' ? 'python' : 'python/bin')].join(process.platform === 'win32' ? ';' : ':');
  delete process.env.PYTHONHOME; delete process.env.PYTHONPATH; delete process.env.HVP_PYTHON;
  if (process.platform === 'darwin') {
    for (const name of ['ffmpeg', 'ffprobe']) {
      const linked = execFileSync('/usr/bin/otool', ['-L', join(execution.directory, 'bin', name)], { encoding: 'utf8' });
      if (/\/(opt\/homebrew|usr\/local|Users\/)/.test(linked.split('\n').slice(1).join('\n'))) throw new Error('FFmpeg depends on a developer library');
    }
  }
  const { createMediaRuntime } = await import(pathToFileURL(join(root, 'src/runtime.mjs')));
  runtime = await createMediaRuntime({ dataDir: join(directory, 'data'), allowedRoots: [directory], allowUserExportGrants: true });
  for (const id of ['lut-batch', 'tone', 'skin', 'local-color', 'finish']) runtime.registerFeature({ id, version: 1 }, 'release');
  const source = join(directory, '素材 sample.mp4');
  execFileSync(join(execution.directory, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
    ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=128x72:rate=6', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', source]);
  await runtime.scan({ directory });
  const assetId = (await runtime.state()).assets[0]?.id;
  if (!assetId) throw new Error('Scan produced no asset');
  let view = await runtime.select({ assetId });
  await runtime.updateDraft({ assetId, revision: view.draft.revision,
    changes: { cameraOverride: 'pocket4p', modeOverride: 'D-Log2', lutEnabled: true, lutLook: 'vivid', lutSize: 65,
      shadows: 0.2, highlights: -0.15, denoise: { amount: 0.1 } } });
  view = await runtime.state();
  async function finish(submission) {
    let job = submission.job;
    const deadline = Date.now() + 120000;
    while (!['succeeded', 'failed', 'cancelled'].includes(job.status)) {
      if (Date.now() > deadline) throw new Error('Package processing timed out');
      await new Promise(resolveWait => setTimeout(resolveWait, 200));
      job = (await runtime.readJob(job.id)).job;
    }
    if (job.status !== 'succeeded') throw new Error(JSON.stringify(job.error));
    return job;
  }
  await finish(await runtime.preview({ assetId, revision: view.draft.revision, timeSeconds: 0.5 }));
  await finish(await runtime.render({ assetId, revision: view.draft.revision, exportQuality: 'preserve' }));
  const exports = await runtime.exportHistory(assetId);
  process.stdout.write(JSON.stringify({ platform: health.platform, source: health.source, health: 'passed',
    scan: 'passed', preview: 'passed', export: 'passed', python: execution.python, exportCount: exports.exports?.length ?? exports.length }) + '\n');
  await manager.close();
} finally {
  await runtime?.close();
  // Detached runners can briefly hold a Windows directory after their final job write.
  await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
