import { applyFeature } from '../../adapters/harness/register.mjs';

export const name = 'video-local-color';
export const inject = ['videoRuntime', 'tools'];
export function apply(ctx) { applyFeature(ctx, 'local-color'); }
