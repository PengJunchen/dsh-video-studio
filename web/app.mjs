import {
  AI_SCOPES, aiContextMatches, aiReceiptForScope, aiRecommendationCanApply,
  describeAiChanges, normalizeAiModels,
  parseAiAdviceResult,
  analysisJobNeedsPolling, analysisMatchesSelection, clamp, colorHasEffect, inputColorState, lutSelection,
  hexFromHue, hueFromHex, hueFromRgb, previewHexForColor,
  directoryFromPickerResult, jobBody, mediaUrl, nativeDirectoryPicker,
  normalizeDraft, normalizeFeatures, patchBody, previewTime, playbackFrameTime,
  previewTimeLimit, progressPercent, requestJson, skinCandidateAvailable,
  skinHasEffect, skinValues, skipChangesForStep, suggestionFor, supportsLiveTone, zoneIsSet,
} from './state.mjs';
import { LiveToneRenderer } from './live-preview.mjs';
import { toneIntervalEntries, toneRangesForGroup, mergeToneRanges } from './tone-intervals.mjs';

const base = new URL('.', document.baseURI);
const app = document.querySelector('#app');
document.body.classList.toggle('native-harness', window.location.protocol === 'dsh-app:');
const hevcPlaybackSupported = Boolean(document.createElement('video').canPlayType('video/mp4; codecs="hvc1.2.4.L150.B0"'));
const state = {
  environment: null, environmentOpen: false, environmentError: null,
  assets: [], directory: '', asset: null, draft: null, analysis: null,
  analysisKey: null, analysisJob: null, analysisError: null,
  sourcePreviewRef: null, previewRef: null, samplePreviewRef: null, sampleImage: null,
  sampleImageStatus: null, outputRef: null, outputRevision: null,
  exportFile: null, exportHistory: [], exportDirectory: '', defaultExportDirectory: '', exportActionPending: false, exportHistoryError: null,
  exportQuality: 'preserve', canChooseExportQuality: false,
  baseRef: null, baseImage: null, baseImageStatus: null, liveRenderer: null,
  previewImage: null, previewModel: null, previewRevision: null, previewRequestTime: null,
  previewTone: null, previewHadOtherEffects: false, selectedTimeSeconds: null,
  currentTime: null, liveToneActive: false, liveToneValues: null, previewStatus: 'empty',
  proxyRef: null, proxyJob: null, proxyError: null,
  playbackRef: null, playbackInfo: null, playbackVisible: false, playbackRevision: null,
  playbackPaused: true, playbackEnded: false,
  playbackQuality: hevcPlaybackSupported ? 'detail' : 'fast',
  viewerExpanded: false, viewerZoom: 0, previewQuality: 'fast',
  materialsCollapsed: false, adjustmentsCollapsed: false,
  stepIndex: 0, timeLocating: false,
  activeToneRangeId: null, toneScope: 'global',
  inputChangePending: false, inputEpoch: 0,
  previewQueued: false,
  activePreviewTarget: null,
  faceZoom: false,
  toneInputPending: false,
  frameInputPending: false,
  job: null, jobKind: null, jobType: null, pending: null, pickColor: false,
  openingName: null, openingAssetId: null,
  previewView: 'after',
  features: [], canPickDirectory: false,
  adjustmentCapabilities: { lowLight: false, denoise: false },
  advancedOpen: false, notice: null, mediaKinds: new Map(),
  aiExpanded: false, aiModels: null, aiModelsLoading: false, aiModelsError: null,
  aiModelIndex: 0, aiIntent: '', aiIncludeFrame: false,
  aiJob: null, aiAdvice: null, aiContext: null, aiTarget: null,
  aiReceipts: new Map(),
  aiError: null, aiStaleReason: null, aiApplyingId: null, aiCancelPending: false,
  cameraOptions: [
    { value: 'pocket4p', label: 'Pocket 4P' },
    { value: 'pocket4', label: 'Pocket 4' },
    { value: 'pocket3', label: 'Pocket 3' },
  ],
};
let requestSequence = 0;
let selectionController = null;
let jobSequence = 0;
let analysisSequence = 0;
let proxySequence = 0;
let aiSequence = 0;
let aiModelSequence = 0;
let liveFrameRequest = 0;
let seekDebounce = 0;
let environmentTimer;
const cancellationRequests = new Set();

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

function notify(message, tone = 'info') {
  state.notice = { message, tone };
  render();
}

function errorMessage(error) {
  return error instanceof Error ? error.message : '操作未完成，请重试。';
}

function durationLabel(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return '时长未知';
  const total = Math.max(0, Math.floor(Number(seconds)));
  return `${Math.floor(total / 60).toString().padStart(2, '0')}:${(total % 60).toString().padStart(2, '0')}`;
}

function frameTimeLabel(seconds) {
  if (!Number.isFinite(seconds)) return '00:00.00';
  const hundredths = Math.round(Math.max(0, seconds) * 100);
  const minutes = Math.floor(hundredths / 6000);
  const remainder = hundredths % 6000;
  return `${minutes.toString().padStart(2, '0')}:${Math.floor(remainder / 100).toString().padStart(2, '0')}.${(remainder % 100).toString().padStart(2, '0')}`;
}

const steps = ['色彩还原', '明暗', '肤色', '局部颜色', '确认'];
const aiStepScopes = [null, 'tone', 'skin', 'local-color', null];

function aiScopeForStep(index = state.stepIndex) {
  return aiStepScopes[index] || null;
}

function restoreCachedAiReceipt() {
  const receipt = aiReceiptForScope(state.aiReceipts, aiScopeForStep(), aiCurrentContext());
  if (!receipt) return false;
  state.aiJob = receipt.job;
  state.aiAdvice = receipt.advice;
  state.aiContext = receipt.context;
  state.aiTarget = receipt.target;
  return true;
}

function setStep(index) {
  state.adjustmentsCollapsed = false;
  if (index === state.stepIndex) return;
  const wasPlaying = state.playbackVisible;
  stopPlayback();
  cancelJobIfRunning(state.aiJob);
  ++aiSequence;
  state.aiJob = null;
  state.aiAdvice = null;
  state.aiContext = null;
  state.aiTarget = null;
  state.aiError = null;
  state.aiStaleReason = null;
  state.aiCancelPending = false;
  state.aiExpanded = false;
  state.aiIncludeFrame = false;
  state.aiIntent = '';
  state.stepIndex = index;
  state.advancedOpen = false;
  restoreCachedAiReceipt();
  if (wasPlaying) void startJob('preview', true);
}

function availableStep(index) {
  return index === 4 || hasFeature(['lut-batch', 'tone', 'skin', 'local-color'][index]);
}

function adjacentStep(index, direction) {
  for (let next = index + direction; next >= 0 && next < steps.length; next += direction) {
    if (availableStep(next)) return next;
  }
  return index;
}

function previewStatusLabel() {
  if (state.pending === 'select') return '正在切换素材';
  if (state.previewView === 'before') return currentExactPreview() ? '原片画面' : '原片画面 · 等待所选帧';
  if (state.stepIndex === 0 && currentExactPreview() && state.baseRef) {
    return state.draft.lutEnabled ? '仅色彩还原 · 引擎已校准' : '原始色彩 · 未应用还原';
  }
  if (state.previewStatus === 'exact' && currentExactPreview()) return state.draft.toneSegments?.length ? '当前帧 · 按已确认方案' : '引擎已校准';
  if (state.previewStatus === 'approx') return state.jobKind === 'preview'
    ? '明暗即时近似 · 引擎校准中'
    : hasOtherEffects() ? '明暗即时近似 · 其他调整待校准' : '明暗即时近似 · 松手后校准';
  if (state.previewStatus === 'locating') return state.proxyRef
    ? state.jobKind === 'preview' ? '基础定位画面 · 精确效果处理中' : '基础定位画面 · 效果待校准'
    : '正在定位所选画面…';
  if (state.jobKind === 'preview') return '正在引擎校准 · 保留上一画面';
  if (state.previewRef) return '预览待校准';
  return '等待画面预览';
}

function hasOtherEffects() {
  return state.previewHadOtherEffects || skinHasEffect(state.draft?.skin)
    || colorHasEffect(state.draft?.color) || state.draft?.denoise != null;
}

function subjectRegion() {
  if (!currentExactPreview()) return null;
  const frameRegion = state.previewModel?.skin?.face_regions?.find((item) =>
    [item?.x, item?.y, item?.width, item?.height].every((value) => Number.isFinite(value))
    && item.width > 0 && item.height > 0);
  if (frameRegion) return {
    x: Math.min(1, Math.max(0, frameRegion.x + frameRegion.width / 2)),
    y: Math.min(1, Math.max(0, frameRegion.y + frameRegion.height / 2)),
  };
  if (!skinCandidateAvailable(state.analysis)) return null;
  const candidate = state.analysis.skin_candidate;
  const segments = candidate?.segments;
  if (!Array.isArray(segments)) return null;
  const frames = Number(candidate.frame_count);
  const duration = Number(state.asset?.duration);
  const frame = Number.isFinite(frames) && frames > 0 && Number.isFinite(duration) && duration > 0
    ? Math.min(frames - 1, Math.floor((state.currentTime ?? 0) / duration * frames)) : 0;
  const segment = segments.find((item) => frame >= item.start_frame && frame < item.end_frame);
  const region = segment?.regions?.find((item) => [item.x, item.y, item.width, item.height]
    .every((value) => Number.isFinite(value)) && item.width > 0 && item.height > 0);
  if (!region) return null;
  return { x: Math.min(1, Math.max(0, region.x + region.width / 2)),
    y: Math.min(1, Math.max(0, region.y + region.height / 2)) };
}

function currentExactPreview() {
  return Boolean(state.previewRef && state.draft
    && state.previewRevision === state.draft.revision
    && state.previewRequestTime === state.selectedTimeSeconds
    && state.previewStatus === 'exact');
}

function hasCurrentBase() {
  return !state.draft?.toneSegments?.length && state.liveRenderer !== null && state.baseImageStatus === 'loaded'
    && supportsLiveTone(state.previewModel)
    && state.previewRequestTime === state.selectedTimeSeconds;
}

function liveToneAmounts() {
  return {
    shadows: state.liveToneValues?.shadows ?? state.draft?.shadows ?? 0,
    highlights: state.liveToneValues?.highlights ?? state.draft?.highlights ?? 0,
    lowLight: state.liveToneValues?.lowLight ?? state.draft?.lowLight ?? 0,
  };
}

function paintLiveCanvas() {
  const canvas = document.querySelector('#live-preview-canvas');
  if (!canvas) return;
  if (state.playbackVisible || state.viewerExpanded || state.stepIndex === 0 || !state.liveToneActive || state.previewView === 'before' || !hasCurrentBase()) {
    canvas.classList.remove('is-active');
    return;
  }
  const amounts = liveToneAmounts();
  state.liveRenderer.draw(canvas, state.previewTone?.shadows ?? 0,
    state.previewTone?.highlights ?? 0, amounts.shadows, amounts.highlights,
    hasOtherEffects(), state.previewTone?.lowLight ?? 0, amounts.lowLight);
  canvas.classList.add('is-active');
}

function scheduleLivePaint() {
  if (liveFrameRequest) return;
  liveFrameRequest = requestAnimationFrame(() => {
    liveFrameRequest = 0;
    paintLiveCanvas();
  });
}

function resolutionLabel(asset) {
  return Number(asset?.width) > 0 && Number(asset?.height) > 0
    ? `${asset.width} × ${asset.height}` : '分辨率未知';
}

function statusLabel(status) {
  return ({ matched: '已识别', verified: '已识别', recognized: '已识别', metadata: '已识别',
    'user-declared': '已确认', unknown: '待确认', ambiguous: '待确认', conflict: '信息冲突', unsupported: '暂不支持',
  })[status] || (status ? String(status) : '待确认');
}

function lutReason(reason) {
  return ({
    camera_or_profile_unknown: '相机或拍摄模式待确认。确认后会重新检查还原方案。',
    input_is_rec709: '这段视频已是标准色彩模式，无需 DJI Log 还原。',
    catalog_not_configured: '尚未配置可核验的还原资源。',
    exact_lut_missing: '没有找到与这台相机、拍摄模式及所选风格和尺寸精确匹配的 LUT。',
    ambiguous_lut: '找到多个候选方案，当前无法安全应用。',
    lut_file_missing: '匹配的还原资源文件暂时不可用。',
    hdr_input_unsupported: '已识别 HDR 输入，当前不使用 Log 还原方案。',
  })[reason] || reason || '当前没有可确认的色彩还原方案。';
}

function modeLabel(mode) {
  return ({ dlog: 'D-Log', dlog2: 'D-Log2', dlogm: 'D-Log M', rec709: 'Rec.709', hlg: 'Rec.2100 HLG', pq: 'Rec.2100 PQ' })[mode] || mode;
}

function cameraLabel(camera) {
  return state.cameraOptions.find((item) => item.value === camera)?.label || camera;
}

function signed(value) {
  return `${value > 0 ? '+' : ''}${Number(value).toFixed(2)}`;
}

function selectedAssetId() {
  return state.asset?.id == null ? null : String(state.asset.id);
}

function isBusy() {
  return state.pending !== null;
}

function hasFeature(feature) {
  return state.features.includes(feature);
}

function acceptAdjustmentCapabilities(data) {
  if (!data || !Object.hasOwn(data, 'adjustmentCapabilities')) return;
  state.adjustmentCapabilities = {
    lowLight: data.adjustmentCapabilities?.lowLight === true,
    denoise: data.adjustmentCapabilities?.denoise === true,
  };
}

function unavailableSettings() {
  const draft = state.draft;
  if (!draft) return [];
  const missing = [];
  if (draft.lutEnabled && !hasFeature('lut-batch')) missing.push('DJI 色彩还原');
  if ((zoneIsSet(draft, 'highlights') || zoneIsSet(draft, 'shadows') || draft.toneSegments?.length
    || draft.lowLight != null || draft.denoise != null) && !hasFeature('tone')) missing.push('明暗');
  if (draft.lowLight != null && !state.adjustmentCapabilities.lowLight) missing.push('暗光增强');
  if (draft.denoise != null && !state.adjustmentCapabilities.denoise) missing.push('降噪');
  if (zoneIsSet(draft, 'skin') && !hasFeature('skin')) missing.push('肤色');
  if (draft.color !== null && !hasFeature('local-color')) missing.push('局部颜色');
  return missing;
}

function canProcess() {
  return state.environment?.ready === true && state.features.length > 0 && unavailableSettings().length === 0;
}

function environmentBusy() {
  return ['downloading', 'extracting', 'checking'].includes(state.environment?.installation?.state);
}

function renderEnvironment() {
  const value = state.environment;
  const ready = value?.ready && value?.visionReady;
  const detail = state.environmentOpen || !ready;
  const source = ({ bundled: '插件自带', managed: '插件独立环境', system: '系统环境', configured: '指定环境' })[value?.source] || '检测中';
  return `<section class="environment-panel ${ready ? 'is-ready' : ''}" aria-label="运行环境"><div class="environment-heading"><div><strong>${environmentBusy() ? '正在配置运行环境' : ready ? '运行环境已就绪' : '准备视频运行环境'}</strong><small>${escapeHtml(value?.platform || '')} · ${source}</small></div><button type="button" data-action="toggle-environment" aria-expanded="${detail}">${detail ? '收起' : '查看'}</button></div>
    ${detail ? `<ul>${(value?.items || []).map(item => `<li><span>${item.ready ? '✓' : '○'} ${escapeHtml(item.label)}</span><span>${escapeHtml(item.version || item.message)}</span></li>`).join('')}</ul>
      ${!value ? '<p>正在检测 Python、编解码器与人物处理依赖…</p>' : ''}
      ${environmentBusy() ? `<p role="status">${escapeHtml(value.installation.message)}</p>` : ''}
      ${value?.installation?.state === 'failed' ? `<p class="is-error" role="alert">${escapeHtml(value.installation.message)}</p>` : ''}
      ${state.environmentError ? `<p class="is-error" role="alert">${escapeHtml(state.environmentError)}</p>` : ''}
      ${!ready && !environmentBusy() ? `<p>完整系统安装包已包含所需环境。通用安装包可在此下载固定版本，保存到插件的数据目录，无需管理员权限。</p>${value?.canInstall ? `<button class="button primary" type="button" data-action="install-environment">配置独立环境${value.downloadBytes ? ` · ${Math.ceil(value.downloadBytes / 1024 / 1024)} MB` : ''}</button>` : `<p>${escapeHtml(value?.installReason || '')}</p>`}` : ''}
      <button class="button secondary" type="button" data-action="check-environment" ${mutedAttribute(environmentBusy())}>重新检查</button>` : ''}</section>`;
}

async function loadEnvironment(refresh = false) {
  clearTimeout(environmentTimer);
  try {
    state.environment = await requestJson(fetch, base, 'GET', `environment${refresh ? '?refresh=1' : ''}`);
    state.environmentError = null;
  } catch (error) { state.environmentError = errorMessage(error); }
  render();
  if (environmentBusy()) environmentTimer = setTimeout(() => loadEnvironment(), 1500);
}

async function installEnvironment() {
  if (environmentBusy() || !state.environment?.canInstall) return;
  state.environmentError = null;
  try { state.environment = await requestJson(fetch, base, 'POST', 'environment/install', {}); }
  catch (error) { state.environmentError = errorMessage(error); }
  await loadEnvironment();
}

function analysisPending() {
  return Boolean(state.analysisJob && !jobFinished(state.analysisJob.status));
}

function proxyPending() {
  return Boolean(state.proxyJob && !jobFinished(state.proxyJob.status));
}

function cancelJobIfRunning(job) {
  if (!job?.id || jobFinished(job.status) || cancellationRequests.has(job.id)) return;
  cancellationRequests.add(job.id);
  void requestJson(fetch, base, 'POST', `cancel/${encodeURIComponent(job.id)}`, {})
    .catch(() => cancellationRequests.delete(job.id));
}

function pickColorBlockReason() {
  if (!currentExactPreview()) return '当前画面完成校准后即可点取颜色。';
  if (!colorHasEffect(state.draft?.color)) return null;
  if (!state.samplePreviewRef) return '当前预览不含取色基准画面。移除局部颜色后，可重新预览并点取。';
  if (state.sampleImageStatus === 'error') return '取色基准画面无法载入。移除局部颜色后，可重新预览并点取。';
  if (state.sampleImageStatus !== 'loaded') return '正在准备取色画面…';
  return null;
}

function setSamplePreview(ref) {
  state.samplePreviewRef = ref || null;
  state.sampleImage = null;
  state.sampleImageStatus = null;
  if (!ref) return;
  const image = new Image();
  state.sampleImage = image;
  state.sampleImageStatus = 'loading';
  image.onload = () => {
    if (state.sampleImage !== image) return;
    state.sampleImageStatus = 'loaded';
    render();
  };
  image.onerror = () => {
    if (state.sampleImage !== image) return;
    state.sampleImageStatus = 'error';
    render();
  };
  image.src = mediaUrl(base, ref);
}

function mutedAttribute(condition) {
  return condition ? 'disabled' : '';
}

function renderAssetRow(asset) {
  const selected = String(asset.id) === (state.openingAssetId || selectedAssetId());
  const input = inputColorState(asset);
  return `<button type="button" class="asset-row ${selected ? 'is-selected' : ''}" data-action="select" data-id="${escapeHtml(asset.id)}" aria-current="${selected}" ${mutedAttribute(isBusy() && state.pending !== 'select')}>
    <span class="asset-icon" aria-hidden="true">▣</span>
    <span class="asset-copy"><strong title="${escapeHtml(asset.name)}">${escapeHtml(asset.name || '未命名视频')}</strong>
      <span>${durationLabel(asset.duration)} <i aria-hidden="true">·</i> ${escapeHtml(input.label)}</span></span>
    <span class="asset-arrow" aria-hidden="true">↗</span>
  </button>`;
}

