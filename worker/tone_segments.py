"""Sparse tone recommendations and approved source-time tone plans.

The interval analyzer treats the existing requested-seek summaries as sparse
evidence, not as shot detection. Approved ranges use the shared 65^3 tone LUT
and blend complete RGB LUT outputs at their time boundaries.
"""

from __future__ import annotations

import itertools
import math
import re
import statistics
import tempfile
from pathlib import Path
from typing import Any

from tone_lut import tone_lut_filter, TONE_ALGORITHM_VERSION, create_tone_lut


MAX_TONE_SEGMENTS = 12
MAX_TRANSITION_SECONDS = 0.25
_LABELS = itertools.count(1)
_LABEL_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_FILTER_PATH_RE = re.compile(r"[':,;\[\]\\]")


def _finite_number(value: Any) -> bool:
    return (not isinstance(value, bool) and isinstance(value, (int, float))
            and math.isfinite(value))


def _percentile(row: dict[str, Any], key: str) -> float | None:
    value = row.get(key)
    return float(value) if _finite_number(value) and 0 <= value <= 255 else None


def _adaptive_amounts(row):
    if "tone_recommendation" not in row:
        return None
    advice=row["tone_recommendation"]
    if not isinstance(advice,dict):return (None,None)
    values=tuple(advice.get(key) for key in ("shadows","highlights"))
    if any(value is not None and (not _finite_number(value) or not -1<=value<=1) for value in values):
        return (None,None)
    return values if advice.get("status")=="suggested" else (None,None)

def _frame_low_information(row: dict[str, Any], p10: float, p90: float) -> bool:
    if "tone_recommendation" in row:
        advice=row["tone_recommendation"]
        return not isinstance(advice,dict) or advice.get("status") in {"review","ineligible"}
    dark_fraction = row.get("dark_fraction")
    near_white_fraction = row.get("near_white_fraction")
    all_black = p90 <= 5 or (_finite_number(dark_fraction) and dark_fraction >= .995)
    all_white = p10 >= 250 or (_finite_number(near_white_fraction) and near_white_fraction >= .995)
    flat = p90 - p10 <= 8
    return all_black or all_white or flat


def _distribution_shift(left: dict[str, Any], right: dict[str, Any]) -> bool:
    """Flag a large coherent quantile shift without claiming that it is a cut."""
    deltas = [right[key] - left[key] for key in ("p10", "p50", "p90")]
    if sum(abs(delta) >= 20 for delta in deltas) < 2:
        return False
    positive = sum(delta >= 20 for delta in deltas)
    negative = sum(delta <= -20 for delta in deltas)
    return positive >= 2 or negative >= 2


