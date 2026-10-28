import { applyFeature } from '../../adapters/harness/register.mjs';

export const name = 'video-tone';
export const inject = ['videoRuntime', 'tools'];
export function apply(ctx) { applyFeature(ctx, 'tone'); }