function renderSidebar() {
  const picker = `<button class="pick-directory-button" type="button" data-action="pick-directory" ${mutedAttribute(isBusy() || !state.canPickDirectory)}>${state.pending === 'picker' ? '正在选择…' : '选择文件夹'} <span aria-hidden="true">↗</span></button>`;
  const sources = `<div class="sidebar-section-title">素材来源</div>
    <form id="scan-form" class="scan-card">
      <label for="directory">素材文件夹</label>
      <div class="path-field"><span aria-hidden="true">⌁</span><input id="directory" name="directory" type="text" autocomplete="off" spellcheck="false" placeholder="输入本机文件夹路径" value="${escapeHtml(state.directory)}" required></div>
      <button class="scan-button" type="submit" ${mutedAttribute(isBusy())}><span aria-hidden="true">⌕</span>${state.pending === 'scan' ? '正在扫描…' : '扫描视频'}<span aria-hidden="true">→</span></button>
      <p>只读取你指定的文件夹；原视频会保留。</p>
    </form>
    <div class="asset-heading"><div><span class="sidebar-section-title">素材列表</span><small>${state.assets.length} 个视频</small></div></div>
    <div class="asset-list">${state.assets.length ? state.assets.map(renderAssetRow).join('') : `<div class="empty-assets"><span aria-hidden="true">◫</span><p>扫描后，视频会出现在这里。</p></div>`}</div>`;
  return `<aside id="media-sidebar" class="sidebar" aria-label="素材浏览器">
    <div class="brand"><span class="brand-mark" aria-hidden="true">映</span><span><strong>影调工作台</strong><small>VIDEO COLOR STUDIO</small></span></div>
    ${picker}
    ${sources}
    <div class="sidebar-foot"><button type="button" data-action="toggle-environment">运行环境${state.environment?.ready ? ' ✓' : ''}</button></div>
  </aside>`;
}

function renderEmpty() {
  if (state.pending === 'select') return `<main class="workspace empty-workspace">
    <header class="topbar"><span class="eyebrow">正在打开视频</span><span class="topbar-label">STUDIO / 02</span></header>
    <div class="opening-card" role="status" aria-live="polite"><span class="opening-orbit" aria-hidden="true"></span>
      <span class="eyebrow accent">正在打开素材</span><h1>${escapeHtml(state.openingName || '正在打开视频')}<br><em>稍等片刻。</em></h1>
      <p>正在确认素材与拍摄信息；进入工作台后会继续分析画面。</p>
    </div>
  </main>`;
  return `<main class="workspace empty-workspace">
    <header class="topbar"><span class="eyebrow">色彩整理，从画面开始</span><span class="topbar-label">STUDIO / 01</span></header>
    <div class="welcome"><div class="welcome-art" aria-hidden="true"><div class="sun"></div><div class="hill hill-one"></div><div class="hill hill-two"></div><span class="art-label">LIGHT IN EVERY FRAME</span></div>
      <div class="welcome-copy"><span class="eyebrow accent">为你的下一段视频</span><h1>看见好画面，<br><em>再做一点调整。</em></h1>
        <p>扫描素材，确认 DJI 色彩还原，再按需要调整明暗、肤色与局部颜色。每一步都由你决定。</p>
        <div class="welcome-steps"><span><b>01</b> 扫描视频</span><span><b>02</b> 确认画面</span><span><b>03</b> 预览处理</span></div>
      </div></div>
    ${renderEnvironment()}<div class="welcome-hint">先在左侧选择文件夹，或输入素材路径开始扫描。</div>
  </main>`;
}

function mediaElement(ref) {
  const proxy = ref === state.proxyRef;
  const playing = ref === state.playbackRef && state.playbackVisible;
  const kind = proxy ? 'video' : state.mediaKinds.get(ref) || 'image';
  const url = mediaUrl(base, ref);
  if (kind === 'invalid') return `<div class="media-fallback">${state.playbackInfo?.original ? '当前环境不支持这段原片的编码。可返回当前帧，或使用处理后片段预览；原片未被转换。' : '预览画面暂时无法显示。你仍可调整参数并重试预览。'}</div>`;
  return kind === 'image'
    ? `<img id="preview-media" data-ref="${escapeHtml(ref)}" class="preview-media" src="${escapeHtml(url)}" alt="当前视频画面预览">`
    : `<video id="preview-media" data-ref="${escapeHtml(ref)}" class="preview-media" src="${escapeHtml(url)}" ${proxy ? 'muted' : playing ? 'controls muted' : 'controls'} playsinline preload="auto" aria-label="${proxy ? '所选位置的基础画面' : '当前视频预览'}"></video>`;
}

function activeMediaRef() {
  if (state.playbackVisible && state.playbackRef && state.playbackRevision === state.draft?.revision) return state.playbackRef;
  if (state.previewView === 'before' && state.sourcePreviewRef) return state.stepIndex === 0 ? state.sourcePreviewRef : state.baseRef || state.sourcePreviewRef;
  if (state.stepIndex === 0 && currentExactPreview() && state.baseRef) return state.baseRef;
  return state.previewRef || state.sourcePreviewRef;
}

function renderViewer() {
  const ref = activeMediaRef();
  const hasImage = Boolean(ref);
  const canCompare = Boolean(currentExactPreview() && state.sourcePreviewRef);
  const timeLimit = previewTimeLimit(Number(state.asset.duration));
  const time = state.selectedTimeSeconds ?? 0;
  const input = inputColorState(state.asset, state.draft);
  const playbackAvailable = !input.hdr && (input.mode === 'rec709' || state.draft.lutEnabled && state.asset.lut?.available);
  const atCurrent = state.currentTime !== null && currentExactPreview();
  const face = state.stepIndex === 2 ? subjectRegion() : null;
  const zoom = Boolean(face && state.faceZoom);
  return `<section class="viewer-section ${state.viewerExpanded ? 'is-expanded' : ''}" aria-label="画面预览" ${state.viewerExpanded ? 'role="dialog" aria-modal="true"' : ''}>
    <div class="section-topline"><div><span class="eyebrow">画面始终在这里</span><h2>${escapeHtml(state.asset.name || '当前视频')}</h2></div><span class="viewer-meta">${durationLabel(state.asset.duration)} <i>·</i> ${escapeHtml(resolutionLabel(state.asset))}</span></div>
    <div class="viewer-tools"><div class="playback-tools">
      <button type="button" data-action="original-playback" aria-pressed="${Boolean(state.playbackVisible && state.playbackInfo?.original)}" ${mutedAttribute(isBusy() || state.jobKind && state.jobKind !== 'preview')}>原片播放</button>
      <button type="button" data-action="playback" ${mutedAttribute(isBusy() || state.jobKind || !canProcess() || !playbackAvailable)}>${state.jobKind === 'playback' ? '正在准备片段…' : state.playbackVisible && !state.playbackInfo?.original ? state.playbackInfo?.end_seconds >= Number(state.asset.duration)-.05 ? '重新播放本段' : '从当前处播放下一段' : `▶ 播放此处 ${state.playbackQuality === 'detail' ? 2 : 6} 秒`}</button>
      <select id="playback-quality" aria-label="处理后播放精度" ${mutedAttribute(isBusy() || state.jobKind)}><option value="detail" ${!hevcPlaybackSupported ? 'disabled' : ''} ${state.playbackQuality === 'detail' ? 'selected' : ''}>原尺寸 10-bit · 2秒</option><option value="fast" ${state.playbackQuality === 'fast' ? 'selected' : ''}>快速 1280 · 8-bit · 6秒</option></select>
      ${state.playbackVisible ? `${state.mediaKinds.get(state.playbackRef) !== 'invalid' ? `<button type="button" data-action="toggle-playback">${state.playbackEnded ? '重播' : state.playbackPaused ? '继续播放' : '暂停'}</button>` : ''}<button type="button" data-action="playback-frame">查看当前帧</button>` : ''}
      <span>${state.playbackVisible && state.playbackInfo ? state.playbackInfo.original ? `原片 · 未还原、未调整 · ${state.playbackInfo.width} × ${state.playbackInfo.height}` : `${state.playbackInfo.scope === 'base' ? '仅色彩还原' : '当前方案'} · ${frameTimeLabel(state.playbackInfo.start_seconds)}–${frameTimeLabel(state.playbackInfo.end_seconds)} · ${state.playbackInfo.width} × ${state.playbackInfo.height} · ${state.playbackInfo.display_bit_depth || 8}-bit` : playbackAvailable ? hevcPlaybackSupported ? '原尺寸片段保留细节，准备时间较长' : '当前环境使用 8-bit 兼容预览；可直接对照原片' : input.hdr ? 'HDR 可查看原片；暂不支持处理后预览' : '可先查看原片，再确认色彩还原'}</span>
    </div><div class="zoom-tools">
      ${state.viewerExpanded ? [0,1,2].map(value => `<button type="button" data-action="viewer-zoom" data-zoom="${value}" aria-pressed="${state.viewerZoom === value}">${value ? value*100+'%' : '适应窗口'}</button>`).join('') : ''}
      <button type="button" data-action="expand-viewer">${state.viewerExpanded ? '收起画面 ↙' : '放大查看 ↗'}</button>
    </div></div>
    ${state.viewerExpanded && !state.playbackVisible ? `<p class="detail-hint">${state.previewQuality === 'detail' ? `${state.previewImage?.naturalWidth} × ${state.previewImage?.naturalHeight} 原尺寸当前帧 · ${state.viewerZoom ? '可拖动查看细节' : '选择 100% 查看真实像素'}` : '正在读取原尺寸当前帧；暂时保留上一张预览'}</p>` : ''}
    <div class="viewer-frame ${state.pickColor ? 'is-picking' : ''} ${zoom && !state.viewerExpanded ? 'is-face-zoom' : ''} ${state.viewerExpanded && state.viewerZoom ? 'is-pixel-zoom' : ''}" data-zoom="${state.viewerZoom}" style="--image-width:${(state.playbackVisible ? state.playbackInfo?.width : state.previewImage?.naturalWidth) || 1280}px;--image-height:${(state.playbackVisible ? state.playbackInfo?.height : state.previewImage?.naturalHeight) || 720}px;--display-scale:${window.devicePixelRatio || 1};--focus-x:${Math.round((face?.x ?? .5)*100)}%;--focus-y:${Math.round((face?.y ?? .5)*100)}%">
      ${hasImage ? mediaElement(ref) : `<div class="viewer-placeholder"><div class="placeholder-orb"></div><span class="play-symbol" aria-hidden="true">▷</span><strong>${state.jobKind === 'preview' ? '正在生成画面预览' : '画面预览'}</strong><small>${state.jobKind === 'preview' ? '稍等片刻，预览会出现在这里。' : '点击“更新预览”查看当前画面。'}</small></div>`}
      ${state.proxyRef ? `<video id="proxy-media" data-ref="${escapeHtml(state.proxyRef)}" class="preview-media proxy-media ${state.timeLocating && state.previewView !== 'before' ? 'is-active' : ''}" src="${escapeHtml(mediaUrl(base, state.proxyRef))}" muted playsinline preload="auto" aria-label="所选位置的基础画面"></video>` : ''}
      ${state.pending === 'select' ? `<div class="seek-waiting" role="status">正在切换至 ${escapeHtml(state.openingName)}</div>`
        : state.timeLocating && (!state.proxyRef || state.previewView === 'before') ? `<div class="seek-waiting" role="status">所选位置将在松手后生成精确画面</div>` : ''}
      <canvas id="live-preview-canvas" class="live-preview-canvas" aria-hidden="true"></canvas>
      ${state.pickColor && hasImage ? `<button type="button" class="pick-overlay" data-action="sample-color" aria-label="点击画面选取颜色"><span>点击画面，选取要调整的颜色</span></button>` : ''}
      <span class="viewer-corner" id="preview-status">${escapeHtml(state.playbackVisible ? state.playbackInfo?.original ? '原片直读 · 未缩小或重编码' : '当前方案片段 · 播放器可暂停 / 拖动' : state.viewerExpanded && state.previewQuality !== 'detail' ? '原尺寸当前帧载入中' : previewStatusLabel())}</span>
    </div>
    <div class="timeline"><div class="timeline-label"><label for="frame-time">选取画面位置</label><output id="frame-time-output">${frameTimeLabel(atCurrent ? state.currentTime : time)}</output><span> / ${durationLabel(state.asset.duration)}</span></div>
      <input id="frame-time" type="range" min="0" max="${timeLimit ?? 0}" step="0.01" value="${time}" ${mutedAttribute(timeLimit === null || state.pending && !['preview'].includes(state.pending))} aria-label="选取当前视频画面位置">
      <p>${state.proxyRef ? '拖动可即时查看基础画面；松手后校准完整效果。'
        : proxyPending() ? '正在准备视频时间条；松手后仍可查看所选位置的精确画面。'
          : state.proxyError ? `视频时间条暂不可用：${escapeHtml(state.proxyError)} <button type="button" class="timeline-retry" data-action="retry-proxy" ${mutedAttribute(isBusy())}>重试</button>`
            : inputColorState(state.asset, state.draft).hdr ? 'HDR 素材仅提供原始解码帧预览，暂不提供 SDR 视频时间条。'
              : `松手后只生成所选帧，不等待整片载入。${state.draft.lutEnabled && state.asset.lut?.available || inputColorState(state.asset, state.draft).mode === 'rec709' ? ` <button type="button" class="timeline-retry" data-action="prepare-timeline" ${mutedAttribute(isBusy())}>缓存全片时间条（可选）</button>` : ''}`}</p>${renderToneTimeline()}</div>
    <div class="viewer-actions"><div class="viewer-action-left">${canCompare ? `<div class="compare-switch" aria-label="画面对比"><button type="button" data-action="view-before" class="${state.previewView === 'before' ? 'selected' : ''}">${state.stepIndex === 0 ? '原始画面' : '处理前'}</button><button type="button" data-action="view-after" class="${state.previewView !== 'before' ? 'selected' : ''}">${state.stepIndex === 0 ? state.draft.lutEnabled ? '还原后' : '未应用还原' : '当前预览'}</button></div>` : `<span class="viewer-tip">${state.pickColor ? '在画面中选择颜色，按 Esc 退出。' : '调整后可随时更新预览。'}</span>`}
      ${face ? `<button type="button" class="zoom-person" data-action="zoom-person" aria-pressed="${zoom}">${zoom ? '看全画面' : '查看人物细节'}</button>` : ''}</div>
      <button type="button" class="button secondary" data-action="preview" ${mutedAttribute(isBusy() || state.jobKind === 'preview' || !canProcess())}><span aria-hidden="true">↻</span> 校准预览</button></div>
  </section>`;
}

function renderLut() {
  const asset = state.asset;
  const profile = asset.profile || {};
  const input = inputColorState(asset, state.draft);
  const available = input.available;
  const enabled = state.draft.lutEnabled;
  const needsConfirmation = input.needsConfirmation || state.draft.cameraOverride !== null;
  const lutFeature = hasFeature('lut-batch');
  const selection = lutSelection(asset, state.draft);
  const modes = ['D-Log', 'D-Log2', 'D-Log M', 'Rec.709'];
  return `<section class="card lut-card" aria-labelledby="lut-heading">
    <div class="card-header"><div class="card-icon warm" aria-hidden="true">◐</div><div class="card-title"><span class="eyebrow">01 / 输入色彩</span><h3 id="lut-heading">${lutFeature ? 'DJI 色彩还原' : '拍摄格式'}</h3></div><span class="status-pill ${input.identified ? 'good' : 'muted'}">${input.status}</span></div>
    <div class="profile-line"><span>相机 <strong>${escapeHtml(cameraLabel(state.draft.cameraOverride || profile.camera) || '未记录型号')}</strong></span><span>拍摄模式 <strong>${escapeHtml(input.label)}</strong></span></div>
    <p class="card-description">${escapeHtml(input.detail)}</p>
    ${lutFeature ? `<div class="restore-result" role="status"><strong>${escapeHtml(input.restoreStatus)}</strong>
      ${available ? `<span>${escapeHtml(asset.lut.title || '匹配的 Rec.709 还原方案')}</span><small>${enabled
        ? state.playbackVisible && state.playbackInfo?.original ? '正在查看原片；还原方案已保留，返回当前帧可查看还原效果。'
          : currentExactPreview() && state.baseRef ? '当前帧还原预览已就绪，可切换原始与还原效果。'
          : state.job?.status === 'failed' ? '还原预览未完成，请查看错误提示并重试校准预览。' : '正在准备当前帧还原预览…'
        : '开启下方还原后，会自动更新当前帧预览。'}</small>`
        : input.selectionPending ? '<span>正在重新匹配风格与尺寸，当前帧预览会随选择更新。</span>'
          : !input.hdr && input.mode !== 'rec709' ? `<span>${escapeHtml(lutReason(asset.lut?.reason))}</span>` : ''}</div>` : ''}
    ${lutFeature && !input.hdr && input.mode !== 'rec709' && selection.options.length ? `<div class="lut-choices">
      <div class="mode-field"><label for="lut-look">还原风格</label><select id="lut-look" data-field="lutLook" ${mutedAttribute(isBusy())}>
        ${!selection.looks.includes(selection.look) ? `<option selected value="${selection.look}" disabled>所选风格不可用</option>` : ''}
        ${selection.looks.map(look => `<option value="${look}" ${selection.look === look ? 'selected' : ''}>${look === 'vivid' ? '鲜艳 Vivid' : '普通 Standard'}</option>`).join('')}</select></div>
      <div class="mode-field"><label for="lut-size">LUT 尺寸</label><select id="lut-size" data-field="lutSize" ${mutedAttribute(isBusy())}>
        ${!selection.sizes.includes(selection.size) ? `<option selected value="${selection.size}" disabled>Size ${selection.size} · 不可用</option>` : ''}
        ${selection.sizes.map(size => `<option value="${size}" ${selection.size === size ? 'selected' : ''}>Size ${size}</option>`).join('')}</select></div>
      <p>${selection.looks.includes('vivid') && selection.options.some(row => row.look === 'vivid' && row.grid === 65)
        ? '默认优先鲜艳 Vivid · Size 65；切换后只更新当前帧。'
        : '默认优先鲜艳和 Size 65；此拍摄格式仅显示库中实际提供的风格与尺寸。'}</p></div>` : ''}
    ${needsConfirmation ? `<details class="format-details capture-format-details"><summary>确认拍摄格式 <span aria-hidden="true">⌄</span></summary>
      <div class="mode-field"><label for="camera-override">相机</label><select id="camera-override" data-field="cameraOverride" ${mutedAttribute(isBusy())}>
        <option value="">使用识别结果</option>${state.cameraOptions.map((item) => `<option value="${escapeHtml(item.value)}" ${state.draft.cameraOverride === item.value ? 'selected' : ''}>${escapeHtml(item.label)}</option>`).join('')}
      </select></div>
      <div class="mode-field"><label for="mode-override">拍摄模式</label><select id="mode-override" data-field="modeOverride" ${mutedAttribute(isBusy())}>
        <option value="">使用识别结果</option>${modes.map((item) => `<option value="${item}" ${state.draft.modeOverride === item ? 'selected' : ''}>${item}</option>`).join('')}
      </select></div><p>请以拍摄时的实际设置为准；选错格式会影响画面颜色。</p></details>` : ''}
    ${lutFeature && !input.hdr && input.mode !== 'rec709' ? `
    <label class="check-row ${!available && !enabled ? 'is-disabled' : ''}"><input type="checkbox" data-field="lutEnabled" ${enabled ? 'checked' : ''} ${mutedAttribute(isBusy() || !available && !enabled)}><span class="custom-check"></span><span>应用匹配的色彩还原</span></label>` : ''}
  </section>`;
}

