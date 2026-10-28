import { TONE_ALGORITHM_VERSION, LOW_LIGHT_ALGORITHM_VERSION, SHADOW_RANGE, HIGHLIGHT_RANGE } from './live-preview.mjs';
import { normalizeBrowserToneSegments } from './tone-intervals.mjs';

export const EMPTY_DRAFT = Object.freeze({
  revision: null,
  lutEnabled: false,
  lutLook: null,
  lutSize: null,
  cameraOverride: null,
  modeOverride: null,
  highlights: null,
  shadows: null,
  toneSegments: null,
  lowLight: null,
  denoise: null,
  skin: null,
  color: null,
});

export const ZONE_FIELDS = Object.freeze(['highlights', 'shadows', 'skin']);

/** Actual catalog choices only; grid size never implies a different Log mode. */
export function lutSelection(asset, draft = {}) {
  const options = (Array.isArray(asset?.lut_options) ? asset.lut_options : []).filter(row => row
    && ['standard', 'vivid'].includes(row.look) && Number.isInteger(row.grid) && row.grid >= 2 && row.grid <= 129
    && row.available === true);
  const preferred = [...options].sort((a, b) => Number(a.look !== 'vivid') - Number(b.look !== 'vivid')
    || Number(a.grid !== 65) - Number(b.grid !== 65) || b.grid - a.grid)[0];
  const look = draft.lutLook ?? preferred?.look ?? 'vivid';
  const sizes = [...new Set(options.filter(row => row.look === look).map(row => row.grid))].sort((a, b) => b - a);
  const size = draft.lutSize ?? (sizes.includes(65) ? 65 : sizes[0] ?? 65);
  return { look, size, options, sizes,
    looks: ['vivid', 'standard'].filter(value => options.some(row => row.look === value)) };
}

const INPUT_MODES = Object.freeze({ dlog: 'D-Log', dlog2: 'D-Log2', dlogm: 'D-Log M',
  rec709: 'Rec.709', hlg: 'Rec.2100 HLG', pq: 'Rec.2100 PQ' });
function inputMode(value) {
  const compact = String(value ?? '').toLowerCase().replace(/[\s_.-]+/g, '');
  return ({ rec2100hlg: 'hlg', rec2100pq: 'pq' })[compact] ?? (INPUT_MODES[compact] ? compact : null);
}

