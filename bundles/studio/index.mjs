import { applyStudio } from '../../adapters/harness/register.mjs';

export const name = 'video-studio';
export const inject = ['videoRuntime', 'tools'];
export function apply(ctx) { applyStudio(ctx); }