function renderSlider(field, title, subtitle, suggestion, isColor = false, canUse = true) {
  const rangeScope = !isColor && ['highlights', 'shadows'].includes(field) && state.toneScope === 'range' && activeToneRange();
  const controls = rangeScope ? state.draft.toneSegments?.find(item => item.id === rangeScope.id) ?? {} : state.draft;
  const enabled = isColor ? state.draft.color !== null : zoneIsSet(controls, field);
  const value = isColor ? state.draft.color?.[field] : controls[field];
  const min = field === 'range' ? 0 : -1;
  const max = field === 'range' ? 180 : 1;
  const step = field === 'range' ? 1 : 0.01;
  const display = enabled ? (field === 'range' ? `${Math.round(value)}°` : signed(value)) : rangeScope ? '继承全片' : '未设置';
  const toneField = !isColor;
  const noSuggestion = analysisPending() ? '画面分析中，可手动调整'
    : field === 'skin' && state.analysis ? '可保持未设置'
      : state.analysis?.measurement ? '可按需要手动调整' : '暂无建议值';
  const suggestionMarkup = toneField ? `<div class="suggestion-row"><span>${suggestion === null ? noSuggestion : `建议 ${signed(suggestion)}`}</span>${suggestion === null ? '' : `<button type="button" class="text-button" data-action="suggest" data-field="${field}" ${mutedAttribute(isBusy() || !canUse)}>应用建议 <span aria-hidden="true">↗</span></button>`}</div>` : '';
  return `<div class="slider-block ${enabled ? '' : 'is-off'}"><div class="slider-head"><div><strong>${title}</strong><small>${subtitle}</small></div><div class="slider-tools">
      <output data-output="${field}">${display}</output>
      ${isColor || field === 'skin' ? '' : `<button type="button" class="mini-button" data-action="zone-switch" data-field="${field}" ${mutedAttribute(isBusy() || !canUse && !enabled)}>${enabled ? '移除' : '加入'}</button>`}</div></div>
    <input class="range-input" type="range" data-field="${field}" min="${min}" max="${max}" step="${step}" value="${enabled ? value : field === 'range' ? 24 : 0}" ${mutedAttribute(!enabled || isBusy() || !canUse)} aria-label="${title}">
    <div class="range-ends"><span>${field === 'range' ? '窄' : '−'}</span><span>${field === 'range' ? '宽' : '+'}</span></div>${suggestionMarkup}</div>`;
}

export function toneExtensionPatch(field, value) {
  if (field === 'lowLightEnabled') return { lowLight: value ? .25 : null };
  if (field === 'denoiseEnabled') return { denoise: value ? { amount: .25 } : null };
  if (field === 'lowLight') return { lowLight: clamp(value, 0, 1) };
  if (field === 'denoise') return { denoise: { amount: clamp(value, 0, 1) } };
  throw new Error('未知的全片调整控件。');
}

export function renderToneExtensions(draft, analysis, capabilities, busy = false) {
  const lowLightAvailable = capabilities?.lowLight === true;
  const denoiseAvailable = capabilities?.denoise === true;
  if (!lowLightAvailable && !denoiseAvailable) return '';
  const lowLightOn = draft?.lowLight != null;
  const denoiseOn = draft?.denoise != null;
  const proposed = analysis?.tone_advice?.low_light;
  const amount = proposed?.amount;
  const validProposal = Number.isFinite(amount) && amount >= 0 && amount <= 1
    && Number.isInteger(proposed?.support_count) && Number.isInteger(proposed?.sample_count)
    && proposed.sample_count > 0 && proposed.support_count <= proposed.sample_count
    && proposed.support_count >= Math.ceil(proposed.sample_count * .8);
  const reference = Number.isFinite(proposed?.reference_shadows_amount)
    ? `，与参考暗部 ${signed(proposed.reference_shadows_amount)} 叠加时估算` : '';
  return `<div class="tone-extensions" aria-label="全片增强">
    ${lowLightAvailable ? `<details class="format-details low-light-details"><summary>暗光增强（全片） · ${lowLightOn ? '已开启' : '未开启'} <span aria-hidden="true">⌄</span></summary>
      <label class="check-row"><input type="checkbox" data-field="lowLightEnabled" ${lowLightOn ? 'checked' : ''} ${mutedAttribute(busy)}><span class="custom-check"></span><span>启用暗光增强</span></label>
      <div class="slider-block ${lowLightOn ? '' : 'is-off'}"><div class="slider-head"><div><strong>暗光强度</strong><small>在原有明暗调整后提亮；整段视频生效</small></div><div class="slider-tools"><output data-output="lowLight">${lowLightOn ? Number(draft.lowLight).toFixed(2) : '未开启'}</output></div></div>
        <input class="range-input" type="range" data-field="lowLight" min="0" max="1" step="0.01" value="${lowLightOn ? draft.lowLight : .25}" ${mutedAttribute(!lowLightOn || busy)} aria-label="暗光强度"><div class="range-ends"><span>0</span><span>1</span></div></div>
      ${validProposal ? `<div class="suggestion-row"><span>基线参考 ${Number(amount).toFixed(2)}${reference}；当前帧需复核。</span><button type="button" class="text-button" data-action="accept-low-light" ${mutedAttribute(busy)}>采纳暗光参考</button></div>` : '<p class="scope-hint">可手调；提亮只放大现有层次，当前帧需复核。</p>'}
    </details>` : ''}
    ${denoiseAvailable ? `<details class="format-details denoise-details"><summary>降噪（全片） · ${denoiseOn ? '已开启' : '未开启'} <span aria-hidden="true">⌄</span></summary>
      <label class="check-row"><input type="checkbox" data-field="denoiseEnabled" ${denoiseOn ? 'checked' : ''} ${mutedAttribute(busy)}><span class="custom-check"></span><span>启用降噪</span></label>
      <div class="slider-block ${denoiseOn ? '' : 'is-off'}"><div class="slider-head"><div><strong>降噪强度</strong><small>开启为轻度 0.25；整段视频生效</small></div><div class="slider-tools"><output data-output="denoise">${denoiseOn ? Number(draft.denoise.amount).toFixed(2) : '未开启'}</output></div></div>
        <input class="range-input" type="range" data-field="denoise" min="0" max="1" step="0.01" value="${denoiseOn ? draft.denoise.amount : .25}" ${mutedAttribute(!denoiseOn || busy)} aria-label="降噪强度"><div class="range-ends"><span>0</span><span>1</span></div></div>
      <p class="scope-hint">细弱线可能柔化；松手后生成当前帧精确预览。</p>
    </details>` : ''}
  </div>`;
}

function renderTone() {
  const on = zoneIsSet(state.draft, 'highlights') || zoneIsSet(state.draft, 'shadows')
    || state.draft.toneSegments?.length || state.draft.lowLight != null || state.draft.denoise != null;
  const range = activeToneRange();
  const evidence = state.analysis?.measurement?.percentiles || state.analysis?.suggestions?.evidence;
  const suggested = suggestionFor(state.analysis, 'highlights') !== null || suggestionFor(state.analysis, 'shadows') !== null;
  const domain = state.analysis?.measurement?.domain;
  const recommendation = state.analysis?.tone_advice?.summary || (suggested ? '建议值需由你点击应用。'
    : domain === 'decoded_source_rgb_unknown_transfer' ? '当前尚未得到标准显示色彩，暂不生成自动建议。'
      : '当前明暗分布可保持，按需要手动调整。');
  return `<section class="card" id="adjustments" aria-labelledby="tone-heading"><div class="card-header"><div class="card-icon violet" aria-hidden="true">☼</div><div class="card-title"><span class="eyebrow">03 / 可选调整</span><h3 id="tone-heading">明暗层次</h3></div><span class="status-pill ${on ? 'active' : 'muted'}">${on ? '已设置' : '未使用'}</span></div>
    <p class="card-description">高光与暗部分开调整；未加入的项目不会处理。</p>
    ${renderToneReview()}
    <div class="tone-scope"><button type="button" class="${state.toneScope === 'global' ? 'selected' : ''}" data-action="tone-global" ${mutedAttribute(isBusy())}>全片基础</button>
      ${range ? `<button type="button" class="${state.toneScope === 'range' ? 'selected' : ''}" data-action="tone-range" ${mutedAttribute(isBusy())}>只调此段 ${timeRangeLabel(range)}</button>` : ''}</div>
    ${range && state.toneScope === 'range' ? '<p class="scope-hint">此处空项继承全片基础；明确加入或采纳后才会单独处理此段。</p>' : ''}
    ${state.draft.toneSegments?.length ? `<p class="scope-hint">${state.toneScope === 'global' ? '已确认区间的单独值优先于全片基础；区间空项仍继承这里。' : ''}区间交界会短暂柔和衔接。</p>` : ''}
    ${evidence ? `<div class="analysis-note"><strong>本地明暗参考</strong><span>${escapeHtml(recommendation)}</span></div>` : analysisPending() ? `<div class="analysis-note"><strong>正在生成本地明暗参考</strong><span>你可以先手动调整高光与暗部；分析完成后再看建议。</span></div>` : ''}
    ${renderSlider('highlights', '高光', '保留亮处的层次', state.toneScope === 'range' ? range?.suggestions?.highlights ?? null : suggestionFor(state.analysis, 'highlights'))}
    ${renderSlider('shadows', '暗部', '调整阴影里的细节', state.toneScope === 'range' ? range?.suggestions?.shadows ?? null : suggestionFor(state.analysis, 'shadows'))}
    ${renderToneExtensions(state.draft, state.analysis, state.adjustmentCapabilities, isBusy())}
    ${range && state.draft.toneSegments?.some(item => item.id === range.id) ? '<button type="button" class="text-button" data-action="remove-tone-range">移除此段的单独调整</button>' : ''}
  </section>`;
}

function toneEntries() {
  return toneIntervalEntries(state.analysis, Number(state.asset?.duration));
}

function allToneRanges() {
  const entries = toneEntries();
  const ids = new Set(entries.map(item => item.id));
  return [...entries, ...(state.draft?.toneSegments ?? []).filter(item => !ids.has(item.id))
    .map(item => ({ ...item, label: '已确认区间', groupId: null,
      representativeSeconds: (item.startSeconds + item.endSeconds) / 2, suggestions: {} }))];
}

function activeToneRange() {
  return allToneRanges().find(item => item.id === state.activeToneRangeId) ?? null;
}

function toneGroupLabel(label) {
  return ({ shadows: '暗部细节', highlights: '高光层次', 'shadows+highlights': '明暗反差' })[label] ?? label;
}

function timeRangeLabel(range) {
  return `${frameTimeLabel(range.startSeconds)}–${frameTimeLabel(range.endSeconds)}`;
}

function renderToneTimeline() {
  if (state.stepIndex !== 1) return '';
  const confirmed = state.draft.toneSegments ?? [];
  const entries = allToneRanges().filter(item => confirmed.some(segment => segment.id === item.id)
    || !confirmed.some(segment => item.startSeconds < segment.endSeconds && item.endSeconds > segment.startSeconds))
    .sort((a, b) => Number(confirmed.some(segment => segment.id === b.id)) - Number(confirmed.some(segment => segment.id === a.id)))
    .slice(0, 12);
  if (!entries.length) return '';
  const duration = Number(state.asset.duration);
  return `<div class="tone-timeline" aria-label="明暗变化提示">${entries.map(item => {
    const accepted = state.draft.toneSegments?.some(segment => segment.id === item.id);
    return `<span class="tone-time-band ${accepted ? 'accepted' : ''}" style="left:${item.startSeconds / duration * 100}%;width:${(item.endSeconds - item.startSeconds) / duration * 100}%"></span>
      <button type="button" class="${accepted ? 'accepted' : ''} ${state.activeToneRangeId === item.id ? 'selected' : ''}" style="left:${Math.min(98, Math.max(2, item.representativeSeconds / duration * 100))}%" data-action="review-tone-range" data-range-id="${escapeHtml(item.id)}" aria-label="查看${escapeHtml(toneGroupLabel(item.label))} ${timeRangeLabel(item)}" title="${escapeHtml(toneGroupLabel(item.label))} ${timeRangeLabel(item)}" ${mutedAttribute(isBusy())}>●</button>`;
  }).join('')}</div><p class="timeline-legend">橙色为抽样建议，绿色为已确认区间；点击提示只定位代表帧。</p>`;
}

function renderToneReview() {
  const entries = toneEntries();
  const active = activeToneRange();
  const groups = [...new Set(entries.map(item => item.groupId))];
  const reviewingStoredRange = active && !active.groupId;
  const groupId = reviewingStoredRange ? null : active?.groupId ?? groups[0];
  const ranges = entries.filter(item => item.groupId === groupId);
  const current = active?.groupId ? active : ranges[0];
  const refined = state.analysis?.measurement?.refined === true;
  const eligible = ['rec709_display_relative', 'sdr_rec709_display_relative'].includes(state.analysis?.measurement?.domain);
  const accepted = state.draft.toneSegments ?? [];
  return `<div class="tone-review"><div class="tone-review-heading"><strong>${entries.length ? `明暗变化 · ${groups.length} 类` : analysisPending() ? '正在寻找明暗变化' : '明暗变化提示'}</strong>
    ${eligible && !refined ? `<button type="button" class="text-button" data-action="refine-tone" ${mutedAttribute(isBusy() || analysisPending())}>细化变化位置</button>` : ''}</div>
    <small>${state.analysis?.measurement ? `${state.analysis.measurement.sampled_frames} 帧${refined ? '细化' : '快速'}抽样，范围为近似提示，需预览确认。` : '先快速抽样，不等待整片处理。'}</small>
    ${groups.length ? `<div class="tone-group-buttons">${groups.map(id => { const group = entries.find(item => item.groupId === id); return `<button type="button" class="${id === groupId ? 'selected' : ''}" data-action="review-tone-range" data-range-id="${escapeHtml(group.id)}" ${mutedAttribute(isBusy())}>${escapeHtml(toneGroupLabel(group.label))} · ${entries.filter(item => item.groupId === id).length} 段</button>`; }).join('')}</div>
      <div class="tone-range-buttons">${ranges.map(item => `<button type="button" class="${item.id === state.activeToneRangeId ? 'selected' : ''}" data-action="review-tone-range" data-range-id="${escapeHtml(item.id)}" ${mutedAttribute(isBusy())}>${timeRangeLabel(item)}</button>`).join('')}</div>
      ${reviewingStoredRange ? `<p class="tone-proposal">正在复查已确认区间 ${timeRangeLabel(active)}。细化后的新建议不会覆盖它；可在下方手调，或点击上方类别查看新建议。</p>` : `<p class="tone-proposal">建议 ${[['shadows', '暗部'], ['highlights', '高光']].filter(([field]) => current?.suggestions[field] != null).map(([field, label]) => `${label} ${signed(current.suggestions[field])}`).join(' · ')}；尚未采纳的区间不会处理。</p>
      <div class="tone-accept-actions"><button type="button" data-action="accept-tone-range" data-range-id="${escapeHtml(current.id)}" ${mutedAttribute(isBusy())}>采纳本段并预览</button>${ranges.length > 1 ? `<button type="button" data-action="accept-tone-group" data-group-id="${escapeHtml(groupId)}" ${mutedAttribute(isBusy())}>统一采纳这类建议</button>` : ''}</div>`}`
      : state.analysis?.measurement && !analysisPending() ? '<p class="tone-proposal">抽样中未找到有把握的局部建议，可继续手调或细化检查；不代表每个位置都已检查。</p>' : ''}
    ${accepted.length ? `<details class="tone-plan-list"><summary>已确认 ${accepted.length} 个区间 · 查看方案</summary>${accepted.map(item => `<button type="button" data-action="review-tone-range" data-range-id="${escapeHtml(item.id)}">${timeRangeLabel(item)} · ${item.shadows === null ? '暗部继承' : `暗部 ${signed(item.shadows)}`} · ${item.highlights === null ? '高光继承' : `高光 ${signed(item.highlights)}`}</button>`).join('')}<button type="button" class="text-button" data-action="clear-tone-ranges">清除全部区间调整</button></details>` : ''}
  </div>`;
}

async function reviewToneRange(id) {
  if (isBusy()) return;
  const range = allToneRanges().find(item => item.id === id);
  if (!range) return;
  state.activeToneRangeId = id;
  state.toneScope = 'range';
  setStep(1);
  state.selectedTimeSeconds = previewTime(range.representativeSeconds, Number(state.asset.duration));
  state.frameInputPending = false;
  state.timeLocating = true;
  state.previewStatus = 'locating';
  state.previewView = 'after';
  state.liveToneActive = false;
  invalidateAiAdvice('已选择另一个明暗区间，请重新分析当前画面。');
  render();
  await startJob('preview', true);
}

async function acceptToneRanges(rangeId, groupId) {
  if (isBusy()) return;
  const entries = toneEntries();
  const targets = rangeId ? entries.filter(item => item.id === rangeId) : entries.filter(item => item.groupId === groupId);
  if (!targets.length) return;
  const proposed = rangeId ? targets.map(({ id, startSeconds, endSeconds, suggestions }) => ({ id, startSeconds, endSeconds, ...suggestions }))
    : toneRangesForGroup(entries, groupId);
  try {
    const plan = mergeToneRanges(state.draft.toneSegments, proposed, Number(state.asset.duration));
    state.activeToneRangeId = targets[0].id;
    state.toneScope = 'range';
    state.selectedTimeSeconds = previewTime(targets[0].representativeSeconds, Number(state.asset.duration));
    state.frameInputPending = false;
    await updateDraft({ toneSegments: plan });
  } catch { notify('此建议与已确认区间重叠，或区间数量超过 12。请先在方案中移除冲突区间。', 'error'); }
}

async function updateToneControl(field, value) {
  const range = state.toneScope === 'range' ? activeToneRange() : null;
  if (!range) return updateDraft({ [field]: value });
  const current = state.draft.toneSegments?.find(item => item.id === range.id)
    ?? { id: range.id, startSeconds: range.startSeconds, endSeconds: range.endSeconds, highlights: null, shadows: null };
  const changed = { ...current, [field]: value };
  if (changed.highlights === null && changed.shadows === null) {
    const remaining = state.draft.toneSegments?.filter(item => item.id !== range.id) ?? [];
    return updateDraft({ toneSegments: remaining.length ? remaining : null });
  }
  try {
    const plan = mergeToneRanges(state.draft.toneSegments, [changed], Number(state.asset.duration));
    return updateDraft({ toneSegments: plan });
  } catch { notify('此区间与已有调整重叠，请先检查已确认方案。', 'error'); return false; }
}

function renderSkin() {
  const on = zoneIsSet(state.draft, 'skin');
  const candidate = state.analysis?.skin_candidate;
  const ready = skinCandidateAvailable(state.analysis);
  const status = ready ? '抽样发现人物候选；是否微调由你决定'
    : analysisPending() ? '正在抽样分析人物；可先调整，预览时会检查所选画面'
      : candidate || state.analysisError ? '抽样未发现稳定人物，可拖到人物画面尝试；完整处理会再次检查'
        : '等待人物抽样分析；可先调整，预览时会检查所选画面';
  const values = skinValues(state.draft.skin);
  const controls = [
    ['amount', '色泽', '向左减弱，向右增强', -1, 1],
    ['brightness', '提亮', '轻轻提亮肤色', 0, 1],
    ['smoothness', '光滑', '柔化细小纹理', 0, 1],
  ];
  return `<section class="card" aria-labelledby="skin-heading"><div class="card-header"><div class="card-icon pink" aria-hidden="true">◔</div><div class="card-title"><span class="eyebrow">可选调整</span><h3 id="skin-heading">肤色</h3></div><span class="status-pill ${on ? 'active' : 'muted'}">${on ? '已设置' : '未使用'}</span></div>
    <p class="card-description">按需要调整色泽、提亮与光滑程度。松手后由引擎校准画面。</p>
    <div class="skin-status ${ready ? 'ready' : ''}"><span class="foot-dot" aria-hidden="true"></span><span>${status}</span></div>
    <button type="button" class="button effect-toggle ${on ? 'secondary' : 'primary'}" data-action="zone-switch" data-field="skin" aria-pressed="${on}" ${mutedAttribute(isBusy())}>${on ? '关闭肤色调整' : '启用肤色调整'}</button>
    ${!on ? '<p class="setup-hint">启用后可分别调整三项；初始强度均为 0。</p>' : ''}
    <div class="skin-controls">${controls.map(([field, title, hint, min, max]) => `<div class="slider-block ${on ? '' : 'is-off'}"><div class="slider-head"><div><strong>${title}</strong><small>${hint}</small></div><div class="slider-tools"><output data-skin-output="${field}">${on ? signed(values[field]) : '未设置'}</output></div></div>
      <input class="range-input" type="range" data-skin-field="${field}" min="${min}" max="${max}" step="0.01" value="${values[field]}" ${mutedAttribute(!on || isBusy())} aria-label="${title}"><div class="range-ends"><span>${field === 'amount' ? '−' : '0'}</span><span>+</span></div></div>`).join('')}</div>
    ${suggestionFor(state.analysis, 'skin') === null ? '' : `<div class="suggestion-row"><span>色泽建议 ${signed(suggestionFor(state.analysis, 'skin'))}</span><button type="button" class="text-button" data-action="suggest" data-field="skin" ${mutedAttribute(isBusy())}>应用建议 ↗</button></div>`}
  </section>`;
}