/** Separate capture evidence from LUT eligibility and the user's apply switch. */
export function inputColorState(asset, draft = {}) {
  const profile = asset?.profile ?? {};
  const recorded = Object.entries(profile.raw ?? {}).find(([key]) =>
    key.toLowerCase().replace(/[^a-z0-9]/g, '').endsWith('colorgammasxs'))?.[1];
  const recordedMode = inputMode(recorded);
  const mode = inputMode(draft.modeOverride) ?? inputMode(profile.mode) ?? recordedMode;
  const hdr = mode === 'hlg' || mode === 'pq';
  const conflict = profile.status === 'conflict';
  const manual = Boolean(mode && !recordedMode
    && (draft.modeOverride || profile.mode_source === 'user-declared' || profile.status === 'user-declared'));
  const identified = Boolean(mode && !conflict);
  const label = INPUT_MODES[mode] ?? (recorded ? String(recorded) : '未记录拍摄格式');
  const selectionPending = asset?.lut?.available === true && ['lutLook', 'lutSize'].some((field, index) => {
    if (!Object.hasOwn(draft, field)) return false;
    const key = index === 0 ? 'look' : 'grid';
    return draft[field] == null ? asset.lut[`requested_${key}`] !== null : asset.lut[key] !== draft[field];
  });
  const available = identified && !hdr && !selectionPending && asset?.lut?.available === true;
  const source = identified ? manual ? '手动确认'
    : recordedMode || profile.mode_source === 'metadata' || profile.status === 'metadata' ? '视频元数据' : '格式记录' : null;
  const status = conflict ? '信息冲突' : identified ? manual ? '已手动确认' : '已识别'
    : recorded ? '已记录 · 暂不支持' : '缺少格式信息';
  const restoreStatus = hdr ? 'HDR 转换暂不支持' : mode === 'rec709' ? '无需 Log 还原'
    : selectionPending ? '正在匹配所选 LUT…'
      : available ? draft.lutEnabled ? '色彩还原已开启' : '已匹配 · 还原未开启' : '还原方案不可用';
  const detail = conflict ? '视频中的拍摄格式信息存在冲突，暂不应用还原。'
    : hdr ? `视频明确记录为 ${label}（HDR）。当前尚未支持 HDR 转 SDR，不会套用 D-Log 还原；原始解码预览不能作为准确的 HDR 显示参考。`
      : mode === 'rec709' ? '视频已记录为标准 Rec.709，无需套用 DJI Log 还原。'
        : identified ? `${source}确认拍摄格式为 ${label}；${selectionPending ? '正在匹配所选风格与尺寸。' : available ? '已精确匹配这台相机的 Rec.709 还原方案。' : '尚未找到与相机型号精确匹配的还原方案。'}`
          : recorded ? `视频记录的格式为 ${label}，当前无法确认对应变换。`
            : '视频没有记录可识别的拍摄格式。仅凭画面不能精确区分 D-Log、D-Log M 和 D-Log2，请按实际拍摄设置确认。';
  return { mode, label, hdr, identified, available, selectionPending, source, status, restoreStatus, detail,
    needsConfirmation: !hdr && mode !== 'rec709'
      && (!identified || !(draft.cameraOverride || profile.camera) || manual) };
}

export function skinValues(skin) {
  if (skin === null || skin === undefined) return { amount: 0, brightness: 0, smoothness: 0 };
  if (typeof skin === 'number') return { amount: skin, brightness: 0, smoothness: 0 };
  return { amount: skin.amount, brightness: skin.brightness, smoothness: skin.smoothness };
}

export function skinHasEffect(skin) {
  if (skin === null || skin === undefined) return false;
  const values = skinValues(skin);
  return values.amount !== 0 || values.brightness !== 0 || values.smoothness !== 0;
}

function validSkin(skin) {
  return finiteInRange(skin, -1, 1) || Boolean(skin && typeof skin === 'object'
    && finiteInRange(skin.amount, -1, 1)
    && finiteInRange(skin.brightness, 0, 1)
    && finiteInRange(skin.smoothness, 0, 1));
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value)));
}

