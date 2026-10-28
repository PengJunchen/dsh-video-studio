import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, stat, rm, rename, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, delimiter } from 'node:path';
import { readJSON } from './storage.mjs';

const execute = promisify(execFile);
const platform = `${process.platform}-${process.arch}`;
const pythonRelative = process.platform === 'win32' ? 'python/python.exe' : 'python/bin/python3';
const pythonBin = process.platform === 'win32' ? 'python' : 'python/bin';
const systemTool = name => process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', `${name}.exe`) : name;
const exists = file => stat(file).then(value => value.isFile()).catch(() => false);
const hash = async file => {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
};
const command = async (file, args, env, options = {}) => (await execute(file, args, {
  env, timeout: 60000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, ...options,
})).stdout;

/** A relocatable package runtime or a private, versioned installation. No global PATH changes. */
export function createEnvironmentManager({ root, dataDir, python, visionPython }) {
  const home = join(dataDir, 'environment');
  let installPromise, cached, controller;
  let installation = { state: 'idle' };
  let closed = false;
  const lock = () => readJSON(join(root, 'runtime/manifest.json'), { schema: 1, id: 'unavailable', platforms: {} });

  async function execution() {
    const manifest = await lock();
    if (!/^[a-zA-Z0-9._-]+$/.test(manifest.id)) throw new Error('运行环境清单无效。');
    const candidates = [join(home, manifest.id, platform), join(root, 'runtime', platform)];
    const packaged = await readJSON(join(root, 'runtime/bundled.json'), null);
    let directory, info;
    if (!python) for (const candidate of candidates) {
      const found = await readJSON(join(candidate, 'runtime.json'), null);
      if (found?.schema === 1 && found.id === manifest.id && found.platform === platform) {
        directory = candidate; info = found; break;
      }
    }
    const managed = Boolean(directory);
    const executable = python || (managed ? join(directory, pythonRelative) : process.platform === 'win32' ? 'python' : 'python3');
    const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
    const prefixes = managed ? [join(directory, 'bin'), join(directory, pythonBin)]
      : process.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : [];
    env.PATH = managed ? prefixes.join(delimiter) : [...prefixes, env.PATH || ''].join(delimiter);
    if (managed) {
      delete env.PYTHONHOME; delete env.PYTHONPATH;
      env.PYTHONNOUSERSITE = '1';
    }
    return { python: executable, visionPython: visionPython || (managed ? executable : undefined), env, info,
      source: python ? 'configured' : directory === candidates[0] ? 'managed' : managed ? 'bundled' : 'system', directory,
      mismatch: packaged?.platform && packaged.platform !== platform ? `安装包为 ${packaged.platform}，当前 Harness Host 为 ${platform}，请选择匹配的完整安装包。` : null };
  }

  async function inspect(context) {
    const { python: executable, env } = context;
    if (context.mismatch) return { ready: false, visionReady: false,
      items: [{ id: 'platform', label: '安装包平台', ready: false, message: context.mismatch }] };
    const ffmpeg = context.directory ? join(context.directory, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg') : 'ffmpeg';
    const ffprobe = context.directory ? join(context.directory, 'bin', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') : 'ffprobe';
    const items = [];
    async function item(id, label, run) {
      try { const version = await run(); items.push({ id, label, ready: true, version }); }
      catch (error) { items.push({ id, label, ready: false, message: error.code === 'ENOENT' ? '尚未安装或无法找到'
        : error.killed ? '首次组件检测超时，请重新检查。系统首次加载大型组件可能需要较长时间。'
          : String(error.stderr || error.message).trim().slice(-480) }); }
    }
    await Promise.all([
      item('python', 'Python', async () => {
        const version = (await command(executable, ['-c', 'import sys; assert sys.version_info >= (3,10), "Python 3.10+ required"; print(sys.version.split()[0])'], env)).trim();
        return version;
      }),
      item('ffmpeg', 'FFmpeg / 10-bit HEVC', async () => {
        const [version, filters, encoders, hevc] = await Promise.all([
          command(ffmpeg, ['-version'], env), command(ffmpeg, ['-hide_banner', '-filters'], env),
          command(ffmpeg, ['-hide_banner', '-encoders'], env), command(ffmpeg, ['-hide_banner', '-h', 'encoder=libx265'], env),
        ]);
        const match = version.match(/ffmpeg version (?:n)?(\d+)([^\s]*)/);
        if (!match || Number(match[1]) < 8) throw new Error('需要 FFmpeg 8 或更新版本。');
        for (const name of ['lut3d', 'bilateral', 'blend', 'maskedmerge']) if (!new RegExp(`\\b${name}\\b`).test(filters)) throw new Error(`缺少 ${name} 滤镜。`);
        for (const name of ['libx264', 'libx265', 'png']) if (!new RegExp(`\\b${name}\\b`).test(encoders)) throw new Error(`缺少 ${name} 编码器。`);
        if (!hevc.includes('yuv420p10le')) throw new Error('HEVC 编码器不支持 10-bit。');
        return match[1] + match[2];
      }),
      item('ffprobe', 'ffprobe', async () => {
        const text = await command(ffprobe, ['-version'], env);
        const match = text.match(/ffprobe version (?:n)?(\d+)([^\s]*)/);
        if (!match || Number(match[1]) < 8) throw new Error('需要 ffprobe 8 或更新版本。');
        return match[1] + match[2];
      }),
      item('vision', '人物处理 / NumPy · OpenCV', async () => {
        const text = await command(context.visionPython || executable, ['-c', 'import numpy,cv2; print(numpy.__version__ + " / " + cv2.__version__)'], env);
        return text.trim();
      }),
    ]);
    items.sort((a, b) => ['python', 'ffmpeg', 'ffprobe', 'vision'].indexOf(a.id) - ['python', 'ffmpeg', 'ffprobe', 'vision'].indexOf(b.id));
    return { ready: items.filter(item => item.id !== 'vision').every(item => item.ready),
      visionReady: items.find(item => item.id === 'vision')?.ready === true, items };
  }

  async function status(refresh = false) {
    if (refresh || !cached || Date.now() - cached.at > 30000) {
      const at = Date.now();
      const entry = { at, value: null };
      entry.value = (async () => {
        const context = await execution();
        return { ...await inspect(context), source: context.source, platform, directory: context.directory ?? null };
      })();
      cached = entry;
      entry.value.then(() => { entry.at = Date.now(); }, () => {});
    }
    const manifest = await lock();
    const artifact = manifest.platforms?.[platform];
    const details = await cached.value;
    const mismatch = details.items.find(item => item.id === 'platform');
    return { ...details, installation, canInstall: Boolean(artifact) && !python && !visionPython && !closed && !mismatch,
      downloadBytes: artifact?.bytes ?? null, runtimeId: manifest.id,
      installReason: mismatch ? mismatch.message : python || visionPython ? '当前使用手动指定的 Python。移除 python / assets.vision_python 配置可启用插件固定环境。'
        : !artifact ? '此平台暂未提供固定环境包，可按 README 配置系统环境。' : null };
  }

  async function install() {
    if (closed) throw new Error('视频服务已关闭。');
    if (installPromise) return status();
    const current = await status();
    if (!current.canInstall) throw new Error(current.installReason || '此平台暂不支持自动配置。');
    const manifest = await lock(), artifact = manifest.platforms?.[platform];
    if (!artifact || python || visionPython) throw new Error((await status()).installReason || '此平台暂不支持自动配置。');
    if (!/^https:\/\/github\.com\/PengJunchen\/dsh-video-studio\/releases\/download\//.test(artifact.url)
        || !/^[a-f0-9]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0) throw new Error('固定环境下载清单无效。');
    await mkdir(home, { recursive: true });
    const installationLock = join(home, 'install.lock');
    const owner = await open(installationLock, 'wx', 0o600).catch(error => {
      if (error.code === 'EEXIST') throw new Error('另一个窗口正在配置环境，请稍后重新检查。');
      throw error;
    });
    await owner.writeFile(JSON.stringify({ pid: process.pid }));
    await owner.close();
    controller = new AbortController();
    const signal = controller.signal;
    installation = { state: 'downloading', message: '正在下载固定环境…' };
    installPromise = (async () => {
      const stage = join(home, `.stage-${randomUUID()}`);
      try {
        await mkdir(stage, { recursive: true });
        const archive = join(stage, 'runtime.tar.gz');
        await command(systemTool('curl'), ['--fail', '--location', '--silent', '--show-error', '--retry', '2',
          '--proto', '=https', '--max-time', '900', '--max-filesize', String(1024 ** 3), '--output', archive, artifact.url],
        process.env, { timeout: 930000, signal });
        if ((await stat(archive)).size !== artifact.bytes || await hash(archive) !== artifact.sha256) throw new Error('运行环境下载不完整或散列不符，请重试。');
        installation = { state: 'extracting', message: '正在解压独立环境…' };
        const unpacked = join(stage, 'unpacked');
        await mkdir(unpacked);
        await command(systemTool('tar'), ['-xzf', archive, '-C', unpacked], process.env, { timeout: 120000, signal });
        const payload = join(unpacked, platform);
        const info = await readJSON(join(payload, 'runtime.json'), null);
        if (info?.id !== manifest.id || info.platform !== platform || info.schema !== 1) throw new Error('环境包与当前插件不匹配。');
        installation = { state: 'checking', message: '正在检查编解码与人物处理能力…' };
        const temporary = { python: join(payload, pythonRelative), env: { ...process.env,
          PATH: [join(payload, 'bin'), join(payload, pythonBin)].join(delimiter),
          PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } };
        delete temporary.env.PYTHONHOME; delete temporary.env.PYTHONPATH;
        const result = await inspect(temporary);
        if (!result.ready || !result.visionReady) throw new Error(result.items.filter(item => !item.ready).map(item => `${item.label}: ${item.message}`).join('；'));
        signal.throwIfAborted();
        const destination = join(home, manifest.id, platform);
        await mkdir(join(home, manifest.id), { recursive: true });
        // An existing working environment is never deleted during download/checking.
        if (await exists(join(destination, 'runtime.json'))) throw new Error('固定环境已存在；请重新检查或重启 Harness。');
        await rename(payload, destination);
        cached = null;
        installation = { state: 'ready', message: '固定环境已就绪，可以开始处理视频。' };
      } catch (error) {
        installation = { state: 'failed', message: signal.aborted ? '环境配置已停止，可重新尝试。' : String(error.message).slice(0, 600) };
      } finally {
        await rm(stage, { recursive: true, force: true });
        await rm(installationLock, { force: true });
        installPromise = null;
      }
    })();
    return status();
  }

  async function ensureReady() {
    const value = await status();
    if (!value.ready) {
      const error = new Error('视频运行环境尚未就绪，请在“运行环境”中完成配置。');
      error.code = 'ENVIRONMENT_REQUIRED'; error.status = 409; throw error;
    }
    return execution();
  }
  return { status, install, execution, ensureReady, async close() { closed = true; controller?.abort(); await installPromise; } };
}