function renderColor() {
  const color = state.draft.color;
  const on = color !== null;
  const swatch = on ? hexFromHue(color.hue) : '#dedfd7';
  const pickBlockReason = pickColorBlockReason();
  return `<section class="card color-card" aria-labelledby="color-heading"><div class="card-header"><div class="card-icon green" aria-hidden="true">◉</div><div class="card-title"><span class="eyebrow">可选调整</span><h3 id="color-heading">局部颜色</h3></div><span class="status-pill ${on ? 'active' : 'muted'}">${on ? '已设置' : '未使用'}</span></div>
    <p class="card-description">${state.analysis?.color_advice?.available === true && state.analysis.color_advice.colors_diverse === true ? '画面颜色较丰富。建议先点选一种颜色，收窄范围后再微调。' : '选一种画面中的颜色，再决定影响范围和调整强度。'}</p>
    ${!on ? '<p class="setup-hint">先点击“选择颜色”或从画面点取，颜色范围、强度和高级色彩就会解锁。</p>' : ''}
    <div class="color-select"><span class="color-swatch" style="--swatch:${swatch}" aria-hidden="true"></span><span class="color-caption"><strong>${on ? '已选颜色' : '尚未选择颜色'}</strong><small>从画面点取，或手动选色</small></span>
      <label class="color-input-wrap" title="选择颜色后启用局部调整"><input type="color" id="manual-color" value="${on ? swatch : '#808080'}" aria-label="选择颜色" ${mutedAttribute(isBusy())}><span>${on ? '更换颜色' : '选择颜色'}</span></label></div>
    <button type="button" class="button color-pick-button" data-action="pick-color" ${mutedAttribute(isBusy() || pickBlockReason !== null)}>${state.pickColor ? '取消点取' : '从画面点取颜色'} <span aria-hidden="true">⌖</span></button>
    ${pickBlockReason ? `<p class="color-note">${escapeHtml(pickBlockReason)}</p>` : ''}
    ${renderSlider('range', '颜色范围', '决定附近的颜色是否一起调整', null, true)}
    ${renderSlider('amount', '调整强度', '向左减弱，向右增强', null, true)}
    <button type="button" class="advanced-link" data-action="advanced" ${mutedAttribute(!on || isBusy())}>${on ? '高级色彩' : '高级色彩（选色后可用）'} <span aria-hidden="true">↗</span></button>
    ${on ? `<button type="button" class="remove-color" data-action="remove-color" ${mutedAttribute(isBusy())}>移除局部颜色调整</button>` : ''}
  </section>`;
}

function renderJob() {
  if (!state.job) return '';
  const status = state.job.status || 'queued';
  if (state.previewQueued && ['cancelled', 'canceled'].includes(status)) return '';
  const finished = ['completed', 'succeeded', 'success'].includes(status);
  const failed = ['failed', 'cancelled', 'canceled'].includes(status);
  const label = state.jobType === 'render' ? '新视频' : state.jobType === 'playback' ? '播放片段' : '预览';
  const progress = progressPercent(state.job.progress);
  const errorText = state.job.error?.code === 'skin_subject_unavailable'
    ? state.jobType === 'preview'
      ? '所选画面未找到人物，请拖到有人物的位置重试；肤色调整不会应用到整个画面。'
      : state.jobType === 'playback' ? '这段预览中未能持续确认人物。可换一个位置，或关闭肤色调整后重试。'
        : '完整视频中未能持续确认人物。可返回肤色步骤调整或关闭后重试。'
    : state.job.error?.message || state.job.error || '请检查素材或稍后重试。';
  return `<div class="job-banner ${failed ? 'is-error' : finished ? 'is-done' : ''}" role="status">
    <span class="job-icon" aria-hidden="true">${failed ? '!' : finished ? '✓' : '↻'}</span><span><strong>${failed ? `${label}生成失败` : finished ? `${label}已完成` : `正在生成${label}`}</strong>
      <small>${failed ? escapeHtml(errorText) : finished ? '可以继续调整当前视频。' : progress === null ? '正在处理，请稍候…' : `${progress}%`}</small></span>
    ${!failed && !finished && progress !== null ? `<div class="progress-track"><span style="width:${progress}%"></span></div>` : ''}
    ${!failed && !finished && state.job.id ? '<button type="button" class="text-button" data-action="cancel-processing">取消处理</button>' : ''}
  </div>`;
}

function renderFinish() {
  const output = state.outputRef ? mediaUrl(base, state.outputRef) : null;
  const oldOutput = state.outputRevision !== null && state.outputRevision !== state.draft.revision;
  const saved = state.exportFile;
  return `<section class="finish-card" aria-labelledby="finish-heading"><div><span class="eyebrow">完成视频</span><h3 id="finish-heading">导出完整视频</h3><p>默认保存到原片文件夹的 Output 目录，也可更换位置。原片会保留。</p></div>
    <div class="export-destination"><span>保存文件夹</span><strong>${escapeHtml(state.exportDirectory || '尚未选择')}</strong>
      ${state.canPickDirectory ? `<button type="button" class="button output-link" data-action="pick-export-directory" ${mutedAttribute(state.exportActionPending)}>${state.exportActionPending ? '正在准备…' : '更换保存文件夹'}</button>` : '<label>输入本机文件夹路径<input id="export-directory" type="text" placeholder="/absolute/path" autocomplete="off"></label><button type="button" class="button output-link" data-action="set-export-directory">使用此文件夹</button>'}
      ${state.exportDirectory !== state.defaultExportDirectory ? '<button type="button" class="button output-link" data-action="default-export-directory">恢复默认 Output</button>' : ''}</div>
    ${state.exportHistoryError ? `<p class="export-warning" role="alert">${escapeHtml(state.exportHistoryError)}</p>` : ''}
    <div class="export-destination">${state.canChooseExportQuality ? `<label>导出方式<select id="export-quality" ${mutedAttribute(Boolean(state.jobKind))}><option value="preserve" ${state.exportQuality === 'preserve' ? 'selected' : ''}>细节优先（默认）</option><option value="balanced" ${state.exportQuality === 'balanced' ? 'selected' : ''}>快速有损</option></select></label>` : '<strong>细节优先（默认）</strong>'}
      <p>${state.exportQuality === 'preserve' ? '核验处理后的 10-bit 图像在编码前后全帧一致；文件可能比原片大，准备时间较长。' : '快速模式使用有损编码；检查暗部细线时请选细节优先。'}</p></div>
    <div class="finish-actions"><button type="button" class="button primary" data-action="render" ${mutedAttribute(isBusy() || state.jobKind || state.exportActionPending || !state.exportDirectory || !canProcess())}>${state.jobKind === 'render' ? '正在处理…' : '导出完整视频'} <span aria-hidden="true">→</span></button></div>
    ${output ? `<div class="export-result" role="region" aria-label="完整视频导出结果"><h4>${oldOutput ? '之前导出的视频' : '已导出的视频'}${saved ? ` · 方案 v${saved.revision}` : ''}</h4>${saved ? `<p>${escapeHtml(saved.lutLabel)} · ${escapeHtml(saved.qualityLabel)}</p>` : ''}
      <video id="export-video" data-ref="${escapeHtml(state.outputRef)}" controls playsinline preload="metadata" src="${escapeHtml(output)}" aria-label="完整导出视频"></video>
      ${saved ? `<p>${saved.savedToChosenDirectory ? '已保存到' : '已生成，当前保存在内部目录；可直接另存到 Output 或更换文件夹'}</p><textarea class="export-path" aria-label="导出视频保存路径" readonly rows="4">${escapeHtml(saved.path)}</textarea>
        ${saved.saveError ? `<p class="export-warning" role="alert">${escapeHtml(saved.saveError)}</p>` : ''}
        <div class="finish-actions">${saved.canOpen ? '<button type="button" class="button output-link" data-action="open-export-video">系统播放器打开</button><button type="button" class="button output-link" data-action="open-export-folder">打开文件夹</button>' : ''}
          <a class="button output-link" href="${escapeHtml(new URL(`api/download-export/${encodeURIComponent(saved.jobId)}`,base).href)}" download="${escapeHtml(saved.fileName)}">下载视频</a>
          <button type="button" class="button output-link" data-action="save-existing-export" ${mutedAttribute(!state.exportDirectory || state.exportActionPending)}>${state.exportActionPending ? '正在保存…' : '另存到所选文件夹'}</button></div>` : ''}
      ${state.exportHistory.length > 1 ? `<details class="export-history"><summary>其他已完成的导出（${state.exportHistory.length-1}）</summary>${state.exportHistory.filter(item=>item.jobId!==saved?.jobId).map(item=>`<button type="button" data-action="select-export" data-job-id="${escapeHtml(item.jobId)}">方案 v${item.revision} · ${escapeHtml(new Date(item.finishedAt).toLocaleString())}</button>`).join('')}</details>` : ''}
      <button type="button" class="button output-link" data-action="return-adjustments">继续调整 ↑</button></div>` : ''}</section>`;
}

function renderConfirm() {
  const draft = state.draft;
  const selectedLut = lutSelection(state.asset, draft);
  const items = [
    ['DJI 色彩还原', draft.lutEnabled ? `${selectedLut.look === 'vivid' ? '鲜艳 Vivid' : '普通 Standard'} · Size ${selectedLut.size}` : '跳过'],
    ['明暗', zoneIsSet(draft, 'highlights') || zoneIsSet(draft, 'shadows') || draft.toneSegments?.length
      || draft.lowLight != null || draft.denoise != null
      ? `高光 ${zoneIsSet(draft, 'highlights') ? signed(draft.highlights) : '未设置'} · 暗部 ${zoneIsSet(draft, 'shadows') ? signed(draft.shadows) : '未设置'}${draft.toneSegments?.length ? ` · ${draft.toneSegments.length} 个已确认区间` : ''}${draft.lowLight != null ? ` · 暗光增强（全片） ${Number(draft.lowLight).toFixed(2)}` : ''}${draft.denoise != null ? ` · 降噪（全片） ${Number(draft.denoise.amount).toFixed(2)}` : ''}` : '跳过'],
    ['肤色', zoneIsSet(draft, 'skin') ? (() => { const values = skinValues(draft.skin); return `色泽 ${signed(values.amount)} · 提亮 ${signed(values.brightness)} · 光滑 ${signed(values.smoothness)}`; })() : '跳过'],
    ['局部颜色', draft.color === null ? '跳过' : '已设置'],
  ];
  return `<section class="card confirm-card"><div class="card-header"><div class="card-icon green" aria-hidden="true">✓</div><div class="card-title"><span class="eyebrow">最后一步</span><h3>检查本次设置</h3></div></div>
    <p class="card-description">你可以逐一预览已确认的区间，或返回任一步修改。单帧预览只代表当前画面；确认后再导出完整视频。</p>
    <div class="confirm-list">${items.map(([name, value], index) => `<button type="button" data-action="go-step" data-step="${index}" ${mutedAttribute(isBusy() || !availableStep(index))}><span>${name}</span><strong>${escapeHtml(value)}</strong><span aria-hidden="true">↗</span></button>`).join('')}</div>
    ${skinHasEffect(draft.skin) && !skinCandidateAvailable(state.analysis)
      ? '<p class="setup-hint">人物抽样尚未确认稳定目标。完整处理会再次检查；若无法持续确认人物，会提示你调整。</p>' : ''}
    ${draft.toneSegments?.length ? `<details class="tone-plan-list"><summary>复查 ${draft.toneSegments.length} 个已确认区间</summary>${draft.toneSegments.map(item => `<button type="button" data-action="review-tone-range" data-range-id="${escapeHtml(item.id)}">查看 ${timeRangeLabel(item)} 的代表帧</button>`).join('')}</details>` : ''}
    ${renderFinish()}</section>`;
}

function renderCurrentCard() {
  switch (state.stepIndex) {
    case 0: return renderLut();
    case 1: return renderTone();
    case 2: return renderSkin();
    case 3: return renderColor();
    default: return renderConfirm();
  }
}

function renderWizardFooter() {
  const previous = adjacentStep(state.stepIndex, -1);
  const next = adjacentStep(state.stepIndex, 1);
  return `<nav class="wizard-footer" aria-label="调整步骤"><div class="wizard-steps">${steps.map((label, index) => availableStep(index) ? `<button type="button" data-action="go-step" data-step="${index}" class="${state.stepIndex === index ? 'is-current' : ''}" aria-current="${state.stepIndex === index ? 'step' : 'false'}" ${mutedAttribute(isBusy())}><span>${index + 1}</span>${label}</button>` : '').join('')}</div>
    <div class="wizard-nav"><button type="button" class="button secondary" data-action="previous-step" ${mutedAttribute(isBusy() || previous === state.stepIndex)}>上一步</button>
      ${state.stepIndex < 4 ? `<button type="button" class="button secondary skip-step" data-action="skip-step" ${mutedAttribute(isBusy())}>跳过此步</button><button type="button" class="button primary" data-action="next-step" ${mutedAttribute(isBusy() || next === state.stepIndex)}>下一步 →</button>` : `<span class="wizard-done">可返回任一步继续调整</span>`}</div></nav>`;
}

function renderAdvancedSlider(field, title, hint, min, max, step) {
  const value = state.draft.color[field];
  return `<div class="advanced-control"><div><label for="advanced-${field}">${title}</label><output data-advanced-output="${field}">${field === 'range' || field === 'hueShift' ? `${Math.round(value)}°` : signed(value)}</output></div>
    <input id="advanced-${field}" type="range" data-advanced-field="${field}" min="${min}" max="${max}" step="${step}" value="${value}" ${mutedAttribute(isBusy())}>
    <small>${hint}</small></div>`;
}

function renderAdvanced() {
  if (!state.advancedOpen || !state.draft?.color) return '';
  const color = state.draft.color;
  const original = hexFromHue(color.hue);
  const result = previewHexForColor(color);
  return `<div class="dialog-backdrop" data-action="close-advanced"><div class="dialog advanced-dialog" role="dialog" aria-modal="true" aria-labelledby="advanced-title"><button type="button" class="dialog-close" data-action="close-advanced" aria-label="关闭">×</button>
    <span class="eyebrow">局部颜色 / 高级色彩</span><h2 id="advanced-title">细调选中的颜色</h2><p>以刚选中的颜色为中心，调整它的色相、明度和饱和度。其他颜色受“颜色范围”控制。</p>
    <div class="color-compare"><div><span class="compare-swatch" style="--swatch:${original}"></span><small>选中颜色</small></div><span class="compare-arrow" aria-hidden="true">→</span><div><span class="compare-swatch" data-preview-swatch style="--swatch:${result}"></span><small>调整示意</small></div></div>
    <p class="compare-note">色块仅作方向示意；实际画面以更新预览为准。</p>
    <div class="advanced-controls">
      ${renderAdvancedSlider('hueShift', '色相偏移', '向左或向右移动选中颜色', -180, 180, 1)}
      ${renderAdvancedSlider('luminance', '明度', '让选中颜色更暗或更亮', -1, 1, 0.01)}
      ${renderAdvancedSlider('amount', '饱和强度', '减弱或增强颜色浓度', -1, 1, 0.01)}
      ${renderAdvancedSlider('range', '颜色范围', '只影响接近选中颜色的区域', 0, 180, 1)}
    </div>
    <div class="advanced-actions"><button type="button" class="reset-button" data-action="reset-advanced" ${mutedAttribute(isBusy())}>重置色相与明度</button><button type="button" class="button primary" data-action="advanced-preview" ${mutedAttribute(isBusy())}>更新画面预览 →</button></div>
  </div></div>`;
}

const aiScopeLabels = {
  tone: '明暗', skin: '肤色', 'local-color': '局部颜色',
};

function selectedAiModel() {
  return state.aiModels?.models[state.aiModelIndex] || null;
}

function aiCurrentContext() {
  return {
    assetId: selectedAssetId(), revision: state.draft?.revision,
    analysisKey: state.analysisKey, timeSeconds: state.selectedTimeSeconds,
    scope: aiScopeForStep(),
    previewRef: currentExactPreview() ? state.previewRef : null,
  };
}

function aiAdviceIsCurrent() {
  return Boolean(state.aiAdvice && aiContextMatches(state.aiTarget, state.aiContext,
    aiCurrentContext()));
}

function renderAiAdvice() {
  if (!state.aiAdvice) return '';
  if (!aiAdviceIsCurrent()) return '<p class="ai-stale">画面或参数已变化，请重新分析后再采纳建议。</p>';
  const recommendations = state.aiAdvice.recommendations;
  const sampleTimes = Array.isArray(state.aiContext.sampleTimes)
    ? state.aiContext.sampleTimes.filter(Number.isFinite) : [];
  const frameCount = Number.isInteger(state.aiContext.frameCount) && state.aiContext.frameCount > 0
    ? state.aiContext.frameCount : sampleTimes.length;
  const visualType = state.aiContext.visualBasis === 'current-adjustments'
    ? '当前调整画面' : '抽样画面';
  const visualBasis = state.aiContext.includedFrame
    ? `${frameCount ? `结合 ${frameCount} 帧` : '结合多处'}${visualType}${sampleTimes.length ? `（${sampleTimes.map(frameTimeLabel).join('、')}）` : ''}`
    : '仅抽样统计；所选时间不是独立测量结果';
  const totalTokens = state.aiJob?.result?.usage?.totalTokens;
  return `<section class="ai-result" aria-label="AI 分析结果">
    <h3>${escapeHtml(aiScopeLabels[state.aiContext.scope])}建议</h3><p class="ai-result-source">来自 ${escapeHtml(state.aiContext.provider)} / ${escapeHtml(state.aiContext.model)} · ${escapeHtml(visualBasis)}${Number.isSafeInteger(totalTokens) && totalTokens > 0 ? ` · 本次 ${totalTokens.toLocaleString()} tokens` : ''}</p><p class="ai-summary">${escapeHtml(state.aiAdvice.summary)}</p>
    ${state.aiAdvice.notes.map((note) => `<p class="ai-note">${escapeHtml(note)}</p>`).join('')}
    ${recommendations.length ? recommendations.map((item) => {
      const changeLines = describeAiChanges(item, state.draft);
      const canApply = changeLines.length > 0 && aiRecommendationCanApply(item,
        { includedFrame: state.aiContext.includedFrame });
      return `<article class="ai-recommendation"><span class="ai-recommendation-group">${escapeHtml(aiScopeLabels[item.group] || item.group || '建议')}</span>
        <strong>${escapeHtml(item.label || '调整建议')}</strong><p>${escapeHtml(item.reason || '')}</p>
        ${canApply ? `<div class="ai-change-preview">${changeLines.map((line) => `<span>${escapeHtml(line)}</span>`).join('')}</div>` : ''}
        ${canApply ? `<button type="button" class="button secondary" data-action="ai-apply" data-recommendation-id="${escapeHtml(item.id)}" ${mutedAttribute(isBusy() || state.aiApplyingId !== null || !aiAdviceIsCurrent())}>${state.aiApplyingId === item.id ? '正在采纳…' : '采纳此建议并预览'}</button>`
          : `<span class="ai-readonly">${changeLines.length ? '仅供参考，不会自动修改参数' : '当前设置已符合建议，或此项仅供参考'}</span>`}</article>`;
    }).join('') : '<p class="ai-note">这次分析没有给出具体调整建议。</p>'}
  </section>`;
}