export function finiteInRange(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

export function normalizeDraft(input, duration) {
  if (!input || typeof input !== 'object' || input.revision === undefined || input.revision === null) {
    throw new Error('服务端没有返回可编辑的参数版本。');
  }
  const draft = { ...EMPTY_DRAFT, ...input };
  try { draft.toneSegments = normalizeBrowserToneSegments(input.toneSegments, duration); }
  catch { throw new Error('服务端返回了无效的分段明暗方案。'); }
  if ('lutEnabled' in input && typeof input.lutEnabled !== 'boolean') {
    throw new Error('服务端返回了无效的色彩还原状态。');
  }
  draft.lutEnabled = input.lutEnabled === true;
  if (draft.lutLook !== null && !['standard', 'vivid'].includes(draft.lutLook)) throw new Error('服务端返回了无效的 LUT 风格。');
  if (draft.lutSize !== null && (!Number.isInteger(draft.lutSize) || draft.lutSize < 2 || draft.lutSize > 129)) throw new Error('服务端返回了无效的 LUT 尺寸。');
  if ('cameraOverride' in input && input.cameraOverride !== null
    && (typeof input.cameraOverride !== 'string' || !input.cameraOverride)) {
    throw new Error('服务端返回了无效的相机设置。');
  }
  draft.cameraOverride = typeof input.cameraOverride === 'string' && input.cameraOverride
    ? input.cameraOverride : null;
  if ('modeOverride' in input && input.modeOverride !== null
    && !['D-Log', 'D-Log2', 'D-Log M', 'Rec.709'].includes(input.modeOverride)) {
    throw new Error('服务端返回了无效的拍摄模式。');
  }
  draft.modeOverride = ['D-Log', 'D-Log2', 'D-Log M', 'Rec.709'].includes(input.modeOverride)
    ? input.modeOverride : null;
  for (const field of ['highlights', 'shadows']) {
    if (field in input && input[field] !== null && !finiteInRange(input[field], -1, 1)) {
      throw new Error(`服务端返回了无效的${field}调整值。`);
    }
    draft[field] = finiteInRange(input[field], -1, 1) ? input[field] : null;
  }
  if (input.lowLight != null && !finiteInRange(input.lowLight, 0, 1)) throw new Error('服务端返回了无效的暗光增强值。');
  draft.lowLight = input.lowLight ?? null;
  if (input.denoise != null && (!input.denoise || typeof input.denoise !== 'object' || Array.isArray(input.denoise)
    || Object.keys(input.denoise).some(key=>key!=='amount') || !finiteInRange(input.denoise.amount,0,1))) throw new Error('服务端返回了无效的降噪强度。');
  draft.denoise = input.denoise == null ? null : { amount: input.denoise.amount };
  if ('skin' in input && input.skin !== null && !validSkin(input.skin)) {
    throw new Error('服务端返回了无效的肤色调整值。');
  }
  draft.skin = validSkin(input.skin) ? input.skin : null;
  const color = input.color;
  if ('color' in input && color !== null && (!color || !finiteInRange(color.hue, 0, 360)
    || !finiteInRange(color.range, 0, 180) || !finiteInRange(color.amount, -1, 1)
    || color.hueShift !== undefined && !finiteInRange(color.hueShift, -180, 180)
    || color.luminance !== undefined && !finiteInRange(color.luminance, -1, 1))) {
    throw new Error('服务端返回了无效的局部颜色设置。');
  }
  draft.color = color && finiteInRange(color.hue, 0, 360)
    && finiteInRange(color.range, 0, 180)
    && finiteInRange(color.amount, -1, 1)
    ? { hue: color.hue, range: color.range, amount: color.amount,
      hueShift: color.hueShift ?? 0, luminance: color.luminance ?? 0 }
    : null;
  return draft;
}

export function zoneIsSet(draft, field) {
  if (field === 'skin') return validSkin(draft?.skin);
  return finiteInRange(draft?.[field], -1, 1);
}

export function normalizeFeatures(input) {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.filter((item) => typeof item === 'string' && item))];
}

export function skinCandidateAvailable(analysis) {
  return analysis?.skin_candidate?.available === true;
}

export function analysisMatchesSelection(target, asset, draft, analysisKey, result) {
  return Boolean(target && asset && draft && result
    && String(target.assetId) === String(asset.id)
    && (target.analysisKey === null && analysisKey === null
      ? target.revision === draft.revision
      : Boolean(target.analysisKey && analysisKey && target.analysisKey === analysisKey))
    && (!target.sourceSha256 || target.sourceSha256 === asset.sha256)
    && (!result.source_sha256 || result.source_sha256 === asset.sha256));
}

export function analysisJobNeedsPolling(job, analysis, target, asset, draft, analysisKey) {
  if (!job?.id) return false;
  const terminal = ['completed', 'succeeded', 'success', 'failed', 'cancelled', 'canceled'].includes(job.status);
  return !terminal || analysis?.action !== 'analyze' || !analysis.measurement
    || !analysisMatchesSelection(target, asset, draft, analysisKey, analysis);
}

