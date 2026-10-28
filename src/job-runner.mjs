import { spawn } from 'node:child_process';
import { open, readFile, realpath, unlink, stat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJSON, readJSON } from './storage.mjs';
import { workerResult } from './worker-protocol.mjs';
import { exportNameFor, publishExport } from './export-files.mjs';

const [runDir, python, workerPath, dataDir] = process.argv.slice(2);
const jobFile = join(runDir, 'job.json');
const job = await readJSON(jobFile);
// Bounded diagnostics and single-frame previews do not wait behind an entire
// proxy/export encode. Each lane still has one owner across all Host windows.
const lockFile = join(dataDir, job.action === 'analyze' ? 'analysis.lock' : job.action === 'preview' ? 'preview.lock' : 'engine.lock');
const isAlive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const exists = async file => { try { await stat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let ownsLock = false;
let child;
let timer;
let killTimer;
let cancelled = false;
async function save() { await atomicJSON(jobFile, job); }
try {
  // An atomic filesystem lock coordinates independent detached task owners.
  while (!ownsLock) {
    if (await exists(join(runDir, 'cancel'))) { cancelled = true; throw new Error('cancelled'); }
    try {
      const lock = await open(lockFile, 'wx', 0o600);
      await lock.writeFile(JSON.stringify({ pid: process.pid, task: job.id }));
      await lock.close(); ownsLock = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = await readJSON(lockFile, null).catch(() => null);
      // Never unlink a stale lock here: two queued owners could both reclaim it
      // and start concurrent encoders. An operator must reconcile a crashed
      // task before explicitly removing its lock.
      const age = Date.now() - (await stat(lockFile).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs;
      if ((owner?.pid && !isAlive(owner.pid)) || (!owner && age > 5000)) {
        const recovery = new Error('上次处理异常退出，需要核对任务后重新启动处理服务。');
        recovery.code = 'ENGINE_RECOVERY_REQUIRED'; throw recovery;
      }
      await sleep(200);
    }
  }
  job.status = 'running'; job.progress = null; job.ownerPid = process.pid; job.startedAt = new Date().toISOString(); await save();
  const request = await readFile(join(runDir, 'request.json'));
  const raw = await new Promise((resolveResult, reject) => {
    child = spawn(python, [workerPath], { detached: true, stdio: ['pipe','pipe','pipe'] });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    let output = '', diagnostic = '', outputBytes = 0;
    let stopping = false, settled = false, pollBusy = false, pollError, outputError, spawnError;
    let poll = Promise.resolve();
    function signalGroup(kind) {
      try {
        if (process.platform === 'win32' || !child.pid) child.kill(kind);
        else process.kill(-child.pid, kind);
      } catch (error) { if (error.code !== 'ESRCH') process.stderr.write(`${error.message}\n`); }
    }
    function stop() {
      if (stopping) return;
      stopping = true;
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => signalGroup('SIGKILL'), 3000);
      killTimer.unref?.();
    }
    function checkCancel() {
      if (settled || pollBusy || cancelled) return;
      pollBusy = true;
      poll = (async () => {
        if (await exists(join(runDir, 'cancel'))) {
          cancelled = true;
          job.status = 'draining';
          await save();
          stop();
        }
      })().catch(error => { pollError = error; stop(); }).finally(() => { pollBusy = false; });
    }
    timer = setInterval(checkCancel, 200);
    child.stdout.on('data', chunk => {
      if (outputError) return;
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > 8 * 1024 * 1024) { outputError = new Error('Worker output exceeds limit'); stop(); return; }
      output += chunk;
    });
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-32768); });
    child.once('spawn', () => { if (stopping) signalGroup('SIGTERM'); });
    child.once('error', error => { spawnError = error; });
    child.once('close', code => {
      settled = true;
      clearInterval(timer);
      void poll.then(() => {
        clearTimeout(killTimer);
        if (stopping || spawnError || code !== 0) signalGroup('SIGKILL');
        if (cancelled) throw new Error('cancelled');
        if (pollError) throw pollError;
        if (outputError) throw outputError;
        if (spawnError) throw spawnError;
        if (code !== 0) {
          try { workerResult(JSON.parse(output)); } catch (error) { throw error; }
          throw new Error(diagnostic || `Worker exited ${code}`);
        }
        return workerResult(JSON.parse(output));
      }).then(resolveResult, reject);
    });
    child.stdin.on('error', () => {}); child.stdin.end(request);
  });
  job.result = raw;
  if (job.action === 'render' && job.exportDestination) {
    try {
      if (![join(runDir, 'render.mp4'), join(runDir, 'render.mkv')].includes(await realpath(raw.outputPath))) throw new Error('导出结果不在任务目录内。');
      const saved = await publishExport(raw.outputPath, job.exportDestination, job.id, exportNameFor(job.exportName, raw.lut), { removeSource: true });
      raw.exportFile = saved; raw.outputPath = saved.path; raw.output_path = saved.path;
    } catch (error) {
      // Preserve a verified encoded video when the external volume fills up or
      // disappears. The UI exposes its internal path and offers Save As again.
      raw.exportSaveError = `视频已生成，但保存到所选文件夹失败：${error.message}`;
    }
    await atomicJSON(join(runDir, 'result.json'), raw);
  }
  job.status = 'succeeded'; job.progress = 1;
} catch (error) {
  job.status = cancelled ? 'cancelled' : 'failed';
  job.error = { code: cancelled ? 'CANCELLED' : error.code ?? 'PROCESSING_FAILED', message: cancelled ? '处理已取消。' : error.message };
} finally {
  clearInterval(timer); clearTimeout(killTimer);
  job.finishedAt = new Date().toISOString();
  try {
    // The owner has drained the worker before removing only its known scratch
    // files. Keep frozen requests, receipts, and published outputs for review.
    for (const name of await readdir(runDir)) {
      if (job.status !== 'succeeded' && (job.action === 'preview'
          && ['before.png','base.png','sample.png','after.png','tone-base.rgb'].includes(name)
          || job.action === 'playback' && name === 'playback.mp4')) {
        await unlink(join(runDir, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
        continue;
      }
      if (/^\.tone-plan-[A-Za-z0-9_-]+$/.test(name)) {
        await rm(join(runDir, name), { recursive: true, force: true });
        continue;
      }
      if (/^\.(?:preview|playback)-source-[A-Za-z0-9_-]+\.partial\.mkv$/.test(name)
          || /^\.proxy-[a-f0-9]{64}-[A-Za-z0-9_-]+\.partial\.mp4$/.test(name)) {
        await unlink(join(runDir, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
        continue;
      }
      if (/^\.tone-[a-f0-9]{20}(?:\.shaper)?\.cube$/.test(name) || /^\.(?:(?:render|playback)\.partial\.(?:mp4|mkv)|after\.partial\.png|skin-mask\.mkv)$/.test(name)) {
        await unlink(join(runDir, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    }
    await save();
  }
  finally { if (ownsLock) await unlink(lockFile).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