function renderAiPanel() {
  if (state.stepIndex === 1 && state.toneScope === 'range') return '<section class="ai-panel"><strong>AI 明暗建议针对全片基础</strong><p class="ai-message">当前正在查看一个区间。可先预览并确认本段；切回“全片基础”后可按需分析。</p></section>';
  const scope = aiScopeForStep();
  if (!scope || !hasFeature(scope)) return '';
  const model = selectedAiModel();
  const running = state.aiJob && !jobFinished(state.aiJob.status);
  const canIncludeFrame = model?.vision === true;
  const frameReady = currentExactPreview();
  const statisticsReady = Boolean(state.analysis?.measurement);
  const canRequest = !state.aiModelsLoading && state.aiModels?.available && model && !running && !isBusy()
    && !state.aiApplyingId && (state.aiIncludeFrame ? canIncludeFrame && frameReady : statisticsReady);
  const progressLabel = state.aiJob?.phase === 'sampling' ? '正在抽取代表画面…'
    : state.aiJob?.phase === 'model' ? '模型正在分析本页…' : '正在准备分析…';
  return `<section class="ai-panel" aria-labelledby="ai-panel-heading"><div class="ai-panel-header"><div><span class="eyebrow">可选分析</span><h3 id="ai-panel-heading">AI 看${escapeHtml(aiScopeLabels[scope])}</h3></div>
    <button type="button" class="ai-panel-toggle" data-action="toggle-ai-panel" aria-expanded="${state.aiExpanded}" ${mutedAttribute(isBusy())}>${state.aiExpanded ? '收起' : running ? '查看分析进度' : state.aiAdvice ? '查看建议' : '获取建议'} <span aria-hidden="true">${state.aiExpanded ? '⌃' : '⌄'}</span></button></div>
    ${state.aiExpanded ? `<div class="ai-panel-content">
    ${state.aiModelsLoading ? '<p class="ai-message">正在读取已配置的模型…</p>' : ''}
    ${state.aiModelsError ? `<p class="ai-message is-error">读取模型失败：${escapeHtml(state.aiModelsError)}</p>` : ''}
    ${state.aiModels && !state.aiModels.available ? `<p class="ai-message is-error">${escapeHtml(state.aiModels.reason || 'Harness 中还没有可用模型。请先配置模型，再回来分析。')}</p>` : ''}
    ${state.aiModels?.available ? `<div class="ai-fields"><label>使用模型<select id="ai-model" ${mutedAttribute(Boolean(running))}>${state.aiModels.models.map((item, index) => `<option value="${index}" ${index === state.aiModelIndex ? 'selected' : ''}>${escapeHtml(item.name)} · ${escapeHtml(item.provider)} / ${escapeHtml(item.id)}</option>`).join('')}</select></label>
      </div><label class="ai-frame-option"><input id="ai-include-frame" type="checkbox" ${state.aiIncludeFrame ? 'checked' : ''} ${mutedAttribute(!canIncludeFrame || Boolean(running))}><span>发送当前及代表位置画面（单张拼图，最多 3 帧）</span></label>
      <p class="ai-disclosure">${state.aiIncludeFrame ? '一张多帧拼图、视频时长、还原状态与本页数据' : '视频时长、还原状态与本页数据，不含画面'}将发送给 <strong>${escapeHtml(model?.provider)} / ${escapeHtml(model?.id)}</strong>；可能在云端处理。${state.aiIncludeFrame && !frameReady ? '请先等待当前画面的精确预览。' : ''}</p>
      <details class="ai-extras"><summary>发送内容与补充要求</summary><p>仅包含视频时长、是否启用色彩还原、所选时间、本页参数、相关抽样参考和你填写的补充要求；不包含文件名、路径、相机或拍摄格式。抽样统计并非所选单帧的测量，建议不会自动应用。</p>
        <label>想重点看什么？<input id="ai-intent" type="text" maxlength="300" value="${escapeHtml(state.aiIntent)}" placeholder="可选，最多 300 字" ${mutedAttribute(Boolean(running))}></label>
        <p>${canIncludeFrame ? '模型声明支持图片；实际能力以服务返回为准。' : '当前模型仅声明文字输入；若要发送画面，请选择声明支持图片的模型。'}</p></details>` : ''}
    ${state.aiModels?.available && !state.aiIncludeFrame && !statisticsReady ? '<p class="ai-message">正在等待视频抽样统计。完成后即可仅发送统计分析；也可选择发送已校准的当前帧。</p>' : ''}
    ${state.aiError ? `<p class="ai-message is-error" role="alert">${escapeHtml(state.aiError)}</p>` : ''}
    ${state.aiStaleReason ? `<p class="ai-message">${escapeHtml(state.aiStaleReason)}</p>` : ''}
    ${running ? `<p class="ai-message" role="status">${progressLabel}${progressPercent(state.aiJob.progress) === null ? '' : ` ${progressPercent(state.aiJob.progress)}%`}</p>` : ''}
    <div class="ai-actions"><button type="button" class="button primary" data-action="ai-run" ${mutedAttribute(!canRequest)}>${state.aiIncludeFrame ? '多帧分析本项' : '仅统计分析'}</button>
      ${running && state.aiJob?.id ? `<button type="button" class="button secondary" data-action="ai-cancel" ${mutedAttribute(state.aiCancelPending)}>${state.aiCancelPending ? '正在取消…' : '取消分析'}</button>` : ''}</div>
    ${renderAiAdvice()}
    </div>` : ''}</section>`;
}

function renderWorkspace() {
  const missing = unavailableSettings();
  const input = inputColorState(state.asset, state.draft);
  if (!availableStep(state.stepIndex)) setStep(adjacentStep(state.stepIndex, 1));
  return `<main class="workspace wizard-workspace"><header class="topbar workspace-topbar"><span class="eyebrow">${escapeHtml(steps[state.stepIndex])} <span class="step-count">${state.stepIndex + 1} / 5</span></span><span class="topbar-label">${escapeHtml(state.asset.name || '当前视频')}</span>
    <div class="panel-tools" role="group" aria-label="显示面板">${state.outputRef ? '<button type="button" data-action="show-export-result">导出结果</button>' : ''}<button type="button" data-action="toggle-materials" aria-controls="media-sidebar" aria-expanded="${!state.materialsCollapsed}">${state.materialsCollapsed ? '展开素材' : '收起素材'}</button><button type="button" data-action="toggle-adjustments" aria-controls="adjustment-panel" aria-expanded="${!state.adjustmentsCollapsed}">${state.adjustmentsCollapsed ? '展开调整' : '收起调整'}</button></div></header>
    <div class="workspace-scroll wizard-scroll">
    ${state.environmentOpen || state.environment?.ready === false ? renderEnvironment() : ''}
    ${state.pending === 'select' ? `<div class="analysis-progress" role="status">正在切换至 ${escapeHtml(state.openingName)}…</div>` : ''}
    <div class="input-summary" aria-label="输入格式与还原状态"><span><strong>${escapeHtml(input.label)}</strong> · ${escapeHtml(input.status)}</span><span>${escapeHtml(input.restoreStatus)}</span>${state.stepIndex !== 0 && hasFeature('lut-batch') ? '<button type="button" data-action="go-step" data-step="0">查看还原</button>' : ''}</div>
    ${analysisPending() ? `<div class="analysis-progress" role="status"><span class="analysis-spinner" aria-hidden="true"></span><span>${state.analysisJob?.refined ? '正在细化变化位置，保留当前预览和已确认方案。' : '正在快速抽样，可先看当前帧；建议会在明暗步骤更新。'}</span></div>` : ''}
    ${state.analysisError ? `<div class="analysis-progress is-error" role="status"><span>画面分析未完成：${escapeHtml(state.analysisError)}</span><button type="button" data-action="retry-analysis" ${mutedAttribute(isBusy())}>重试分析</button></div>` : ''}
    ${missing.length ? `<div class="capability-notice">当前入口未加载已设置的${escapeHtml(missing.join('、'))}功能，请使用包含这些功能的入口继续处理。</div>` : ''}
    ${!state.features.length ? `<div class="capability-notice">当前没有加载可处理的视频功能。</div>` : ''}
    <div class="work-grid wizard-grid"><div class="work-left">${state.viewerExpanded ? '' : renderViewer()}</div><section id="adjustment-panel" class="work-right" aria-label="调整面板">${renderCurrentCard()}${renderAiPanel()}${renderJob()}<button type="button" class="finish-adjustment" data-action="hide-adjustments" ${mutedAttribute(isBusy())}>完成本项，收起调整</button></section></div>
    </div>${renderWizardFooter()}</main>`;
}

function syncPanelLayout() {
  const active = Boolean(state.asset && state.draft);
  document.body.classList.toggle('materials-collapsed', active && state.materialsCollapsed);
  document.body.classList.toggle('adjustments-collapsed', active && state.adjustmentsCollapsed);
  for (const [id, collapsed] of [['media-sidebar', active && state.materialsCollapsed], ['adjustment-panel', active && state.adjustmentsCollapsed]]) {
    const panel = document.getElementById(id);
    if (panel) { panel.hidden = collapsed; panel.inert = collapsed || state.viewerExpanded; }
  }
  for (const [action, collapsed, label] of [['toggle-materials', state.materialsCollapsed, '素材'], ['toggle-adjustments', state.adjustmentsCollapsed, '调整']]) {
    for (const button of document.querySelectorAll(`[data-action="${action}"]`)) {
      button.textContent = `${collapsed ? '展开' : '收起'}${label}`;
      button.setAttribute('aria-expanded', String(!collapsed));
    }
  }
}

function render() {
  document.body.classList.toggle('has-workspace', Boolean(state.asset && state.draft));
  const oldMedia = document.querySelector('#preview-media');
  const oldProxy = document.querySelector('#proxy-media');
  const oldExportVideo = document.querySelector('#export-video');
  const frameScroll = { left: document.querySelector('.viewer-frame')?.scrollLeft ?? 0, top: document.querySelector('.viewer-frame')?.scrollTop ?? 0 };
  const oldCanvas = document.querySelector('#live-preview-canvas');
  const workspaceScroll = document.querySelector('.workspace-scroll')?.scrollTop ?? 0;
  const assetScroll = document.querySelector('.asset-list')?.scrollTop ?? 0;
  const dialogScroll = document.querySelector('.dialog')?.scrollTop ?? 0;
  const formatOpen = document.querySelector('.capture-format-details')?.open ?? false;
  const lowLightOpen = document.querySelector('.low-light-details')?.open ?? false;
  const denoiseOpen = document.querySelector('.denoise-details')?.open ?? false;
  const aiExtrasOpen = document.querySelector('.ai-extras')?.open ?? false;
  app.innerHTML = `${renderSidebar()}${state.asset && state.draft ? renderWorkspace() : renderEmpty()}
    ${state.notice ? `<div class="toast ${state.notice.tone}" role="alert"><span>${escapeHtml(state.notice.message)}</span><button type="button" data-action="dismiss" aria-label="关闭提示">×</button></div>` : ''}
    ${state.viewerExpanded ? renderViewer() : ''}${renderAdvanced()}`;
  for (const panel of document.querySelectorAll('.sidebar, .asset-sidebar, main.workspace')) panel.inert = state.viewerExpanded;
  syncPanelLayout();
  const newMedia = document.querySelector('#preview-media');
  if (oldMedia && newMedia && oldMedia.tagName === newMedia.tagName
    && oldMedia.dataset.ref === newMedia.dataset.ref) newMedia.replaceWith(oldMedia);
  const newProxy = document.querySelector('#proxy-media');
  const newExportVideo = document.querySelector('#export-video');
  if (oldExportVideo && newExportVideo && oldExportVideo.dataset.ref === newExportVideo.dataset.ref) newExportVideo.replaceWith(oldExportVideo);
  if (oldProxy && newProxy && oldProxy.dataset.ref === newProxy.dataset.ref) {
    newProxy.replaceWith(oldProxy);
    oldProxy.classList.toggle('is-active', state.timeLocating && state.previewView !== 'before');
  }
  const newCanvas = document.querySelector('#live-preview-canvas');
  if (oldCanvas && newCanvas && state.liveToneActive) newCanvas.replaceWith(oldCanvas);
  if (document.querySelector('.workspace-scroll')) document.querySelector('.workspace-scroll').scrollTop = workspaceScroll;
  if (document.querySelector('.asset-list')) document.querySelector('.asset-list').scrollTop = assetScroll;
  if (document.querySelector('.dialog')) document.querySelector('.dialog').scrollTop = dialogScroll;
  if (formatOpen && document.querySelector('.capture-format-details')) document.querySelector('.capture-format-details').open = true;
  if (lowLightOpen && document.querySelector('.low-light-details')) document.querySelector('.low-light-details').open = true;
  if (denoiseOpen && document.querySelector('.denoise-details')) document.querySelector('.denoise-details').open = true;
  if (aiExtrasOpen && document.querySelector('.ai-extras')) document.querySelector('.ai-extras').open = true;
  const viewerFrame = document.querySelector('.viewer-frame');
  if (viewerFrame && state.viewerExpanded && state.viewerZoom) { viewerFrame.scrollLeft = frameScroll.left; viewerFrame.scrollTop = frameScroll.top; }
  attachMediaHandlers();
  seekProxyToSelected();
  scheduleLivePaint();
}

function renderUnlessDragging() {
  if (!state.toneInputPending && !state.frameInputPending) render();
}

function attachMediaHandlers() {
  const frame = document.querySelector('.viewer-frame.is-pixel-zoom');
  if (frame) frame.onpointerdown = event => {
    if (!['IMG','VIDEO'].includes(event.target.tagName) || event.button !== 0) return;
    if (event.target.tagName === 'VIDEO' && event.clientY > event.target.getBoundingClientRect().bottom-60) return;
    event.preventDefault();
    const origin = { x:event.clientX, y:event.clientY, left:frame.scrollLeft, top:frame.scrollTop };
    frame.setPointerCapture(event.pointerId);
    frame.onpointermove = move => {
      frame.scrollLeft = origin.left + origin.x - move.clientX;
      frame.scrollTop = origin.top + origin.y - move.clientY;
    };
    frame.onpointerup = frame.onpointercancel = () => { frame.onpointermove = null; };
  };
  const proxy = document.querySelector('#proxy-media');
  if (proxy && proxy.dataset.boundRef !== state.proxyRef) {
    proxy.dataset.boundRef = state.proxyRef;
    proxy.addEventListener('loadedmetadata', seekProxyToSelected);
    proxy.addEventListener('error', () => {
      if (proxy.dataset.ref !== state.proxyRef) return;
      state.proxyRef = null;
      state.timeLocating = false;
      render();
    }, { once: true });
  }
  const media = document.querySelector('#preview-media');
  if (!media) return;
  const ref = activeMediaRef();
  if (media.dataset.boundRef === ref) return;
  media.dataset.boundRef = ref;
  if (media.tagName === 'VIDEO') {
    if (ref === state.playbackRef) {
      const reflectPlayback = () => {
        if (!state.playbackVisible || state.playbackRef !== ref) return;
        state.playbackPaused = media.paused; state.playbackEnded = media.ended;
        const control = document.querySelector('[data-action="toggle-playback"]');
        if (control) control.textContent = media.ended ? '重播' : media.paused ? '继续播放' : '暂停';
      };
      for (const event of ['play','pause','ended']) media.addEventListener(event, reflectPlayback);
      const updatePosition = () => {
        if (!state.playbackVisible || state.playbackRef !== ref) return;
        state.selectedTimeSeconds = playbackFrameTime(state.playbackInfo, media.currentTime, Number(state.asset.duration))
          ?? previewTime(Math.min(state.playbackInfo.end_seconds, state.playbackInfo.start_seconds + media.currentTime), Number(state.asset.duration));
        const output = document.querySelector('#frame-time-output');
        if (output) output.textContent = frameTimeLabel(state.selectedTimeSeconds);
        const slider = document.querySelector('#frame-time');
        if (slider) slider.value = state.selectedTimeSeconds;
      };
      media.addEventListener('timeupdate', updatePosition);
      media.addEventListener('seeked', updatePosition);
      media.addEventListener('ended', updatePosition);
      media.addEventListener('loadedmetadata', () => {
        if (state.playbackRef !== ref || !state.playbackVisible) return;
        if (state.playbackInfo?.original) media.currentTime = state.playbackInfo.initial_time_seconds;
        void media.play().catch(reflectPlayback);
      }, { once: true });
    }
    media.addEventListener('error', () => {
      if (ref !== activeMediaRef()) return;
      state.mediaKinds.set(ref, 'invalid');
      render();
    }, { once: true });
  } else {
    media.addEventListener('error', () => {
      if (ref !== activeMediaRef()) return;
      state.mediaKinds.set(ref, 'video');
      render();
    }, { once: true });
  }
}

function seekProxyToSelected() {
  const media = document.querySelector('#proxy-media');
  if (!media || media.dataset.ref !== state.proxyRef
    || !Number.isFinite(state.selectedTimeSeconds)) return;
  if (media.readyState < 1) return;
  const duration = Number.isFinite(media.duration) ? media.duration : state.asset?.duration;
  const position = previewTime(state.selectedTimeSeconds, duration);
  if (position !== null && Math.abs(media.currentTime - position) > .015) media.currentTime = position;
}

function scheduleProxySeek() {
  if (seekDebounce) return;
  seekDebounce = requestAnimationFrame(() => {
    seekDebounce = 0;
    seekProxyToSelected();
  });
}

function loadImage(ref) {
  if (!ref) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('画面载入失败。'));
    image.src = mediaUrl(base, ref);
    if (image.complete && image.naturalWidth > 0) resolve(image);
  });
}

async function prepareBaseRenderer(ref, previewImage, expectedPreviewRef, toneDataRef, toneData) {
  state.baseRef = ref || null;
  state.baseImage = null;
  state.baseImageStatus = ref ? 'loading' : null;
  state.liveRenderer = null;
  if (!ref || !supportsLiveTone(state.previewModel)) return;
  try {
    const image = await loadImage(ref);
    let highPrecision = null;
    if (toneDataRef && toneData?.format === 'rgb48le') {
      const response = await fetch(mediaUrl(base, toneDataRef));
      if (!response.ok) throw new Error('高精度预览载入失败。');
      highPrecision = { ...toneData, buffer: await response.arrayBuffer() };
    }
    if (state.previewRef !== expectedPreviewRef || state.baseRef !== ref) return;
    state.baseImage = image;
    state.liveRenderer = new LiveToneRenderer(image, previewImage, 640, highPrecision);
    state.baseImageStatus = 'loaded';
  } catch {
    if (state.previewRef !== expectedPreviewRef) return;
    state.baseImageStatus = 'error';
  }
  render();
}

async function loadState() {
  try {
    const data = await requestJson(fetch, base, 'GET', 'state');
    state.assets = Array.isArray(data.assets) ? data.assets : [];
    state.features = normalizeFeatures(data.features);
    acceptAdjustmentCapabilities(data);
    state.directory = data.directory || '';
    state.canPickDirectory = data.canPickDirectory === true || nativeDirectoryPicker(window) !== null;
    if (Array.isArray(data.cameraOptions)) state.cameraOptions = data.cameraOptions;
    render();
    if (data.assetId || data.selectedAssetId) await selectAsset(String(data.assetId || data.selectedAssetId));
  } catch (error) { notify(`无法载入工作台：${errorMessage(error)}`, 'error'); }
}

function invalidateAiAdvice(reason) {
  cancelJobIfRunning(state.aiJob);
  ++aiSequence;
  state.aiReceipts.clear();
  state.aiJob = null;
  state.aiAdvice = null;
  state.aiContext = null;
  state.aiTarget = null;
  state.aiError = null;
  state.aiStaleReason = reason;
  state.aiApplyingId = null;
  state.aiCancelPending = false;
}