export function proxyStartDecision(target, asset, draft, analysisKey, conditions) {
  if (!target) return 'none';
  if (target.inputEpoch !== undefined && target.inputEpoch !== conditions.inputEpoch) return 'stale';
  if (!analysisMatchesSelection(target, asset, draft, analysisKey, {})) return 'stale';
  if (conditions.proxyRef || conditions.proxyJob || conditions.proxyError) return 'done';
  if (conditions.busy || conditions.inputChangePending || conditions.previewRunning) return 'wait';
  return 'start';
}

export const AI_SCOPES = Object.freeze(['tone', 'skin', 'local-color']);

export function normalizeAiModels(input) {
  if (!input || typeof input !== 'object') throw new Error('模型列表无效。');
  const models = Array.isArray(input.models) ? input.models.filter((item) =>
    item && typeof item.provider === 'string' && item.provider
      && typeof item.id === 'string' && item.id
      && typeof item.name === 'string' && item.name).map((item) => ({
        provider: item.provider, id: item.id, name: item.name,
        vision: item.vision === true || item.inputModalities?.includes?.('image') === true,
      })) : [];
  return {
    available: input.available === true && models.length > 0,
    models,
    defaultModel: input.defaultModel && typeof input.defaultModel.provider === 'string'
      && typeof input.defaultModel.model === 'string' ? input.defaultModel : null,
    reason: typeof input.reason === 'string' ? input.reason : null,
  };
}

export function aiContextMatches(target, context, current) {
  if (!target || !context || !current) return false;
  if (typeof target.assetId !== 'string' || !target.assetId
    || !AI_SCOPES.includes(target.scope)
    || !Number.isFinite(target.revision) || !Number.isFinite(target.timeSeconds)
    || typeof target.analysisKey !== 'string' || !target.analysisKey
    || typeof target.provider !== 'string' || !target.provider
    || typeof target.model !== 'string' || !target.model
    || typeof target.includedFrame !== 'boolean'
    || (target.includedFrame && (typeof target.previewRef !== 'string' || !target.previewRef))
    || (!target.includedFrame && target.previewRef !== null)) return false;
  return target.assetId === context.assetId && target.assetId === current.assetId
    && target.revision === context.revision && target.revision === current.revision
    && target.analysisKey === context.analysisKey && target.analysisKey === current.analysisKey
    && target.timeSeconds === context.timeSeconds && target.timeSeconds === current.timeSeconds
    && target.previewRef === context.previewRef
    && target.scope === context.scope && target.scope === current.scope
    && target.includedFrame === context.includedFrame
    && target.provider === context.provider && target.model === context.model
    && (!target.includedFrame || target.previewRef === current.previewRef);
}

export function aiReceiptForScope(receipts, scope, current) {
  if (!AI_SCOPES.includes(scope)) return null;
  const receipt = receipts?.get?.(scope);
  return receipt && ['completed', 'succeeded', 'success'].includes(receipt.job?.status)
    && receipt.advice && aiContextMatches(receipt.target, receipt.context, current)
    ? receipt : null;
}

export function aiRecommendationCanApply(recommendation, { includedFrame = true } = {}) {
  if (!includedFrame && recommendation?.group !== 'tone') return false;
  const keys = { tone: ['highlights', 'shadows'], skin: ['skin'], 'local-color': ['color'] }[recommendation?.group];
  const changes = recommendation?.changes;
  return Boolean(keys && changes && typeof changes === 'object' && !Array.isArray(changes)
    && Object.keys(changes).length > 0 && Object.keys(changes).every((key) => keys.includes(key))
    && typeof recommendation.id === 'string' && recommendation.id);
}

