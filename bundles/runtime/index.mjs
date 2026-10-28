import { createMediaRuntime } from '../../src/runtime.mjs';
import { createHarnessAdvisor } from '../../adapters/harness/ai-advisor.mjs';
import { isAbsolute } from 'node:path';
import { nativeExportOpener } from '../../src/native-export-open.mjs';

export const name = 'video-runtime';
export const inject = ['webServer', 'connection'];

function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('video-runtime config must be an object');
  if (!Array.isArray(config.allowedRoots) || config.allowedRoots.some(path => typeof path !== 'string' || path.trim() === '' || !isAbsolute(path))) {
    throw new Error('video-runtime allowedRoots must be an array of absolute directory paths');
  }
  for (const field of ['dataDir', 'python', 'workerPath']) {
    if (config[field] !== undefined && (typeof config[field] !== 'string' || config[field].trim() === '')) throw new Error(`video-runtime ${field} must be a nonempty string`);
  }
  if (config.workerConfig !== undefined && (!config.workerConfig || typeof config.workerConfig !== 'object' || Array.isArray(config.workerConfig))) {
    throw new Error('video-runtime workerConfig must be an object');
  }
  if (config.assets !== undefined && (!config.assets || typeof config.assets !== 'object' || Array.isArray(config.assets))) {
    throw new Error('video-runtime assets must be an object');
  }
  if (config.assets?.vision_python !== undefined && (typeof config.assets.vision_python !== 'string' || !isAbsolute(config.assets.vision_python))) {
    throw new Error('video-runtime assets.vision_python must be an absolute path');
  }
  if (config.assets === undefined) return config;
  return { ...config, workerConfig: { ...config.workerConfig, assets: { ...config.workerConfig?.assets, ...config.assets } } };
}

function rejectUntrusted(ctx, req, res) {
  const status = ctx.connection.requestRejection(req);
  if (status === undefined) return false;
  res.writeHead(status, { 'cache-control': 'no-store' });
  res.end();
  return true;
}

/** One provider, one authenticated `/hvp/` route, one shared feature catalog. */
export async function apply(ctx, config = {}) {
  const runtime = await createMediaRuntime({
    ...validateConfig(config),
    allowUserDirectoryGrants: true,
    allowUserExportGrants: true,
    exportOpener: nativeExportOpener,
    aiAdvisor: createHarnessAdvisor(ctx),
    directoryPicker: {
      available: () => ctx.get('directoryPicker')?.capability().kind === 'native',
      pick: signal => {
        const capability = ctx.get('directoryPicker')?.capability();
        if (capability?.kind !== 'native') throw new Error('系统文件夹选择器暂不可用。');
        return capability.pick(signal);
      },
    },
  });
  ctx.effect(() => () => runtime.close(), 'video runtime close');
  ctx.provide('videoRuntime', runtime);
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/hvp',
    handler: (req, res) => {
      if (rejectUntrusted(ctx, req, res)) return;
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET' });
        res.end();
        return;
      }
      res.writeHead(308, { location: '/hvp/' });
      res.end();
    },
  }), 'video runtime UI redirect');
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/hvp',
    handler: async (req, res) => {
      if (rejectUntrusted(ctx, req, res)) return;
      if (!await runtime.handleHttp(req, res, '/hvp/')) {
        res.writeHead(404);
        res.end();
      }
    },
  }), 'video runtime authenticated HTTP');
}