function resetAiRequestChoices() {
  state.aiIncludeFrame = false;
  state.aiIntent = '';
  state.aiExpanded = false;
}

async function openAiPanel() {
  if (!state.asset || !state.draft || !aiScopeForStep()) return;
  state.aiExpanded = true;
  state.aiModelsLoading = true;
  state.aiModelsError = null;
  const token = ++aiModelSequence;
  render();
  try {
    const data = await requestJson(fetch, base, 'GET', 'ai/models');
    if (token !== aiModelSequence) return;
    const models = normalizeAiModels(data);
    const previous = selectedAiModel();
    state.aiModels = models;
    const preferred = previous ? models.models.findIndex((item) => item.provider === previous.provider
      && item.id === previous.id) : -1;
    const defaultIndex = models.defaultModel ? models.models.findIndex((item) =>
      item.provider === models.defaultModel.provider && item.id === models.defaultModel.model) : -1;
    state.aiModelIndex = preferred >= 0 ? preferred : defaultIndex >= 0 ? defaultIndex : 0;
    if (!selectedAiModel()?.vision) state.aiIncludeFrame = false;
  } catch (error) {
    if (token !== aiModelSequence) return;
    state.aiModels = null;
    state.aiModelsError = errorMessage(error);
  } finally {
    if (token === aiModelSequence) { state.aiModelsLoading = false; render(); }
  }
}

async function pollAiJob(initial, target, token) {
  let job = initial;
  try {
    while (token === aiSequence) {
      if (!aiContextMatches(target, target, aiCurrentContext())) return;
      if (job.analysisKey && target.analysisKey && job.analysisKey !== target.analysisKey) {
        throw new Error('AI 分析对应的视频设置已变化。');
      }
      state.aiJob = job;
      if (jobFinished(job.status)) {
        if (['completed', 'succeeded', 'success'].includes(job.status)) {
          if (!job.result) {
            job = jobFrom(await requestJson(fetch, base, 'GET', `jobs/${encodeURIComponent(job.id)}`));
            if (!job.result) throw new Error('AI 分析完成，但没有返回建议。');
          }
          const result = parseAiAdviceResult(job.result);
          if (!aiContextMatches(target, result.context, aiCurrentContext())) return;
          state.aiJob = job;
          state.aiAdvice = result.advice;
          state.aiContext = result.context;
          state.aiReceipts.set(target.scope, { job, advice: result.advice,
            context: result.context, target });
          state.aiError = null;
        } else {
          state.aiError = job.error?.message || job.error ||
            (['cancelled', 'canceled'].includes(job.status) ? '分析已取消。' : 'AI 分析未完成，请重试。');
          restoreCachedAiReceipt();
        }
        renderUnlessDragging();
        return;
      }
      renderUnlessDragging();
      await new Promise((resolve) => setTimeout(resolve, 900));
      if (token !== aiSequence) return;
      job = jobFrom(await requestJson(fetch, base, 'GET', `jobs/${encodeURIComponent(job.id)}`));
    }
  } catch (error) {
    if (token !== aiSequence) return;
    state.aiJob = null;
    state.aiError = errorMessage(error);
    restoreCachedAiReceipt();
    renderUnlessDragging();
  }
}

async function runAiAdvice() {
  const scope = aiScopeForStep();
  if (!state.aiExpanded || !AI_SCOPES.includes(scope) || !hasFeature(scope)
    || !state.asset || !state.draft || isBusy()
    || (state.aiJob && !jobFinished(state.aiJob.status))) return;
  const model = selectedAiModel();
  if (state.aiModelsLoading || !state.aiModels?.available || !model) return;
  const includeFrame = state.aiIncludeFrame;
  if (!includeFrame && !state.analysis?.measurement) {
    state.aiError = '视频抽样统计尚未完成，请稍后重试。';
    render();
    return;
  }
  if (includeFrame && (!model.vision || !currentExactPreview())) {
    state.aiError = '请先等待当前画面的精确预览完成，再发送代表位置的缩略画面。';
    render();
    return;
  }
  const current = aiCurrentContext();
  const target = { ...current, previewRef: includeFrame ? current.previewRef : null,
    includedFrame: includeFrame, provider: model.provider, model: model.id };
  if (!Number.isFinite(target.timeSeconds) || !Number.isFinite(target.revision)) return;
  const token = ++aiSequence;
  state.aiTarget = target;
  state.aiJob = { status: 'queued', progress: null };
  state.aiAdvice = null;
  state.aiContext = null;
  state.aiError = null;
  state.aiStaleReason = null;
  render();
  try {
    const data = await requestJson(fetch, base, 'POST', 'ai/advice', {
      assetId: target.assetId, revision: target.revision,
      timeSeconds: target.timeSeconds, previewRef: target.previewRef,
      provider: target.provider, model: target.model,
      scope,
      intent: state.aiIntent.trim().slice(0, 300), includeFrame,
    });
    const job = jobFrom(data);
    if (token !== aiSequence || !aiContextMatches(target, target, aiCurrentContext())) {
      cancelJobIfRunning(job);
      return;
    }
    void pollAiJob(job, target, token);
  } catch (error) {
    if (token !== aiSequence) return;
    state.aiJob = null;
    state.aiError = errorMessage(error);
    restoreCachedAiReceipt();
    render();
  }
}

async function cancelAiAdvice() {
  const job = state.aiJob;
  if (!job?.id || jobFinished(job.status) || state.aiCancelPending) return;
  const token = aiSequence;
  let shouldRender = false;
  state.aiCancelPending = true;
  render();
  try {
    await requestJson(fetch, base, 'POST', `cancel/${encodeURIComponent(job.id)}`, {});
    if (token !== aiSequence || state.aiJob?.id !== job.id) return;
    if (jobFinished(state.aiJob.status)) {
      shouldRender = true;
      return;
    }
    ++aiSequence;
    state.aiJob = null;
    state.aiAdvice = null;
    state.aiContext = null;
    state.aiTarget = null;
    state.aiStaleReason = '分析已取消。';
    state.aiError = null;
    restoreCachedAiReceipt();
    shouldRender = true;
  } catch (error) {
    if (token === aiSequence && state.aiJob?.id === job.id) {
      if (jobFinished(state.aiJob.status)) {
        shouldRender = true;
        return;
      }
      state.aiError = `取消失败：${errorMessage(error)}`;
      shouldRender = true;
    }
  } finally {
    if (shouldRender) {
      state.aiCancelPending = false;
      render();
    }
  }
}

async function applyAiRecommendation(recommendationId) {
  if (isBusy() || !aiAdviceIsCurrent() || !state.aiJob?.id) return;
  const recommendation = state.aiAdvice.recommendations.find((item) => item.id === recommendationId);
  if (!aiRecommendationCanApply(recommendation,
    { includedFrame: state.aiContext.includedFrame })
    || describeAiChanges(recommendation, state.draft).length === 0) return;
  const target = state.aiTarget;
  state.aiApplyingId = recommendationId;
  state.aiError = null;
  state.pending = 'ai-apply';
  render();
  let applied = false;
  let conflict = false;
  try {
    const data = await requestJson(fetch, base, 'POST', 'ai/apply', {
      assetId: target.assetId, revision: target.revision, jobId: state.aiJob.id,
      recommendationId, timeSeconds: target.timeSeconds, previewRef: target.previewRef,
    });
    if (!data.draft) throw new Error('服务端没有返回更新后的参数。');
    state.draft = normalizeDraft(data.draft, Number(state.asset.duration));
    if (data.asset) {
      state.asset = data.asset;
      const index = state.assets.findIndex((item) => String(item.id) === target.assetId);
      if (index >= 0) state.assets[index] = data.asset;
    }
    state.previewStatus = 'stale';
    state.previewView = 'after';
    state.liveToneActive = false;
    invalidateAiAdvice('已采纳建议。若需更多建议，请重新分析当前画面。');
    state.notice = { message: '已采纳建议，正在更新画面预览。', tone: 'info' };
    applied = true;
  } catch (error) {
    state.aiError = `采纳失败：${errorMessage(error)}`;
    if (error.status === 409) {
      conflict = true;
      invalidateAiAdvice('参数已有新版本，请重新分析。');
    }
  } finally {
    state.pending = null;
    state.aiApplyingId = null;
    render();
  }
  if (applied) void startJob('preview', true);
  if (conflict) {
    await selectAsset(target.assetId, { refresh: true });
    notify('参数已有新版本，已重新载入。请重新分析后采纳建议。', 'error');
  }
}

function stopPlayback() {
  const wasVisible = state.playbackVisible;
  document.querySelector('#preview-media')?.pause?.();
  state.playbackVisible = false;
  state.playbackPaused = true; state.playbackEnded = false;
  // Swapping just the media keeps a slider's pointer interaction intact.
  if (wasVisible) {
    const ref = activeMediaRef();
    if (ref) {
      const image = document.createElement('img');
      image.id = 'preview-media'; image.className = 'preview-media';
      image.dataset.ref = ref; image.src = mediaUrl(base, ref); image.alt = '当前视频画面预览';
      document.querySelector('#preview-media')?.replaceWith(image);
    }
  }
  if (state.jobKind === 'playback') {
    cancelJobIfRunning(state.job);
    ++jobSequence;
    state.jobKind = null;
  }
}

async function startOriginalPlayback() {
  if (!state.asset || !state.draft || isBusy() || state.jobKind && state.jobKind !== 'preview') return;
  const current = document.querySelector('#preview-media');
  if (state.playbackVisible && state.playbackInfo?.original && current?.tagName === 'VIDEO') {
    if (current.ended) current.currentTime = 0;
    void current.play().catch(() => {}); return;
  }
  stopPlayback();
  if (state.jobKind === 'preview') {
    cancelJobIfRunning(state.job);
    state.jobKind = null; state.job = null; state.activePreviewTarget = null; state.previewQueued = false;
  }
  const assetId = selectedAssetId(), revision = state.draft.revision, token = ++jobSequence;
  state.pending = 'original-playback';
  render();
  try {
    const data = await requestJson(fetch, base, 'POST', 'original-playback', { assetId, revision, timeSeconds: state.selectedTimeSeconds ?? 0 });
    if (token !== jobSequence || selectedAssetId() !== assetId || state.draft.revision !== revision) return;
    state.playbackRef = data.videoRef; state.playbackInfo = data.playback;
    state.playbackRevision = revision; state.playbackVisible = true;
    state.playbackPaused = false; state.playbackEnded = false;
    state.liveToneActive = false; state.pickColor = false;
    state.mediaKinds.set(data.videoRef, 'video');
  } catch (error) { if (token === jobSequence) notify(errorMessage(error), 'error'); }
  finally {
    if (token === jobSequence && state.pending === 'original-playback') { state.pending = null; render(); }
  }
}

function clearPreview() {
  stopPlayback();
  state.playbackRef = null;
  state.playbackInfo = null;
  state.viewerExpanded = false;
  state.viewerZoom = 0;
  state.previewQuality = 'fast';
  state.sourcePreviewRef = null;
  state.previewRef = null;
  state.previewImage = null;
  state.samplePreviewRef = null;
  state.sampleImage = null;
  state.sampleImageStatus = null;
  state.baseRef = null;
  state.baseImage = null;
  state.baseImageStatus = null;
  state.liveRenderer = null;
  state.previewModel = null;
  state.previewRevision = null;
  state.previewRequestTime = null;
  state.previewTone = null;
  state.proxyRef = null;
  state.proxyJob = null;
  state.proxyError = null;
  state.selectedTimeSeconds = null;
  state.currentTime = null;
  state.liveToneActive = false;
  state.liveToneValues = null;
  state.timeLocating = false;
  state.previewStatus = 'empty';
  state.previewQueued = false;
  state.activePreviewTarget = null;
  state.toneInputPending = false;
  state.frameInputPending = false;
  state.job = null;
  state.jobKind = null;
  state.jobType = null;
  state.faceZoom = false;
}

async function pickDirectory() {
  if (isBusy() || !state.canPickDirectory) return;
  state.pending = 'picker';
  render();
  let stage = '选择';
  try {
    const bridge = nativeDirectoryPicker(window);
    let directory;
    if (bridge) {
      directory = directoryFromPickerResult(await bridge.pick());
      if (directory === null) return;
      stage = '授权';
      await requestJson(fetch, base, 'POST', 'grant-directory', { directory });
    } else {
      const data = await requestJson(fetch, base, 'POST', 'pick-directory', {});
      directory = directoryFromPickerResult(data.directory);
      if (directory === null) return;
    }
    state.pending = null;
    await scanDirectory(directory);
  } catch (error) {
    notify(`${stage === '授权' ? '所选文件夹授权' : '选择文件夹'}失败：${errorMessage(error)}。也可手动输入素材路径。`, 'error');
  }
  finally { state.pending = null; render(); }
}

function applyExportHistory(data, preferredJobId) {
  state.exportDirectory = data.directory || '';
  state.defaultExportDirectory = data.defaultDirectory || '';
  state.canChooseExportQuality = data.supportsExportQualityChoices === true;
  state.exportHistory = Array.isArray(data.exports) ? data.exports : [];
  state.exportFile = state.exportHistory.find(item=>item.jobId===preferredJobId) || state.exportHistory[0] || null;
  state.outputRef = state.exportFile?.videoRef || null;
  state.outputRevision = state.exportFile?.revision ?? null;
  state.exportHistoryError = null;
}

async function refreshExportHistory(assetId, preferredJobId) {
  try {
    const data = await requestJson(fetch, base, 'GET', `exports/${encodeURIComponent(assetId)}`);
    // Older running Hosts can already recover results but omit this label.
    // Read the frozen job rather than infer it from the current draft.
    await Promise.all((data.exports || []).filter(item=>!item.lutLabel || !item.qualityLabel).map(async item=>{
      try {
        const {job} = await requestJson(fetch, base, 'GET', `jobs/${encodeURIComponent(item.jobId)}`);
        const lut = job.result?.lut;
        item.lutLabel = lut ? `${lut.look === 'vivid' ? 'Vivid' : 'Standard'} · Size ${lut.grid || '—'}` : '未应用 LUT';
        item.qualityLabel = job.result?.readback?.encoding_pixel_check?.all_frames_bit_exact ? '细节优先 · 全帧编码校验一致' : '有损编码 · 不用于细线保真验收';
      } catch { item.lutLabel = '还原风格记录暂不可用'; }
    }));
    if (selectedAssetId() === assetId) applyExportHistory(data, preferredJobId);
    return data;
  } catch (error) {
    if (selectedAssetId() === assetId) state.exportHistoryError = `无法读取导出位置：${errorMessage(error)}`;
    return null;
  }
}

async function chooseExportDirectory(manual = false) {
  if (state.exportActionPending) return;
  state.exportActionPending = true;
  const entered = document.querySelector('#export-directory')?.value;
  render();
  try {
    let directory;
    if (manual) directory = entered?.trim();
    else {
      const bridge = nativeDirectoryPicker(window);
      if (bridge) directory = directoryFromPickerResult(await bridge.pick());
      else {
        const data = await requestJson(fetch, base, 'POST', 'pick-export-directory', {});
        directory = directoryFromPickerResult(data.directory);
      }
    }
    if (directory == null) return;
    const data = await requestJson(fetch, base, 'POST', 'export-directory', { directory });
    state.exportDirectory = data.directory;
  } catch (error) { notify(`选择保存文件夹失败：${errorMessage(error)}`, 'error'); }
  finally { state.exportActionPending = false; render(); }
}

async function saveExistingExport() {
  if (state.exportActionPending || !state.exportFile || !state.exportDirectory) return;
  const assetId = selectedAssetId(), jobId = state.exportFile.jobId;
  state.exportActionPending = true; render();
  try {
    await requestJson(fetch, base, 'POST', 'save-export', { jobId, directory: state.exportDirectory });
    await refreshExportHistory(assetId, jobId);
  } catch (error) { notify(`另存视频失败：${errorMessage(error)}`, 'error'); }
  finally { state.exportActionPending = false; render(); }
}

async function openExport(target) {
  if (!state.exportFile) return;
  try { await requestJson(fetch, base, 'POST', 'open-export', { jobId: state.exportFile.jobId, target }); }
  catch (error) { notify(`打开失败：${errorMessage(error)}。可复制上方完整路径。`, 'error'); }
}

async function scanDirectory(directory) {
  if (isBusy()) return;
  if (!directory.trim()) return notify('请先输入素材文件夹路径。', 'error');
  state.directory = directory.trim();
  state.pending = 'scan';
  state.notice = null;
  render();
  try {
    const data = await requestJson(fetch, base, 'POST', 'scan', { directory: state.directory });
    if (!Array.isArray(data.assets)) throw new Error('扫描结果缺少视频列表。');
    cancelJobIfRunning(state.jobKind === 'preview' ? state.job : null);
    cancelJobIfRunning(state.analysisJob);
    cancelJobIfRunning(state.proxyJob);
    ++jobSequence;
    ++analysisSequence;
    ++proxySequence;
    ++state.inputEpoch;
    invalidateAiAdvice('已更换素材文件夹，请重新分析所选视频。');
    resetAiRequestChoices();
    state.asset = null;
    state.draft = null;
    state.analysis = null;
    state.analysisKey = null;
    state.analysisJob = null;
    state.analysisError = null;
    clearPreview();
    state.previewView = 'after';
    state.outputRef = null;
    state.exportFile = null; state.exportHistory = [];
    state.assets = data.assets;
    state.features = normalizeFeatures(data.features);
    acceptAdjustmentCapabilities(data);
    if (Array.isArray(data.cameraOptions)) state.cameraOptions = data.cameraOptions;
    notify(data.assets.length ? `找到 ${data.assets.length} 个视频。请选择一段开始。` : '这个文件夹中没有找到可用视频。');
  } catch (error) { notify(`扫描失败：${errorMessage(error)}`, 'error'); }
  finally { state.pending = null; render(); }
}

