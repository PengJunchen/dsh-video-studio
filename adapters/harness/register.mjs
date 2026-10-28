import { definitionFor, featureDefinitions } from './descriptors.mjs';
import { leaseTool } from './tools.mjs';

function catalogOf(runtime) {
  return runtime.catalog ?? runtime;
}

function leaseFeatures(ctx, definitions, owner, toolName) {
  ctx.effect(() => {
    const releases = [];
    try {
      for (const definition of definitions) releases.push(catalogOf(ctx.videoRuntime).registerFeature(definition, owner));
      releases.push(leaseTool(ctx, ctx.videoRuntime, definitions, toolName));
    } catch (error) {
      for (const release of releases.reverse()) release();
      throw error;
    }
    return () => { for (const release of releases.reverse()) release(); };
  }, `video feature leases: ${owner}`);
}

/** Mount one independent feature row with its own tool and shared catalog lease. */
export function applyFeature(ctx, id) {
  const definition = definitionFor(id);
  leaseFeatures(ctx, [definition], `plugin:${id}`, `video_${id.replaceAll('-', '_')}`);
}

/** Mount all canonical features plus one aggregate tool; shares independent leases. */
export function applyStudio(ctx) {
  for (const definition of featureDefinitions) {
    leaseFeatures(ctx, [definition], 'studio', `video_${definition.id.replaceAll('-', '_')}`);
  }
  ctx.effect(() => leaseTool(ctx, ctx.videoRuntime, featureDefinitions, 'video_studio'), 'video Studio tool');
}