export function describeAiChanges(recommendation, draft) {
  if (!aiRecommendationCanApply(recommendation) || !draft) return [];
  const changes = recommendation.changes;
  const lines = [];
  const number = (value, degrees = false) => value === null || value === undefined ? '未设置'
    : degrees ? `${Math.round(value)}°` : `${value > 0 ? '+' : ''}${Number(value).toFixed(2)}`;
  const add = (label, before, after, degrees = false) => {
    if (before === after) return;
    lines.push(`${label} ${number(before, degrees)} → ${after === null ? '关闭' : number(after, degrees)}`);
  };
  if (recommendation.group === 'tone') {
    if (Object.hasOwn(changes, 'highlights')) add('高光', draft.highlights, changes.highlights);
    if (Object.hasOwn(changes, 'shadows')) add('暗部', draft.shadows, changes.shadows);
  } else if (recommendation.group === 'skin') {
    if (changes.skin === null) {
      if (draft.skin !== null) lines.push('肤色 当前设置 → 关闭');
    } else {
      const current = draft.skin === null ? null : skinValues(draft.skin);
      for (const [field, label] of [['amount', '色泽'], ['brightness', '提亮'], ['smoothness', '光滑']]) {
        add(label, current?.[field] ?? null, changes.skin[field]);
      }
    }
  } else if (recommendation.group === 'local-color') {
    if (changes.color === null) {
      if (draft.color !== null) lines.push('局部颜色 当前设置 → 关闭');
    } else {
      const current = draft.color;
      const proposed = { hueShift: 0, luminance: 0, ...changes.color };
      for (const [field, label, degrees] of [
        ['hue', '选中色相', true], ['range', '颜色范围', true],
        ['amount', '饱和强度', false], ['hueShift', '色相偏移', true],
        ['luminance', '明度', false],
      ]) add(label, current?.[field] ?? null, proposed[field], degrees);
    }
  }
  return lines;
}

export function parseAiAdviceResult(result) {
  const advice = result?.advice;
  const context = result?.context;
  if (!advice || typeof advice.summary !== 'string' || !Array.isArray(advice.notes)
    || !Array.isArray(advice.recommendations) || !context
    || !advice.notes.every((note) => typeof note === 'string')
    || !advice.recommendations.every((item) => item && typeof item === 'object'
      && typeof item.id === 'string' && typeof item.group === 'string'
      && typeof item.label === 'string' && typeof item.reason === 'string'
      && (item.changes === null || (typeof item.changes === 'object' && !Array.isArray(item.changes))))
    || typeof context.assetId !== 'string' || !Number.isFinite(context.revision)
    || !Number.isFinite(context.timeSeconds) || typeof context.provider !== 'string'
    || typeof context.model !== 'string' || typeof context.includedFrame !== 'boolean'
    || typeof context.analysisKey !== 'string'
    || !AI_SCOPES.includes(context.scope)
    || advice.recommendations.some((item) => item.group !== context.scope)
    || !(context.previewRef === null || typeof context.previewRef === 'string')) {
    throw new Error('AI 分析未返回可用的建议结果。');
  }
  return { advice, context };
}

export function suggestionFor(analysis, field) {
  const suggestion = analysis?.suggestions?.[field];
  return finiteInRange(suggestion, -1, 1) ? suggestion : null;
}

export function draftHasChanges(draft) {
  return draft?.lutEnabled === true
    || Boolean(draft?.toneSegments?.length)
    || draft?.lowLight != null || draft?.denoise != null
    || ZONE_FIELDS.some((field) => zoneIsSet(draft, field))
    || draft?.color !== null && draft?.color !== undefined;
}

export function colorHasEffect(color) {
  return Boolean(color && (color.amount !== 0 || (color.hueShift ?? 0) !== 0
    || (color.luminance ?? 0) !== 0));
}

export function mediaUrl(base, ref) {
  if (typeof ref !== 'string' || !ref.trim()) throw new Error('预览引用无效。');
  return new URL(`api/media/${encodeURIComponent(ref)}`, base).href;
}

export function apiUrl(base, path) {
  return new URL(`api/${path.replace(/^\/+/, '')}`, base).href;
}

export function nativeDirectoryPicker(windowLike) {
  try {
    const parent = windowLike?.parent;
    if (!parent || parent.location.origin !== windowLike.location.origin) return null;
    const bridge = parent.__DSH_DIRECTORY_PICKER__;
    return typeof bridge?.pick === 'function' ? bridge : null;
  } catch {
    return null;
  }
}