async function selectAsset(assetId, options = {}) {
  if (isBusy() && state.pending !== 'select' && !options.refresh) return;
  if (!options.refresh && state.pending !== 'select' && assetId === selectedAssetId()) return;
  selectionController?.abort();
  const controller = selectionController = new AbortController();
  if (assetId !== selectedAssetId()) resetAiRequestChoices();
  invalidateAiAdvice(options.refresh ? '拍摄设置或参数已更新，请重新分析。' : '已更换视频，请重新分析当前画面。');
  const sequence = ++requestSequence;
  const analysisToken = ++analysisSequence;
  const previousAnalysisKey = state.analysisKey;
  const previousAnalysisJob = state.analysisJob;
  const previousProxyJob = state.proxyJob;
  if (!options.refresh) {
    state.activeToneRangeId = null;
    state.toneScope = 'global';
    cancelJobIfRunning(state.jobKind === 'preview' ? state.job : null);
    cancelJobIfRunning(previousAnalysisJob);
    cancelJobIfRunning(previousProxyJob);
  }
  if (!options.refresh) ++proxySequence;
  if (!options.refresh) ++state.inputEpoch;
  if (!options.refresh) ++jobSequence;
  state.pending = 'select';
  state.openingAssetId = assetId;
  state.openingName = state.assets.find((item) => String(item.id) === assetId)?.name || '正在打开视频';
  state.analysisJob = null;
  state.analysisError = null;
  if (!options.refresh) {
    state.analysis = null;
    state.analysisKey = null;
    clearPreview();
    state.previewView = 'after';
    state.outputRef = null;
    state.exportFile = null; state.exportHistory = [];
    state.job = null;
    state.pickColor = false;
  }
  render();
  let selected = false;
  let analysisTicket = null;
  try {
    const data = await requestJson(fetch, base, 'POST', 'select', { assetId,
      ...(options.refine ? { refineAnalysis: true } : {}) }, { signal: controller.signal });
    if (sequence !== requestSequence) return;
    if (!data.asset || !data.draft) throw new Error('服务端没有返回视频和参数。');
    state.asset = data.asset;
    state.draft = normalizeDraft(data.draft, Number(data.asset.duration));
    const exports = await refreshExportHistory(assetId);
    if (sequence !== requestSequence) return;
    state.analysis = data.analysis || null;
    state.analysisKey = data.analysisKey || data.analysisJob?.analysisKey || null;
    if (options.refresh && previousAnalysisKey !== state.analysisKey) {
      ++state.inputEpoch;
      cancelJobIfRunning(previousAnalysisJob);
      cancelJobIfRunning(previousProxyJob);
      ++proxySequence;
      state.proxyRef = null;
      state.proxyJob = null;
      state.proxyError = null;
      }
    state.analysisJob = data.analysisJob ? jobFrom({ job: data.analysisJob }) : null;
    if (state.analysisJob) analysisTicket = {
      assetId, revision: state.draft.revision, analysisKey: state.analysisKey,
      sourceSha256: state.asset.sha256,
    };
    state.features = normalizeFeatures(data.features);
    acceptAdjustmentCapabilities(data);
    if (Array.isArray(data.cameraOptions)) state.cameraOptions = data.cameraOptions;
    state.sourcePreviewRef = data.previewRef || (options.refresh ? state.sourcePreviewRef : null);
    if (!options.refresh) {
      state.selectedTimeSeconds = previewTime(Number(data.asset.duration) / 2, Number(data.asset.duration));
      state.stepIndex = 0;
    } else if (!options.refine) {
      state.selectedTimeSeconds = previewTime(state.selectedTimeSeconds ?? Number(data.asset.duration) / 2, Number(data.asset.duration));
      state.liveToneActive = false;
      state.liveRenderer = null;
      state.baseRef = null;
      state.previewStatus = 'stale';
    }
    const index = state.assets.findIndex((item) => String(item.id) === assetId);
    if (index !== -1) state.assets[index] = data.asset;
    else state.assets.unshift(data.asset);
    state.notice = null;
    selected = true;
    if (exports?.activeJob && !options.refresh) {
      const running = exports.activeJob, token = ++jobSequence;
      state.job = running; state.jobKind = 'render'; state.jobType = 'render';
      state.stepIndex = 4; state.adjustmentsCollapsed = false;
      void pollJob(running.id, 'render', running.revision, null, assetId, token).catch(error=>notify(errorMessage(error),'error'));
    }
  } catch (error) {
    if (sequence === requestSequence && error.name !== 'AbortError') notify(`打开视频失败：${errorMessage(error)}`, 'error');
  }
  finally {
    if (sequence === requestSequence) {
      state.pending = null;
      state.openingName = null;
      state.openingAssetId = null;
      selectionController = null;
      render();
      if (selected && state.asset && state.draft) {
        if (analysisTicket && analysisJobNeedsPolling(state.analysisJob, state.analysis,
          analysisTicket, state.asset, state.draft, state.analysisKey)) {
          void pollAnalysisJob(state.analysisJob, analysisTicket, analysisToken);
        }
        if (!options.refine) void startJob('preview', true);
      }
    }
  }
}

async function updateDraft(changes, refreshAsset = false) {
  stopPlayback();
  if (isBusy() || !state.draft || !state.asset) return false;
  const assetId = selectedAssetId();
  const oldDraft = state.draft;
  const oldRevision = oldDraft.revision;
  const oldPreviewStatus = state.previewStatus;
  const oldLiveToneActive = state.liveToneActive;
  const oldLiveToneValues = state.liveToneValues;
  const oldPreviewView = state.previewView;
  const oldBase = { ref: state.baseRef, image: state.baseImage,
    status: state.baseImageStatus, renderer: state.liveRenderer };
  const oldProxyRef = state.proxyRef;
  const oldTimeLocating = state.timeLocating;
  const oldPickColor = state.pickColor;
  const oldAnalysis = state.analysis;
  if (refreshAsset) state.inputChangePending = true;
  state.draft = { ...oldDraft, ...changes };
  if ('denoise' in changes) {
    state.toneInputPending = false;
    state.liveToneValues = null;
    state.liveToneActive = false;
    state.baseRef = null;
    state.baseImage = null;
    state.baseImageStatus = null;
    state.liveRenderer = null;
  } else if ('highlights' in changes || 'shadows' in changes || 'lowLight' in changes) {
    state.toneInputPending = false;
    state.liveToneValues = { shadows: state.draft.shadows ?? 0,
      highlights: state.draft.highlights ?? 0, lowLight: state.draft.lowLight ?? 0 };
    state.liveToneActive = hasCurrentBase();
  } else if ('toneSegments' in changes) {
    state.toneInputPending = false;
    state.liveToneValues = { shadows: state.draft.shadows ?? 0,
      highlights: state.draft.highlights ?? 0, lowLight: state.draft.lowLight ?? 0 };
    state.liveToneActive = false;
  }
  state.previewView = 'after';
  state.pickColor = false;
  state.previewStatus = state.liveToneActive && hasCurrentBase() ? 'approx' : 'stale';
  if (refreshAsset) {
    state.analysis = null;
    state.liveToneActive = false;
    state.liveRenderer = null;
    state.baseRef = null;
    state.proxyRef = null;
    state.timeLocating = false;
  }
  state.pending = 'patch';
  state.notice = null;
  app.setAttribute('aria-busy', 'true');
  try {
    const data = await requestJson(fetch, base, 'PATCH', 'draft', patchBody(assetId, oldDraft, changes));
    state.draft = normalizeDraft(data.draft || data, Number(state.asset.duration));
    if (state.draft.revision === oldRevision && Object.keys(changes).length) {
      throw new Error('服务端未更新参数版本。');
    }
    invalidateAiAdvice('调整已改变，请重新分析当前画面。');
    if (refreshAsset) {
      state.analysis = null;
      ++state.inputEpoch;
    }
    if (data.asset) {
      state.asset = data.asset;
      const index = state.assets.findIndex((item) => String(item.id) === assetId);
      if (index !== -1) state.assets[index] = data.asset;
    }
  } catch (error) {
    state.draft = oldDraft;
    state.previewStatus = oldPreviewStatus;
    state.liveToneActive = oldLiveToneActive;
    state.liveToneValues = oldLiveToneValues;
    state.previewView = oldPreviewView;
    state.baseRef = oldBase.ref;
    state.baseImage = oldBase.image;
    state.baseImageStatus = oldBase.status;
    state.liveRenderer = oldBase.renderer;
    state.proxyRef = oldProxyRef;
    state.timeLocating = oldTimeLocating;
    state.pickColor = oldPickColor;
    state.analysis = oldAnalysis;
    if (error.status === 409) {
      state.pending = null;
      await selectAsset(assetId, { refresh: true });
      notify('参数已有新版本，已重新载入。请再做一次调整。', 'error');
    } else notify(`保存调整失败：${errorMessage(error)}`, 'error');
    return false;
  } finally {
    state.pending = null;
    state.inputChangePending = false;
    app.removeAttribute('aria-busy');
    render();
  }
  if (refreshAsset) await selectAsset(assetId, { refresh: true });
  else void startJob('preview', true);
  return true;
}

function jobFrom(data) {
  const job = data.job || data;
  if (!job || !job.id || !job.status) throw new Error('服务端没有返回任务状态。');
  return job;
}

function jobFinished(status) {
  return ['completed', 'succeeded', 'success', 'failed', 'cancelled', 'canceled'].includes(status);
}

function acceptAnalysis(result, refreshedAsset = null) {
  state.analysis = result;
  state.analysisError = null;
  if (refreshedAsset) state.asset = refreshedAsset;
  else if (result.profile || result.lut) state.asset = {
    ...state.asset,
    ...(result.profile ? { profile: result.profile } : {}),
    ...(result.lut ? { lut: result.lut } : {}),
    ...(result.lut_options ? { lut_options: result.lut_options } : {}),
  };
  const index = state.assets.findIndex((item) => String(item.id) === selectedAssetId());
  if (index !== -1) state.assets[index] = state.asset;
  if (!activeToneRange()) { state.activeToneRangeId = null; state.toneScope = 'global'; }
}

async function pollAnalysisJob(initial, target, token) {
  let job = initial;
  let fetchedTerminalDetails = false;
  try {
    while (token === analysisSequence) {
      if (selectedAssetId() !== target.assetId) return;
      if (job.analysisKey && target.analysisKey && job.analysisKey !== target.analysisKey) {
        throw new Error('画面分析任务与当前拍摄设置不一致。');
      }
      const statusChanged = state.analysisJob?.status !== job.status
        || state.analysisJob?.progress !== job.progress;
      state.analysisJob = job;
      if (jobFinished(job.status)) {
        if (!fetchedTerminalDetails
          && (['completed', 'succeeded', 'success'].includes(job.status)
            ? !job.result?.measurement : !job.error)) {
          fetchedTerminalDetails = true;
          job = jobFrom(await requestJson(fetch, base, 'GET',
            `jobs/${encodeURIComponent(job.id)}`));
          continue;
        }
        if (state.inputChangePending) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          continue;
        }
        if (['completed', 'succeeded', 'success'].includes(job.status)) {
          if (!job.result || job.result.action !== 'analyze' || !job.result.measurement) {
            throw new Error('画面分析完成，但没有返回有效结果。');
          }
          if (analysisMatchesSelection(target, state.asset, state.draft,
            state.analysisKey, job.result)) {
            acceptAnalysis(job.result);
          } else {
            // A tone edit may advance the draft while the same input analysis is running.
            // Re-read the persisted result rather than applying an obsolete job directly.
            const data = await requestJson(fetch, base, 'GET', 'state');
            if (token !== analysisSequence || selectedAssetId() !== target.assetId) return;
            if (analysisMatchesSelection({ assetId: target.assetId,
              revision: data.draft?.revision, analysisKey: data.analysisKey,
              sourceSha256: target.sourceSha256 }, state.asset, state.draft,
            state.analysisKey, data.analysis)) acceptAnalysis(data.analysis, data.asset);
            else state.analysisError = '设置已变化，请重试分析。';
          }
        } else {
          state.analysisError = job.error?.message || job.error || '请稍后重试。';
        }
        renderUnlessDragging();
        return;
      }
      if (statusChanged) renderUnlessDragging();
      await new Promise((resolve) => setTimeout(resolve, 900));
      if (token !== analysisSequence) return;
      job = jobFrom(await requestJson(fetch, base, 'GET', `jobs/${encodeURIComponent(job.id)}`));
    }
  } catch (error) {
    if (token !== analysisSequence || selectedAssetId() !== target.assetId) return;
    state.analysisError = errorMessage(error);
    state.analysisJob = null;
    renderUnlessDragging();
  }
}

async function startProxyJob(force = false) {
  if (!state.asset || !state.draft || state.proxyRef || isBusy()) return;
  if (!force && (state.proxyJob || state.proxyError)) return;
  const target = { assetId: selectedAssetId(), sourceSha256: state.asset.sha256,
    analysisKey: state.analysisKey, revision: state.draft.revision,
    inputEpoch: state.inputEpoch };
  const token = ++proxySequence;
  state.proxyJob = { status: 'queued', progress: null };
  state.proxyError = null;
  renderUnlessDragging();
  const current = (result = {}) => token === proxySequence
    && target.inputEpoch === state.inputEpoch
    && analysisMatchesSelection(target, state.asset, state.draft, state.analysisKey, result);
  try {
    const data = await requestJson(fetch, base, 'POST', 'proxy',
      jobBody(target.assetId, state.draft));
    let job = jobFrom(data);
    if (!current()) {
      cancelJobIfRunning(job);
      return;
    }
    while (current()) {
      if (job.analysisKey && target.analysisKey && job.analysisKey !== target.analysisKey) {
        throw new Error('视频时间条任务与当前拍摄设置不一致。');
      }
      const statusChanged = state.proxyJob?.status !== job.status
        || state.proxyJob?.progress !== job.progress;
      state.proxyJob = job;
      if (jobFinished(job.status)) {
        if (state.inputChangePending) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          continue;
        }
        if (['completed', 'succeeded', 'success'].includes(job.status)) {
          if (!job.result?.proxyRef) throw new Error('视频时间条完成，但没有返回画面。');
          if (current(job.result)) {
            state.proxyRef = job.result.proxyRef;
            state.mediaKinds.set(job.result.proxyRef, 'video');
            state.proxyError = null;
          }
        } else state.proxyError = job.error?.message || '视频时间条暂不可用。';
        renderUnlessDragging();
        return;
      }
      if (statusChanged) renderUnlessDragging();
      await new Promise((resolve) => setTimeout(resolve, 900));
      if (!current()) return;
      job = jobFrom(await requestJson(fetch, base, 'GET',
        `jobs/${encodeURIComponent(job.id)}`));
    }
  } catch (error) {
    if (!current()) return;
    state.proxyJob = null;
    state.proxyError = errorMessage(error);
    renderUnlessDragging();
  }
}

async function receiveJob(job, kind, revision, timeSeconds, assetId, token) {
  if (token !== jobSequence) return;
  if (kind === 'preview' && state.previewQueued) cancelJobIfRunning(job);
  const statusChanged = state.job?.status !== job.status || state.job?.progress !== job.progress;
  state.job = job;
  state.jobType = kind;
  state.jobKind = jobFinished(job.status) ? null : kind;
  if (['completed', 'succeeded', 'success'].includes(job.status)) {
    const result = job.result || {};
    if (kind === 'preview') {
      if (!result.previewRef) throw new Error('预览完成，但没有返回画面。');
      if (!state.toneInputPending && !state.frameInputPending && !state.previewQueued
        && !['patch', 'select', 'scan'].includes(state.pending)
        && state.draft?.revision === revision
        && state.selectedTimeSeconds === timeSeconds
        && selectedAssetId() === assetId) {
        const image = await loadImage(result.previewRef);
        if (token !== jobSequence || state.toneInputPending || state.frameInputPending
          || state.previewQueued
          || ['patch', 'select', 'scan'].includes(state.pending)
          || state.draft?.revision !== revision
          || state.selectedTimeSeconds !== timeSeconds
          || selectedAssetId() !== assetId) return;
        state.previewRef = result.previewRef;
        state.previewImage = image;
        state.previewRevision = revision;
        state.previewRequestTime = timeSeconds;
        state.currentTime = Number.isFinite(result.currentTime) ? result.currentTime : timeSeconds;
        state.previewModel = result.previewModel || null;
        state.previewQuality = result.readback?.quality || 'fast';
        if (result.input_profile) state.asset = { ...state.asset, profile: result.input_profile };
        if (result.lut) state.asset = { ...state.asset, lut: result.lut };
        state.previewTone = { shadows: state.draft.shadows ?? 0,
          highlights: state.draft.highlights ?? 0,
          lowLight: result.previewModel?.tone?.low_light ?? 0 };
        state.previewHadOtherEffects = skinHasEffect(state.draft.skin)
          || colorHasEffect(state.draft.color) || state.draft.denoise != null;
        state.previewStatus = 'exact';
        state.liveToneActive = false;
        state.liveToneValues = null;
        state.timeLocating = false;
        if (result.proxyRef) state.proxyRef = result.proxyRef;
        if (result.beforeRef) state.sourcePreviewRef = result.beforeRef;
        setSamplePreview(result.sampleRef);
        state.mediaKinds.set(result.previewRef, 'image');
        if (result.beforeRef) state.mediaKinds.set(result.beforeRef, 'image');
        void prepareBaseRenderer(result.baseRef, image, result.previewRef, result.toneDataRef, result.tone_data);
      }
    } else if (kind === 'playback') {
      if (!result.videoRef || !result.playback) throw new Error('播放片段未能生成。');
      if (state.draft?.revision === revision && selectedAssetId() === assetId && !state.frameInputPending) {
        state.playbackRef = result.videoRef;
        state.playbackInfo = result.playback;
        state.playbackRevision = revision;
        state.playbackVisible = true;
        state.playbackPaused = false; state.playbackEnded = false;
        state.liveToneActive = false;
        state.pickColor = false;
        state.mediaKinds.set(result.videoRef, 'video');
      }
    } else {
      if (!result.videoRef) throw new Error('处理完成，但没有返回新视频。');
      state.outputRef = result.videoRef;
      state.outputRevision = revision;
      await refreshExportHistory(assetId, job.id);
      if (token !== jobSequence) return;
      state.stepIndex = 4; state.adjustmentsCollapsed = false; state.viewerExpanded = false;
    }
  }
  if (statusChanged || jobFinished(job.status)) {
    renderUnlessDragging();
    if (kind === 'render' && ['completed','succeeded','success'].includes(job.status)) document.querySelector('.export-result')?.scrollIntoView({block:'center'});
  }
}

async function startJob(kind, automatic = false) {
  if (!state.asset || !state.draft) return;
  const nextTarget = kind === 'preview' ? { assetId: selectedAssetId(),
    revision: state.draft.revision, timeSeconds: state.selectedTimeSeconds, quality: state.viewerExpanded ? 'detail' : 'fast' } : null;
  if (kind === 'preview' && state.jobKind === 'preview'
    && !isBusy() && state.activePreviewTarget?.assetId === nextTarget.assetId
    && state.activePreviewTarget?.revision === nextTarget.revision
    && state.activePreviewTarget?.timeSeconds === nextTarget.timeSeconds
    && state.activePreviewTarget?.quality === nextTarget.quality) return;
  if (kind === 'preview' && (state.jobKind === 'preview' || isBusy())) {
    state.previewQueued = true;
    cancelJobIfRunning(state.jobKind === 'preview' ? state.job : null);
    renderUnlessDragging();
    return;
  }
  if (isBusy() || state.jobKind) return;
  if (!canProcess()) return notify('当前设置中有不可用的功能，请先检查提示。', 'error');
  if (kind === 'render' && !state.exportDirectory) return notify('请先选择视频保存文件夹。', 'error');
  const assetId = selectedAssetId();
  const revision = state.draft.revision;
  const timeSeconds = ['preview', 'playback'].includes(kind) ? state.selectedTimeSeconds : null;
  const token = ++jobSequence;
  state.previewQueued = false;
  if (kind === 'preview') state.activePreviewTarget = nextTarget;
  if (kind === 'render') {
    cancelJobIfRunning(state.proxyJob);
    ++proxySequence;
    state.proxyJob = null;
    state.pending = kind;
  }
  state.jobKind = kind;
  state.jobType = kind;
  state.job = { status: 'queued', progress: 0 };
  state.notice = null;
  renderUnlessDragging();
  try {
    const endpoint = kind;
    const data = await requestJson(fetch, base, 'POST', endpoint,
      { ...jobBody(assetId, state.draft, kind === 'preview' ? { timeSeconds, previewQuality: nextTarget.quality } : kind === 'playback' ? { timeSeconds, previewScope: state.stepIndex === 0 ? 'base' : 'current', playbackQuality: state.playbackQuality } : {}), ...(kind === 'render' ? { exportDirectory: state.exportDirectory, ...(state.canChooseExportQuality ? {exportQuality:state.exportQuality} : {}) } : {}) });
    const initial = jobFrom(data);
    if (token !== jobSequence) {
      cancelJobIfRunning(initial);
      return;
    }
    await receiveJob(initial, kind, revision, timeSeconds, assetId, token);
    if (!jobFinished(initial.status)) await pollJob(initial.id, kind, revision, timeSeconds, assetId, token);
  } catch (error) {
    if (token === jobSequence) {
      state.jobKind = null;
      state.job = { status: 'failed', error: { message: errorMessage(error) } };
      if (!automatic) notify(errorMessage(error), 'error');
      else renderUnlessDragging();
    }
  } finally {
    if (token === jobSequence) {
      if (kind === 'render') state.pending = null;
      if (kind === 'preview') state.activePreviewTarget = null;
      if (kind !== 'playback') renderUnlessDragging();
      if (kind === 'preview' && state.previewQueued && !isBusy()) {
        state.previewQueued = false;
        void startJob('preview', true);
      }
    }
  }
}

