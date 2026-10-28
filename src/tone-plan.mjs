const TONE_SEGMENT_FIELDS = new Set([
  'id', 'startSeconds', 'endSeconds', 'highlights', 'shadows',
]);
const MAX_TONE_SEGMENTS = 12;

function invalidToneSegments() {
  const error = new Error('Tone segments are invalid.');
  error.code = 'INVALID_TONE_SEGMENTS';
  throw error;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Validate and normalize the user's accepted, source-relative tone ranges. */
export function normalizeToneSegments(value, duration) {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.length > MAX_TONE_SEGMENTS) invalidToneSegments();
  if (value.length === 0) return null;
  if (!finiteNumber(duration) || duration <= 0) invalidToneSegments();

  const ids = new Set();
  const segments = value.map(segment => {
    if (!segment || typeof segment !== 'object' || Array.isArray(segment)) invalidToneSegments();
    const prototype = Object.getPrototypeOf(segment);
    if (prototype !== Object.prototype && prototype !== null) invalidToneSegments();
    const keys = Reflect.ownKeys(segment);
    if (keys.some(key => typeof key !== 'string' || !TONE_SEGMENT_FIELDS.has(key))) {
      invalidToneSegments();
    }
    const descriptors = Object.getOwnPropertyDescriptors(segment);
    for (const field of TONE_SEGMENT_FIELDS) {
      if (!Object.hasOwn(descriptors, field) || !Object.hasOwn(descriptors[field], 'value')) {
        invalidToneSegments();
      }
    }

    const { id, startSeconds, endSeconds, highlights, shadows } = segment;
    if (typeof id !== 'string' || id.trim().length === 0 || id.length > 80 || ids.has(id)) {
      invalidToneSegments();
    }
    ids.add(id);
    if (!finiteNumber(startSeconds) || !finiteNumber(endSeconds)
        || startSeconds < 0 || startSeconds >= endSeconds || endSeconds > duration) {
      invalidToneSegments();
    }
    for (const amount of [highlights, shadows]) {
      if (amount !== null && (!finiteNumber(amount) || amount < -1 || amount > 1)) {
        invalidToneSegments();
      }
    }
    return { id, startSeconds, endSeconds, highlights, shadows };
  }).sort((left, right) => left.startSeconds - right.startSeconds);

  for (let index = 1; index < segments.length; index += 1) {
    if (segments[index].startSeconds < segments[index - 1].endSeconds) invalidToneSegments();
  }

  const effective = segments.filter(segment =>
    segment.highlights !== null || segment.shadows !== null);
  return effective.length === 0 ? null : effective;
}
