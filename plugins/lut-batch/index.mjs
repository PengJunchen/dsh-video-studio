import { applyFeature } from '../../adapters/harness/register.mjs';

export const name = 'video-lut-batch';
export const inject = ['videoRuntime', 'tools'];
export function apply(ctx) { applyFeature(ctx, 'lut-batch'); }