def analyze_tone_intervals(frame_summaries: Any, duration: float,
                           can_suggest: bool) -> dict[str, Any]:
    """Convert bounded requested-seek summaries into low-confidence ranges.

    Bounds are Voronoi-like cells around the requested seek times. They are
    useful for representative-frame suggestions, but are not detected shot
    boundaries and can be uncertain by a substantial fraction of the clip.
    """
    if not _finite_number(duration) or duration <= 0:
        raise ValueError("duration must be a finite positive number")
    duration = float(duration)
    limitations = [
        "Ranges use midpoints between sparse requested seeks; they are not precise shot boundaries.",
        "Sparse summaries cannot distinguish a cut from a content or exposure change.",
        "A single representative frame cannot establish that the whole range needs the same correction.",
        "Luma summaries can reject flat or near-black/near-white frames, but cannot identify a semantically empty scene.",
    ]
    if can_suggest is not True:
        limitations.append("The measured working domain is not eligible for tone suggestions.")

    rows: list[dict[str, Any]] = []
    if isinstance(frame_summaries, list):
        for source_index, row in enumerate(frame_summaries):
            if not isinstance(row, dict):
                continue
            time_seconds = row.get("time_seconds")
            p10, p50, p90 = (_percentile(row, name) for name in ("p10", "p50", "p90"))
            if (not _finite_number(time_seconds) or not 0 <= time_seconds <= duration
                    or p10 is None or p50 is None or p90 is None):
                continue
            point = {"time_seconds": float(time_seconds), "p10": p10, "p50": p50,
                     "p90": p90, "p99": _percentile(row, "p99"),
                     "dark_fraction": row.get("dark_fraction"),
                     "near_white_fraction": row.get("near_white_fraction"),
                     "_source_index": source_index,
                     **({"tone_recommendation":row["tone_recommendation"]} if "tone_recommendation" in row else {})}
            rows.append(point)

    rows.sort(key=lambda row: (row["time_seconds"], row["_source_index"]))
    unique_rows: list[dict[str, Any]] = []
    seen_times: set[float] = set()
    for row in rows:
        if row["time_seconds"] in seen_times:
            continue
        seen_times.add(row["time_seconds"])
        unique_rows.append(row)
    rows = unique_rows
    sample_times = [row["time_seconds"] for row in rows]
    result: dict[str, Any] = {
        "version": 1,
        "basis": "sparse-requested-seeks",
        "confidence": "low" if can_suggest is True and len(rows) >= 3 else "unavailable",
        "sample_count": len(rows),
        "sample_times_seconds": sample_times,
        "groups": [],
        "limitations": limitations,
    }
    if any(row["p99"] is None for row in rows):
        limitations.append("Per-frame p99 was unavailable, so highlight suggestions were suppressed.")
    if len(rows) < 3:
        limitations.append("Fewer than three distinct requested seeks remain; temporal ranges are not suggested.")
        return result
    if can_suggest is not True:
        return result

    edges = [0.0]
    edges.extend((rows[index - 1]["time_seconds"] + rows[index]["time_seconds"]) / 2
                 for index in range(1, len(rows)))
    edges.append(duration)
    # Clamp against unusual summaries that are valid but outside duration order.
    edges = [max(0.0, min(duration, edge)) for edge in edges]

    candidates: list[dict[str, Any]] = []
    for row in rows:
        low_information = _frame_low_information(row, row["p10"], row["p90"])
        adaptive=_adaptive_amounts(row)
        shadows = adaptive[0] is not None if adaptive is not None else not low_information and row["p10"] < 35 and row["p50"] > 45
        highlights = adaptive[1] is not None if adaptive is not None else (not low_information and row["p99"] is not None
                      and row["p90"] > 220 and row["p99"] > 245)
        signature = (bool(shadows), bool(highlights))
        candidates.append({"signature": signature if any(signature) else None,
                           "amounts":adaptive if adaptive is not None else (.15 if shadows else None,-.15 if highlights else None),
                           "low_information": low_information})

    # Group adjacent like recommendations. Split a run at a large coherent
    # histogram shift so a single card does not smooth across likely scene or
    # exposure changes. The split is explicitly not labeled a shot cut.
    runs: list[tuple[tuple[bool, bool], list[int], bool]] = []
    current_signature: tuple[bool, bool] | None = None
    current_indices: list[int] = []
    current_shift_before = False
    for index, candidate in enumerate(candidates):
        signature = candidate["signature"]
        shift = (index > 0 and _distribution_shift(rows[index - 1], rows[index]))
        if signature is None:
            if current_signature is not None:
                runs.append((current_signature, current_indices, current_shift_before))
            current_signature, current_indices, current_shift_before = None, [], False
            continue
        if current_signature == signature and current_indices and not shift:
            current_indices.append(index)
            continue
        if current_signature is not None:
            runs.append((current_signature, current_indices, current_shift_before))
        current_signature, current_indices = signature, [index]
        current_shift_before = bool(shift)
    if current_signature is not None:
        runs.append((current_signature, current_indices, current_shift_before))

    group_map: dict[tuple[bool, bool], dict[str, Any]] = {}
    for signature, indices, shift_before in runs:
        shadows, highlights = signature
        if shadows and highlights:
            group_id, label = "tone-shadows-highlights", "shadows+highlights"
        elif shadows:
            group_id, label = "tone-shadows", "shadows"
        else:
            group_id, label = "tone-highlights", "highlights"
        group = group_map.setdefault(signature, {
            "id": group_id, "label": label, "representative_seconds": None,
            "ranges": [],
            "suggestions": {"shadows": .15 if shadows else None,
                            "highlights": -.15 if highlights else None},
            "evidence": {"thresholds": {"shadow": "p10 < 35 and p50 > 45",
                                         "highlight": "p90 > 220 and p99 > 245"},
                         "range_method": "requested-seek midpoint cells",
                         "possible_distribution_changes": []},
            "_representative_score": -1.0,
        })
        representative_index = max(indices, key=lambda i: (
            ((35 - rows[i]["p10"]) / 35 if shadows else 0)
            + ((rows[i]["p99"] - 245) / 10 if highlights and rows[i]["p99"] is not None else 0),
            -i))
        representative = rows[representative_index]
        score = (((35 - representative["p10"]) / 35) if shadows else 0)
        if highlights and representative["p99"] is not None:
            score += (representative["p99"] - 245) / 10
        group["ranges"].append({
            "start_seconds": edges[indices[0]],
            "end_seconds": edges[indices[-1] + 1],
            "representative_seconds": representative["time_seconds"],
            "sample_times_seconds": [rows[i]["time_seconds"] for i in indices],
            "evidence": [{key: rows[i][key] for key in (
                "time_seconds", "p10", "p50", "p90", "p99", "dark_fraction", "near_white_fraction")}
                for i in indices],
        })
        if shift_before:
            group["evidence"]["possible_distribution_changes"].append(
                {"before_seconds": rows[indices[0] - 1]["time_seconds"],
                 "after_seconds": rows[indices[0]]["time_seconds"],
                 "interpretation": "possible cut, content change, or exposure change; unclassified"})
        if score > group["_representative_score"]:
            group["_representative_score"] = score
            group["representative_seconds"] = representative["time_seconds"]

    groups = list(group_map.values())
    groups.sort(key=lambda group: (-group["_representative_score"], group["id"]))
    if len(groups) > 3:
        groups = groups[:3]
    for group in groups:
        signature=(group["suggestions"]["shadows"] is not None,group["suggestions"]["highlights"] is not None)
        matching=[item["amounts"] for item in candidates if item["signature"]==signature]
        for index,field in enumerate(("shadows","highlights")):
            values=[amounts[index] for amounts in matching if amounts[index] is not None]
            group["suggestions"][field]=round(statistics.median(values),2) if values else None
        if any("tone_recommendation" in row for row in rows):
            group["evidence"]["thresholds"]={"shadow":"precision-aware dark structure and bounded luminance target",
                                                "highlight":"precision-aware bright distribution and bounded rolloff target"}
        group["evidence"]["recommendation_method"]="median of per-frame curve targets when precise summaries are available; legacy thresholds otherwise"
        group.pop("_representative_score", None)
    result["groups"] = groups
    if any(group["evidence"]["possible_distribution_changes"] for group in groups):
        limitations.append("Large adjacent quantile shifts split ranges but are not classified as shot cuts.")
    if not groups:
        limitations.append("No sampled frame passed the conservative tone thresholds and low-information guard.")
    return result


