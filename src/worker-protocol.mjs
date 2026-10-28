const modes = { 'D-Log': 'dlog', 'D-Log2': 'dlog2', 'D-Log M': 'dlogm', 'Rec.709': 'rec709' };
export function workerRequest(input) {
  const draft = input.draft ?? {};
  const mode = draft.modeOverride ?? input.profile?.mode;
  return {
    action: input.action,
    source_path: input.sourcePath,
    source_sha256: input.sourceSha256,
    lut_sha256: input.expectedLutSha256,
    output_dir: input.outputDir,
    ...(input.timeSeconds === undefined ? {} : { time_seconds: input.timeSeconds }),
    ...(input.proxyCacheDir === undefined ? {} : { proxy_cache_dir: input.proxyCacheDir }),
    ...(input.buildProxy === undefined ? {} : { build_proxy: input.buildProxy }),
    ...(input.sampleTimes === undefined ? {} : { sample_times: input.sampleTimes }),
    ...(input.aiSampleCacheDir === undefined ? {} : { ai_sample_cache_dir: input.aiSampleCacheDir }),
    ...(input.analysisRefine === undefined ? {} : { analysis_refine: input.analysisRefine }),
    ...(input.previewQuality === undefined ? {} : { preview_quality: input.previewQuality }),
    ...(input.previewScope === undefined ? {} : { preview_scope: input.previewScope }),
    ...(input.playbackQuality === undefined ? {} : { playback_quality: input.playbackQuality }),
    ...(input.action === 'render' ? { export_quality: input.exportQuality ?? 'preserve' } : {}),
    ...(input.sourceCacheDir === undefined || input.action === 'render' ? {} : { source_cache_dir: input.sourceCacheDir }),
    assets: input.assets,
    recipe: {
      camera_model: draft.cameraOverride ?? input.profile?.camera ?? input.cameraModel,
      profile: modes[mode] ?? mode,
      look: draft.lutLook ?? undefined, lut_grid: draft.lutSize ?? undefined,
      lut_enabled: Boolean(draft.lutEnabled),
      tone: { highlights: draft.highlights ?? null, shadows: draft.shadows ?? null, low_light: draft.lowLight ?? null },
      denoise: draft.denoise ?? null,
      tone_segments: draft.toneSegments?.map(segment => ({ id: segment.id,
        start_seconds: segment.startSeconds, end_seconds: segment.endSeconds,
        highlights: segment.highlights, shadows: segment.shadows })) ?? null,
      skin: draft.skin ?? null, local_color: draft.color ?? null,
    },
  };
}
export function workerResult(value) {
  if (value.status === 'error' || value.ok === false) {
    const error = new Error(value.error?.message ?? (typeof value.error === 'string' ? value.error : null) ?? value.message ?? '视频处理失败。');
    error.code = value.error?.code ?? value.code ?? 'WORKER_FAILED';
    throw error;
  }
  const result = value.result ?? value;
  if (result.output_path) result.outputPath = result.output_path;
  if (result.preview_path) result.previewPath = result.preview_path;
  if (result.after_path) result.previewPath = result.after_path;
  if (result.before_path) result.beforePath = result.before_path;
  if (result.sample_path) result.samplePath = result.sample_path;
  if (result.base_path) result.basePath = result.base_path;
  if (result.proxy_path) result.proxyPath = result.proxy_path;
  if (result.proxy_timing) result.proxyTiming = result.proxy_timing;
  if (result.preview_model) result.previewModel = result.preview_model;
  if (result.readback?.sample_target_seconds !== undefined) result.currentTime = result.readback.sample_target_seconds;
  if (result.tone_data_path) result.toneDataPath = result.tone_data_path;
  if (result.video_path) result.videoPath = result.video_path;
  return result;
}
