/** One-shot AI advice through the Host's configured Harness LLM registry. */
const MAX_IMAGES = 2;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MODEL_LIST_TIMEOUT_MS = 8_000;
const CALL_TIMEOUT_MS = 180_000;

export class AdvisorError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AdvisorError';
    this.code = code;
    this.status = status;
  }
}

function error(code, message, status) { return new AdvisorError(code, message, status); }

function aborted(signal) {
  if (!signal.aborted) return;
  if (signal.reason?.name === 'TimeoutError') throw error('AI_TIMEOUT', 'AI 分析已超时，请稍后重试。', 504);
  throw error('AI_ABORTED', 'AI 分析已取消。', 499);
}

function withAbort(operation, signal) {
  aborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (finish, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      finish(value);
    };
    const onAbort = () => {
      try { aborted(signal); } catch (failure) { settle(reject, failure); }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(operation).then(value => settle(resolve, value), failure => settle(reject, failure));
    if (signal.aborted) onAbort();
  });
}

function callSignal(external) {
  const deadline = AbortSignal.timeout(CALL_TIMEOUT_MS);
  return external === undefined ? deadline : AbortSignal.any([external, deadline]);
}

function modelDirectory(llm) {
  try { return llm.listProviders(); }
  catch { throw error('AI_UNAVAILABLE', '模型服务暂不可用。', 503); }
}

function selectionOf(ctx) {
  try { return ctx.get('agentDefaultModel')?.currentSelection(); }
  catch { return undefined; }
}

function imageInputs(images) {
  if (images === undefined) return [];
  if (!Array.isArray(images) || images.length > MAX_IMAGES) {
    throw error('AI_INVALID_IMAGES', '最多可发送两张画面。');
  }
  return images.map((image) => {
    if (!image || !(image.data instanceof Uint8Array) || image.data.byteLength === 0
      || image.mediaType !== 'image/png' || typeof image.name !== 'string' || !image.name.trim()) {
      throw error('AI_INVALID_IMAGES', '画面数据必须是有效的 PNG。');
    }
    return { data: image.data, mediaType: image.mediaType, name: image.name };
  });
}

function visibleUsage(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const usage = {};
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    if (Number.isSafeInteger(raw[key]) && raw[key] >= 0) usage[key] = raw[key];
  }
  return Object.keys(usage).length ? usage : undefined;
}

function collectText(blocks) {
  return [...blocks.entries()].sort(([left], [right]) => left - right)
    .map(([, block]) => block.text).join('');
}

function appendText(blocks, index, text, replace = false) {
  if (!Number.isSafeInteger(index) || index < 0 || typeof text !== 'string') {
    throw error('AI_INVALID_RESPONSE', '模型返回了无法读取的内容。', 502);
  }
  const current = blocks.get(index)?.text ?? '';
  const next = replace ? text : current + text;
  blocks.set(index, { text: next });
  if (Buffer.byteLength(collectText(blocks), 'utf8') > MAX_OUTPUT_BYTES) {
    throw error('AI_RESPONSE_TOO_LARGE', 'AI 建议过长，请缩小分析范围。', 502);
  }
}

function terminalError(code, message, status, kind, usage) {
  const failure = error(code, message, status);
  // Only protocol outcome and numeric usage may leave this boundary; never
  // provider failure text, reasoning content, or partial generated text.
  failure.diagnostics = { finish: kind, ...(usage === undefined ? {} : { usage }) };
  throw failure;
}

async function readStream(stream, signal) {
  const blocks = new Map();
  let usage;
  let finish;
  const iterator = stream[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await withAbort(iterator.next(), signal);
      if (next.done) break;
      const chunk = next.value;
      aborted(signal);
      if (chunk?.type === 'text-delta') appendText(blocks, chunk.index, chunk.text);
      else if (chunk?.type === 'block-end' && chunk.block?.type === 'text') {
        appendText(blocks, chunk.index, chunk.block.text, true);
      } else if (chunk?.type === 'usage') usage = visibleUsage(chunk.usage);
      else if (chunk?.type === 'finish') { finish = chunk.reason; break; }
    }
  } finally {
    // A stalled adapter may queue `return()` behind a pending `next()`.
    // The request signal owns transport cancellation; do not re-hang here.
    void Promise.resolve().then(() => iterator.return?.()).catch(() => {});
  }
  aborted(signal);
  if (finish?.kind === 'aborted') terminalError('AI_ABORTED', 'AI 分析已取消。', 499, 'aborted', usage);
  if (finish?.kind === 'max-tokens') terminalError('AI_TRUNCATED', '模型输出被截断，请重试。', 502, 'max-tokens', usage);
  if (finish?.kind === 'error') terminalError('AI_PROVIDER_ERROR', '模型服务未完成分析，请检查模型配置后重试。', 502, 'error', usage);
  if (finish?.kind !== 'stop') terminalError('AI_INCOMPLETE', '模型未完整返回建议，请重试。', 502, 'incomplete', usage);
  const text = collectText(blocks).trim();
  if (!text) throw error('AI_NO_TEXT', '模型没有返回可见的建议。', 502);
  return { text, ...(usage === undefined ? {} : { usage }) };
}