def tone_refinement_times(frame_summaries: Any, duration: float,
                          budget: int = 4) -> list[float]:
    """Prioritize midpoint seeks around sparse tone or luma-distribution changes.

    The result is an optional, bounded refinement plan. It does not locate
    precise cuts; a midpoint is only a new observation between existing
    requested seeks. At most four seeks are returned per refinement round.
    """
    if not _finite_number(duration) or duration <= 0:
        raise ValueError("duration must be a finite positive number")
    if isinstance(budget, bool) or not isinstance(budget, int) or budget < 0:
        raise ValueError("budget must be a nonnegative integer")
    if budget == 0 or not isinstance(frame_summaries, list):
        return []
    budget = min(budget, 4)

    rows: list[dict[str, Any]] = []
    seen_times: set[float] = set()
    for row in frame_summaries:
        if not isinstance(row, dict):
            continue
        time_seconds = row.get("time_seconds")
        p10, p50, p90 = (_percentile(row, name) for name in ("p10", "p50", "p90"))
        if (not _finite_number(time_seconds) or not 0 <= time_seconds <= duration
                or p10 is None or p50 is None or p90 is None):
            continue
        time_seconds = float(time_seconds)
        if time_seconds in seen_times:
            continue
        seen_times.add(time_seconds)
        p99 = _percentile(row, "p99")
        low_information = _frame_low_information(row, p10, p90)
        adaptive=_adaptive_amounts(row)
        signature = (tuple(value is not None for value in adaptive) if adaptive is not None else
                     (not low_information and p10 < 35 and p50 > 45,
                      not low_information and p99 is not None and p90 > 220 and p99 > 245))
        rows.append({"time_seconds": time_seconds, "p10": p10, "p50": p50,
                     "p90": p90, "p99": p99, "signature": signature})
    rows.sort(key=lambda row: row["time_seconds"])

    candidates: list[tuple[float, float]] = []
    existing = [row["time_seconds"] for row in rows]
    for left, right in zip(rows, rows[1:]):
        interval = right["time_seconds"] - left["time_seconds"]
        if interval <= 1.0:
            continue
        signature_changed = left["signature"] != right["signature"]
        deltas = [abs(right[key] - left[key]) for key in ("p10", "p50", "p90")]
        if left["p99"] is not None and right["p99"] is not None:
            deltas.append(abs(right["p99"] - left["p99"]))
        significant_quantiles = sum(delta >= 24 for delta in deltas)
        if not signature_changed and significant_quantiles < 2:
            continue

        # Label transitions have first priority. For matching labels, prioritize
        # larger multi-quantile distribution changes; no cut/exposure type is
        # inferred from this score.
        score = (2.0 if signature_changed else 0.0)
        score += significant_quantiles * .25
        score += sum(min(delta, 255.0) for delta in deltas) / (255.0 * len(deltas))
        midpoint = round((left["time_seconds"] + right["time_seconds"]) / 2, 6)
        if midpoint <= 0 or midpoint >= duration:
            continue
        if any(abs(midpoint - known) <= 1e-6 for known in existing):
            continue
        candidates.append((score, midpoint))

    # A rounded midpoint can coincide when floating seek timestamps are very
    # close. Keep only the highest-scoring copy before enforcing the budget.
    best_by_time: dict[float, float] = {}
    for score, midpoint in candidates:
        best_by_time[midpoint] = max(score, best_by_time.get(midpoint, -math.inf))
    selected = sorted(best_by_time.items(), key=lambda item: (-item[1], item[0]))[:budget]
    return sorted(midpoint for midpoint, _score in selected)


