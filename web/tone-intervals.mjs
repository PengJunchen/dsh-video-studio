const MAX_TONE_SEGMENTS = 12;
const MAX_TONE_GROUPS = 3;
const TONE_DOMAINS = new Set(['rec709_display_relative', 'sdr_rec709_display_relative']);
const PLAN_FIELDS = new Set(['id', 'startSeconds', 'endSeconds', 'highlights', 'shadows']);
const GROUP_FIELDS = new Set(['id', 'label', 'representative_seconds', 'ranges', 'suggestions']);
const GROUP_METADATA_FIELDS = new Set(['evidence']);
const RANGE_FIELDS = new Set(['start_seconds', 'end_seconds', 'representative_seconds']);
const RANGE_METADATA_FIELDS = new Set(['sample_times_seconds', 'evidence']);
const SUGGESTION_FIELDS = new Set(['highlights', 'shadows']);
const NO_OPTIONAL_FIELDS = new Set();

function tonePlanError() {
  const error = new Error('Tone segments are invalid.');
  error.code = 'INVALID_TONE_SEGMENTS';
  return error;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function ownDataRecord(value, fields, optionalFields = NO_OPTIONAL_FIELDS) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  return keys.every(key => typeof key === 'string' && (fields.has(key) || optionalFields.has(key)))
    && [...fields].every(key => Object.hasOwn(descriptors, key)
      && Object.hasOwn(descriptors[key], 'value'));
}

function normalizePlan(value, duration) {
  if (!finiteNumber(duration) || duration <= 0) throw tonePlanError();
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.length > MAX_TONE_SEGMENTS) throw tonePlanError();
  if (value.length === 0) return null;

  const ids = new Set();
  const segments = value.map(segment => {
    if (!ownDataRecord(segment, PLAN_FIELDS)) throw tonePlanError();
    const { id, startSeconds, endSeconds, highlights, shadows } = segment;
    if (typeof id !== 'string' || id.trim().length === 0 || id.length > 80 || ids.has(id)) {
      throw tonePlanError();
    }
    ids.add(id);
    if (!finiteNumber(startSeconds) || !finiteNumber(endSeconds)
        || startSeconds < 0 || startSeconds >= endSeconds || endSeconds > duration) {
      throw tonePlanError();
    }
    for (const amount of [highlights, shadows]) {
      if (amount !== null && (!finiteNumber(amount) || amount < -1 || amount > 1)) {
        throw tonePlanError();
      }
    }
    return { id, startSeconds, endSeconds, highlights, shadows };
  }).sort((left, right) => left.startSeconds - right.startSeconds);

  for (let index = 1; index < segments.length; index += 1) {
    if (segments[index].startSeconds < segments[index - 1].endSeconds) throw tonePlanError();
  }

  const effective = segments.filter(segment =>
    segment.highlights !== null || segment.shadows !== null);
  return effective.length === 0 ? null : effective;
}

function inferredDuration(value) {
  if (value === null || value === undefined || Array.isArray(value) && value.length === 0) return null;
  if (!Array.isArray(value)) throw tonePlanError();
  if (value.length > MAX_TONE_SEGMENTS) throw tonePlanError();
  let duration = 0;
  for (const segment of value) {
    if (!segment || typeof segment !== 'object' || Array.isArray(segment)) throw tonePlanError();
    const end = Object.getOwnPropertyDescriptor(segment, 'endSeconds');
    if (!end || !Object.hasOwn(end, 'value') || !finiteNumber(end.value)) throw tonePlanError();
    duration = Math.max(duration, end.value);
  }
  if (!finiteNumber(duration) || duration <= 0) throw tonePlanError();
  return duration;
}

/** Browser-side structural validation; the backend remains authoritative on duration. */
export function normalizeBrowserToneSegments(value, duration) {
  const bound = duration === undefined ? inferredDuration(value) : duration;
  if (bound === null && (value === null || value === undefined
      || Array.isArray(value) && value.length === 0)) return null;
  return normalizePlan(value, bound);
}

function stableHash(value) {
  let first = 2166136261;
  let second = 2246822519;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619) >>> 0;
    second = Math.imul(second ^ (code + index), 3266489917) >>> 0;
  }
  return `${first.toString(36)}${second.toString(36)}`;
}

function validRange(range, duration) {
  if (!ownDataRecord(range, RANGE_FIELDS, RANGE_METADATA_FIELDS)) return false;
  const { start_seconds: start, end_seconds: end, representative_seconds: representative } = range;
  return finiteNumber(start) && finiteNumber(end) && finiteNumber(representative)
    && start >= 0 && start < end && end <= duration
    && representative >= start && representative < end;
}

function validSuggestions(value) {
  if (!ownDataRecord(value, SUGGESTION_FIELDS)) return false;
  const { highlights, shadows } = value;
  const valid = amount => amount === null || finiteNumber(amount) && amount >= -1 && amount <= 1;
  return valid(highlights) && valid(shadows)
    && (highlights !== null || shadows !== null);
}