export function directoryFromPickerResult(result) {
  if (result === null || result === undefined) return null;
  const directory = typeof result === 'string' ? result : result?.directory;
  if (typeof directory !== 'string' || !directory.trim()) {
    throw new Error('系统没有返回有效的文件夹路径。');
  }
  return directory;
}

export function unwrapData(payload) {
  return payload?.data && typeof payload.data === 'object' ? payload.data : payload;
}

export async function requestJson(fetchImpl, base, method, path, body, { signal } = {}) {
  let response;
  try {
    response = await fetchImpl(apiUrl(base, path), {
      method,
      headers: body === undefined ? { Accept: 'application/json' } : {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (cause) {
    if (cause?.name === 'AbortError') throw cause;
    const error = new Error('未收到视频服务响应，请重试；这不表示视频文件损坏。', { cause });
    error.code = 'NETWORK_UNAVAILABLE';
    throw error;
  }
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : null;
  if (!response.ok) {
    const detail = payload?.error;
    const message = typeof detail === 'string' ? detail : detail?.message || payload?.message;
    const headerId = response.headers.get('x-hvp-request-id');
    const requestId = typeof headerId === 'string' && /^[A-Za-z0-9._-]{6,128}$/.test(headerId)
      ? headerId : null;
    const error = new Error(`${message || `请求失败（${response.status}）`}${requestId ? `（请求编号：${requestId}）` : ''}`);
    error.status = response.status;
    error.code = detail?.code;
    if (requestId) error.requestId = requestId;
    throw error;
  }
  if (!payload || typeof payload !== 'object') throw new Error('服务端返回了无效数据。');
  return unwrapData(payload);
}

export function revisionOf(draft) {
  if (!draft || draft.revision === undefined || draft.revision === null) {
    throw new Error('当前参数尚未载入。');
  }
  return draft.revision;
}

export function patchBody(assetId, draft, changes) {
  if (typeof assetId !== 'string' || !assetId) throw new Error('尚未选择视频。');
  return { assetId, revision: revisionOf(draft), changes };
}

export function previewTimeLimit(duration) {
  if (!Number.isFinite(duration) || duration <= 0) return null;
  return Math.max(0, duration - Math.min(0.01, duration / 2));
}

export function previewTime(value, duration) {
  const limit = previewTimeLimit(duration);
  if (limit === null) return null;
  const rounded = Math.round(clamp(value, 0, limit) * 1000) / 1000;
  return rounded < duration ? rounded : Math.max(0, Math.floor((duration - 0.000001) * 1000) / 1000);
}

export function playbackFrameTime(info, playerTime, duration) {
  if (!Number.isFinite(info?.start_seconds) || !Number.isFinite(playerTime)) return null;
  const times = info.frame_times_seconds;
  if (!Array.isArray(times) || !times.length || times.some((value,index) => !Number.isFinite(value)
    || value < 0 || index > 0 && value < times[index-1])) return null;
  let left = 0, right = times.length;
  while (left < right) {
    const middle = (left+right) >>> 1;
    if (times[middle] <= playerTime+.0001) left = middle+1;
    else right = middle;
  }
  // Seek just before the displayed PTS: millisecond UI rounding must not
  // turn a paused frame into the following frame on the worker's input seek.
  return previewTime((info.clock_source_start_seconds ?? info.start_seconds) + times[Math.max(0,left-1)] - .001, duration);
}

export function supportsLiveTone(model) {
  const tone = model?.tone;
  if (tone?.low_light && tone.low_light_algorithm_version !== LOW_LIGHT_ALGORITHM_VERSION) return false;
  if (model?.version !== 1 || tone?.available !== true
    || tone.formula !== 'shared-input-luminance'
    || tone.algorithm_version !== TONE_ALGORITHM_VERSION
    || tone.shadow_toe_stops_per_unit !== 4
    || tone.highlight_span_stops_per_unit !== 2) return false;
  const same = (values, expected) => Array.isArray(values) && values.length === expected.length
    && values.every((value, index) => Number.isFinite(value) && Math.abs(value - expected[index]) < 1e-9);
  return same(tone.luminance_coefficients, [.2126, .7152, .0722])
    && same(tone.shadow_range, SHADOW_RANGE)
    && same(tone.highlight_range, HIGHLIGHT_RANGE);
}

export function jobBody(assetId, draft, options = {}) {
  if (typeof assetId !== 'string' || !assetId) throw new Error('尚未选择视频。');
  const body = { assetId, revision: revisionOf(draft) };
  if (options.timeSeconds !== undefined && options.timeSeconds !== null) {
    if (!Number.isFinite(options.timeSeconds) || options.timeSeconds < 0) {
      throw new Error('预览时间无效。');
    }
    body.timeSeconds = options.timeSeconds;
  }
  if (options.previewQuality !== undefined) {
    if (!['fast', 'detail'].includes(options.previewQuality)) throw new Error('预览精度无效。');
    body.previewQuality = options.previewQuality;
  }
  if (options.previewScope !== undefined) {
    if (!['base', 'current'].includes(options.previewScope)) throw new Error('播放范围无效。');
    body.previewScope = options.previewScope;
  }
  if (options.playbackQuality !== undefined) {
    if (!['fast', 'detail'].includes(options.playbackQuality)) throw new Error('播放精度无效。');
    body.playbackQuality = options.playbackQuality;
  }
  return body;
}

export function skipChangesForStep(step) {
  const changes = [
    { lutEnabled: false },
    { highlights: null, shadows: null, toneSegments: null, lowLight: null, denoise: null },
    { skin: null },
    { color: null },
  ][step];
  if (!changes) throw new Error('这一步没有可跳过的调整。');
  return { ...changes };
}

export function progressPercent(progress) {
  if (!Number.isFinite(progress)) return null;
  return Math.round(clamp(progress <= 1 ? progress * 100 : progress, 0, 100));
}

export function hueFromRgb(red, green, blue) {
  const r = red / 255, g = green / 255, b = blue / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  if (delta < 0.035) return null;
  // Match the worker's opponent-space hue selector, so a sampled pixel
  // targets the same center hue in the rendered video.
  return Math.round((Math.atan2(Math.sqrt(3) * (g - b), 2 * r - g - b) * 180 / Math.PI + 360) % 360);
}

export function hueFromHex(hex) {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  return hueFromRgb(...[1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16)));
}

export function hexFromHue(hue) {
  const h = clamp(hue, 0, 360) / 60;
  const x = Math.round(255 * (1 - Math.abs(h % 2 - 1)));
  const sectors = [[255, x, 0], [x, 255, 0], [0, 255, x], [0, x, 255], [x, 0, 255], [255, 0, x]];
  return `#${sectors[Math.min(5, Math.floor(h === 6 ? 0 : h))].map((part) => part.toString(16).padStart(2, '0')).join('')}`;
}

export function previewHexForColor(color) {
  const hue = ((color.hue + (color.hueShift ?? 0)) % 360 + 360) % 360;
  const saturation = clamp(0.76 * (1 + color.amount * 0.35), 0, 1);
  const lightness = clamp(0.52 + (color.luminance ?? 0) * 0.26, 0.08, 0.92);
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const h = hue / 60;
  const x = chroma * (1 - Math.abs(h % 2 - 1));
  const sectors = [[chroma, x, 0], [x, chroma, 0], [0, chroma, x], [0, x, chroma], [x, 0, chroma], [chroma, 0, x]];
  const offset = lightness - chroma / 2;
  return `#${sectors[Math.floor(h)].map((part) => Math.round((part + offset) * 255).toString(16).padStart(2, '0')).join('')}`;
}