def _tone_amount(value: Any, name: str) -> float:
    if value is None:
        return 0.0
    if isinstance(value, dict):
        if "amount" not in value:
            raise ValueError(f"{name} must include amount")
        if value.get("region") is not None:
            raise ValueError("temporal tone segments cannot be combined with spatial tone regions")
        value = value["amount"]
    if not _finite_number(value) or not -1 <= value <= 1:
        raise ValueError(f"{name} must be finite in [-1, 1]")
    return float(value)


def _validated_segments(value: Any, duration: float) -> list[dict[str, Any]]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > MAX_TONE_SEGMENTS:
        raise ValueError(f"tone_segments must contain at most {MAX_TONE_SEGMENTS} ranges")
    fields = {"id", "start_seconds", "end_seconds", "highlights", "shadows"}
    result: list[dict[str, Any]] = []
    ids: set[str] = set()
    for item in value:
        if not isinstance(item, dict) or set(item) != fields:
            raise ValueError("each tone segment must have id, start_seconds, end_seconds, highlights, and shadows")
        segment_id = item["id"]
        start, end = item["start_seconds"], item["end_seconds"]
        if (not isinstance(segment_id, str) or not segment_id.strip() or len(segment_id) > 80
                or segment_id in ids):
            raise ValueError("tone segment IDs must be unique non-empty strings of at most 80 characters")
        ids.add(segment_id)
        if (not _finite_number(start) or not _finite_number(end)
                or start < 0 or start >= end or end > duration):
            raise ValueError("tone segment bounds must satisfy 0 <= start < end <= duration")
        for name in ("highlights", "shadows"):
            amount = item[name]
            if amount is not None and (not _finite_number(amount) or not -1 <= amount <= 1):
                raise ValueError(f"tone segment {name} must be null or finite in [-1, 1]")
        result.append({"id": segment_id, "start_seconds": float(start),
                       "end_seconds": float(end), "highlights": item["highlights"],
                       "shadows": item["shadows"]})
    result.sort(key=lambda segment: (segment["start_seconds"], segment["end_seconds"], segment["id"]))
    for previous, current in zip(result, result[1:]):
        if current["start_seconds"] < previous["end_seconds"]:
            raise ValueError("tone segments must not overlap")
    return result


def _state_key(shadows: float, highlights: float) -> str:
    return f"s={shadows.hex()};h={highlights.hex()}"


