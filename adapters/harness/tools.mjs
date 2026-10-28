import { defineTool } from '@deepseek-ai/dsh-tools';
import { sharedAdjustments } from './descriptors.mjs';

const registrations = new WeakMap();
const ACTIONS = ['state', 'scan', 'select', 'adjust', 'preview', 'render', 'job', 'cancel'];

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} is required`);
  return value;
}

function requiredRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('revision must be a non-negative integer');
  return value;
}

function changesFor(args, definitions) {
  const changes = args.changes;
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('changes must be an object');
  const allowed = new Set(definitions.flatMap(definition => definition.controls));
  for (const key of Object.keys(changes)) {
    if (allowed.has(key) || (key === 'modeOverride' && sharedAdjustments.modeOverride)
      || (Object.hasOwn(sharedAdjustments.clear, key) && changes[key] === sharedAdjustments.clear[key])) continue;
    throw new Error(`control ${key} does not belong to this feature`);
  }
  if (Object.keys(changes).length === 0) throw new Error('changes must contain a control');
  return changes;
}

/** Pure replay projection of the canonical JSON value. */
export function projectToolResult(value) {
  return [{ type: 'text', text: JSON.stringify(value) }];
}

/** One model tool fronts the same runtime methods used by the authenticated UI. */
export function createVideoTool(runtime, definitions, name) {
  const label = definitions.length === 1 ? definitions[0].title : 'Video Studio';
  return defineTool({
    name,
    description: `${label}: inspect scanned clips, select one, adjust enabled controls, submit preview or export jobs, read or cancel jobs. Any feature may set modeOverride for an explicit input mode, set lutEnabled to false, or clear optional controls with null. Positive changes to another feature's controls are rejected. Scanning requires an absolute directory under a configured source grant. Preview and export return a job id; use job to observe completion. Never infer processing quality from a queued job.`,
    parameters: {
      action: { type: 'string', required: true, enum: ACTIONS, description: 'Operation to perform.' },
      directory: { type: 'string', description: 'Absolute directory for scan.' },
      assetId: { type: 'string', description: 'Asset id returned by scan or state.' },
      revision: { type: 'integer', description: 'Current draft revision for adjust, preview, or render.' },
      changes: { type: 'object', additionalProperties: true, description: 'Owned controls plus shared clears and modeOverride. LUT owns lutLook (standard/vivid) and lutSize (available integer grid); null follows automatic Vivid65 preference. Only choose variants listed for this camera and capture profile. toneSegments is null or up to 12 nonoverlapping {id,startSeconds,endSeconds,highlights,shadows} ranges; nullable tone values inherit global controls, times are source-relative seconds. Tone also owns global lowLight (0..1 or null) and denoise ({amount:0..1} or null). These apply across all confirmed ranges; start denoising gently and verify original-size fine detail. Never apply suggestions without user acceptance. Skin accepts a legacy amount (-1..1), or {amount:-1..1,brightness:0..1,smoothness:0..1}; null disables it.' },
      timeSeconds: { type: 'number', description: 'Optional source-relative frame time for preview, from zero up to but excluding the clip duration. Omit to preview the middle frame.' },
      jobId: { type: 'string', description: 'Job id returned by preview or render.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => projectToolResult(value),
      presentationMeta: (args) => ({ operation: args.action, feature: definitions.length === 1 ? definitions[0].id : 'studio' }),
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      switch (args.action) {
        case 'state': return runtime.state();
        case 'scan': return runtime.scan({ directory: requiredString(args.directory, 'directory') }, exec.signal);
        case 'select': return runtime.select({ assetId: requiredString(args.assetId, 'assetId') }, exec.signal);
        case 'adjust': return runtime.updateDraft({
          assetId: requiredString(args.assetId, 'assetId'),
          revision: requiredRevision(args.revision),
          changes: changesFor(args, definitions),
        });
        case 'preview': return runtime.preview({ assetId: requiredString(args.assetId, 'assetId'), revision: requiredRevision(args.revision), timeSeconds: args.timeSeconds });
        case 'render': return runtime.render({ assetId: requiredString(args.assetId, 'assetId'), revision: requiredRevision(args.revision) });
        case 'job': return runtime.readJob(requiredString(args.jobId, 'jobId'));
        case 'cancel': return runtime.cancel(requiredString(args.jobId, 'jobId'));
        default: throw new Error(`unsupported video action: ${args.action}`);
      }
    },
  });
}

// A shared runtime can appear inside separate Cordis tool-service realms.
// Lease once per registry and tool name, including mixed Studio rows.
export function leaseTool(ctx, runtime, definitions, name) {
  let registries = registrations.get(runtime);
  if (registries === undefined) {
    registries = new WeakMap();
    registrations.set(runtime, registries);
  }
  let tools = registries.get(ctx.tools);
  if (tools === undefined) {
    tools = new Map();
    registries.set(ctx.tools, tools);
  }
  let record = tools.get(name);
  const hash = definitions.map(definition => definition.definitionHash).join(':');
  if (record !== undefined && record.hash !== hash) throw new Error(`conflicting tool definition: ${name}`);
  if (record === undefined) {
    const dispose = ctx.tools.register(createVideoTool(runtime, definitions, name));
    record = { hash, count: 0, dispose };
    tools.set(name, record);
  }
  record.count++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    record.count--;
    if (record.count === 0) {
      record.dispose();
      tools.delete(name);
      if (tools.size === 0) registries.delete(ctx.tools);
    }
  };
}
