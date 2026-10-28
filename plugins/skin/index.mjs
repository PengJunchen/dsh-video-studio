import { applyFeature } from '../../adapters/harness/register.mjs';

export const name = 'video-skin';
export const inject = ['videoRuntime', 'tools'];
export function apply(ctx) { applyFeature(ctx, 'skin'); }