def _transition_width(left_duration: float, right_duration: float) -> float:
    # This is the complete crossfade width. It is at most 250 ms and leaves
    # room for a stable center even when an adjacent interval is short.
    return min(MAX_TRANSITION_SECONDS, left_duration / 2, right_duration / 2)


def _plan_timeline(segments: list[dict[str, Any]], base_state: tuple[float, float],
                   duration: float) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    intervals: list[dict[str, Any]] = []
    cursor = 0.0
    for segment in segments:
        state = (base_state[0] if segment["shadows"] is None else float(segment["shadows"]),
                 base_state[1] if segment["highlights"] is None else float(segment["highlights"]))
        if segment["start_seconds"] > cursor:
            intervals.append({"start_seconds": cursor, "end_seconds": segment["start_seconds"],
                              "state": base_state})
        intervals.append({"start_seconds": segment["start_seconds"],
                          "end_seconds": segment["end_seconds"], "state": state})
        cursor = segment["end_seconds"]
    if cursor < duration:
        intervals.append({"start_seconds": cursor, "end_seconds": duration, "state": base_state})

    merged: list[dict[str, Any]] = []
    for interval in intervals:
        if interval["end_seconds"] <= interval["start_seconds"]:
            continue
        if merged and merged[-1]["state"] == interval["state"]:
            merged[-1]["end_seconds"] = interval["end_seconds"]
        else:
            merged.append(dict(interval))
    transitions: list[dict[str, Any]] = []
    for index in range(1, len(merged)):
        previous, current = merged[index - 1], merged[index]
        boundary = current["start_seconds"]
        width = _transition_width(previous["end_seconds"] - previous["start_seconds"],
                                  current["end_seconds"] - current["start_seconds"])
        if width <= 0:
            continue
        transitions.append({"start_seconds": boundary - width / 2,
                            "end_seconds": boundary + width / 2,
                            "from_state": previous["state"], "to_state": current["state"]})
    return merged, transitions


def _state_at_time(intervals: list[dict[str, Any]], transitions: list[dict[str, Any]],
                   time_seconds: float) -> tuple[list[tuple[float, float]], float | None]:
    for transition in transitions:
        start, end = transition["start_seconds"], transition["end_seconds"]
        if start < time_seconds < end:
            weight = (time_seconds - start) / (end - start)
            return [transition["from_state"], transition["to_state"]], weight
    state = intervals[0]["state"]
    for transition in transitions:
        if time_seconds >= transition["end_seconds"]:
            state = transition["to_state"]
        elif time_seconds <= transition["start_seconds"]:
            break
    return [state], None


