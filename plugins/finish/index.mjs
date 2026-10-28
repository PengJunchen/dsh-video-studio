import { applyFeature } from '../../adapters/harness/register.mjs';

export const name = 'video-finish';
export const inject = ['videoRuntime', 'tools'];
export function apply(ctx) { applyFeature(ctx, 'finish'); }
