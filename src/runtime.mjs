import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { createReadStream } from 'node:fs';
import { mkdir, realpath, readdir, stat, readFile, writeFile, appendFile, unlink } from 'node:fs/promises';
import { resolve, join, dirname, extname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { atomicJSON, readJSON, digest } from './storage.mjs';
import { workerRequest, workerResult } from './worker-protocol.mjs';
import { normalizeToneSegments } from './tone-plan.mjs';
import { adviceSystem, AI_GROUPS, adviceFacts, adviceSamplePlan, parseAdvice } from './ai-advice.mjs';
import { exportDirectoryIdentity, validateExportDirectory, exportFileIdentity, exportNameFor, publishExport } from './export-files.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const features = ['lut-batch', 'tone', 'skin', 'local-color', 'finish'];
// New optional controls stay absent/null in legacy drafts until the user edits them.
const optionalKeys = ['highlights', 'shadows', 'toneSegments', 'lowLight', 'denoise', 'skin', 'color'];
const mediaTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.mkv':'video/x-matroska', '.webm': 'video/webm' };
const inside = (base, file) => { const rel = relative(base, file); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
export class MediaError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
const fail = (code, message, status) => { throw new MediaError(code, message, status); };
const publicAsset = asset => Object.fromEntries(Object.entries(asset).filter(([key]) => !['sourcePath', 'source_path', 'path', 'captureProfile', 'analysis', 'analysisJob', 'analysisKey', 'analysisResultJobId'].includes(key)));
const defaultDraft = (asset, hasLutFeature) => ({ revision: 0, lutEnabled: Boolean(asset.lut?.available && hasLutFeature),
  lutLook: asset.lut?.look ?? null, lutSize: asset.lut?.grid ?? null,
  highlights: null, shadows: null, toneSegments: null, lowLight: null, denoise: null, skin: null, color: null });

/** Local authority: source grants, immutable drafts, durable tasks and feature ownership. */
export async function createMediaRuntime(config = {}) {
  const requestedDataDir = resolve(config.dataDir ?? join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'video-studio'));
  await mkdir(requestedDataDir, { recursive: true });
  const dataDir = await realpath(requestedDataDir);
  const allowedRoots = await Promise.all((config.allowedRoots ?? [process.cwd()]).map(p => realpath(resolve(p))));
  const python = config.python ?? process.env.HVP_PYTHON ?? 'python3';
  const workerPath = resolve(config.workerPath ?? join(root, 'worker/media_worker.py'));
  const workerConfig = { ...config.workerConfig, sourceCacheDir: join(dataDir, 'source-cache') };
  let catalogContentHash;
  async function refreshCatalogIdentity() {
    const paths = [workerConfig.assets?.catalog_path, workerConfig.assets?.library_path].filter(Boolean);
    if (!paths.length) { catalogContentHash = undefined; return; }
    // A catalog can be replaced in place. Its path is not its identity.
    try {
      const hashes = await Promise.all(paths.map(async path => createHash('sha256').update(await readFile(path)).digest('hex')));
      catalogContentHash = hashes.length === 1 ? hashes[0] : digest(hashes);
    }
    catch (error) { catalogContentHash = `unavailable:${error.code ?? 'read-error'}`; }
  }
  await refreshCatalogIdentity();
  const stateFile = join(dataDir, 'state.json');
  let store = await readJSON(stateFile, { schemaVersion: 1, assets: {}, drafts: {}, selectedAssetId: null });
  // Older builds hard-coded Standard and never offered a user selection.
  // Missing fields now follow the automatic Vivid/65 preference; manual
  // choices saved by this build remain explicit across restarts and scans.
  for (const draft of Object.values(store.drafts)) {
    draft.lutLook ??= null;
    draft.lutSize ??= null;
  }
  // Grants come from explicit operator folder selection, never from the scan
  // API itself. Missing volumes can be reselected.
  for (const path of store.sourceGrants ?? []) {
    if (typeof path !== 'string' || !isAbsolute(path)) continue;
    try { allowedRoots.push(await realpath(path)); } catch { /* An unplugged volume is not an active grant. */ }
  }
  const catalog = new Map();
  let mutation = Promise.resolve();
  let closed = false;
  let closing;
  let tracing = Promise.resolve();
  const traceFile = join(dataDir, 'request-trace.ndjson');
  function traceRequest(record) {
    // Local bounded diagnostics: never record paths, bodies, headers or metadata.
    tracing = tracing.then(async () => {
      const size = await stat(traceFile).then(info => info.size).catch(() => 0);
      if (size > 1024 * 1024) await writeFile(traceFile, '');
      await appendFile(traceFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    }).catch(() => {});
  }
  const foreground = new Set();
  const processes = new Set();
  const pickerControllers = new Set();
  const aiControllers = new Map();
  const originalSources = new Map();
  // In-process LLM calls cannot resume after their Host has exited.
  for (const entry of await readdir(join(dataDir, 'jobs')).catch(() => [])) {
    if (!/^[0-9a-f-]{36}$/.test(entry)) continue;
    const file = join(dataDir, 'jobs', entry, 'job.json');
    const job = await readJSON(file, null);
    if (job?.action !== 'ai-advice' || !['queued', 'running', 'draining'].includes(job.status)) continue;
    let alive = false;
    if (job.ownerPid) { try { process.kill(job.ownerPid, 0); alive = true; } catch { /* Owner exited. */ } }
    if (!alive) await atomicJSON(file, { ...job, status: 'failed', finishedAt: new Date().toISOString(),
      error: { code: 'AI_INTERRUPTED', message: '上次 AI 分析随服务退出而中断，请重新分析。' } });
  }
  let pickerPending;
  const serialize = operation => {
    const next = mutation.then(operation);
    mutation = next.catch(() => {});
    return next;
  };
  function available(id) { return catalog.has(id); }
  function analysisKey(selected, draft = store.drafts[selected.id]) {
    const facts = selected.captureProfile ?? selected.profile;
    return digest({ sha256: selected.sha256, camera: draft.cameraOverride ?? facts?.camera,
      mode: draft.modeOverride ?? facts?.mode, lutEnabled: draft.lutEnabled,
      lutLook: draft.lutLook ?? null, lutSize: draft.lutSize ?? null,
      catalog: workerConfig.assets?.catalog_path, library: workerConfig.assets?.library_path,
      catalogSha256: catalogContentHash, analyzerRevision: 8 });
  }
  function feature(id) { if (!available(id)) fail('FEATURE_UNAVAILABLE', '此功能尚未启用。', 409); }
  function asset(id) { const value = store.assets[id]; if (!value) fail('ASSET_NOT_FOUND', '找不到所选视频。', 404); return value; }
  function assertOpen() { if (closed) fail('RUNTIME_CLOSED', '视频服务已停止。', 503); }
  async function trackForeground(operation) {
    assertOpen();
    const task = operation();
    foreground.add(task);
    task.then(() => foreground.delete(task), () => foreground.delete(task));
    return task;
  }
  async function trustedPath(path) {
    const canonical = await realpath(resolve(path));
    if (!allowedRoots.some(base => inside(base, canonical))) fail('SOURCE_OUTSIDE_GRANT', '此文件夹不在已选择的素材范围内。', 403);
    return canonical;
  }
  async function sourceVersion(path) {
    const value = await stat(path, { bigint: true });
    return digest(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => String(value[key])));
  }
  async function assertSourceDigest(path, expected, signal) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
    if (hash.digest('hex') !== expected) fail('SOURCE_CHANGED', '素材已变化，请重新扫描后分析。', 409);
  }
  function registerFeature(definition, owner) {
    assertOpen();
    if (!features.includes(definition.id) || !owner) fail('INVALID_FEATURE', 'Unknown feature registration');
    const hash = definition.definitionHash ?? digest({ id: definition.id, version: definition.version ?? 1 });
    const previous = catalog.get(definition.id);
    if (previous && previous.hash !== hash) fail('FEATURE_CONFLICT', `功能版本冲突：${definition.id}`, 409);
    const entry = previous ?? { hash, owners: new Map(), definition };
    entry.owners.set(owner, (entry.owners.get(owner) ?? 0) + 1);
    catalog.set(definition.id, entry);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const count = entry.owners.get(owner) ?? 0;
      if (count <= 1) entry.owners.delete(owner); else entry.owners.set(owner, count - 1);
      if (!entry.owners.size) catalog.delete(definition.id);
    };
  }
  async function invoke(request, signal) {
    assertOpen();
    signal?.throwIfAborted();
    const input = JSON.stringify(workerRequest({ ...workerConfig, ...request }));
    const task = { abort: () => {}, promise: null };
    const promise = new Promise((resolveResult, reject) => {
      const child = spawn(python, [workerPath], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      let stdout = '', stderr = '', spawnError, aborted;
      let forceTimer;
      const signalGroup = kind => {
        try {
          if (process.platform === 'win32' || !child.pid) child.kill(kind);
          else process.kill(-child.pid, kind);
        } catch (error) {
          if (error.code !== 'ESRCH') process.stderr.write(`worker ${kind}: ${error.message}\n`);
        }
      };
      task.abort = reason => {
        if (aborted) return;
        aborted = reason instanceof Error ? reason : new Error('Operation aborted');
        signalGroup('SIGTERM');
        forceTimer = setTimeout(() => signalGroup('SIGKILL'), 3000);
        forceTimer.unref?.();
      };
      const onAbort = () => task.abort(signal.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      child.once('spawn', () => { if (aborted) signalGroup('SIGTERM'); });
      child.once('error', error => { spawnError = error; });
      child.stdout.on('data', chunk => {
        if (Buffer.byteLength(stdout) + chunk.byteLength > 8 * 1024 * 1024) {
          task.abort(new MediaError('WORKER_OUTPUT_TOO_LARGE', '视频服务响应过大。', 502));
          return;
        }
        stdout += chunk;
      });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-32768); });
      child.once('close', code => {
        signal?.removeEventListener('abort', onAbort);
        clearTimeout(forceTimer);
        if (aborted || spawnError || code !== 0) signalGroup('SIGKILL');
        if (aborted) { reject(aborted); return; }
        if (spawnError) { reject(spawnError); return; }
        try {
          const result = JSON.parse(stdout.trim());
          if (code !== 0 || result.ok === false || result.status === 'error') throw new MediaError(result.error?.code ?? result.code ?? 'WORKER_FAILED', result.error?.message ?? (typeof result.error === 'string' ? result.error : null) ?? result.message ?? stderr ?? '处理失败。');
          resolveResult(workerResult(result));
        } catch (error) { reject(error instanceof MediaError ? error : new MediaError('WORKER_FAILED', `视频服务返回错误：${stderr || error.message}`)); }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
    task.promise = promise;
    processes.add(task);
    promise.then(() => processes.delete(task), () => processes.delete(task));
    return promise;
  }
  async function save() { await atomicJSON(stateFile, store); }
  async function grantDirectory(chosen, signal) {
    assertOpen();
    signal?.throwIfAborted();
    if (typeof chosen !== 'string' || !isAbsolute(chosen)) fail('PICKER_INVALID_PATH', '文件夹选择器未返回有效路径。');
    const path = await realpath(chosen);
    if (!(await stat(path)).isDirectory()) fail('PICKER_INVALID_PATH', '请选择一个文件夹。');
    return serialize(async () => {
      assertOpen();
      signal?.throwIfAborted();
      const previous = store.sourceGrants ?? [];
      store.sourceGrants = [...new Set([...previous, path])];
      try { await save(); } catch (error) { store.sourceGrants = previous; throw error; }
      if (!allowedRoots.includes(path)) allowedRoots.push(path);
      return { directory: path };
    });
  }
  async function grantExportDirectory(directory) {
    assertOpen();
    if (config.allowUserExportGrants !== true) fail('EXPORT_GRANT_UNAVAILABLE', '当前环境不允许选择保存位置。', 403);
    let destination;
    try { destination = await exportDirectoryIdentity(directory); }
    catch (error) { fail('INVALID_EXPORT_DIRECTORY', `保存文件夹不可用：${error.message}`); }
    return serialize(async () => {
      const previous = { grants: store.exportGrants, directory: store.exportDirectory };
      store.exportGrants = { ...store.exportGrants, [destination.directory]: destination };
      store.exportDirectory = destination.directory;
      try { await save(); }
      catch (error) { store.exportGrants = previous.grants; store.exportDirectory = previous.directory; throw error; }
      return { directory: destination.directory };
    });
  }
  async function exportDestination(directory) {
    const destination = store.exportGrants?.[directory];
    if (!destination) fail('EXPORT_DIRECTORY_REQUIRED', '请先选择视频保存文件夹。');
    try { await validateExportDirectory(destination); }
    catch (error) { fail('EXPORT_DIRECTORY_CHANGED', error.message, 409); }
    return structuredClone(destination);
  }
  function defaultExportDirectory(assetId) {
    return join(dirname(asset(assetId).sourcePath), 'Output');
  }
  async function prepareExportDirectory(assetId, directory) {
    const requested = directory || defaultExportDirectory(assetId);
    if (store.exportGrants?.[requested]) return exportDestination(requested);
    if (requested !== defaultExportDirectory(assetId)) return exportDestination(requested);
    if (config.allowUserExportGrants !== true) fail('EXPORT_GRANT_UNAVAILABLE', '当前环境不允许写入默认保存位置。', 403);
    const parent = await trustedPath(dirname(asset(assetId).sourcePath));
    await mkdir(join(parent, 'Output'), { recursive: true });
    if (await realpath(join(parent, 'Output')) !== join(parent, 'Output')) fail('INVALID_EXPORT_DIRECTORY', '默认 Output 不能是符号链接，请另选保存位置。');
    await grantExportDirectory(join(parent, 'Output'));
    return exportDestination(join(parent, 'Output'));
  }
  async function exportRecord(id) {
    const job = await readJSON(join(jobDir(id), 'job.json'), null);
    if (!job || job.action !== 'render' || job.status !== 'succeeded') fail('EXPORT_NOT_READY', '完整视频还未生成。', 409);
    const path = await mediaPath(`${id}:video`);
    return { jobId: id, assetId: job.assetId, revision: job.revision, videoRef: `${id}:video`, path,
      fileName: path.split(/[\\/]/).pop(), bytes: (await stat(path)).size, finishedAt: job.finishedAt,
      savedToChosenDirectory: Boolean(job.result.exportFile), saveError: job.result.exportSaveError ?? null,
      lutLabel: job.result.lut ? `${job.result.lut.look === 'vivid' ? 'Vivid' : 'Standard'} · Size ${job.result.lut.grid || '—'}` : '未应用 LUT',
      qualityLabel: job.result.readback?.encoding_pixel_check?.all_frames_bit_exact ? '细节优先 · 全帧编码校验一致' : '有损编码 · 不用于细线保真验收',
      canOpen: config.exportOpener?.available?.() === true };
  }
  async function exportHistory(assetId) {
    assertOpen(); asset(assetId);
    const rows = [], active = [];
    for (const id of await readdir(join(dataDir, 'jobs')).catch(error=>{ if(error.code==='ENOENT')return [];throw error; })) {
      if (!/^[0-9a-f-]{36}$/.test(id)) continue;
      const job = await readJSON(join(jobDir(id), 'job.json'), null);
      if (job?.action !== 'render' || job.assetId !== assetId) continue;
      if (['queued', 'running', 'draining'].includes(job.status)) {
        let alive = true;
        if (job.ownerPid) { try { process.kill(job.ownerPid, 0); } catch { alive = false; } }
        if (alive) active.push(job);
      }
      if (job.status === 'succeeded') rows.push(job);
    }
    rows.sort((a,b) => String(b.finishedAt).localeCompare(String(a.finishedAt)));
    const exports = [];
    for (const job of rows.slice(0, 10)) {
      try { exports.push(await exportRecord(job.id)); } catch { /* Missing files are not playable results. */ }
    }
    active.sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return { exports, directory: store.exportDirectory ?? defaultExportDirectory(assetId), defaultDirectory: defaultExportDirectory(assetId), supportsExportQualityChoices: true, activeJob: active[0] ? (await readJob(active[0].id)).job : null };
  }
  async function saveExport({ jobId: id, directory }) {
    assertOpen();
    const initial = await exportRecord(id);
    const destination = await prepareExportDirectory(initial.assetId, directory);
    return serialize(async () => {
      const record = await exportRecord(id);
      if (record.savedToChosenDirectory && dirname(record.path) === destination.directory) return { export: record };
      const job = await readJSON(join(jobDir(id), 'job.json'), null);
      const saved = await publishExport(record.path, destination, id, exportNameFor(asset(job.assetId).name, job.result.lut));
      job.result.exportFile = saved; delete job.result.exportSaveError;
      await atomicJSON(join(jobDir(id), 'job.json'), job);
      return { export: await exportRecord(id) };
    });
  }
  async function openExport({ jobId: id, target }) {
    if (!['video', 'folder'].includes(target)) fail('INVALID_EXPORT_TARGET', '打开方式无效。');
    if (config.exportOpener?.available?.() !== true) fail('EXPORT_OPEN_UNAVAILABLE', '请使用保存路径或下载按钮打开视频。', 409);
    const record = await exportRecord(id);
    await config.exportOpener.open(record.path, target);
    return { opened: true };
  }
  function canPickDirectory() { return config.directoryPicker?.available?.() === true; }
  function pickDirectory(signal, purpose = 'source') {
    assertOpen();
    if (!canPickDirectory()) fail('PICKER_UNAVAILABLE', '此环境暂不支持系统文件夹选择，请输入素材路径。', 409);
    // A second window does not acquire or cancel another caller's dialog.
    if (pickerPending) fail('PICKER_BUSY', '另一个窗口已打开文件夹选择，请先完成或取消。', 409);
    pickerPending = trackForeground(async () => {
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      pickerControllers.add(controller);
      try {
        const chosen = await config.directoryPicker.pick(controller.signal);
        controller.signal.throwIfAborted();
        assertOpen();
        if (chosen === null) return { directory: null };
        return purpose === 'export' ? await grantExportDirectory(chosen) : await grantDirectory(chosen, controller.signal);
      } finally {
        signal?.removeEventListener('abort', abort);
        pickerControllers.delete(controller);
      }
    }).finally(() => { pickerPending = undefined; });
    return pickerPending;
  }
  async function view(selectedId = store.selectedAssetId) {
    await refreshCatalogIdentity();
    const selected = selectedId ? asset(selectedId) : null;
    const currentAnalysis = selected && selected.analysisKey === analysisKey(selected) ? selected.analysis ?? null : null;
    const visible = Array.isArray(store.visibleAssetIds) ? store.visibleAssetIds.map(id => store.assets[id]).filter(Boolean) : Object.values(store.assets);
    return { assets: visible.map(publicAsset), asset: selected && publicAsset(selected), draft: selected && store.drafts[selectedId], directory: store.lastDirectory ?? '', features: [...catalog.keys()], selectedAssetId: selectedId, analysis: currentAnalysis,
      analysisKey: selected ? analysisKey(selected) : null, analysisJob: selected?.analysisJob ?? null, protocolVersion: 1,
      canPickDirectory: canPickDirectory(),
      adjustmentCapabilities: { lowLight: true, denoise: true },
      cameraOptions: [{value:'pocket4p',label:'DJI Osmo Pocket 4P'},{value:'pocket4',label:'DJI Osmo Pocket 4'},{value:'pocket3',label:'DJI Osmo Pocket 3'}] };
  }
  async function doScan({ directory }, signal) {
    await refreshCatalogIdentity();
    if (typeof directory !== 'string') fail('DIRECTORY_REQUIRED', '请选择素材文件夹。');
    const directoryPath = await trustedPath(directory);
    assertOpen();
    signal?.throwIfAborted();
    const found = [];
    async function walk(dir, depth = 0) {
      if (depth > 8 || found.length >= 200 || inside(dataDir, dir)) return;
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        assertOpen();
        signal?.throwIfAborted();
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name.toLowerCase() === 'output' || store.exportGrants?.[path]) continue;
          await walk(path, depth + 1);
        }
        else if (/\.(mp4|mov|mkv|m4v)$/i.test(entry.name) && found.length < 200) found.push(path);
      }
    }
    await walk(directoryPath);
    const scanned = [];
    const problems = [];
    for (const path of found) {
      assertOpen();
      signal?.throwIfAborted();
      try {
        const sourcePath = await trustedPath(path);
        const result = await invoke({ action: 'probe', sourcePath }, signal);
        const probed = result.asset ?? result.assets?.[0] ?? result;
        if (!probed.sha256 || !probed.width || !probed.height) fail(result.errors?.[0]?.code ?? 'PROBE_FAILED', result.errors?.[0]?.error ?? '无法读取视频。');
        const id = probed.id ?? digest({ sourcePath, sha256: probed.sha256 }).slice(0, 24);
        scanned.push({ ...probed, id, name: probed.name ?? path.split('/').at(-1), sourcePath, captureProfile: probed.profile });
      } catch (error) {
        assertOpen();
        signal?.throwIfAborted();
        problems.push({ name: path.split('/').at(-1), message: error.message });
      }
    }
    return serialize(async () => {
      assertOpen();
      signal?.throwIfAborted();
      for (const item of scanned) {
        const previous = store.assets[item.id];
        const draft = store.drafts[item.id] ??= defaultDraft(item, available('lut-batch'));
        // Probe still verifies the source bytes. Reuse work only for the same
        // canonical source, capture evidence and effective input transform.
        const sameInput = previous?.sourcePath === item.sourcePath && previous.sha256 === item.sha256
          && digest(previous.captureProfile ?? previous.profile) === digest(item.captureProfile);
        const key = analysisKey(item, draft);
        if (sameInput) {
          if (previous.analysis && previous.analysisKey === key) {
            item.analysis = previous.analysis;
            item.analysisKey = key;
            item.analysisResultJobId = previous.analysisResultJobId;
            if (previous.analysis.profile) item.profile = previous.analysis.profile;
            if (previous.analysis.lut) item.lut = previous.analysis.lut;
          }
          if (previous.analysisJob?.analysisKey === key) item.analysisJob = previous.analysisJob;
        }
        store.assets[item.id] = item;
      }
      store.visibleAssetIds = scanned.map(item => item.id);
      if (!store.visibleAssetIds.includes(store.selectedAssetId)) store.selectedAssetId = null;
      store.lastDirectory = directoryPath;
      await save();
      return { ...await view(), scanned: scanned.length, problems, limit: 200 };
    });
  }
  const scan = (input, signal) => trackForeground(() => doScan(input, signal));
  async function doSelect({ assetId, refineAnalysis = false }, signal) {
    if (typeof refineAnalysis !== 'boolean') fail('INVALID_ANALYSIS', '请选择是否细化区间。');
    await refreshCatalogIdentity();
    const selected = asset(assetId);
    await trustedPath(selected.sourcePath);
    assertOpen();
    signal?.throwIfAborted();
    if (selected.analysisJob?.id) {
      await readJob(selected.analysisJob.id).catch(error => { if (error.code !== 'JOB_NOT_FOUND') throw error; });
    }
    return serialize(async () => {
      assertOpen();
      signal?.throwIfAborted();
      const current = asset(assetId);
      const key = analysisKey(current);
      if (current.analysisKey !== key) current.analysis = null;
      if (refineAnalysis || !current.analysis) {
        const previous = current.analysisJob?.analysisKey === key
          ? await readJSON(join(jobDir(current.analysisJob.id), 'job.json'), null) : null;
        const active = previous && ['queued', 'running', 'draining'].includes(previous.status);
        if (!active || refineAnalysis && !previous.refined) {
          if (active) await writeFile(join(jobDir(previous.id), 'cancel'), 'superseded by refined analysis\n');
          const queued = await queueWorker('analyze', current, store.drafts[assetId], { analysisKey: key, analysisRefine: refineAnalysis });
          current.analysisJob = { id: queued.job.id, status: queued.job.status, analysisKey: key, refined: refineAnalysis };
        }
      }
      store.selectedAssetId = assetId;
      await save();
      return view(assetId);
    });
  }
  const select = (input, signal) => trackForeground(() => doSelect(input, signal));
  async function updateDraft({ assetId, revision, changes }) {
    await refreshCatalogIdentity();
    assertOpen();
    return serialize(async () => {
      assertOpen();
      const selected = asset(assetId);
      const draft = store.drafts[assetId];
      if (revision !== draft.revision) fail('STALE_DRAFT', '方案已更新，请刷新后重试。', 409);
      if (!changes || typeof changes !== 'object' || Array.isArray(changes)) fail('INVALID_CHANGES', '无效的调整。');
      const allowed = ['lutEnabled', 'lutLook', 'lutSize', ...optionalKeys, 'modeOverride', 'cameraOverride'];
      for (const key of Object.keys(changes)) if (!allowed.includes(key)) fail('UNKNOWN_CONTROL', `不支持的调整：${key}`);
      const next = { ...draft, ...changes, revision: draft.revision + 1 };
      next.lowLight ??= null; next.denoise ??= null;
      try { next.toneSegments = normalizeToneSegments(next.toneSegments, selected.duration); }
      catch { fail('INVALID_TONE_SEGMENTS', '分段明暗方案无效，请检查时间范围和调节值。'); }
      for (const key of ['highlights', 'shadows']) {
        if (next[key] !== null && (typeof next[key] !== 'number' || !Number.isFinite(next[key]) || Math.abs(next[key]) > 1)) fail('INVALID_CONTROL', '调整值超出范围。');
      }
      if (next.lowLight !== null && (typeof next.lowLight !== 'number' || !Number.isFinite(next.lowLight) || next.lowLight < 0 || next.lowLight > 1)) fail('INVALID_LOW_LIGHT', '暗光增强值超出范围。');
      if (next.denoise !== null) {
        if (typeof next.denoise !== 'object' || Array.isArray(next.denoise) || Object.keys(next.denoise).some(key => key !== 'amount')
          || typeof next.denoise.amount !== 'number' || !Number.isFinite(next.denoise.amount) || next.denoise.amount < 0 || next.denoise.amount > 1) fail('INVALID_DENOISE', '降噪强度超出范围。');
        next.denoise = { amount: next.denoise.amount };
      }
      if (next.skin !== null) {
        if (typeof next.skin === 'number') {
          if (!Number.isFinite(next.skin) || Math.abs(next.skin) > 1) fail('INVALID_SKIN', '肤色调整值超出范围。');
        } else {
          const skin = next.skin;
          if (typeof skin !== 'object' || Array.isArray(skin) || Object.keys(skin).some(key => !['amount', 'brightness', 'smoothness'].includes(key))
            || !Number.isFinite(skin.amount ?? 0) || Math.abs(skin.amount ?? 0) > 1
            || ['brightness', 'smoothness'].some(key => !Number.isFinite(skin[key] ?? 0) || (skin[key] ?? 0) < 0 || (skin[key] ?? 0) > 1)) {
            fail('INVALID_SKIN', '肤色、提亮或光滑设置无效。');
          }
          next.skin = { amount: skin.amount ?? 0, brightness: skin.brightness ?? 0, smoothness: skin.smoothness ?? 0 };
        }
      }
      if (typeof next.lutEnabled !== 'boolean') fail('INVALID_CONTROL', '请选择是否还原。');
      if (next.lutLook !== null && !['standard', 'vivid'].includes(next.lutLook)) fail('INVALID_LUT_LOOK', '请选择普通或鲜艳风格。');
      if (next.lutSize !== null && (!Number.isInteger(next.lutSize) || next.lutSize < 2 || next.lutSize > 129)) fail('INVALID_LUT_SIZE', '请选择可用的 LUT 尺寸。');
      if (['lutLook', 'lutSize'].some(key => Object.hasOwn(changes, key))) feature('lut-batch');
      if (changes.lutEnabled === true) feature('lut-batch');
      if (next.highlights !== null || next.shadows !== null || next.toneSegments !== null || next.lowLight !== null || next.denoise !== null) feature('tone');
      if (next.skin !== null) feature('skin');
      if (next.color !== null) {
        feature('local-color');
        if (typeof next.color !== 'object' || !Number.isFinite(next.color.hue) || next.color.hue < 0 || next.color.hue > 360 || !Number.isFinite(next.color.range) || next.color.range < 0 || next.color.range > 180 || !Number.isFinite(next.color.amount) || Math.abs(next.color.amount) > 1 || (next.color.hueShift != null && (!Number.isFinite(next.color.hueShift) || Math.abs(next.color.hueShift) > 180)) || (next.color.luminance != null && (!Number.isFinite(next.color.luminance) || Math.abs(next.color.luminance) > 1)) || Object.keys(next.color).some(k => !['hue','range','amount','hueShift','luminance'].includes(k))) fail('INVALID_COLOR', '颜色范围设置无效。');
      }
      if (next.modeOverride != null && !['D-Log','D-Log2','D-Log M','Rec.709'].includes(next.modeOverride)) fail('INVALID_PROFILE', '请选择支持的拍摄模式。');
      if (next.cameraOverride != null && !/^[a-z0-9][a-z0-9-]{0,47}$/.test(next.cameraOverride)) fail('INVALID_CAMERA', '请选择支持的拍摄设备。');
      store.drafts[assetId] = next;
      if (['lutEnabled', 'lutLook', 'lutSize', 'cameraOverride', 'modeOverride'].some(key => Object.hasOwn(changes, key) && changes[key] !== draft[key])) {
        selected.analysis = null;
        selected.analysisJob = null;
      }
      await save();
      return { draft: next, asset: publicAsset(selected) };
    });
  }
  async function originalPlayback({ assetId, revision, timeSeconds = 0 }) {
    assertOpen();
    if (!catalog.size) fail('FEATURE_UNAVAILABLE', '尚未启用视频功能。', 409);
    const selected = asset(assetId);
    if (store.drafts[assetId].revision !== revision) fail('STALE_DRAFT', '方案已更新，请重新打开原片。', 409);
    if (!Number.isFinite(timeSeconds) || timeSeconds < 0 || timeSeconds >= selected.duration) fail('INVALID_PREVIEW_TIME', '请选择视频时长范围内的位置。');
    const path = await trustedPath(selected.sourcePath);
    const version = await sourceVersion(path);
    // A stat snapshot alone cannot establish that an old scan still owns these
    // bytes. Probe reuses only the worker's verified source identity cache.
    const verified = await invoke({ action: 'probe', sourcePath: path });
    if (verified.asset?.sha256 !== selected.sha256 || await sourceVersion(path) !== version) fail('SOURCE_CHANGED', '素材已变化，请重新扫描。', 409);
    if (store.drafts[assetId].revision !== revision) fail('STALE_DRAFT', '方案已更新，请重新打开原片。', 409);
    const ref = `source:${randomUUID()}`;
    originalSources.set(ref, { path, version });
    if (originalSources.size > 32) originalSources.delete(originalSources.keys().next().value);
    return { videoRef: ref, playback: { original: true, start_seconds: 0, end_seconds: selected.duration,
      duration_seconds: selected.duration, initial_time_seconds: timeSeconds,
      width: selected.width, height: selected.height, codec: selected.media_facts?.codec,
      pixel_format: selected.media_facts?.pixel_format, transcoded: false, lut_applied: false } };
  }
  async function submit(action, { assetId, revision, timeSeconds, previewQuality, previewScope, playbackQuality, exportDirectory, exportQuality }) {
    await refreshCatalogIdentity();
    assertOpen();
    const selected = asset(assetId);
    await trustedPath(selected.sourcePath);
    const draft = store.drafts[assetId];
    if (revision !== draft.revision) fail('STALE_DRAFT', '方案已更新，请重新预览。', 409);
    if (timeSeconds !== undefined && (!['preview', 'playback'].includes(action) || typeof timeSeconds !== 'number' || !Number.isFinite(timeSeconds)
      || timeSeconds < 0 || timeSeconds >= selected.duration)) fail('INVALID_PREVIEW_TIME', '请选择视频时长范围内的预览帧。');
    if (previewQuality !== undefined && (action !== 'preview' || !['fast','detail'].includes(previewQuality))) fail('INVALID_PREVIEW_QUALITY', '预览精度无效。');
    if (previewScope !== undefined && (action !== 'playback' || !['base','current'].includes(previewScope))) fail('INVALID_PREVIEW_SCOPE', '播放范围无效。');
    if (playbackQuality !== undefined && (action !== 'playback' || !['fast','detail'].includes(playbackQuality))) fail('INVALID_PLAYBACK_QUALITY', '播放精度无效。');
    if (exportDirectory !== undefined && action !== 'render') fail('INVALID_EXPORT_DIRECTORY', '保存位置仅适用于完整视频。');
    if (exportQuality !== undefined && (action !== 'render' || !['preserve','balanced'].includes(exportQuality))) fail('INVALID_EXPORT_QUALITY', '导出精度无效。');
    const destination = action === 'render' && config.allowUserExportGrants === true
      ? await prepareExportDirectory(assetId, exportDirectory) : exportDirectory === undefined ? undefined : await exportDestination(exportDirectory);
    if (draft.lutEnabled) feature('lut-batch');
    if (draft.highlights !== null || draft.shadows !== null || draft.toneSegments?.length || draft.lowLight != null || draft.denoise != null) feature('tone');
    if (draft.skin !== null) feature('skin');
    if (draft.color !== null) feature('local-color');
    if (!catalog.size) fail('FEATURE_UNAVAILABLE', '尚未启用视频功能。', 409);
    if (action === 'render') {
      // Rebuildable background proxies yield the shared encoder lane to an export.
      for (const id of await readdir(join(dataDir, 'jobs')).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
        if (!/^[0-9a-f-]{36}$/.test(id)) continue;
        const candidate = await readJSON(join(jobDir(id), 'job.json'), null);
        if (['proxy','playback'].includes(candidate?.action) && ['queued', 'running', 'draining'].includes(candidate.status)) await cancel(id);
      }
    }
    return queueWorker(action, selected, draft, { timeSeconds, previewQuality, previewScope, playbackQuality, destination, exportQuality, analysisKey: analysisKey(selected, draft) });
  }
  async function queueWorker(action, selected, draft, { timeSeconds, previewQuality, previewScope, playbackQuality, destination, exportQuality, analysisKey: key, analysisRefine } = {}) {
    const id = randomUUID();
    const runDir = join(dataDir, 'jobs', id);
    await mkdir(runDir, { recursive: true });
    const plannedProfile = workerRequest({ profile: selected.captureProfile ?? selected.profile, draft }).recipe;
    const reviewedProfile = workerRequest({ profile: selected.profile }).recipe;
    const effectiveProfileMatches = plannedProfile.camera_model === reviewedProfile.camera_model
      && plannedProfile.profile === reviewedProfile.profile
      && (plannedProfile.look == null ? selected.lut?.requested_look === null : selected.lut?.look === plannedProfile.look)
      && (plannedProfile.lut_grid == null ? selected.lut?.requested_grid === null : selected.lut?.grid === plannedProfile.lut_grid);
    const requestInput = { ...workerConfig, action, sourcePath: selected.sourcePath, sourceSha256: selected.sha256,
      expectedLutSha256: draft.lutEnabled && effectiveProfileMatches ? selected.lut?.sha256 : undefined,
      profile: selected.captureProfile ?? selected.profile, draft: structuredClone(draft), outputDir: runDir, timeSeconds, previewQuality, previewScope, playbackQuality, exportQuality,
      ...(analysisRefine === undefined ? {} : { analysisRefine }),
      ...(['preview', 'proxy', 'analyze'].includes(action) ? { proxyCacheDir: join(dataDir, 'proxy-cache') } : {}),
      ...(action === 'preview' ? { buildProxy: false } : {}) };
    const request = workerRequest(requestInput);
    const job = { id, action, assetId: selected.id, revision: draft.revision, analysisKey: key,
      ...(destination ? { exportDestination: destination, exportName: selected.name } : {}),
      ...(action === 'analyze' ? { refined: analysisRefine === true } : {}),
      planHash: digest(destination ? { request, destination } : request), status: 'queued', progress: 0, createdAt: new Date().toISOString() };
    await atomicJSON(join(runDir, 'request.json'), request);
    await atomicJSON(join(runDir, 'job.json'), job);
    const child = spawn(process.execPath, [join(root, 'src/job-runner.mjs'), runDir, python, workerPath, dataDir], { detached: true, stdio: 'ignore' });
    await new Promise((resolveSpawn, reject) => { child.once('spawn', resolveSpawn); child.once('error', reject); });
    child.unref();
    return { job };
  }
  async function aiModels() {
    assertOpen();
    return config.aiAdvisor ? config.aiAdvisor.listModels()
      : { available: false, models: [], defaultModel: null, reason: '当前环境没有接入 Harness 模型服务。' };
  }
  async function aiAdvice(input) {
    await refreshCatalogIdentity();
    assertOpen();
    if (!config.aiAdvisor) fail('AI_UNAVAILABLE', '当前环境没有接入 Harness 模型服务。', 409);
    if (aiControllers.size) fail('AI_BUSY', '已有 AI 分析正在进行，请等待或取消。', 409);
    const { assetId, revision, timeSeconds, provider, model, includeFrame, previewRef = null, scope, intent = '' } = input;
    if (typeof provider !== 'string' || !provider || provider.length > 200 || typeof model !== 'string' || !model || model.length > 200
        || typeof includeFrame !== 'boolean' || !AI_GROUPS.includes(scope)
        || typeof intent !== 'string' || intent.length > 300) fail('AI_INVALID_REQUEST', '请选择模型、分析范围和发送内容。');
    const id = randomUUID();
    const controller = new AbortController();
    aiControllers.set(id, controller);
    try {
      const snapshot = await serialize(() => {
        assertOpen();
        const selected = asset(assetId), draft = store.drafts[assetId];
        if (revision !== draft.revision) fail('STALE_DRAFT', '方案已更新，请重新发起 AI 分析。', 409);
        if (!Number.isFinite(timeSeconds) || timeSeconds < 0 || timeSeconds >= selected.duration) fail('INVALID_PREVIEW_TIME', '请选择视频范围内的画面。');
        return structuredClone({ selected, draft, key: analysisKey(selected), features: [...catalog.keys()] });
      });
      const { selected, draft, key } = snapshot;
      await trustedPath(selected.sourcePath);
      const version = await sourceVersion(selected.sourcePath);
      feature(scope);
      let images = [];
      let frameDomain;
      if (includeFrame) {
        if (typeof previewRef !== 'string' || !/^[0-9a-f-]{36}:preview$/.test(previewRef)) fail('AI_FRAME_REQUIRED', '请先生成当前画面的精确预览。', 409);
        const previewId = previewRef.split(':')[0];
        const preview = await readJSON(join(jobDir(previewId), 'job.json'), null);
        if (!preview || preview.action !== 'preview' || preview.status !== 'succeeded' || preview.assetId !== assetId
            || preview.revision !== revision || preview.analysisKey !== key || preview.result?.source_sha256 !== selected.sha256) fail('AI_STALE_FRAME', '画面已变化，请先更新精确预览。', 409);
        frameDomain = preview.result.working_domain;
        const request = await readJSON(join(jobDir(previewId), 'request.json'));
        const frameTime = request.time_seconds;
        if (!Number.isFinite(frameTime) || Math.abs(frameTime - timeSeconds) > .002) fail('AI_STALE_FRAME', '所选时间已变化，请先更新精确预览。', 409);
      } else if (previewRef !== null) {
        fail('AI_INVALID_REQUEST', '仅分析统计时不应附带图像引用。');
      }
      const analysis = selected.analysisKey === key ? selected.analysis : null;
      if (!includeFrame && !analysis?.measurement) fail('AI_ANALYSIS_PENDING', '请等待抽样分析完成，或选择结合多帧画面。', 409);
      controller.signal.throwIfAborted();
      assertOpen();
      const context = { assetId, revision, analysisKey: key, timeSeconds, previewRef, includedFrame: includeFrame,
        provider, model, scope, inputBasis: includeFrame ? 'multi-frame-and-measurements' : 'measurements-only',
        sampleTimes: [], frameCount: 0, visualBasis: null, sourceVersion: version,
        toneReviewOnly: scope === 'tone' && !includeFrame && analysis?.tone_advice?.status === 'review' };
      const facts = adviceFacts(selected, draft, analysis, { timeSeconds, scope, intent, includedFrame: includeFrame, features: snapshot.features });
      facts.workingDomain = frameDomain ?? facts.workingDomain;
      const runDir = jobDir(id);
      const job = { id, action: 'ai-advice', assetId, revision, analysisKey: key, status: 'queued', progress: null,
        ownerPid: process.pid, createdAt: new Date().toISOString() };
      await atomicJSON(join(runDir, 'request.json'), { context, facts });
      await atomicJSON(join(runDir, 'job.json'), job);
      controller.signal.throwIfAborted();
      const task = trackForeground(async () => {
        const timeout = setTimeout(() => controller.abort(new MediaError('AI_TIMEOUT', 'AI 分析超时，请稍后重试。')), config.aiTimeoutMs ?? 120000);
        timeout.unref?.();
        let abortListener;
        try {
          controller.signal.throwIfAborted();
          job.status = 'running'; job.startedAt = new Date().toISOString();
          await atomicJSON(join(runDir, 'job.json'), job);
          const aborted = new Promise((_, reject) => {
            abortListener = () => reject(controller.signal.reason);
            controller.signal.addEventListener('abort', abortListener, { once: true });
            if (controller.signal.aborted) abortListener();
          });
          // Sampling may outlive an abort; keep the model race rejection observed.
          aborted.catch(() => {});
          if (includeFrame) {
            job.phase = 'sampling';
            await atomicJSON(join(runDir, 'job.json'), job);
            const samplePlan = adviceSamplePlan(selected.duration, timeSeconds, { scope, measurement: analysis?.measurement });
            context.sampleSelection = samplePlan.method;
            const samples = await invoke({ action: 'ai-samples', sourcePath: selected.sourcePath, sourceSha256: selected.sha256,
              expectedLutSha256: draft.lutEnabled ? selected.lut?.sha256 : undefined,
              profile: selected.captureProfile ?? selected.profile, draft, outputDir: runDir,
              sampleTimes: samplePlan.times, aiSampleCacheDir: join(dataDir, 'ai-sample-cache') }, controller.signal);
            controller.signal.throwIfAborted();
            if (samples.source_sha256 !== selected.sha256 || samples.visual_basis !== 'current-adjustments'
                || !Number.isInteger(samples.frame_count) || samples.frame_count < 1 || samples.frame_count > 3
                || !Array.isArray(samples.sample_times) || samples.sample_times.length !== samples.frame_count) {
              fail('AI_FRAME_INVALID', '多帧取样校验失败，请重新分析。');
            }
            const sampleTimes = samples.sample_times.map(sample => sample.actual_seconds);
            if (sampleTimes.some(time => !Number.isFinite(time) || time < 0 || time > selected.duration + .1)) fail('AI_FRAME_INVALID', '多帧时间校验失败。');
            const path = await realpath(samples.contact_sheet_path);
            if (!inside(runDir, path) && !inside(join(dataDir, 'ai-sample-cache'), path)) fail('AI_FRAME_INVALID', '取样图不在任务目录内。');
            if ((await stat(path)).size > 4 * 1024 * 1024) fail('AI_FRAME_TOO_LARGE', '多帧缩略图过大。');
            const data = await readFile(path);
            if (!data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) fail('AI_FRAME_INVALID', '取样图不是有效的 PNG。');
            images = [{ data, mediaType: 'image/png', name: 'representative-frames.png' }];
            frameDomain = samples.working_domain;
            facts.workingDomain = frameDomain ?? null;
            facts.visualInput = { layout: 'left-to-right', basis: 'current-adjustments', timesSeconds: sampleTimes,
              selectedFrameIndex: 0, selection: samplePlan.method, thumbnailWidth: samples.width / samples.frame_count,
              ...(scope === 'skin' ? { detectedFaces: samples.sample_times.map(sample => sample.skin_face_count ?? null) } : {}) };
            Object.assign(context, { sampleTimes, frameCount: samples.frame_count, visualBasis: samples.visual_basis });
            await atomicJSON(join(runDir, 'request.json'), { context, facts });
          }
          if (!includeFrame) await assertSourceDigest(selected.sourcePath, selected.sha256, controller.signal);
          if (await sourceVersion(selected.sourcePath) !== version) fail('SOURCE_CHANGED', '素材在分析期间变化，请重新扫描。', 409);
          job.phase = 'model';
          await atomicJSON(join(runDir, 'job.json'), job);
          const response = await Promise.race([config.aiAdvisor.analyze({ provider, model, system: adviceSystem(scope), input: JSON.stringify(facts), images }, controller.signal), aborted]);
          controller.signal.throwIfAborted();
          const advice = parseAdvice(response.text, { scope, features: snapshot.features, includedFrame: includeFrame, toneReviewOnly: context.toneReviewOnly });
          const domain = frameDomain ?? analysis?.measurement?.domain;
          if (!['sdr_rec709_display_relative', 'rec709_display_relative'].includes(domain)
              && advice.recommendations.some(rec => rec.changes)) {
            fail('AI_INVALID_ADVICE', '输入色彩域尚未确认，AI 不能生成调整值。');
          }
          job.result = { advice, context };
          if (response.usage) job.result.usage = Object.fromEntries(Object.entries(response.usage)
            .filter(([key, value]) => ['inputTokens', 'outputTokens', 'totalTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens'].includes(key)
              && Number.isSafeInteger(value) && value >= 0));
          job.status = 'succeeded'; job.progress = 1;
        } catch (error) {
          const cancelled = controller.signal.aborted && controller.signal.reason?.code !== 'AI_TIMEOUT';
          job.status = cancelled ? 'cancelled' : 'failed';
          const code = cancelled ? 'CANCELLED' : error.code === 'AI_TIMEOUT' ? 'AI_TIMEOUT'
            : /^[A-Z_0-9]{1,60}$/.test(error.code ?? '') ? error.code : 'AI_FAILED';
          const explanations = { AI_TIMEOUT: 'AI 分析超时，请稍后重试。', CANCELLED: 'AI 分析已取消。',
            AI_INVALID_ADVICE: 'AI 返回的建议无法安全应用，请重新分析。', AI_IMAGE_UNSUPPORTED: '该模型未确认支持图片，请取消发送画面或换模型。',
            AI_TRUNCATED: '模型的思考与回答达到输出上限，尚未形成完整建议。可缩小分析范围后手动重试。',
            SOURCE_CHANGED: '素材已变化，请重新扫描后分析。',
            AI_UNAVAILABLE: '请在 Harness 中配置可用的模型。' };
          job.error = { code, message: explanations[code] ?? `模型分析失败（${code}），请检查 Harness 模型配置或换模型重试。` };
          if (['max-tokens', 'error', 'aborted', 'incomplete'].includes(error.diagnostics?.finish)) {
            const usage = Object.fromEntries(Object.entries(error.diagnostics.usage ?? {})
              .filter(([key, value]) => ['inputTokens', 'outputTokens', 'totalTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens'].includes(key)
                && Number.isSafeInteger(value) && value >= 0));
            job.diagnostics = { finish: error.diagnostics.finish, usage };
          }
        } finally {
          clearTimeout(timeout);
          if (abortListener) controller.signal.removeEventListener('abort', abortListener);
          images = [];
          job.finishedAt = new Date().toISOString();
          try { await atomicJSON(join(runDir, 'job.json'), job); } finally { aiControllers.delete(id); }
        }
      });
      task.catch(() => {});
      return { job: { ...job } };
    } catch (error) {
      aiControllers.delete(id);
      const file = join(jobDir(id), 'job.json');
      const queued = await readJSON(file, null);
      if (queued?.status === 'queued') await atomicJSON(file, { ...queued, status: 'cancelled',
        finishedAt: new Date().toISOString(), error: { code: 'CANCELLED', message: 'AI 分析未开始，服务已停止。' } });
      throw error;
    }
  }
  async function applyAiAdvice({ assetId, revision, jobId, recommendationId, timeSeconds, previewRef = null }) {
    await refreshCatalogIdentity();
    assertOpen();
    const { job } = await readJob(jobId);
    const context = job.result?.context;
    if (job.action !== 'ai-advice' || job.status !== 'succeeded' || context?.assetId !== assetId
        || context.revision !== revision || context.analysisKey !== analysisKey(asset(assetId))
        || !Number.isFinite(timeSeconds) || Math.abs(context.timeSeconds - timeSeconds) > .002 || context.previewRef !== previewRef) {
      fail('AI_STALE_ADVICE', '素材、参数或画面已变化，请重新分析后采纳。', 409);
    }
    const selected = asset(assetId);
    await trustedPath(selected.sourcePath);
    if (!context.sourceVersion || await sourceVersion(selected.sourcePath) !== context.sourceVersion) fail('AI_STALE_ADVICE', '素材已变化，请重新扫描后分析。', 409);
    const recommendation = job.result.advice.recommendations.find(rec => rec.id === recommendationId);
    if (!recommendation?.changes) fail('AI_READ_ONLY_ADVICE', '此项仅供参考，无需改动参数。', 409);
    // Revalidate the durable receipt before reaching the existing CAS writer.
    const verified = parseAdvice(JSON.stringify({ summary: job.result.advice.summary, notes: job.result.advice.notes,
      recommendations: [{ group: recommendation.group, reason: recommendation.reason, changes: recommendation.changes }] }),
    { scope: context.scope, features: [...catalog.keys()], includedFrame: context.includedFrame, toneReviewOnly: context.toneReviewOnly });
    return updateDraft({ assetId, revision, changes: verified.recommendations[0].changes });
  }
  function jobDir(id) { if (!/^[0-9a-f-]{36}$/.test(id)) fail('INVALID_JOB', '无效的任务。'); return join(dataDir, 'jobs', id); }
  async function prunePlaybackCache() {
    const rows=[];
    for (const id of await readdir(join(dataDir,'jobs')).catch(()=>[])) {
      if (!/^[0-9a-f-]{36}$/.test(id)) continue;
      const directory=jobDir(id), job=await readJSON(join(directory,'job.json'),null);
      if (job?.action!=='playback' || job.status!=='succeeded' || job.result?.media_expired) continue;
      const file=job.result?.videoPath;
      if (file!==join(directory,'playback.mp4')) continue;
      try {
        if (await realpath(file)!==file) continue;
        rows.push({id,job,file,size:(await stat(file)).size});
      } catch { /* Missing output is not an eligible cache entry. */ }
    }
    rows.sort((a,b)=>String(b.job.finishedAt).localeCompare(String(a.job.finishedAt)) || b.id.localeCompare(a.id));
    const limit=Number.isSafeInteger(config.playbackCacheBytes) && config.playbackCacheBytes>=0 ? config.playbackCacheBytes : 512*1024*1024;
    let count=0,bytes=0;
    const expired=new Set();
    for (const row of rows) {
      // Always retain the newest clip; the byte budget is soft for a single
      // oversized clip. Only reproducible playback outputs are eligible.
      if (count===0 || count<2 && bytes+row.size<=limit) { count++;bytes+=row.size;continue; }
      try { await unlink(row.file); } catch { continue; }
      row.job.result.media_expired=true;
      await atomicJSON(join(jobDir(row.id),'job.json'),row.job);
      expired.add(row.id);
    }
    return expired;
  }
  async function readJob(id) {
    await refreshCatalogIdentity();
    const job = await readJSON(join(jobDir(id), 'job.json'), null);
    if (!job) fail('JOB_NOT_FOUND', '找不到处理任务。', 404);
    if (job.action==='playback' && job.status==='succeeded') {
      const expired=await serialize(prunePlaybackCache);
      if (expired.has(id)) job.result.media_expired=true;
    }
    if (job.action === 'analyze' && ['succeeded', 'failed', 'cancelled'].includes(job.status)) {
      await serialize(async () => {
        const selected = store.assets[job.assetId];
        if (!selected || selected.analysisResultJobId === id || analysisKey(selected) !== job.analysisKey
          || selected.analysisJob?.id && selected.analysisJob.id !== id) return;
        if (job.status === 'succeeded') {
          if (job.result?.source_sha256 !== selected.sha256) fail('SOURCE_CHANGED', '素材校验不一致，请重新扫描。', 409);
          selected.analysis = job.result;
          selected.analysisKey = job.analysisKey;
          if (job.result.profile) selected.profile = job.result.profile;
          if (job.result.lut) selected.lut = job.result.lut;
          if (job.result.lut_options) selected.lut_options = job.result.lut_options;
        }
        selected.analysisJob = { id, status: job.status, analysisKey: job.analysisKey };
        selected.analysisResultJobId = id;
        await save();
      });
    }
    const result = job.result;
    delete job.exportDestination; delete job.exportName;
    if (result) {
      job.result = { ...result };
      delete job.result.exportFile;
      for (const key of ['toneDataPath','tone_data_path','outputPath','previewPath','beforePath','samplePath','basePath','proxyPath','videoPath','path','sourcePath','output_path','preview_path','before_path','after_path','sample_path','base_path','proxy_path','video_path','source_path']) delete job.result[key];
      if (result.previewPath || (job.action === 'preview' && result.outputPath)) job.result.previewRef = `${id}:preview`;
      if (result.beforePath) job.result.beforeRef = `${id}:before`;
      if (result.samplePath) job.result.sampleRef = `${id}:sample`;
      if (result.toneDataPath) job.result.toneDataRef = `${id}:tone-data`;
      if (result.basePath) job.result.baseRef = `${id}:base`;
      if (result.proxyPath) job.result.proxyRef = `${id}:proxy`;
      if (!result.media_expired && (result.videoPath || (job.action === 'render' && result.outputPath))) job.result.videoRef = `${id}:video`;
    }
    return { job };
  }
  async function cancel(id) { const directory = jobDir(id); const job = await readJSON(join(directory, 'job.json'), null); if (!job) fail('JOB_NOT_FOUND', '找不到处理任务。', 404); if (!['succeeded','failed','cancelled'].includes(job.status)) { await writeFile(join(directory, 'cancel'), 'requested\n'); aiControllers.get(id)?.abort(new MediaError('CANCELLED', 'AI 分析已取消。')); } return readJob(id); }
  async function mediaPath(ref) {
    if (ref.startsWith('source:')) {
      const source = originalSources.get(ref);
      if (!source) fail('MEDIA_NOT_FOUND', '原片播放引用已过期，请重新打开。', 404);
      const path = await trustedPath(source.path);
      if (path !== source.path || await sourceVersion(path) !== source.version) fail('SOURCE_CHANGED', '素材已变化，请重新扫描。', 409);
      return path;
    }
    const [id, kind] = ref.split(':');
    const directory = jobDir(id);
    const job = await readJSON(join(directory, 'job.json'), null);
    if (!job) fail('JOB_NOT_FOUND', '找不到处理任务。', 404);
    if (job.status !== 'succeeded') fail('MEDIA_NOT_READY', '结果还未生成。', 409);
    if (kind==='video' && job.result?.media_expired) fail('MEDIA_EXPIRED','播放缓存已清理，请重新生成。',409);
    const file = kind === 'preview' ? job.result.previewPath ?? (job.action === 'preview' && job.result.outputPath) : kind === 'before' ? job.result.beforePath : kind === 'sample' ? job.result.samplePath : kind === 'base' ? job.result.basePath : kind === 'tone-data' ? job.result.toneDataPath : kind === 'proxy' ? job.result.proxyPath : kind === 'video' ? job.result.videoPath ?? (job.action === 'render' && job.result.outputPath) : null;
    if (kind === 'video' && job.action === 'render' && job.result.exportFile) {
      const saved = job.result.exportFile;
      const destination = store.exportGrants?.[saved.directory];
      if (!destination || dirname(saved.path) !== saved.directory || !['.mp4','.mkv'].includes(extname(saved.path))) fail('INVALID_ARTIFACT', '保存位置无效。', 403);
      await validateExportDirectory(destination);
      if (await exportFileIdentity(saved.path) !== saved.identity) fail('EXPORT_FILE_CHANGED', '导出文件已变化，请在保存文件夹中确认。', 409);
      return saved.path;
    }
    if (!file) fail('MEDIA_NOT_FOUND', '找不到结果文件。', 404);
    const path = await realpath(file);
    if (!inside(directory, path) && !(kind === 'proxy' && inside(join(dataDir, 'proxy-cache'), path))) fail('INVALID_ARTIFACT', '结果文件不在任务目录内。', 403);
    return path;
  }
  async function handleHttp(req, res, base = '/hvp/') {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith(base)) return false;
    const requestId = randomUUID();
    const started = performance.now();
    let errorCode;
    let recorded = false;
    const route = url.pathname.slice(base.length).split('/').slice(0, 2).join('/');
    const knownRoute = ['state', 'grant-directory', 'export-directory', 'exports', 'save-export', 'open-export', 'download-export', 'pick-directory', 'pick-export-directory', 'scan', 'select', 'draft', 'preview', 'proxy', 'playback', 'original-playback', 'render', 'jobs', 'cancel', 'ai'].includes(route.split('/')[1]) ? route : 'other';
    res.setHeader('x-hvp-request-id', requestId);
    const record = () => {
      if (recorded) return;
      recorded = true;
      if (req.method === 'GET' && !errorCode && res.writableFinished) return;
      traceRequest({ at: new Date().toISOString(), requestId, method: req.method, route: knownRoute,
        elapsedMs: Math.round(performance.now() - started), status: res.statusCode,
        outcome: res.writableFinished ? 'response' : 'disconnected', ...(errorCode ? { errorCode } : {}) });
    };
    res.once('finish', record);
    res.once('close', record);
    try {
      const suffix = decodeURIComponent(url.pathname.slice(base.length));
      if (['GET','HEAD'].includes(req.method) && suffix.startsWith('api/media/')) return await serveFile(req, res, await mediaPath(suffix.slice(10)));
      if (['GET','HEAD'].includes(req.method) && suffix.startsWith('api/download-export/')) {
        const record = await exportRecord(suffix.slice(20));
        return await serveFile(req, res, record.path, { downloadName: record.fileName });
      }
      let input = {};
      if (['POST','PATCH'].includes(req.method)) {
        if (!req.headers['content-type']?.includes('application/json')) fail('JSON_REQUIRED', '请求格式不正确。', 415);
        let body = '';
        for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 65536) fail('REQUEST_TOO_LARGE', '请求过大。', 413); }
        input = JSON.parse(body || '{}');
      }
      let value;
      if (req.method === 'GET' && suffix === 'api/state') value = await view();
      else if (req.method === 'GET' && suffix === 'api/ai/models') value = await aiModels();
      else if (req.method === 'POST' && suffix === 'api/ai/advice') value = await trackForeground(() => aiAdvice(input));
      else if (req.method === 'POST' && suffix === 'api/ai/apply') value = await applyAiAdvice(input);
      else if (req.method === 'POST' && suffix === 'api/grant-directory') {
        // Authenticated Host operator action. The desktop UI uses its owned
        // native dialog; this endpoint is not a cryptographic dialog attestation.
        // It is absent from model tools and disabled in the standalone server.
        if (config.allowUserDirectoryGrants !== true) fail('SOURCE_GRANT_UNAVAILABLE', '请使用当前环境提供的文件夹选择器。', 403);
        value = await grantDirectory(input.directory);
      }
      else if (req.method === 'POST' && ['api/pick-directory','api/pick-export-directory'].includes(suffix)) {
        const controller = new AbortController();
        const abort = () => { if (!res.writableEnded) controller.abort(new MediaError('PICKER_CANCELLED', '文件夹选择已取消。')); };
        req.once('aborted', abort);
        res.once('close', abort);
        try { value = await pickDirectory(controller.signal, suffix === 'api/pick-export-directory' ? 'export' : 'source'); }
        finally { req.removeListener('aborted', abort); res.removeListener('close', abort); }
      }
      else if (req.method === 'POST' && suffix === 'api/scan') value = await scan(input);
      else if (req.method === 'POST' && suffix === 'api/export-directory') value = await trackForeground(() => grantExportDirectory(input.directory));
      else if (req.method === 'GET' && suffix.startsWith('api/exports/')) value = await exportHistory(suffix.slice(12));
      else if (req.method === 'POST' && suffix === 'api/save-export') value = await trackForeground(() => saveExport(input));
      else if (req.method === 'POST' && suffix === 'api/open-export') value = await trackForeground(() => openExport(input));
      else if (req.method === 'POST' && suffix === 'api/select') value = await select(input);
      else if (req.method === 'PATCH' && suffix === 'api/draft') value = await updateDraft(input);
      else if (req.method === 'POST' && suffix === 'api/preview') value = await submit('preview', input);
      else if (req.method === 'POST' && suffix === 'api/original-playback') value = await trackForeground(() => originalPlayback(input));
      else if (req.method === 'POST' && suffix === 'api/playback') value = await submit('playback', input);
      else if (req.method === 'POST' && suffix === 'api/proxy') value = await submit('proxy', input);
      else if (req.method === 'POST' && suffix === 'api/render') {
        if (!input.exportDirectory && config.allowUserExportGrants !== true) fail('EXPORT_DIRECTORY_REQUIRED', '请先选择视频保存文件夹。');
        value = await submit('render', input);
      }
      else if (req.method === 'GET' && suffix.startsWith('api/jobs/')) value = await readJob(suffix.slice(9));
      else if (req.method === 'POST' && suffix.startsWith('api/cancel/')) value = await cancel(suffix.slice(11));
      else if (req.method === 'GET' && !suffix.startsWith('api/')) {
        const file = suffix || 'index.html';
        if (!['index.html','app.mjs','styles.css','state.mjs','live-preview.mjs','tone-intervals.mjs'].includes(file)) fail('NOT_FOUND', '页面不存在。', 404);
        return await serveFile(req, res, join(root, 'web', file));
      } else fail('NOT_FOUND', '接口不存在。', 404);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value));
    } catch (error) {
      if (error instanceof URIError || error instanceof SyntaxError) error = new MediaError('INVALID_REQUEST', '请求格式不正确。', 400);
      errorCode = error.code ?? 'INTERNAL_ERROR';
      if (!res.headersSent) res.writeHead(error.status ?? 500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { code: error.code ?? 'INTERNAL_ERROR', message: error.message } }));
    }
    return true;
  }
  function close() {
    closing ??= (async () => {
      closed = true;
      originalSources.clear();
      const reason = new MediaError('RUNTIME_CLOSED', '视频服务已停止。', 503);
      for (const controller of pickerControllers) controller.abort(reason);
      for (const controller of aiControllers.values()) controller.abort(reason);
      for (const task of processes) task.abort(reason);
      await Promise.allSettled([...foreground]);
      await Promise.allSettled([...processes].map(task => task.promise));
      await mutation;
      await tracing;
    })();
    return closing;
  }
  return { protocolVersion: 1, dataDir, registerFeature, catalog: { registerFeature, listFeatures: () => [...catalog.values()].map(e => ({ ...e.definition, owners: e.owners.size })) }, state: view, pickDirectory, scan, select, updateDraft,
    exportHistory, grantExportDirectory, saveExport, openExport,
    originalPlayback: input => trackForeground(() => originalPlayback(input)),
    playback: input => trackForeground(() => submit('playback', input)),
    preview: input => trackForeground(() => submit('preview', input)), proxy: input => trackForeground(() => submit('proxy', input)), render: input => trackForeground(() => submit('render', input)),
    aiModels, aiAdvice: input => trackForeground(() => aiAdvice(input)), applyAiAdvice, readJob, cancel, mediaPath, handleHttp, close };
}