def create_tone_plan(recipe: dict[str, Any], output_dir: Path, duration: float,
                     preview_time: float | None = None,
                     source_start: float = 0.0) -> dict[str, Any] | None:
    """Create reusable LUTs and a source-time plan for accepted tone ranges.

    ``preview_time`` is source-relative and should be the selected frame's
    exact source-relative time. In preview mode, only the active state or the
    two transition endpoints are materialized.
    """
    if not isinstance(recipe, dict):
        raise ValueError("recipe must be an object")
    if not _finite_number(duration) or duration <= 0:
        raise ValueError("duration must be a finite positive number")
    if not _finite_number(source_start):
        raise ValueError("source_start must be finite")
    duration = float(duration)
    source_start = float(source_start)
    if preview_time is not None and (not _finite_number(preview_time)
                                     or preview_time < 0 or preview_time >= duration):
        raise ValueError("preview_time must be source-relative and before duration")
    segments = _validated_segments(recipe.get("tone_segments"), duration)
    if not segments:
        return None
    tone = recipe.get("tone") or {}
    if not isinstance(tone, dict):
        raise ValueError("tone must be an object")
    base_state = (_tone_amount(tone.get("shadows"), "tone.shadows"),
                  _tone_amount(tone.get("highlights"), "tone.highlights"))
    changed = []
    for segment in segments:
        state = (base_state[0] if segment["shadows"] is None else float(segment["shadows"]),
                 base_state[1] if segment["highlights"] is None else float(segment["highlights"]))
        if state != base_state:
            changed.append(segment)
    if not changed:
        return None

    intervals, transitions = _plan_timeline(changed, base_state, duration)
    mode = "preview" if preview_time is not None else "render"
    if preview_time is None:
        required_states = [interval["state"] for interval in intervals]
        required_intervals = intervals
        required_transitions = transitions
    else:
        required_states, weight = _state_at_time(intervals, transitions, float(preview_time))
        if weight is None:
            required_intervals = []
            required_transitions = []
        else:
            required_intervals = []
            required_transitions = [{"start_seconds": 0.0, "end_seconds": 1.0,
                                     "from_state": required_states[0],
                                     "to_state": required_states[1],
                                     "preview_weight": weight}]

    state_map: dict[str, dict[str, Any]] = {}
    staging_dir: str | None = None
    paths: list[str] = []
    if required_states:
        output_root = Path(output_dir)
        output_root.mkdir(parents=True, exist_ok=True)
        staging = Path(tempfile.mkdtemp(prefix=".tone-plan-", dir=output_root))
        staging_dir = str(staging)
        try:
            for shadows, highlights in required_states:
                key = _state_key(shadows, highlights)
                if key in state_map:
                    continue
                lut = create_tone_lut({"tone": {"shadows": shadows,
                                                 "highlights": highlights,
                                                 "low_light": tone.get("low_light")}}, staging)
                entry = {"key": key, "shadows": shadows, "highlights": highlights,
                         "low_light": tone.get("low_light"),
                         "path": lut["path"] if lut else None,
                         "shaper_path": lut["shaper_path"] if lut else None,
                         "sha256": lut["sha256"] if lut else None,
                         "algorithm_version": TONE_ALGORITHM_VERSION}
                state_map[key] = entry
                if entry["path"]:
                    paths.append(entry["path"])
        except BaseException:
            import shutil
            shutil.rmtree(staging, ignore_errors=True)
            raise

    def describe_state(state: tuple[float, float]) -> dict[str, Any]:
        return state_map[_state_key(*state)]

    plan = {
        "version": 1,
        "basis": "approved-source-time-ranges",
        "mode": mode,
        "duration_seconds": duration,
        "source_start_seconds": source_start,
        "preview_time_seconds": float(preview_time) if preview_time is not None else None,
        "base_state": {"shadows": base_state[0], "highlights": base_state[1]},
        "states": list(state_map.values()),
        "timeline": [{"start_seconds": interval["start_seconds"],
                       "end_seconds": interval["end_seconds"],
                       "state": describe_state(interval["state"])}
                      for interval in required_intervals],
        "transitions": [{**transition,
                         "from_state": describe_state(transition["from_state"]),
                         "to_state": describe_state(transition["to_state"])}
                        for transition in required_transitions],
        "paths": paths,
        "staging_dir": staging_dir,
        "algorithm_version": TONE_ALGORITHM_VERSION,
        "_blend_weight": (required_transitions[0].get("preview_weight")
                          if mode == "preview" and required_transitions else None),
    }
    if mode == "preview":
        if plan["transitions"]:
            plan["preview_states"] = [describe_state(state) for state in required_states]
        else:
            plan["preview_states"] = [describe_state(required_states[0])]
    return plan


def _label(value: str | None, default: str) -> str:
    label = default if value is None else value
    if not isinstance(label, str) or not _LABEL_RE.fullmatch(label):
        raise ValueError("filter labels must contain only letters, digits, and underscores")
    return label


def _branch_filter(state: dict[str, Any], *, enable: str | None = None) -> str:
    path = state.get("path")
    if path is None:
        return "null"
    if not isinstance(path, str) or _FILTER_PATH_RE.search(path):
        raise ValueError("LUT path contains unsupported filter characters")
    timeline = f":enable='{enable}'" if enable is not None else ""
    return tone_lut_filter(state, enable=enable)


