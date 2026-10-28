import { createHash } from 'node:crypto';

// This is the one definition table imported by independent entries and Studio.
// Shared clear operations let a remaining feature remove a stale adjustment
// without taking ownership of another feature's positive controls.
export const sharedAdjustments = Object.freeze({
  modeOverride: true,
  clear: Object.freeze({ lutEnabled: false, highlights: null, shadows: null, toneSegments: null, lowLight: null, denoise: null, skin: null, color: null }),
});
// Version six adds optional low-light enhancement and denoising to tone ownership.
const version = 6;
const definitions = [
  { id: 'lut-batch', title: 'LUT batch', controls: ['lutEnabled', 'lutLook', 'lutSize', 'modeOverride', 'cameraOverride'], description: 'Inspect a source profile and choose Standard/Vivid and an available input LUT grid size; prefer Vivid65 by default.' },
  { id: 'tone', title: 'Highlights and shadows', controls: ['highlights', 'shadows', 'toneSegments', 'lowLight', 'denoise', 'modeOverride'], description: 'Adjust highlights and shadows independently, with optional confirmed source-relative time ranges, opt-in global low-light enhancement and spatial denoising.' },
  { id: 'skin', title: 'Skin', controls: ['skin', 'modeOverride'], description: 'Adjust bounded skin color, brightness, and edge-preserving smoothing.' },
  { id: 'local-color', title: 'Local color', controls: ['color', 'modeOverride'], description: 'Adjust a selected hue range.' },
  { id: 'finish', title: 'Finish', controls: [], description: 'Preview and export the current revision.' },
];

export const featureDefinitions = Object.freeze(definitions.map(({ id, title, controls, description }) => Object.freeze({
  id,
  version,
  title,
  description: `${description} Any feature can explicitly disable LUT, clear an optional adjustment, or declare the input mode.`,
  controls: Object.freeze(controls),
  sharedAdjustments,
  definitionHash: createHash('sha256').update(JSON.stringify({ id, version, controls, sharedAdjustments })).digest('hex'),
})));

export function definitionFor(id) {
  const definition = featureDefinitions.find(item => item.id === id);
  if (definition === undefined) throw new Error(`unknown video feature: ${id}`);
  return definition;
}