async function pollJob(jobId, kind, revision, timeSeconds, assetId, token) {
  while (token === jobSequence) {
    await new Promise((resolve) => setTimeout(resolve, 900));
    if (token !== jobSequence) return;
    const data = await requestJson(fetch, base, 'GET', `jobs/${encodeURIComponent(jobId)}`);
    if (token !== jobSequence) return;
    const job = jobFrom(data);
    await receiveJob(job, kind, revision, timeSeconds, assetId, token);
    if (jobFinished(job.status)) return;
  }
}

function currentColor(changes) {
  return { hue: 0, range: 24, amount: 0, hueShift: 0, luminance: 0,
    ...(state.draft.color || {}), ...changes };
}

async function chooseHue(hue) {
  if (hue === null) return notify('这个颜色接近灰色，请选择更鲜明的颜色。', 'error');
  await updateDraft({ color: currentColor({ hue }) });
}

function sampleColor(event) {
  const blockReason = pickColorBlockReason();
  if (blockReason) return notify(blockReason, 'error');
  const media = document.querySelector('#preview-media');
  if (!media) return notify('请先生成画面预览。', 'error');
  const width = media.videoWidth || media.naturalWidth;
  const height = media.videoHeight || media.naturalHeight;
  if (!width || !height) return notify('画面尚未载入，请稍后再点取。', 'error');
  const frame = media.getBoundingClientRect();
  const scale = Math.min(frame.width / width, frame.height / height);
  const visibleWidth = width * scale, visibleHeight = height * scale;
  const left = frame.left + (frame.width - visibleWidth) / 2;
  const top = frame.top + (frame.height - visibleHeight) / 2;
  const x = (event.clientX - left) / scale;
  const y = (event.clientY - top) / scale;
  if (x < 0 || y < 0 || x >= width || y >= height) return notify('请点击画面内部。', 'error');
  try {
    const sample = state.sampleImageStatus === 'loaded' ? state.sampleImage : media;
    const sampleWidth = sample.naturalWidth || sample.videoWidth || width;
    const sampleHeight = sample.naturalHeight || sample.videoHeight || height;
    const sampleX = Math.min(sampleWidth - 1, Math.floor(x / width * sampleWidth));
    const sampleY = Math.min(sampleHeight - 1, Math.floor(y / height * sampleHeight));
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(sample, sampleX, sampleY, 1, 1, 0, 0, 1, 1);
    const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
    state.pickColor = false;
    chooseHue(hueFromRgb(red, green, blue));
  } catch { notify('无法读取此画面颜色，请用右侧的手动选色。', 'error'); }
}

app.addEventListener('submit', (event) => {
  if (event.target.id !== 'scan-form') return;
  event.preventDefault();
  scanDirectory(event.target.elements.directory.value);
});

app.addEventListener('click', async (event) => {
  const control = event.target.closest('[data-action]');
  if (!control) return;
  const action = control.dataset.action;
  if (action === 'toggle-materials' || action === 'toggle-adjustments' || action === 'hide-adjustments') {
    if (action === 'toggle-materials') state.materialsCollapsed = !state.materialsCollapsed;
    else state.adjustmentsCollapsed = action === 'hide-adjustments' || !state.adjustmentsCollapsed;
    // Keep the same media element mounted: layout changes must not pause,
    // reload or regenerate the frame the user is watching.
    syncPanelLayout();
    if (action === 'hide-adjustments') document.querySelector('[data-action="toggle-adjustments"]')?.focus();
    return;
  }
  if (action === 'dismiss') { state.notice = null; render(); return; }
  if (action === 'toggle-environment') { state.environmentOpen = !state.environmentOpen; render(); return; }
  if (action === 'check-environment') return loadEnvironment(true);
  if (action === 'install-environment') return installEnvironment();
  if (action === 'toggle-ai-panel') {
    if (state.aiExpanded) { state.aiExpanded = false; render(); return; }
    return openAiPanel();
  }
  if (action === 'ai-run') return runAiAdvice();
  if (action === 'ai-cancel') return cancelAiAdvice();
  if (action === 'ai-apply') return applyAiRecommendation(control.dataset.recommendationId);
  if (action === 'pick-directory') return pickDirectory();
  if (action === 'show-export-result') {
    state.stepIndex = 4; state.adjustmentsCollapsed = false; state.viewerExpanded = false; render();
    document.querySelector('.export-result')?.scrollIntoView({block:'center'}); return;
  }
  if (action === 'pick-export-directory') return chooseExportDirectory();
  if (action === 'set-export-directory') return chooseExportDirectory(true);
  if (action === 'default-export-directory') { state.exportDirectory = state.defaultExportDirectory; render(); return; }
  if (action === 'save-existing-export') return saveExistingExport();
  if (action === 'open-export-video') return openExport('video');
  if (action === 'open-export-folder') return openExport('folder');
  if (action === 'select-export') {
    const saved = state.exportHistory.find(item=>item.jobId===control.dataset.jobId);
    if (saved) { state.exportFile = saved; state.outputRef = saved.videoRef; state.outputRevision = saved.revision; render(); }
    return;
  }
  if (action === 'retry-analysis') return selectAsset(selectedAssetId(), { refresh: true });
  if (action === 'retry-proxy' || action === 'prepare-timeline') return startProxyJob(true);
  if (action === 'cancel-processing') { cancelJobIfRunning(state.job); return; }
  if (action === 'review-tone-range') return reviewToneRange(control.dataset.rangeId);
  if (action === 'accept-tone-range') return acceptToneRanges(control.dataset.rangeId, null);
  if (action === 'accept-tone-group') return acceptToneRanges(null, control.dataset.groupId);
  if (action === 'refine-tone') return selectAsset(selectedAssetId(), { refresh: true, refine: true });
  if (action === 'accept-low-light') {
    const proposal = state.analysis?.tone_advice?.low_light;
    if (!hasFeature('tone') || !state.adjustmentCapabilities.lowLight
      || !Number.isFinite(proposal?.amount) || proposal.amount < 0 || proposal.amount > 1
      || !Number.isInteger(proposal?.support_count) || !Number.isInteger(proposal?.sample_count)
      || proposal.sample_count <= 0 || proposal.support_count > proposal.sample_count
      || proposal.support_count < Math.ceil(proposal.sample_count * .8)) return;
    return updateDraft({ lowLight: proposal.amount });
  }
  if (action === 'tone-global') {
    state.toneScope = 'global';
    state.liveToneValues = { highlights: state.draft.highlights, shadows: state.draft.shadows,
      lowLight: state.draft.lowLight };
    render(); return;
  }
  if (action === 'tone-range') { if (activeToneRange()) state.toneScope = 'range'; render(); return; }
  if (action === 'remove-tone-range') {
    const ranges = state.draft.toneSegments?.filter(item => item.id !== state.activeToneRangeId) ?? [];
    return updateDraft({ toneSegments: ranges.length ? ranges : null });
  }
  if (action === 'clear-tone-ranges') { state.toneScope = 'global'; return updateDraft({ toneSegments: null }); }
  if (action === 'toggle-playback') {
    const video = document.querySelector('#preview-media');
    if (video?.tagName !== 'VIDEO') return;
    if (video.ended) video.currentTime = 0;
    if (video.paused) void video.play().catch(() => {}); else video.pause();
    return;
  }
  if (action === 'original-playback') return startOriginalPlayback();
  if (action === 'playback') {
    const video = document.querySelector('#preview-media');
    if (state.playbackVisible && !state.playbackInfo?.original && video?.tagName === 'VIDEO' && video.ended) {
      if (state.playbackInfo.end_seconds >= Number(state.asset.duration)-.05) {
        video.currentTime = 0; void video.play().catch(() => {}); return;
      }
      state.selectedTimeSeconds = previewTime(state.playbackInfo.end_seconds, Number(state.asset.duration));
    }
    stopPlayback(); return startJob('playback');
  }
  if (action === 'playback-frame') { stopPlayback(); render(); return startJob('preview'); }
  if (action === 'expand-viewer') {
    state.viewerExpanded = !state.viewerExpanded;
    state.viewerZoom = 0;
    state.faceZoom = false;
    state.pickColor = false;
    render();
    if (state.viewerExpanded && !state.playbackVisible && (state.previewQuality !== 'detail' || !currentExactPreview())) return startJob('preview', true);
    return;
  }
  if (action === 'viewer-zoom') { state.viewerZoom = Number(control.dataset.zoom); render(); return; }
  if (action === 'zoom-person') { state.faceZoom = !state.faceZoom; render(); return; }
  if (action === 'go-step') {
    const step = Number(control.dataset.step);
    if (!isBusy() && availableStep(step)) {
      if (step === state.stepIndex) { state.adjustmentsCollapsed = false; syncPanelLayout(); }
      else { setStep(step); render(); }
    }
    return;
  }
  if (action === 'previous-step') { setStep(adjacentStep(state.stepIndex, -1)); render(); return; }
  if (action === 'next-step') { setStep(adjacentStep(state.stepIndex, 1)); render(); return; }
  if (action === 'skip-step') {
    if (state.stepIndex === 4) return;
    const clear = skipChangesForStep(state.stepIndex);
    const needsPatch = Object.entries(clear).some(([field, value]) => state.draft[field] !== value);
    const done = !needsPatch || await updateDraft(clear, state.stepIndex === 0);
    if (done) { setStep(adjacentStep(state.stepIndex, 1)); render(); }
    return;
  }
  if (action === 'close-advanced') {
    if (control.classList.contains('dialog-backdrop') && event.target !== control) return;
    state.advancedOpen = false; render(); return;
  }
  if (action === 'advanced') { state.advancedOpen = true; render(); return; }
  if (action === 'advanced-preview') { state.advancedOpen = false; render(); return startJob('preview'); }
  if (action === 'reset-advanced') return updateDraft({ color: currentColor({ hueShift: 0, luminance: 0 }) });
  if (action === 'select') return selectAsset(control.dataset.id);
  if (action === 'preview') return startJob('preview');
  if (action === 'render') return startJob('render');
  if (action === 'view-before') { stopPlayback(); state.previewView = 'before'; render(); return; }
  if (action === 'view-after') { stopPlayback(); state.previewView = 'after'; render(); return; }
  if (action === 'return-adjustments') {
    setStep(adjacentStep(4, -1));
    render();
    return;
  }
  if (action === 'pick-color') { state.pickColor = !state.pickColor; state.previewView = 'after'; render(); return; }
  if (action === 'sample-color') { sampleColor(event); return; }
  if (action === 'suggest') {
    const field = control.dataset.field;
    const value = ['highlights', 'shadows'].includes(field) && state.toneScope === 'range'
      ? activeToneRange()?.suggestions?.[field] ?? null : suggestionFor(state.analysis, field);
    if (value !== null) {
      if (field === 'skin') await updateDraft({ skin: { ...skinValues(state.draft.skin), amount: value } });
      else if (['highlights', 'shadows'].includes(field)) await updateToneControl(field, value);
      else await updateDraft({ [field]: value });
    }
    return;
  }
  if (action === 'zone-switch') {
    const field = control.dataset.field;
    if (['highlights', 'shadows'].includes(field)) {
      const controls = state.toneScope === 'range' && activeToneRange()
        ? state.draft.toneSegments?.find(item => item.id === state.activeToneRangeId) : state.draft;
      return updateToneControl(field, zoneIsSet(controls, field) ? null : 0);
    }
    await updateDraft({ [field]: zoneIsSet(state.draft, field) ? null
      : field === 'skin' ? { amount: 0, brightness: 0, smoothness: 0 } : 0 });
    return;
  }
  if (action === 'remove-color') {
    state.advancedOpen = false;
    await updateDraft({ color: null });
  }
});

app.addEventListener('input', (event) => {
  const input = event.target;
  if (input.id === 'ai-intent') { state.aiIntent = input.value.slice(0, 300); return; }
  if (input.id === 'frame-time') {
    if (state.playbackVisible && state.playbackInfo?.original) {
      const selected = previewTime(Number(input.value), Number(state.asset?.duration));
      const video = document.querySelector('#preview-media');
      if (selected !== null && video?.tagName === 'VIDEO') {
        video.pause(); video.currentTime = selected; state.selectedTimeSeconds = selected;
        invalidateAiAdvice('已选择其他时间位置，请重新分析当前画面。');
      }
      return;
    }
    if (state.playbackVisible || state.jobKind === 'playback') stopPlayback();
    const selected = previewTime(Number(input.value), Number(state.asset?.duration));
    if (selected === null) return;
    if (selected !== state.selectedTimeSeconds) invalidateAiAdvice('已选择其他时间位置，请重新分析当前画面。');
    state.selectedTimeSeconds = selected;
    state.frameInputPending = true;
    state.previewView = 'after';
    state.pickColor = false;
    state.timeLocating = true;
    state.liveToneActive = false;
    state.previewStatus = 'locating';
    const output = document.querySelector('#frame-time-output');
    if (output) output.textContent = frameTimeLabel(selected);
    const status = document.querySelector('#preview-status');
    if (status) status.textContent = previewStatusLabel();
    document.querySelector('#proxy-media')?.classList.add('is-active');
    document.querySelector('#live-preview-canvas')?.classList.remove('is-active');
    scheduleProxySeek();
    return;
  }
  if (input.matches('input[data-advanced-field]')) {
    const field = input.dataset.advancedField;
    const output = document.querySelector(`[data-advanced-output="${field}"]`);
    if (output) output.textContent = field === 'range' || field === 'hueShift' ? `${Math.round(Number(input.value))}°` : signed(Number(input.value));
    const preview = document.querySelector('[data-preview-swatch]');
    if (preview) {
      const live = currentColor({});
      document.querySelectorAll('input[data-advanced-field]').forEach((slider) => { live[slider.dataset.advancedField] = Number(slider.value); });
      preview.style.setProperty('--swatch', previewHexForColor(live));
    }
    return;
  }
  if (input.matches('input[data-skin-field]')) {
    const output = document.querySelector(`[data-skin-output="${input.dataset.skinField}"]`);
    if (output) output.textContent = signed(Number(input.value));
    return;
  }
  if (!input.matches('input[type="range"][data-field]')) return;
  const output = document.querySelector(`[data-output="${input.dataset.field}"]`);
  if (output) output.textContent = input.dataset.field === 'range' ? `${Math.round(Number(input.value))}°`
    : ['lowLight', 'denoise'].includes(input.dataset.field) ? Number(input.value).toFixed(2) : signed(Number(input.value));
  if (['highlights', 'shadows', 'lowLight'].includes(input.dataset.field)) {
    if (state.playbackVisible) stopPlayback();
    state.toneInputPending = true;
    state.liveToneValues = { ...liveToneAmounts(), [input.dataset.field]: Number(input.value) };
    state.liveToneActive = hasCurrentBase();
    state.previewStatus = state.liveToneActive ? 'approx' : 'stale';
    state.previewView = 'after';
    const status = document.querySelector('#preview-status');
    if (status) status.textContent = previewStatusLabel();
    scheduleLivePaint();
  } else if (input.dataset.field === 'denoise') {
    if (state.playbackVisible) stopPlayback();
    state.toneInputPending = true;
    state.liveToneActive = false;
    state.previewStatus = 'stale';
    state.previewView = 'after';
    document.querySelector('#live-preview-canvas')?.classList.remove('is-active');
    const status = document.querySelector('#preview-status');
    if (status) status.textContent = previewStatusLabel();
  }
});

app.addEventListener('change', async (event) => {
  const input = event.target;
  const field = input.dataset.field;
  if (input.id === 'ai-model') {
    const index = Number(input.value);
    if (Number.isInteger(index) && state.aiModels?.models[index]) state.aiModelIndex = index;
    if (!selectedAiModel()?.vision) state.aiIncludeFrame = false;
    render(); return;
  }
  if (input.id === 'ai-include-frame') {
    state.aiIncludeFrame = input.checked && selectedAiModel()?.vision === true;
    render(); return;
  }
  if (input.id === 'playback-quality') { state.playbackQuality = input.value; render(); return; }
  if (input.id === 'export-quality') { state.exportQuality = input.value; render(); return; }
  if (input.id === 'frame-time') {
    if (state.playbackVisible && state.playbackInfo?.original) return;
    const selected = previewTime(Number(input.value), Number(state.asset?.duration));
    if (selected === null) return;
    if (selected !== state.selectedTimeSeconds) invalidateAiAdvice('已选择其他时间位置，请重新分析当前画面。');
    state.selectedTimeSeconds = selected;
    state.frameInputPending = false;
    const activeRange = activeToneRange();
    if (state.toneScope === 'range' && activeRange
        && (selected < activeRange.startSeconds || selected >= activeRange.endSeconds)) {
      state.toneScope = 'global';
      state.activeToneRangeId = null;
      state.liveToneValues = { shadows: state.draft.shadows ?? 0,
        highlights: state.draft.highlights ?? 0, lowLight: state.draft.lowLight ?? 0 };
    }
    state.timeLocating = true;
    state.previewStatus = 'locating';
    state.previewView = 'after';
    render();
    return startJob('preview', true);
  }
  if (input.id === 'manual-color') return chooseHue(hueFromHex(input.value));
  if (field === 'cameraOverride') return updateDraft({ cameraOverride: input.value || null }, true);
  if (field === 'modeOverride') return updateDraft({ modeOverride: input.value || null }, true);
  if (field === 'lutEnabled') return updateDraft({ lutEnabled: input.checked }, true);
  if (field === 'lutLook') {
    const selection = lutSelection(state.asset, { ...state.draft, lutLook: input.value });
    const size = selection.sizes.includes(selection.size) ? selection.size
      : selection.sizes.includes(65) ? 65 : selection.sizes[0];
    if (!size || !selection.looks.includes(input.value)) return;
    return updateDraft({ lutLook: input.value, lutSize: size }, true);
  }
  if (field === 'lutSize') {
    const selection = lutSelection(state.asset, state.draft);
    const size = Number(input.value);
    if (!selection.sizes.includes(size)) return;
    return updateDraft({ lutLook: selection.look, lutSize: size }, true);
  }
  if (['lowLightEnabled', 'denoiseEnabled'].includes(field)) {
    const capability = field === 'lowLightEnabled' ? 'lowLight' : 'denoise';
    if (!hasFeature('tone') || !state.adjustmentCapabilities[capability]) return;
    return updateDraft(toneExtensionPatch(field, input.checked));
  }
  if (input.matches('input[data-advanced-field]')) {
    const advancedField = input.dataset.advancedField;
    return updateDraft({ color: currentColor({ [advancedField]: clamp(input.value,
      advancedField === 'hueShift' ? -180 : advancedField === 'range' ? 0 : -1,
      advancedField === 'hueShift' ? 180 : advancedField === 'range' ? 180 : 1) }) });
  }
  if (input.matches('input[data-skin-field]')) {
    if (!zoneIsSet(state.draft, 'skin')) return;
    const skinField = input.dataset.skinField;
    return updateDraft({ skin: { ...skinValues(state.draft.skin),
      [skinField]: clamp(input.value, skinField === 'amount' ? -1 : 0, 1) } });
  }
  if (input.matches('input[type="range"]') && ['highlights', 'shadows'].includes(field)) {
    return updateToneControl(field, clamp(input.value, -1, 1));
  }
  if (input.matches('input[type="range"]') && ['lowLight', 'denoise'].includes(field)) {
    if (!hasFeature('tone') || !state.adjustmentCapabilities[field]
      || field === 'lowLight' && state.draft.lowLight == null
      || field === 'denoise' && state.draft.denoise == null) return;
    return updateDraft(toneExtensionPatch(field, input.value));
  }
  if (input.matches('input[type="range"]') && ['range', 'amount'].includes(field)) {
    if (!state.draft.color) return;
    return updateDraft({ color: currentColor({ [field]: clamp(input.value, field === 'range' ? 0 : -1, field === 'range' ? 180 : 1) }) });
  }
});

window.addEventListener('resize', () => {
  document.querySelector('.viewer-frame')?.style.setProperty('--display-scale', String(window.devicePixelRatio || 1));
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (state.viewerExpanded) { state.viewerExpanded = false; state.viewerZoom = 0; }
  if (state.advancedOpen) state.advancedOpen = false;
  if (state.pickColor) state.pickColor = false;
  render();
});

render();
loadEnvironment();
loadState();