/** Keep provider configuration, credentials and wire requests owned by Harness. */
export function createHarnessAdvisor(ctx) {
  return {
    async listModels() {
      const llm = ctx.get('llm');
      if (!llm) return { available: false, models: [], defaultModel: null, reason: 'Harness 模型服务尚未加载。' };
      let providers;
      try { providers = modelDirectory(llm); }
      catch { return { available: false, models: [], defaultModel: null, reason: '模型目录暂不可用。' }; }
      const groups = await Promise.all(providers.map(async (provider) => {
        try {
          const signal = AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS);
          const entries = await withAbort(llm.listModels(provider.id), signal);
          return entries.map((model) => {
            const inputModalities = Array.isArray(model.inputModalities)
              ? model.inputModalities.filter(item => typeof item === 'string') : [];
            return { provider: provider.id, id: model.id, name: model.name,
              inputModalities, vision: inputModalities.includes('image') };
          });
        } catch { return []; /* One broken provider must not hide other configured routes. */ }
      }));
      const models = groups.flat();
      const current = selectionOf(ctx);
      const preferred = models.find(item => item.provider === current?.provider && item.id === current?.model);
      const chosen = preferred ?? models[0];
      return { available: models.length > 0, models,
        defaultModel: chosen ? { provider: chosen.provider, model: chosen.id } : null,
        ...(models.length ? {} : { reason: '尚无可用模型，请先在 Harness 配置模型。' }) };
    },

    async analyze({ provider, model, system, input, images } = {}, externalSignal) {
      const signal = callSignal(externalSignal);
      try {
        aborted(signal);
        if (typeof provider !== 'string' || !provider || typeof model !== 'string' || !model
          || typeof system !== 'string' || !system.trim() || typeof input !== 'string' || !input.trim()
          || Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES) {
          throw error('AI_INVALID_REQUEST', '请选择模型并提供有效的分析内容。');
        }
        const pictures = imageInputs(images);
        const llm = ctx.get('llm');
        if (!llm) throw error('AI_UNAVAILABLE', 'Harness 模型服务尚未加载。', 503);
        if (!modelDirectory(llm).some(item => item.id === provider)) {
          throw error('AI_MODEL_UNAVAILABLE', '所选模型已不可用，请重新选择。', 409);
        }
        let listed;
        try {
          listed = await withAbort(llm.listModels(provider),
            AbortSignal.any([signal, AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS)]));
        }
        catch (failure) {
          if (failure instanceof AdvisorError) throw failure;
          throw error('AI_MODEL_UNAVAILABLE', '无法读取所选模型，请重新选择。', 409);
        }
        if (!listed.some(item => item.id === model)) {
          throw error('AI_MODEL_UNAVAILABLE', '所选模型已不可用，请重新选择。', 409);
        }
        const current = selectionOf(ctx);
        const controls = current?.provider === provider && current?.model === model
          && current.reasoningEffort !== undefined ? { reasoningEffort: current.reasoningEffort } : {};
        const prepared = await withAbort(llm.prepareCall({ provider, model, maxTokens: 16_384, ...controls }, signal), signal);
        aborted(signal);
        if (pictures.length && !prepared.inputModalities?.includes('image')) {
          throw error('AI_IMAGE_UNSUPPORTED', '该模型未明确支持画面输入，请选择视觉模型。', 409);
        }
        let refs = [];
        if (pictures.length) {
          const attachments = ctx.get('attachments');
          if (!attachments?.saveImages) throw error('AI_ATTACHMENTS_UNAVAILABLE', 'Harness 画面附件服务尚未加载。', 503);
          refs = await withAbort(attachments.saveImages(pictures), signal);
          aborted(signal);
          if (refs.length !== pictures.length) throw error('AI_ATTACHMENTS_UNAVAILABLE', '画面附件保存未完成。', 503);
        }
        const content = [{ type: 'text', text: input }, ...refs.map(attachment => ({ type: 'image', attachment }))];
        const result = await readStream(prepared.stream({
          ...prepared.config, system, messages: [{ role: 'user', content }], signal,
        }), signal);
        return { ...result, model: { provider, model } };
      } catch (failure) {
        if (failure instanceof AdvisorError) throw failure;
        aborted(signal);
        throw error('AI_PROVIDER_ERROR', '模型服务未完成分析，请检查模型配置后重试。', 502);
      }
    },
  };
}