function overlaps(left, right) {
  return left.startSeconds < right.endSeconds && right.startSeconds < left.endSeconds;
}

/** Convert sparse analysis groups into safe, flat interval suggestions for UI use. */
export function toneIntervalEntries(analysis, duration) {
  if (!finiteNumber(duration) || duration <= 0 || !analysis
      || !TONE_DOMAINS.has(analysis.measurement?.domain)) return [];
  const summary = analysis.tone_intervals;
  if (!summary || summary.version !== 1 || summary.basis !== 'sparse-requested-seeks'
      || !Array.isArray(summary.groups) || summary.groups.length > MAX_TONE_GROUPS) return [];

  const groups = summary.groups;
  const idCounts = new Map();
  for (const group of groups) {
    if (group && typeof group.id === 'string') idCounts.set(group.id, (idCounts.get(group.id) ?? 0) + 1);
  }

  const candidates = [];
  groups.forEach((group, groupIndex) => {
    if (!ownDataRecord(group, GROUP_FIELDS, GROUP_METADATA_FIELDS)
        || typeof group.id !== 'string' || group.id.trim().length === 0 || group.id.length > 80
        || idCounts.get(group.id) !== 1
        || typeof group.label !== 'string' || group.label.trim().length === 0 || group.label.length > 120
        || !finiteNumber(group.representative_seconds) || group.representative_seconds < 0
        || group.representative_seconds >= duration || !Array.isArray(group.ranges)
        || !validSuggestions(group.suggestions)) return;

    const validRanges = group.ranges.map((range, rangeIndex) => ({ range, rangeIndex }))
      .filter(({ range }) => validRange(range, duration));
    if (!validRanges.some(({ range }) => group.representative_seconds >= range.start_seconds
        && group.representative_seconds < range.end_seconds)) return;

    for (const { range, rangeIndex } of validRanges) {
      const identity = `${group.id}\u0000${rangeIndex}\u0000${range.start_seconds}\u0000${range.end_seconds}`;
      candidates.push({
        id: `tone-${stableHash(identity)}`,
        groupId: group.id,
        label: group.label,
        startSeconds: range.start_seconds,
        endSeconds: range.end_seconds,
        representativeSeconds: range.representative_seconds,
        suggestions: { highlights: group.suggestions.highlights, shadows: group.suggestions.shadows },
        _groupIndex: groupIndex,
        _rangeIndex: rangeIndex,
      });
    }
  });

  candidates.sort((left, right) => left.startSeconds - right.startSeconds
    || left.endSeconds - right.endSeconds
    || left._groupIndex - right._groupIndex
    || left._rangeIndex - right._rangeIndex);
  const conflicting = new Set();
  for (let left = 0; left < candidates.length; left += 1) {
    for (let right = left + 1; right < candidates.length; right += 1) {
      if (candidates[right].startSeconds >= candidates[left].endSeconds) break;
      if (overlaps(candidates[left], candidates[right])) {
        conflicting.add(left);
        conflicting.add(right);
      }
    }
  }

  return candidates.filter((_, index) => !conflicting.has(index))
    .slice(0, MAX_TONE_SEGMENTS)
    .map(({ _groupIndex, _rangeIndex, ...entry }) => entry);
}

/** Convert one suggestion group to plan rows without applying them. */
export function toneRangesForGroup(entries, groupId) {
  if (!Array.isArray(entries) || typeof groupId !== 'string' || !groupId) return [];
  const selected = entries.filter(entry => entry?.groupId === groupId).map(entry => ({
    id: entry.id,
    startSeconds: entry.startSeconds,
    endSeconds: entry.endSeconds,
    highlights: entry.suggestions?.highlights,
    shadows: entry.suggestions?.shadows,
  }));
  if (selected.length === 0) return [];
  return normalizeBrowserToneSegments(selected) ?? [];
}

/** Merge accepted recommendations without deleting or moving a user's existing range. */
export function mergeToneRanges(existing, proposed, duration) {
  const oldPlan = normalizeBrowserToneSegments(existing, duration);
  const newPlan = normalizeBrowserToneSegments(proposed, duration);
  const ranges = [...(oldPlan ?? []), ...(newPlan ?? [])];
  if (ranges.length === 0) return null;

  const bound = duration === undefined
    ? Math.max(...ranges.map(range => range.endSeconds)) : duration;
  const merged = [...(oldPlan ?? [])];
  for (const candidate of newPlan ?? []) {
    const sameId = merged.findIndex(item => item.id === candidate.id);
    if (sameId >= 0) {
      const current = merged[sameId];
      if (current.startSeconds !== candidate.startSeconds
          || current.endSeconds !== candidate.endSeconds) throw tonePlanError();
      merged[sameId] = { ...candidate };
      continue;
    }
    if (merged.some(item => overlaps(item, candidate))) throw tonePlanError();
    merged.push({ ...candidate });
  }
  return normalizeBrowserToneSegments(merged, bound);
}