def tone_plan_filter(plan: dict[str, Any] | None, input_label: str | None = None,
                     output_label: str | None = None) -> dict[str, str] | None:
    """Build a filter_complex fragment consuming one preconverted RGB stream.

    Returned labels omit square brackets. Callers should connect their
    already-domain-converted stream to ``input_label`` and use
    ``output_label`` for the following filter chain. The graph blends complete
    LUT outputs, never interpolated slider values.
    """
    if plan is None:
        return None
    if not isinstance(plan, dict) or plan.get("version") != 1:
        raise ValueError("tone plan is invalid")
    prefix = f"hvp_tone_{next(_LABELS):06d}"
    source = _label(input_label, prefix + "_input")
    output = _label(output_label, prefix + "_output")
    mode = plan.get("mode")
    graph: list[str] = []

    if mode == "preview":
        states = plan.get("preview_states")
        if not isinstance(states, list) or len(states) not in (1, 2):
            raise ValueError("preview tone plan must contain one state or two transition endpoints")
        if len(states) == 1:
            graph.append(f"[{source}]format=gbrpf32le,{_branch_filter(states[0])}[{output}]")
        else:
            first, second = f"{prefix}_a", f"{prefix}_b"
            left, right = f"{prefix}_left", f"{prefix}_right"
            weight = plan.get("_blend_weight")
            if not _finite_number(weight) or not 0 <= weight <= 1:
                raise ValueError("preview tone blend weight is invalid")
            graph.extend((
                f"[{source}]format=gbrpf32le,split=2[{first}][{second}]",
                f"[{first}]{_branch_filter(states[0])}[{left}]",
                f"[{second}]{_branch_filter(states[1])}[{right}]",
                f"[{left}][{right}]blend=all_expr='A*(1-{weight:.12g})+B*{weight:.12g}':shortest=1[{output}]",
            ))
    elif mode == "render":
        intervals = plan.get("timeline")
        transitions = plan.get("transitions")
        if not isinstance(intervals, list) or not intervals:
            raise ValueError("render tone plan has no timeline")
        if len(transitions) != len(intervals) - 1:
            raise ValueError("render tone plan transition count does not match timeline")
        branch_labels = [f"{prefix}_source_{index}" for index in range(len(intervals))]
        state_labels = [f"{prefix}_state_{index}" for index in range(len(intervals))]
        accumulator_labels = [f"{prefix}_mix_{index}" for index in range(len(intervals) - 1)]
        if len(intervals) == 1:
            graph.append(f"[{source}]format=gbrpf32le,{_branch_filter(intervals[0]['state'])}[{output}]")
        else:
            split = (f"[{source}]format=gbrpf32le,split={len(intervals)}"
                     + "".join(f"[{label}]" for label in branch_labels))
            graph.append(split)
            for index, interval in enumerate(intervals):
                if index == 0:
                    enable_start = plan["source_start_seconds"]
                    enable_end = plan["source_start_seconds"] + transitions[0]["end_seconds"]
                else:
                    enable_start = plan["source_start_seconds"] + transitions[index - 1]["start_seconds"]
                    enable_end = (plan["source_start_seconds"] + transitions[index]["end_seconds"]
                                  if index < len(transitions) else
                                  plan["source_start_seconds"] + plan["duration_seconds"])
                enable = (f"between(t,{enable_start:.12g},{enable_end:.12g})"
                          if interval["state"].get("path") is not None else None)
                graph.append(f"[{branch_labels[index]}]"
                             f"{_branch_filter(interval['state'], enable=enable)}"
                             f"[{state_labels[index]}]")
            for index, transition in enumerate(transitions):
                start, end = transition["start_seconds"], transition["end_seconds"]
                width = end - start
                if width <= 0:
                    raise ValueError("render tone transition has invalid bounds")
                start_expr = f"({plan['source_start_seconds']:.12g}+{start:.12g})"
                weight_expr = f"clip((T-{start_expr})/{width:.12g},0,1)"
                left = state_labels[0] if index == 0 else accumulator_labels[index - 1]
                right = state_labels[index + 1]
                target = output if index == len(transitions) - 1 else accumulator_labels[index]
                enable_start = plan["source_start_seconds"] + start
                enable_end = (plan["source_start_seconds"] + transitions[index + 1]["end_seconds"]
                              if index + 1 < len(transitions) else
                              plan["source_start_seconds"] + plan["duration_seconds"])
                enable_expr = f"between(t,{enable_start:.12g},{enable_end:.12g})"
                graph.append(f"[{left}][{right}]blend=all_expr='A*(1-{weight_expr})+B*{weight_expr}'"
                             f":shortest=1:enable='{enable_expr}'[{target}]")
    else:
        raise ValueError("tone plan mode must be preview or render")
    return {"graph": ";".join(graph), "input_label": source, "output_label": output}