async function serveFile(req, res, file, { downloadName } = {}) {
  const info = await stat(file);
  const extension = extname(file).toLowerCase();
  const type = mediaTypes[extension] ?? ({ '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8' }[extension] ?? 'application/octet-stream');
  const headers = { 'content-type': type, 'cache-control': 'no-store', 'accept-ranges': 'bytes', 'x-content-type-options': 'nosniff' };
  if (downloadName) headers['content-disposition'] = `attachment; filename="video${extension}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
  const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  let start = 0, end = info.size - 1;
  let invalidRange = req.headers.range && (!range || !range[1] && !range[2]);
  if (range) {
    if (!range[1]) {
      const count = Number(range[2]);
      invalidRange ||= !Number.isSafeInteger(count) || count <= 0;
      start = Math.max(0, info.size-count);
    } else {
      start = Number(range[1]); end = range[2] ? Math.min(end, Number(range[2])) : end;
      invalidRange ||= !Number.isSafeInteger(start) || !Number.isSafeInteger(Number(range[2] || 0));
    }
  }
  if (invalidRange || start > end || start >= info.size) { res.writeHead(416, { 'content-range': `bytes */${info.size}` }); res.end(); return true; }
  if (range) headers['content-range'] = `bytes ${start}-${end}/${info.size}`;
  headers['content-length'] = end - start + 1;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD') res.end(); else {
    const stream = createReadStream(file, { start, end });
    res.once('close', () => stream.destroy());
    stream.on('error', () => res.destroy()).pipe(res);
  }
  return true;
}
