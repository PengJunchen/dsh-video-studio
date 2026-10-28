#!/usr/bin/env python3
"""Local, single-request FFmpeg media worker.

The trusted runtime supplies paths and a frozen recipe.  No input file is
modified.  All image operations are explicit and null means disabled.
"""

from __future__ import annotations

import argparse
from bisect import bisect_left
from concurrent.futures import ThreadPoolExecutor
from fractions import Fraction
import hashlib
from itertools import count
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Any

from tone_lut import (HIGHLIGHT_END, HIGHLIGHT_START, SHADOW_END, SHADOW_START,
                      TONE_ALGORITHM_VERSION, LOW_LIGHT_ALGORITHM_VERSION, create_tone_lut, tone_lut_filter)
from tone_advisor import summarize_rgb16
from source_identity import verified_digest, SourceIdentityError
from skin_treatment import build_skin_filter, normalize_skin
from tone_segments import analyze_tone_intervals, create_tone_plan, tone_plan_filter, tone_refinement_times
from video_denoise import normalize_denoise, denoise_filter, denoise_metadata, noise_metrics
from export_validation import decoded_video_facts, ExportValidationError
from preview_color import display_png_frame_filter, display_png_options
from filter_paths import filter_file


VIDEO_EXTENSIONS = {".mp4", ".mov", ".m4v", ".mkv"}
MODES = {"dlog": "dlog", "dlog2": "dlog2", "dlogm": "dlogm", "rec709": "rec709",
         "hlg": "hlg", "rec2100hlg": "hlg", "pq": "pq", "rec2100pq": "pq"}
CAMERAS = {"pp-041": "pocket4p", "osmo pocket 4p": "pocket4p", "pocket 4p": "pocket4p", "osmo pocket 4": "pocket4", "pocket 4": "pocket4", "osmo pocket 3": "pocket3", "pocket 3": "pocket3"}
PROFILE_KEYS = {"com.dji.camera.colorgammasxs", "djicameracolorgammasxs"}
MODEL_KEYS = {"com.dji.camera.cameramodel", "djicameramodel"}
MAX_FILES = 10000
_SKIN_ROI_LABELS = count(1)
_DENOISE_LABELS = count(1)
HUE_MASK_FORMULA_VERSION = 2


class WorkerError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def run(cmd: list[str], *, timeout: int | None = None) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(cmd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, check=False)
    except FileNotFoundError as exc:
        raise WorkerError("dependency_missing", f"Executable unavailable: {cmd[0]}") from exc
    except subprocess.TimeoutExpired as exc:
        raise WorkerError("tool_timeout", f"Timed out: {cmd[0]}") from exc


def checked(cmd: list[str], *, timeout: int | None = None) -> str:
    result = run(cmd, timeout=timeout)
    if result.returncode:
        raise WorkerError("media_tool_failed", f"{Path(cmd[0]).name}: {result.stderr[-1800:].strip()}")
    return result.stdout


def digest_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(8 * 1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def digest_json(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def ffprobe(path: Path, *, frames: bool = False) -> dict[str, Any]:
    command = ["ffprobe", "-v", "error", "-of", "json"]
    if frames:
        command += ["-count_frames"]
    command += ["-show_format", "-show_streams", str(path)]
    try:
        result = json.loads(checked(command))
    except json.JSONDecodeError as exc:
        raise WorkerError("probe_invalid", "ffprobe returned invalid JSON") from exc
    if not any(s.get("codec_type") == "video" for s in result.get("streams", [])):
        raise WorkerError("no_video_stream", "No video stream")
    return result


def video_stream(info: dict[str, Any]) -> dict[str, Any]:
    return next(s for s in info["streams"] if s.get("codec_type") == "video")


def norm_mode(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    return MODES.get(re.sub(r"[\s_.-]+", "", value.strip().lower()))


def norm_camera(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip().lower().removeprefix("dji ")
    return CAMERAS.get(value, value if re.fullmatch(r"[a-z][a-z0-9]{2,30}", value) else None)


def capture_profile(info: dict[str, Any]) -> dict[str, Any]:
    declarations: dict[str, set[str]] = {"mode": set(), "camera": set()}
    raw: dict[str, str] = {}
    unsupported_modes: set[str] = set()
    scopes = [info.get("format", {})] + info.get("streams", [])
    for scope in scopes:
        for key, value in scope.get("tags", {}).items():
            key_lower = key.lower()
            if key_lower in PROFILE_KEYS:
                raw[key] = str(value)
                mode = norm_mode(value)
                if mode:
                    declarations["mode"].add(mode)
                elif str(value).strip():
                    unsupported_modes.add(str(value).strip())
            if key_lower in MODEL_KEYS:
                raw[key] = str(value)
                camera = norm_camera(value)
                if camera:
                    declarations["camera"].add(camera)
    if any(len(items) > 1 for items in declarations.values()) or (declarations["mode"] and unsupported_modes):
        status = "conflict"
    elif declarations["mode"]:
        status = "metadata"
    elif unsupported_modes:
        status = "unsupported"
    else:
        status = "unknown"
    return {"camera": next(iter(declarations["camera"])) if len(declarations["camera"]) == 1 else None,
            "mode": next(iter(declarations["mode"])) if len(declarations["mode"]) == 1 else None,
            "status": status, "raw": raw,
            "mode_source": "metadata" if len(declarations["mode"]) == 1 else None,
            "camera_source": "metadata" if len(declarations["camera"]) == 1 else None}


def effective_profile(info: dict[str, Any], recipe: dict[str, Any]) -> dict[str, Any]:
    found = capture_profile(info)
    selected_mode = norm_mode(recipe.get("profile"))
    selected_camera = norm_camera(recipe.get("camera_model"))
    if recipe.get("profile") is not None and selected_mode is None:
        raise WorkerError("profile_unknown", f"Unsupported profile: {recipe['profile']}")
    if recipe.get("camera_model") is not None and selected_camera is None:
        raise WorkerError("camera_unknown", f"Unsupported camera: {recipe['camera_model']}")
    if found["status"] == "conflict":
        raise WorkerError("capture_conflict", "Conflicting camera capture metadata")
    if selected_mode and found["mode"] and selected_mode != found["mode"]:
        raise WorkerError("capture_conflict", "Selected mode conflicts with capture metadata")
    if selected_camera and found["camera"] and selected_camera != found["camera"]:
        raise WorkerError("capture_conflict", "Selected camera conflicts with capture metadata")
    if selected_mode or selected_camera:
        return {"camera": selected_camera or found["camera"], "mode": selected_mode or found["mode"],
                "status": "user-declared" if selected_mode and not found["mode"] else found["status"],
                "raw": found["raw"],
                "mode_source": "metadata" if found["mode"] else "user-declared" if selected_mode else None,
                "camera_source": "metadata" if found["camera"] else "user-declared" if selected_camera else None}
    return found


def load_catalog(assets: dict[str, Any]) -> tuple[list[dict[str, Any]], Path] | None:
    catalog_name, lut_root_name = assets.get("catalog_path"), assets.get("lut_root")
    if not catalog_name or not lut_root_name:
        return None
    catalog_path, lut_root = Path(catalog_name), Path(lut_root_name)
    if not catalog_path.is_absolute() or not lut_root.is_absolute():
        raise WorkerError("asset_path_invalid", "Catalog and LUT root must be absolute")
    try:
        catalog = json.loads(catalog_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise WorkerError("catalog_invalid", f"Cannot read catalog: {exc}") from exc
    if catalog.get("version") != 2 or not isinstance(catalog.get("entries"), list):
        raise WorkerError("catalog_invalid", "Expected version 2 LUT catalog")
    entries = list(catalog["entries"])
    # The automatic catalog can intentionally retain only one grid size.
    # Supplement sizes from an explicitly configured library, but only for the
    # exact camera/profile/look/version already approved in that catalog.
    library_name = assets.get("library_path")
    if library_name:
        library_path = Path(library_name)
        if not library_path.is_absolute():
            raise WorkerError("asset_path_invalid", "Library path must be absolute")
        try:
            library = json.loads(library_path.read_text())
        except (OSError, json.JSONDecodeError) as exc:
            raise WorkerError("catalog_invalid", f"Cannot read LUT library: {exc}") from exc
        if library.get("schema") != 1 or not isinstance(library.get("assets"), list):
            raise WorkerError("catalog_invalid", "Expected schema 1 LUT library")
        approved = {(e.get("camera"), e.get("profile"), e.get("look"), e.get("version")) for e in entries}
        identities = {(e.get("camera"), e.get("profile"), e.get("look"), e.get("grid"), e.get("sha256")) for e in entries}
        for item in library["assets"]:
            if (item.get("purpose") != "restore" or item.get("output_color_space") != "rec709"
                    or item.get("format") != "cube" or item.get("dimension") != "3d"):
                continue
            for camera in item.get("cameras", []):
                if camera.get("engine_id_confirmed") is not True:
                    continue
                entry = {key: item.get(key) for key in ("profile", "look", "version", "grid", "sha256", "file", "title", "purpose", "output_color_space")}
                entry["camera"] = camera.get("id")
                identity = (entry["camera"], entry["profile"], entry["look"], entry["grid"], entry["sha256"])
                if (*identity[:3], entry["version"]) in approved and identity not in identities:
                    entries.append(entry)
                    identities.add(identity)
    return entries, lut_root.resolve()


def lut_grid(path: Path) -> int:
    with path.open(encoding="utf-8-sig") as stream:
        for _, line in zip(range(256), stream):
            match = re.fullmatch(r"\s*LUT_3D_SIZE\s+(\d+)\s*(?:#.*)?", line.strip())
            if match:
                grid = int(match.group(1))
                if 2 <= grid <= 129:
                    return grid
                break
    raise WorkerError("catalog_invalid", "LUT must declare a supported 3D grid")


def lut_candidates(profile: dict[str, Any], catalog: tuple[list[dict[str, Any]], Path] | None) -> list[dict[str, Any]]:
    if catalog is None or profile.get("mode") not in {"dlog", "dlogm", "dlog2"} or not profile.get("camera"):
        return []
    entries, root = catalog
    result = []
    for entry in entries:
        if (entry.get("camera") != profile["camera"] or entry.get("profile") != profile["mode"]
                or entry.get("purpose") != "restore" or entry.get("output_color_space") != "rec709"
                or entry.get("look") not in {"standard", "vivid"}):
            continue
        expected, basename = entry.get("sha256", ""), entry.get("file", "")
        if not re.fullmatch(r"[a-f0-9]{64}", expected) or basename != f"sha256-{expected}.cube":
            raise WorkerError("catalog_invalid", "Invalid LUT file/hash")
        path = root / basename
        exists = path.is_file() and path.resolve().parent == root
        grid = entry.get("grid")
        if grid is None and exists:
            grid = lut_grid(path)
        if grid is not None and (isinstance(grid, bool) or not isinstance(grid, int) or not 2 <= grid <= 129):
            raise WorkerError("catalog_invalid", "Invalid LUT grid")
        result.append({"look": entry["look"], "grid": grid, "sha256": expected,
                       "title": entry.get("title"), "version": entry.get("version"),
                       "path": str(path), "available": exists})
    return result


def public_lut_options(profile: dict[str, Any], catalog: tuple[list[dict[str, Any]], Path] | None) -> list[dict[str, Any]]:
    return [{key: row[key] for key in ("look", "grid", "sha256", "title", "available")}
            for row in lut_candidates(profile, catalog)]


def match_lut(profile: dict[str, Any], look: str | None, catalog: tuple[list[dict[str, Any]], Path] | None,
              *, grid: int | None = None, verify: bool = False) -> dict[str, Any]:
    if look is not None and look not in {"standard", "vivid"}:
        raise WorkerError("recipe_invalid", "look must be standard or vivid")
    if grid is not None and (isinstance(grid, bool) or not isinstance(grid, int) or not 2 <= grid <= 129):
        raise WorkerError("recipe_invalid", "lut_grid must be an integer in [2,129]")
    if profile.get("mode") in {"hlg", "pq"}:
        return {"available": False, "reason": "hdr_input_unsupported"}
    if profile.get("mode") == "rec709":
        return {"available": False, "reason": "input_is_rec709"}
    if not profile.get("mode") or not profile.get("camera"):
        return {"available": False, "reason": "camera_or_profile_unknown"}
    if catalog is None:
        return {"available": False, "reason": "catalog_not_configured"}
    matches = [entry for entry in lut_candidates(profile, catalog)
               if (look is None or entry["look"] == look) and (grid is None or entry["grid"] == grid)]
    if matches:
        # Automatic preference: Vivid, then Size65, then the largest supported
        # size. Explicit look/grid requests never cross those filters.
        preferred = min(matches, key=lambda e: (not e["available"], e["look"] != "vivid", e["grid"] != 65, -(e["grid"] or 0)))
        matches = [entry for entry in matches if entry["look"] == preferred["look"] and entry["grid"] == preferred["grid"]]
    if len(matches) != 1:
        return {"available": False, "reason": "exact_lut_missing" if not matches else "ambiguous_lut"}
    entry = matches[0]
    expected, path = entry["sha256"], Path(entry["path"])
    if not entry["available"]:
        return {"available": False, "reason": "lut_file_missing"}
    if verify and digest_file(path) != expected:
        raise WorkerError("lut_hash_mismatch", "LUT bytes differ from catalog SHA-256")
    if verify and lut_grid(path) != entry["grid"]:
        raise WorkerError("lut_grid_mismatch", "LUT grid differs from catalog")
    return {"available": True, "reason": None, "sha256": expected, "title": entry.get("title"), "version": entry.get("version"),
            "path": str(path), "output_color_space": "rec709", "look": entry["look"], "grid": entry["grid"],
            "requested_look": look, "requested_grid": grid}


def source_files(path: Path) -> list[Path]:
    if not path.is_absolute():
        raise WorkerError("source_path_invalid", "Source path must be absolute")
    if path.is_file():
        return [path]
    if not path.is_dir():
        raise WorkerError("source_missing", f"Source unavailable: {path}")
    found: list[Path] = []
    for base, folders, files in os.walk(path, followlinks=False):
        folders[:] = sorted(d for d in folders if not (Path(base) / d).is_symlink())
        for name in sorted(files):
            item = Path(base) / name
            if item.suffix.lower() in VIDEO_EXTENSIONS and not item.is_symlink():
                found.append(item)
                if len(found) > MAX_FILES:
                    raise WorkerError("scan_limit", f"Directory has more than {MAX_FILES} video files")
    return found


def source_stat_signature(path: Path) -> dict[str, int]:
    stat = path.stat()
    return {"device": stat.st_dev, "inode": stat.st_ino, "size": stat.st_size,
            "mtime_ns": stat.st_mtime_ns, "ctime_ns": stat.st_ctime_ns}


def _duration_value(value: Any) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) and result > 0 else None


def _finite_time_value(value: Any) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _matroska_duration_tag(value: Any) -> float | None:
    if not isinstance(value, str):
        return None
    parts = value.strip().split(":")
    if len(parts) != 3:
        return None
    try:
        hours, minutes, seconds = int(parts[0]), int(parts[1]), float(parts[2])
    except ValueError:
        return None
    result = hours * 3600 + minutes * 60 + seconds
    return result if hours >= 0 and 0 <= minutes < 60 and math.isfinite(result) and result > 0 else None


def source_relative_duration(info: dict[str, Any]) -> tuple[float, str]:
    """Return playable duration on the first video frame's relative clock.

    Most containers provide a stream duration directly. Matroska commonly
    omits it and exposes the final timeline timestamp as a DURATION tag; only
    there do we translate that endpoint back to elapsed duration. For a
    format-level fallback, require its start timestamp to agree with the video
    stream start before interpreting the format duration as an endpoint.
    """
    stream = video_stream(info)
    stream_duration = _duration_value(stream.get("duration"))
    if stream_duration is not None:
        return stream_duration, "video_stream_duration"

    format_info = info.get("format") or {}
    format_duration = _duration_value(format_info.get("duration")) or 0.0
    format_name = str(format_info.get("format_name") or "").lower().split(",")
    if not any(name in {"matroska", "webm"} for name in format_name):
        return format_duration, "format_duration" if format_duration else "duration_unavailable"

    stream_start = _finite_time_value(stream.get("start_time"))
    if stream_start is None and stream.get("start_pts") is not None:
        try:
            stream_start = float(Fraction(stream["start_pts"]) * Fraction(stream.get("time_base") or "1"))
        except (TypeError, ValueError, ZeroDivisionError):
            stream_start = None
    stream_start = stream_start if stream_start is not None else 0.0

    tags = stream.get("tags") if isinstance(stream.get("tags"), dict) else {}
    duration_end = _matroska_duration_tag(tags.get("DURATION"))
    if duration_end is not None:
        # Matroska's stream DURATION tag is an endpoint on the stream PTS clock.
        if duration_end > stream_start:
            return duration_end - stream_start, "matroska_stream_duration_endpoint"
        return duration_end, "matroska_stream_duration_tag"

    format_start = _finite_time_value(format_info.get("start_time"))
    if (format_start is not None and format_start > 0 and
            abs(format_start - stream_start) <= .001 and format_duration > format_start):
        return format_duration - format_start, "matroska_format_duration_endpoint"
    return format_duration, "format_duration" if format_duration else "duration_unavailable"


def asset_probe(path: Path, recipe: dict[str, Any], catalog: tuple[list[dict[str, Any]], Path] | None,
                source_cache_dir: str | None = None) -> tuple[dict[str, Any], dict[str, Any]]:
    source_stat_before = source_stat_signature(path)
    info = ffprobe(path)
    stream = video_stream(info)
    profile = effective_profile(info, recipe)
    duration, duration_basis = source_relative_duration(info)
    lut = match_lut(profile, recipe.get("look"), catalog, grid=recipe.get("lut_grid"))
    lut.pop("path", None)
    try:
        source_sha256,identity_cache_hit = verified_digest(path,source_stat_before,source_cache_dir,digest_file,source_stat_signature)
    except SourceIdentityError as exc:
        raise WorkerError("source_identity_cache_invalid", str(exc)) from exc
    source_stat_after = source_stat_signature(path)
    if source_stat_before != source_stat_after:
        raise WorkerError("source_changed_during_probe", "Source bytes changed while probing")
    # Keep this private in the ffprobe result: render() can cheaply confirm
    # the already SHA-256-identified preview source stayed on the same inode.
    info["_source_stat_signature"] = source_stat_after
    asset = {"id": source_sha256, "name": path.name, "source_path": str(path), "sha256": source_sha256,
             "width": stream.get("width"), "height": stream.get("height"), "duration": duration,
             "profile": profile, "lut": lut, "lut_options": public_lut_options(profile, catalog),
             "media_facts": {"source_identity_cache_hit":identity_cache_hit, "codec": stream.get("codec_name"), "pixel_format": stream.get("pix_fmt"),
                             "color_range": stream.get("color_range"), "color_transfer": stream.get("color_transfer"),
                             "color_primaries": stream.get("color_primaries"), "time_base": stream.get("time_base"),
                             "frame_rate": stream.get("avg_frame_rate"), "duration_basis": duration_basis,
                             "audio_streams": sum(s.get("codec_type") == "audio" for s in info.get("streams", []))}}
    return asset, info


def number(value: Any, name: str, minimum: float, maximum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or not minimum <= value <= maximum:
        raise WorkerError("recipe_invalid", f"{name} must be finite in [{minimum}, {maximum}]")
    return float(value)


def low_light_setting(tone: dict[str, Any]) -> float:
    value = tone.get("low_light")
    amount = number(0 if value is None else value, "tone.low_light", 0, 1)
    if amount and any(item and item["region"] for item in
                      (term(tone.get("shadows"), "tone.shadows"), term(tone.get("highlights"), "tone.highlights"))):
        raise WorkerError("recipe_unsupported", "Low-light enhancement requires global tone controls or confirmed time ranges")
    return amount


def term(value: Any, name: str) -> dict[str, Any] | None:
    if value is None:
        return None
    if isinstance(value, (float, int)) and not isinstance(value, bool):
        return {"amount": number(value, name, -1, 1), "region": None}
    if not isinstance(value, dict) or "amount" not in value:
        raise WorkerError("recipe_invalid", f"{name} must be a number or amount/region object")
    amount = number(value["amount"], f"{name}.amount", -1, 1)
    region = value.get("region")
    if region is not None:
        if not isinstance(region, dict):
            raise WorkerError("recipe_invalid", f"{name}.region must be an object")
        for key in ("x", "y", "width", "height"):
            number(region.get(key), f"{name}.region.{key}", 0, 1)
        if region["x"] + region["width"] > 1 or region["y"] + region["height"] > 1 or region["width"] == 0 or region["height"] == 0:
            raise WorkerError("recipe_invalid", f"{name}.region exceeds frame")
        number(region.get("feather", 0), f"{name}.region.feather", 0, 0.25)
    return {"amount": amount, "region": region}


def skin_settings(value: Any) -> dict[str, Any] | None:
    try:
        return normalize_skin(value)
    except ValueError as exc:
        raise WorkerError("recipe_invalid", str(exc)) from exc


def skin_enabled(settings: dict[str, Any] | None) -> bool:
    return settings is not None and any(settings[key] != 0 for key in ("amount", "brightness", "smoothness"))


def fmt(value: float) -> str:
    return f"{value:.8g}"


def step(a: float, b: float, x: str) -> str:
    t = f"clip(({x}-{fmt(a)})/{fmt(b-a)},0,1)"
    return f"({t}*{t}*(3-2*{t}))"


def region_expr(region: dict[str, Any] | None, *, x_expr: str = "X/W", y_expr: str = "Y/H") -> str:
    if region is None:
        return "1"
    x, y = float(region["x"]), float(region["y"])
    right, bottom = x + float(region["width"]), y + float(region["height"])
    f = float(region.get("feather", 0))
    if f == 0:
        return f"(between({x_expr},{fmt(x)},{fmt(right)})*between({y_expr},{fmt(y)},{fmt(bottom)}))"
    return f"({step(x,x+f,x_expr)}*(1-{step(right-f,right,x_expr)})*{step(y,y+f,y_expr)}*(1-{step(bottom-f,bottom,y_expr)}))"


def skin_crop_rect(track: dict[str, Any], width: int, height: int,
                   smoothness: float) -> dict[str, int]:
    """Bound costly skin work to the union of tracked face candidates.

    The fixed crop preserves frame PTS. Padding supplies the bilateral filter
    with neighboring pixels; the final per-frame face mask still decides which
    output pixels may change.
    """
    regions = [region for frame in track["frame_regions"] for region in frame]
    if not regions:
        raise WorkerError("skin_subject_unavailable", "No tracked face regions")
    sigma_s = (1.5 + smoothness*6.5) * width/960
    padding = math.ceil(max(8, 5*sigma_s))
    x0 = max(0, math.floor(min(item["x"] for item in regions)*width)-padding)
    y0 = max(0, math.floor(min(item["y"] for item in regions)*height)-padding)
    x1 = min(width, math.ceil(max(item["x"]+item["width"] for item in regions)*width)+padding)
    y1 = min(height, math.ceil(max(item["y"]+item["height"] for item in regions)*height)+padding)
    return {"x": x0, "y": y0, "width": x1-x0, "height": y1-y0, "padding": padding}


def skin_roi_filter(skin_filter: str, crop: dict[str, int], width: int, height: int) -> str:
    """Replace only the cropped rectangle; the skin filter gates within it."""
    prefix = f"hvp_roi_{next(_SKIN_ROI_LABELS):06d}"
    original, candidate, mask_source = (f"{prefix}_{name}" for name in ("original", "candidate", "mask_source"))
    treated, mask = f"{prefix}_treated", f"{prefix}_mask"
    x,y,w,h = (crop[key] for key in ("x", "y", "width", "height"))
    mask_expr = f"between(X,{x},{x+w-1})*between(Y,{y},{y+h-1})*1023"
    return ";".join((
        f"split=3[{original}][{candidate}][{mask_source}]",
        f"[{candidate}]crop={w}:{h}:{x}:{y},{skin_filter},pad={width}:{height}:{x}:{y}:color=black[{treated}]",
        f"[{mask_source}]format=gray10le,geq=lum='{mask_expr}':i=nearest[{mask}]",
        f"[{original}][{treated}][{mask}]maskedmerge=planes=7",
    ))


def geq_filter(transform: list[str]) -> str:
    # Values are 10-bit RGB code values after the optional Rec.709 LUT.
    channel = {"R": "r(X,Y)", "G": "g(X,Y)", "B": "b(X,Y)"}
    luminance = f"((0.2126*{channel['R']}+0.7152*{channel['G']}+0.0722*{channel['B']})/1023)"
    result: list[str] = []
    for name in ("R", "G", "B"):
        expr = channel[name]
        for operation in transform:
            if operation.startswith("tone:"):
                _, kind, raw_amount, spatial = operation.split(":", 3)
                amount = f"({fmt(float(raw_amount))}*{spatial})"
                if kind == "shadows":
                    t = "(ld(4)/.4)"
                    slope = f"pow(2,4*{amount})"
                    gain = f"if(lt(ld(4),.4),({t}+{slope}*(1-{t}))/(1+({slope}-1)*{t}*(1-{t})),1)"
                else:
                    distance = "(ld(4)-.55)"
                    endpoint = f"pow(2,2*{amount})"
                    mapped = (f"(.55+if(lt({amount},0),{distance}/(1+(1/{endpoint}-1)*{distance}/.45),"
                              f"{distance}*(1+({endpoint}-1)*{distance}/.45)))")
                    gain = f"if(gt(ld(4),.55),{mapped}/max(ld(4),.0000001),1)"
                expr = f"(st(4,{luminance});{expr}*({gain}))"
            elif operation.startswith("sat:"):
                _, raw_amount, mask, spatial = operation.split(":", 3)
                gain = f"(1+{fmt(float(raw_amount)*.35)}*{mask}*{spatial})"
                expr = f"(st(0,{luminance}*1023);ld(0)+({expr}-ld(0))*{gain})"
        result.append(f"{name.lower()}='clip({expr},0,1023)'")
    return "geq=" + ":".join(result) + ":i=nearest"


def hue_expr() -> str:
    r, g, b = "r(X,Y)", "g(X,Y)", "b(X,Y)"
    return f"mod(atan2(1.7320508*({g}-{b}),2*{r}-{g}-{b})*180/PI+360,360)"


def hue_mask(hue: float, width: float) -> str:
    distance = f"abs(mod(({hue_expr()})-{fmt(hue)}+540,360)-180)"
    inner = max(0, width - 12)
    outer = min(180, width + 12)
    if outer == inner:
        outer = inner + .001
    chroma = "(max(r(X,Y),max(g(X,Y),b(X,Y)))-min(r(X,Y),min(g(X,Y),b(X,Y))))/1023"
    hue_t = f"clip(({distance}-{fmt(inner)})/{fmt(outer-inner)},0,1)"
    chroma_t = f"clip(({chroma}-.03)/.07,0,1)"
    # Registers 0/1 belong to the surrounding local-color and skin expressions.
    # The left-associated expression sequences stores and reads without a
    # semicolon, keeping this valid inside skin_treatment's mask expression.
    return (f"((1-st(8,{hue_t})*ld(8)*(3-2*ld(8)))"
            f"*st(9,{chroma_t})*ld(9)*(3-2*ld(9)))")


def vision_track(source: Path, assets: dict[str, Any], *, mask_output: Path | None = None,
                 fps: str | None = None) -> dict[str, Any]:
    interpreter = assets.get("vision_python") or sys.executable
    if not isinstance(interpreter, str) or not Path(interpreter).is_absolute() or not os.access(interpreter, os.X_OK):
        raise WorkerError("skin_vision_unavailable", "An executable absolute assets.vision_python is required")
    script = Path(__file__).with_name("vision_tracker.py")
    command = [interpreter, str(script), "--source-path", str(source), "--max-segments", "12"]
    if mask_output is not None:
        command += ["--mask-output", str(mask_output), "--fps", str(fps)]
    process = run(command)
    try:
        result = json.loads(process.stdout)
    except json.JSONDecodeError as exc:
        raise WorkerError("skin_vision_unavailable", process.stderr[-1000:] or "Face tracker did not return JSON") from exc
    if process.returncode or result.get("status") != "ok":
        raise WorkerError("skin_vision_unavailable", result.get("error") or process.stderr[-1000:] or "Face tracker failed")
    return result


def vision_sample_faces(source: Path, assets: dict[str, Any]) -> dict[str, Any]:
    interpreter = assets.get("vision_python") or sys.executable
    if not isinstance(interpreter, str) or not Path(interpreter).is_absolute() or not os.access(interpreter, os.X_OK):
        raise WorkerError("skin_vision_unavailable", "An executable absolute assets.vision_python is required")
    process = run([interpreter, str(Path(__file__).with_name("vision_tracker.py")),
                   "--source-path", str(source), "--sample-count", "5"])
    try:
        result = json.loads(process.stdout)
    except json.JSONDecodeError as exc:
        raise WorkerError("skin_vision_unavailable", process.stderr[-1000:] or "Sparse face detector did not return JSON") from exc
    if process.returncode or result.get("status") != "ok":
        raise WorkerError("skin_vision_unavailable", result.get("error") or process.stderr[-1000:] or "Sparse face detector failed")
    return {key: value for key,value in result.items() if key != "status"}


def vision_preview_frame(source: Path, assets: dict[str, Any], frame_index: int) -> dict[str, Any]:
    interpreter = assets.get("vision_python") or sys.executable
    if not isinstance(interpreter, str) or not Path(interpreter).is_absolute() or not os.access(interpreter, os.X_OK):
        raise WorkerError("skin_vision_unavailable", "An executable absolute assets.vision_python is required")
    process = run([interpreter, str(Path(__file__).with_name("vision_tracker.py")),
                   "--source-path", str(source), "--preview-frame-index", str(frame_index)])
    try:
        result = json.loads(process.stdout)
    except json.JSONDecodeError as exc:
        raise WorkerError("skin_vision_unavailable", process.stderr[-1000:] or "Preview face detector did not return JSON") from exc
    if process.returncode or result.get("status") != "ok":
        raise WorkerError("skin_vision_unavailable", result.get("error") or process.stderr[-1000:] or "Preview face detector failed")
    return result


_VISION_RUNTIME_IDENTITY_SCRIPT = r'''import cv2, hashlib, json, os, sys
from pathlib import Path

def file_identity(name, with_hash=False):
    path = Path(name).resolve(strict=True)
    stat = path.stat()
    result = {"realpath": str(path), "device": stat.st_dev, "inode": stat.st_ino,
              "size": stat.st_size, "mtime_ns": stat.st_mtime_ns, "ctime_ns": stat.st_ctime_ns}
    if with_hash:
        digest = hashlib.sha256()
        with path.open("rb") as source:
            for block in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(block)
        result["sha256"] = digest.hexdigest()
    return result

cv2_binary = getattr(getattr(cv2, "cv2", cv2), "__file__", cv2.__file__)
package_dir = Path(cv2.__file__).resolve().parent
binary_paths = set()
if cv2_binary and Path(cv2_binary).suffix.lower() in (".so", ".dylib", ".pyd"):
    binary_paths.add(Path(cv2_binary))
for pattern in ("cv2*.so", "cv2*.dylib", "cv2*.pyd"):
    binary_paths.update(package_dir.glob(pattern))
cascade = Path(cv2.data.haarcascades) / "haarcascade_frontalface_default.xml"
build = cv2.getBuildInformation().encode("utf-8", errors="replace")
print(json.dumps({
    "python_version": sys.version.split()[0],
    "python": file_identity(sys.executable),
    "opencv_version": cv2.__version__,
    "opencv_module": file_identity(cv2.__file__),
    "opencv_binaries": [file_identity(path) for path in sorted(binary_paths)],
    "opencv_build_sha256": hashlib.sha256(build).hexdigest(),
    "haar_cascade": file_identity(cascade, with_hash=True),
}, sort_keys=True, separators=(",", ":")))
'''


def vision_runtime_identity(assets: dict[str, Any]) -> dict[str, Any]:
    """Describe the configured OpenCV runtime for local face-cache keys."""
    interpreter = assets.get("vision_python") or sys.executable
    if not isinstance(interpreter, str) or not Path(interpreter).is_absolute() or not os.access(interpreter, os.X_OK):
        raise WorkerError("skin_vision_unavailable", "An executable absolute assets.vision_python is required")
    try:
        process = run([interpreter, "-c", _VISION_RUNTIME_IDENTITY_SCRIPT], timeout=15)
    except WorkerError as exc:
        raise WorkerError("skin_vision_unavailable", str(exc)) from exc
    if len(process.stdout.encode("utf-8")) > 16 * 1024:
        raise WorkerError("skin_vision_unavailable", "OpenCV runtime identity output exceeds the size limit")
    if process.returncode:
        raise WorkerError("skin_vision_unavailable", process.stderr[-1000:] or "Cannot inspect the configured OpenCV runtime")
    try:
        identity = json.loads(process.stdout)
    except json.JSONDecodeError as exc:
        raise WorkerError("skin_vision_unavailable", process.stderr[-1000:] or "OpenCV runtime identity is invalid") from exc
    required = {"python_version", "python", "opencv_version", "opencv_module", "opencv_binaries",
                "opencv_build_sha256", "haar_cascade"}
    if not isinstance(identity, dict) or set(identity) != required:
        raise WorkerError("skin_vision_unavailable", "OpenCV runtime identity is incomplete")
    return identity


def cached_preview_frame(source: Path, asset: dict[str, Any], assets: dict[str, Any],
                         request: dict[str, Any], frame_index: int,
                         source_pts_seconds: float | None = None) -> dict[str, Any]:
    cache_name = request.get("proxy_cache_dir")
    if cache_name is None:
        return {**vision_preview_frame(source, assets, frame_index), "cache_hit": False}
    if not isinstance(cache_name, str) or not Path(cache_name).is_absolute():
        raise WorkerError("proxy_cache_dir_invalid", "Proxy cache directory must be absolute")
    cache_dir = Path(cache_name)
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_dir = cache_dir.resolve()
    if source.resolve().is_relative_to(cache_dir):
        raise WorkerError("proxy_cache_dir_invalid", "Source cannot be inside proxy cache")
    plan = {"version": "preview-face-v2", "source_sha256": asset["sha256"],
            "frame_index": frame_index,
            "source_pts_seconds": round(source_pts_seconds, 6) if source_pts_seconds is not None else None,
            "tracker_sha256": digest_file(Path(__file__).with_name("vision_tracker.py")),
            "vision_runtime_identity": vision_runtime_identity(assets)}
    key = digest_json(plan)
    target = cache_dir / f"face-frame-{key}.json"
    if target.is_symlink():
        raise WorkerError("proxy_cache_invalid", "Face track cache entry cannot be a symlink")

    def valid(track: Any) -> bool:
        if not isinstance(track, dict) or track.get("status") != "ok" or track.get("preview_frame_index") != frame_index:
            return False
        regions = track.get("preview_regions")
        if not isinstance(regions, list) or len(regions) > 3 or track.get("track_scope") != "single_preview_frame":
            return False
        try:
            for region in regions:
                face_region_expr(region)
        except (WorkerError, TypeError):
            return False
        return True

    if target.is_file():
        try:
            cached = json.loads(target.read_text())
            track = cached["track"]
            if cached.get("plan") == plan and cached.get("track_sha256") == digest_json(track) and valid(track):
                return {**track, "cache_hit": True}
        except (OSError, KeyError, TypeError, ValueError):
            pass
    track = vision_preview_frame(source, assets, frame_index)
    if not valid(track):
        raise WorkerError("skin_tracking_mismatch", "Preview detector returned invalid face regions")
    write_json(target, {"plan": plan, "track": track, "track_sha256": digest_json(track)})
    return {**track, "cache_hit": False}


def track_regions_for_frame(track: dict[str, Any], frame_offset: int) -> list[dict[str, float]]:
    if track.get("track_scope") == "single_preview_frame":
        if frame_offset != track["preview_frame_index"]:
            raise WorkerError("skin_tracking_mismatch", "Preview face frame index differs from selected frame")
        return track["preview_regions"]
    return track["frame_regions"][frame_offset]


def tracked_face_expr(track: dict[str, Any], frame_offset: int | None = None,
                      *, x_expr: str = "X/W", y_expr: str = "Y/H") -> str:
    if frame_offset is not None:
        regions = track_regions_for_frame(track, frame_offset)
        if not regions:
            return "0"
        value = face_region_expr(regions[0], x_expr=x_expr, y_expr=y_expr)
        for region in regions[1:]:
            value = f"max({value},{face_region_expr(region, x_expr=x_expr, y_expr=y_expr)})"
        return value
    parts: list[str] = []
    for segment in track["segments"]:
        regions = segment["regions"]
        if not regions:
            continue
        region_mask = face_region_expr(regions[0])
        for item in regions[1:]:
            region_mask = f"max({region_mask},{face_region_expr(item)})"
        parts.append(f"(between(N,{segment['start_frame']},{segment['end_frame']-1})*{region_mask})")
    return "min(1," + "+".join(parts) + ")" if parts else "0"


def face_region_expr(region: dict[str, float], *, x_expr: str = "X/W", y_expr: str = "Y/H") -> str:
    if not isinstance(region, dict):
        raise WorkerError("skin_tracking_invalid", "Face region must have named normalized coordinates")
    try:
        x0 = number(region["x"], "face.x", 0, 1)
        y0 = number(region["y"], "face.y", 0, 1)
        width = number(region["width"], "face.width", 0, 1)
        height = number(region["height"], "face.height", 0, 1)
        feather = number(region.get("feather", .01), "face.feather", .001, .25)
    except KeyError as exc:
        raise WorkerError("skin_tracking_invalid", "Face region lacks a normalized coordinate") from exc
    x1, y1 = x0+width, y0+height
    if width == 0 or height == 0 or x1 > 1.000001 or y1 > 1.000001:
        raise WorkerError("skin_tracking_invalid", "Face region extends outside the frame")
    return f"clip(min(min(({x_expr}-{fmt(x0)})/{fmt(feather)},({fmt(x1)}-{x_expr})/{fmt(feather)}),min(({y_expr}-{fmt(y0)})/{fmt(feather)},({fmt(y1)}-{y_expr})/{fmt(feather)})),0,1)"


def local_color_filter(hue: float, width: float, amount: float, hue_shift: float, luminance_amount: float,
                       region: dict[str, Any] | None) -> str:
    mask = f"({hue_mask(hue,width)}*{region_expr(region)})"
    theta = math.radians(hue_shift)
    cosine, sine = math.cos(theta), math.sin(theta)
    # Rodrigues rotation about the neutral R=G=B axis. Neutral pixels stay
    # neutral; hue selection comes from the unmodified input of this node.
    rotation = []
    for row in range(3):
        coefficients = []
        for col in range(3):
            skew = ((0,-1,1),(1,0,-1),(-1,1,0))[row][col] / math.sqrt(3)
            coefficients.append((cosine if row == col else 0) + (1-cosine)/3 + sine*skew)
        rotation.append(coefficients)
    rgb = ("r(X,Y)", "g(X,Y)", "b(X,Y)")
    y = f"(.2126*{rgb[0]}+.7152*{rgb[1]}+.0722*{rgb[2]})"
    result = []
    for index, name in enumerate("rgb"):
        rotated = "+".join(f"{fmt(rotation[index][column])}*{rgb[column]}" for column in range(3))
        if hue_shift:
            shifted = f"({rgb[index]}+ld(0)*(({rotated})-{rgb[index]}))"
        else:
            shifted = rgb[index]
        saturation_gain = f"(1+{fmt(amount*.35)}*ld(0))"
        exposure_gain = f"pow(2,{fmt(luminance_amount*.5)}*ld(0))"
        expression = f"(st(0,{mask});st(1,{y});(ld(1)+({shifted}-ld(1))*{saturation_gain})*{exposure_gain})"
        result.append(f"{name}='clip({expression},0,1023)'")
    return "geq="+":".join(result)+":i=nearest"


def lut_filter(path: str) -> str:
    try:
        return f"lut3d=file={filter_file(path)}:interp=tetrahedral"
    except ValueError as error:
        raise WorkerError("asset_path_invalid", str(error)) from error


def export_input_rgb(info: dict[str, Any]) -> str:
    stream = video_stream(info)
    matrix, value = stream.get("color_space"), stream.get("color_range")
    if matrix not in {"bt709", "bt470bg", "smpte170m", "fcc", "smpte240m", "bt2020nc"} or value not in {"tv", "pc"}:
        return ""
    return (f"scale=in_color_matrix={matrix}:out_color_matrix=bt709:in_range={value}:out_range=pc:"
            "flags=accurate_rnd+full_chroma_int,")


def export_encoder(request: dict[str, Any], info: dict[str, Any], *, sdr: bool) -> tuple[str, list[str], dict[str, Any]]:
    choice = request.get("export_encoder", "auto")
    quality = request.get("export_quality", "preserve")
    if quality not in {"preserve", "balanced"}:
        raise WorkerError("request_invalid", "export_quality must be preserve or balanced")
    if choice not in {"auto", "x265", "videotoolbox"}:
        raise WorkerError("request_invalid", "export_encoder must be auto, x265 or videotoolbox")
    if quality == "preserve":
        if choice == "videotoolbox":
            raise WorkerError("encoder_quality_unsupported", "VideoToolbox does not provide the verified lossless export path")
        return "libx265", ["-c:v", "libx265", "-preset", "ultrafast", "-profile:v", "main10", "-x265-params",
                           "lossless=1:bframes=0:pools=2:frame-threads=2:log-level=error"], {"quality": "preserve", "encoding_lossless": True, "selection": choice}
    use_hardware = sdr and choice != "x265" and sys.platform == "darwin" and "hevc_videotoolbox" in checked(["ffmpeg", "-hide_banner", "-encoders"])
    if choice == "videotoolbox" and not use_hardware:
        raise WorkerError("encoder_unavailable", "HEVC VideoToolbox is unavailable")
    if use_hardware:
        stream = video_stream(info)
        try: bitrate = int(stream.get("bit_rate") or 0)
        except (TypeError, ValueError): bitrate = 0
        try: fps = float(Fraction(stream.get("avg_frame_rate") or "30/1"))
        except (ValueError, ZeroDivisionError): fps = 30
        # A flat/dark source may have a tiny measured bitrate. Reusing it as
        # the encoder budget after grading erases gradients and fine lines.
        bitrate = round(max(8_000_000, min(160_000_000, max(bitrate, stream["width"]*stream["height"]*fps*.1))))
        return "hevc_videotoolbox", ["-c:v", "hevc_videotoolbox", "-profile:v", "main10", "-b:v", str(bitrate)], {"target_bitrate": bitrate, "selection": choice, "quality": quality, "encoding_lossless": False}
    return "libx265", ["-c:v", "libx265", "-preset", "medium", "-crf", "16", "-x265-params", "pools=2:frame-threads=2:log-level=error"], {"crf": 16, "preset": "medium", "selection": choice, "quality": quality, "encoding_lossless": False}


def prepare_tone_transform(recipe: dict[str, Any], directory: Path, duration: float,
                           *, preview_time: float | None = None, source_start: float = 0) -> dict[str, Any] | None:
    try:
        plan = create_tone_plan(recipe, directory, duration, preview_time, source_start)
    except ValueError as exc:
        raise WorkerError("recipe_invalid", str(exc)) from exc
    return plan if plan is not None else create_tone_lut(recipe, directory)


def cleanup_tone_transform(transform: dict[str, Any] | None) -> None:
    if transform is None:
        return
    if transform.get("basis") == "approved-source-time-ranges":
        shutil.rmtree(transform["staging_dir"], ignore_errors=True)
    elif transform.get("path"):
        Path(transform["path"]).unlink(missing_ok=True)
        if transform.get("shaper_path"):
            Path(transform["shaper_path"]).unlink(missing_ok=True)


def filter_graph(recipe: dict[str, Any], lut: dict[str, Any] | None, *, preview: bool,
                 skin_track: dict[str, Any] | None = None, frame_offset: int | None = None,
                 tone_lut: dict[str, Any] | None = None,
                 skin_pixel_scale: float = 1.0,
                 skin_frame_size: tuple[int, int] | None = None) -> str:
    filters: list[str] = []
    if preview:
        filters.append("scale=w='min(1280,iw)':h=-2:flags=lanczos")
    filters.append("format=gbrpf32le")
    if lut:
        filters.append(lut_filter(lut["path"]))
    if recipe.get("denoise") is not None:
        filters.append(denoise_filter(recipe["denoise"], preview=preview,
                                      label_prefix=f"hvp_dn_{next(_DENOISE_LABELS)}"))
    if tone_lut:
        if tone_lut.get("basis") == "approved-source-time-ranges":
            graph = tone_plan_filter(tone_lut)
            filters = [f"{','.join(filters or ['null'])}[{graph['input_label']}];"
                       f"{graph['graph']};[{graph['output_label']}]null"]
        else:
            filters.append(tone_lut_filter(tone_lut))
    tone_operations: list[str] = []
    skin_filter = None
    skin_crop = None
    tone = recipe.get("tone") or {}
    if not isinstance(tone, dict):
        raise WorkerError("recipe_invalid", "tone must be an object")
    for kind in ("shadows", "highlights"):
        item = term(tone.get(kind), f"tone.{kind}")
        if item is not None and item["amount"] != 0 and tone_lut is None:
            tone_operations.append(f"tone:{kind}:{fmt(item['amount'])}:{region_expr(item['region'])}")
    skin = skin_settings(recipe.get("skin"))
    if skin_enabled(skin):
        if skin_track is None:
            raise WorkerError("skin_vision_unavailable", "Automatic face tracking is required for skin correction")
        # Candidate skin chroma is accepted only inside tracked face regions.
        # A user region, when present, further restricts the result.
        regions = track_regions_for_frame(skin_track, frame_offset) if frame_offset is not None else None
        if regions is None or regions:
            if regions is not None and skin_frame_size is not None:
                skin_crop = skin_crop_rect({"frame_regions": [regions]}, *skin_frame_size, skin["smoothness"])
                x_expr = f"(X+{skin_crop['x']})/{skin_frame_size[0]}"
                y_expr = f"(Y+{skin_crop['y']})/{skin_frame_size[1]}"
            else:
                x_expr, y_expr = "X/W", "Y/H"
            spatial = f"({tracked_face_expr(skin_track, frame_offset, x_expr=x_expr, y_expr=y_expr)}*"
            spatial += f"{region_expr(skin['region'], x_expr=x_expr, y_expr=y_expr)})"
            skin_filter = build_skin_filter(skin, f"({hue_mask(28,30)}*{spatial})",
                                            pixel_scale=skin_pixel_scale)
    local_filter = None
    local = recipe.get("local_color")
    if local is not None:
        if not isinstance(local, dict):
            raise WorkerError("recipe_invalid", "local_color must be an object")
        hue = number(local.get("hue"), "local_color.hue", 0, 360)
        width = number(local.get("range"), "local_color.range", 0, 180)
        item = term({"amount": local.get("amount"), "region": local.get("region")}, "local_color")
        hue_shift = number(local.get("hueShift", 0) or 0, "local_color.hueShift", -180, 180)
        luminance_amount = number(local.get("luminance", 0) or 0, "local_color.luminance", -1, 1)
        if item and (item["amount"] or hue_shift or luminance_amount):
            local_filter = local_color_filter(hue,width,item["amount"],hue_shift,luminance_amount,item["region"])
    if tone_operations or skin_filter or local_filter:
        filters.append("format=gbrp10le")
        if tone_operations:
            filters.append(geq_filter(tone_operations))
        if skin_filter:
            if skin_crop is not None and skin_frame_size is not None:
                filters.append(skin_roi_filter(skin_filter,skin_crop,*skin_frame_size))
            else:
                filters.append(skin_filter)
        if local_filter:
            filters.append(local_filter)
    finish = recipe.get("finish")
    if finish is not None:
        if not isinstance(finish, dict):
            raise WorkerError("recipe_invalid", "finish must be an object")
        if set(finish) - {"contrast", "saturation"}:
            raise WorkerError("recipe_unsupported", "Unsupported finish setting")
        contrast = number(finish.get("contrast", 0), "finish.contrast", -1, 1)
        saturation = number(finish.get("saturation", 0), "finish.saturation", -1, 1)
        filters.append(f"eq=contrast={fmt(1+.15*contrast)}:saturation={fmt(1+.25*saturation)}")
    return ",".join(filters or ["null"])


def frame_pts(path: Path) -> list[float]:
    raw = checked(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=best_effort_timestamp_time", "-of", "csv=p=0", str(path)])
    return [float(line.strip().split(",")[0]) for line in raw.splitlines() if line.strip() and line.strip().split(",")[0] != "N/A"]


def video_packet_pts(path: Path) -> list[float]:
    """Read presentation times from demuxed video packets without decoding frames.

    This is suitable for approximate proxy timing and selecting a preview
    tracker frame. Export readback deliberately uses decoded ``frame_pts``.
    """
    raw = checked(["ffprobe", "-v", "error", "-select_streams", "v:0",
                   "-show_packets", "-show_entries", "packet=pts_time",
                   "-of", "csv=p=0", str(path)])
    try:
        values = [float(line.strip().split(",")[0]) for line in raw.splitlines() if line.strip()]
    except ValueError as exc:
        raise WorkerError("packet_timing_invalid", "Video packet lacks a numeric PTS") from exc
    if not values or any(not math.isfinite(value) for value in values):
        raise WorkerError("packet_timing_invalid", "Video packets lack finite PTS values")
    values.sort()  # Decode order can differ from presentation order for B-frames.
    if any(current <= previous for previous,current in zip(values,values[1:])):
        raise WorkerError("packet_timing_invalid", "Video packet PTS values are not unique")
    return values


def audio_packet_facts(path: Path, stream_number: int) -> tuple[int, str, list[tuple[float, float]]]:
    raw = checked(["ffprobe", "-v", "error", "-select_streams", f"a:{stream_number}", "-show_packets",
                   "-show_data_hash", "sha256", "-show_entries", "packet=size,data_hash,pts_time,dts_time", "-of", "json", str(path)])
    packets = json.loads(raw).get("packets", [])
    value = hashlib.sha256()
    timestamps: list[tuple[float, float]] = []
    for packet in packets:
        entry = f"{packet.get('size')}:{packet.get('data_hash')}\n"
        if not re.fullmatch(r"\d+:SHA256:[a-f0-9]{64}\n", entry):
            raise WorkerError("audio_packet_unverified", "Could not hash audio packet payload")
        value.update(entry.encode())
        try:
            timestamps.append((float(packet["pts_time"]),float(packet["dts_time"])))
        except (KeyError, TypeError, ValueError) as exc:
            raise WorkerError("audio_packet_unverified", "Audio packet lacks a timestamp") from exc
    return len(packets), value.hexdigest(), timestamps


def readback(source: Path, output: Path, input_info: dict[str, Any], *, sdr_output: bool,
             reference_pixel_sha256: str | None = None) -> dict[str, Any]:
    # The processed reference gates the optional platform decoder. Any failure
    # or pixel mismatch retries software; this never changes the video encoder.
    decoder = "videotoolbox" if sys.platform == "darwin" and reference_pixel_sha256 else "software"
    decoder_fallback = None
    try:
        try:
            decoded = decoded_video_facts(output, decoder=decoder)
            if decoder == "videotoolbox" and decoded["pixel_sha256"] != reference_pixel_sha256:
                decoder_fallback = "videotoolbox_pixel_mismatch"
        except ExportValidationError:
            if decoder != "videotoolbox": raise
            decoder_fallback = "videotoolbox_decode_failed"
        if decoder_fallback:
            decoder = "software"
            decoded = decoded_video_facts(output, decoder=decoder)
    except ExportValidationError as exc:
        raise WorkerError("readback_decode_failed", str(exc)) from exc
    if reference_pixel_sha256 and decoded["pixel_sha256"] != reference_pixel_sha256:
        raise WorkerError("export_pixel_mismatch", "Encoded video differs from the processed 10-bit frame samples")
    output_info = ffprobe(output)
    input_video, output_video = video_stream(input_info), video_stream(output_info)
    if (input_video.get("width"), input_video.get("height")) != (output_video.get("width"), output_video.get("height")):
        raise WorkerError("readback_dimensions_mismatch", "Rendered video dimensions changed")
    if output_video.get("codec_name") != "hevc" or output_video.get("pix_fmt") != "yuv420p10le":
        raise WorkerError("readback_format_mismatch", "Expected HEVC 10-bit 4:2:0 output")
    if sdr_output and any(output_video.get(key) != "bt709" for key in ("color_primaries", "color_transfer", "color_space")):
        raise WorkerError("readback_color_mismatch", "SDR output lacks BT.709 color tags")
    for scope in [output_info.get("format", {})] + output_info.get("streams", []):
        if any(key.lower() in PROFILE_KEYS for key in scope.get("tags", {})):
            raise WorkerError("readback_capture_metadata_leak", "Output still carries a source DJI capture gamma tag")
    source_pts, output_pts = frame_pts(source), decoded["frame_pts"]
    if not source_pts or len(source_pts) != len(output_pts):
        raise WorkerError("readback_frame_mismatch", f"Input/output frames: {len(source_pts)}/{len(output_pts)}")
    max_pts_error = max(abs(a-b) for a,b in zip(source_pts, output_pts))
    if max_pts_error > .003:
        raise WorkerError("readback_pts_mismatch", f"Maximum frame PTS error {max_pts_error:.6f}s")
    input_audio = [s for s in input_info["streams"] if s.get("codec_type") == "audio"]
    output_audio = [s for s in output_info["streams"] if s.get("codec_type") == "audio"]
    if len(input_audio) != len(output_audio) or any((a.get("codec_name"),a.get("sample_rate"),a.get("channels")) !=
                                                   (b.get("codec_name"),b.get("sample_rate"),b.get("channels"))
                                                   for a,b in zip(input_audio, output_audio)):
        raise WorkerError("readback_audio_mismatch", "Audio stream count, codec, sample rate, or channels changed")
    if any(abs(float(a.get("duration") or 0)-float(b.get("duration") or 0)) > .05 for a,b in zip(input_audio, output_audio)):
        raise WorkerError("readback_audio_mismatch", "Audio duration changed")
    audio_packets = []
    for index in range(len(input_audio)):
        source_packets, source_hash, source_timestamps = audio_packet_facts(source,index)
        output_packets, output_hash, output_timestamps = audio_packet_facts(output,index)
        if (source_packets,source_hash) != (output_packets,output_hash):
            raise WorkerError("readback_audio_payload_mismatch", "Audio packets changed despite stream copy")
        max_audio_pts_error = max((abs(a-b) for source_pair,output_pair in zip(source_timestamps,output_timestamps)
                                   for a,b in zip(source_pair,output_pair)),default=0.0)
        if max_audio_pts_error > .003:
            raise WorkerError("readback_audio_pts_mismatch", f"Maximum audio packet PTS/DTS error {max_audio_pts_error:.6f}s")
        audio_packets.append({"packets":output_packets,"sha256":output_hash,
                              "max_pts_error_seconds":max_audio_pts_error})
    return {"decode": "pass", "video_frames": len(output_pts), "max_pts_error_seconds": max_pts_error,
            "decoded_pixel_sha256": decoded["pixel_sha256"], "validation_method": decoded["method"],
            "validation_decoder_requested": decoder, "validation_decoder_fallback": decoder_fallback,
            "width":output_video.get("width"),"height":output_video.get("height"),"pixel_format":output_video.get("pix_fmt"),
            "color_primaries":output_video.get("color_primaries"),"color_transfer":output_video.get("color_transfer"),
            "color_space":output_video.get("color_space"),
            "audio_streams": len(output_audio), "audio_codecs": [s.get("codec_name") for s in output_audio],
            "audio_packet_checks": audio_packets}


def write_json(path: Path, result: dict[str, Any]) -> None:
    fd, temp_name = tempfile.mkstemp(prefix=".manifest-", suffix=".json", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump(result, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(temp_name, path)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def preview_time(request: dict[str, Any], duration: float) -> float | None:
    if "time_seconds" in request and "timeSeconds" in request:
        raise WorkerError("preview_time_invalid", "Specify only one preview time field")
    value = request.get("time_seconds", request.get("timeSeconds"))
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise WorkerError("preview_time_invalid", "Preview time must be a finite nonnegative number of seconds")
    if duration <= 0 or value >= duration:
        raise WorkerError("preview_time_out_of_range", "Preview time must be before the clip end")
    return float(value)


def first_showinfo_pts(stderr: str) -> float:
    match = re.search(r"showinfo[^\n]*\bn:\s*0\b[^\n]*\bpts_time:\s*([-+]?\d+(?:\.\d+)?)", stderr)
    if not match:
        raise WorkerError("preview_frame_unverified", "FFmpeg did not report the selected frame timestamp")
    return float(match.group(1))


def extract_preview_frame(source: Path, output: Path | None, seek_at: float, duration: float,
                          stream: dict[str, Any]) -> tuple[float, float]:
    """Select the exact preview PTS, optionally preserving it in a lossless file.

    The input seek decodes only the nearby GOP. Skin preview reuses a one-frame
    file for detection and rendering; other previews only need the timestamp
    probe and continue rendering directly from the source.
    """
    def command(position: float) -> list[str]:
        args = ["ffmpeg", "-hide_banner", "-v", "info", "-xerror", "-nostdin", "-ss", fmt(position),
                "-copyts", "-noautorotate", "-i", str(source), "-map", "0:v:0", "-vf", "showinfo",
                "-frames:v", "1", "-an", "-sn", "-dn"]
        if output is None:
            return [*args, "-f", "null", "-"]
        args += ["-fps_mode", "passthrough", "-c:v", "ffv1", "-level", "3"]
        pixel_format = stream.get("pix_fmt")
        if isinstance(pixel_format, str) and pixel_format and pixel_format != "unknown":
            args += ["-pix_fmt", pixel_format]
        args += ["-map_metadata", "0", "-map_metadata:s:v:0", "0:s:v:0"]
        for option, key in (("-color_range", "color_range"),
                            ("-color_primaries", "color_primaries"),
                            ("-color_trc", "color_transfer"),
                            ("-colorspace", "color_space")):
            value = stream.get(key)
            if isinstance(value, str) and value and value != "unknown":
                args += [option, value]
        return [*args, "-avoid_negative_ts", "disabled", "-y", str(output)]

    def contains_selected_frame(process: subprocess.CompletedProcess[str]) -> bool:
        if process.returncode or (output is not None and
                                  (not output.is_file() or output.stat().st_size == 0)):
            return False
        try:
            first_showinfo_pts(process.stderr)
        except WorkerError:
            return False
        return True

    if output is not None:
        output.unlink(missing_ok=True)
    process = run(command(seek_at))
    if not contains_selected_frame(process):
        if output is not None:
            output.unlink(missing_ok=True)
        try:
            frame_interval = 1 / float(Fraction(stream.get("avg_frame_rate")))
        except (TypeError, ValueError, ZeroDivisionError):
            frame_interval = .04
        if seek_at < max(0.0, duration - max(1.0, frame_interval * 2)):
            raise WorkerError("preview_frame_extract_failed",
                              process.stderr[-1600:].strip() or "No frame at the requested preview time")
        # Container duration includes the final frame's display interval. Seek
        # backward in bounded increments until FFmpeg selects the last frame;
        # this avoids indexing every packet just to clamp a near-end request.
        candidate = max(0.0, duration - max(.01, frame_interval * 1.5))
        for _ in range(8):
            process = run(command(candidate))
            if contains_selected_frame(process):
                break
            if output is not None:
                output.unlink(missing_ok=True)
            if candidate <= 0:
                break
            candidate = max(0.0, candidate - max(.05, frame_interval * 2))
        else:
            process = None
        if process is None or not contains_selected_frame(process):
            raise WorkerError("preview_frame_extract_failed",
                              process.stderr[-1600:].strip() or "Cannot extract the final preview frame")
    source_pts = first_showinfo_pts(process.stderr)
    if output is None:
        return source_pts, source_pts
    output_pts = frame_pts(output)
    if len(output_pts) != 1 or abs(output_pts[0] - source_pts) > .003:
        output.unlink(missing_ok=True)
        raise WorkerError("preview_frame_unverified", "Lossless preview frame PTS differs from the selected source frame")
    return source_pts, output_pts[0]


def preview_proxy(source: Path, asset: dict[str, Any], lut: dict[str, Any] | None,
                  recipe: dict[str, Any], request: dict[str, Any],
                  source_pts: list[float] | None = None, *, build: bool = True) -> dict[str, Any]:
    cache_name = request.get("proxy_cache_dir")
    if cache_name is None:
        return {"available": False, "reason": "cache_not_configured"}
    if not isinstance(cache_name, str) or not Path(cache_name).is_absolute():
        raise WorkerError("proxy_cache_dir_invalid", "Proxy cache directory must be absolute")
    if not (lut or recipe.get("input_domain") == "rec709" or asset["profile"]["mode"] == "rec709"):
        return {"available": False, "reason": "working_domain_unknown"}
    cache_dir = Path(cache_name)
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_dir = cache_dir.resolve()
    if source.resolve().is_relative_to(cache_dir):
        raise WorkerError("proxy_cache_dir_invalid", "Source cannot be inside proxy cache")
    plan = {"backend_version": "proxy-v3", "source_sha256": asset["sha256"],
            "lut_sha256": lut["sha256"] if lut else None,
            "camera": asset["profile"]["camera"], "mode": asset["profile"]["mode"],
            "input_domain": recipe.get("input_domain") if not lut else None,
            "width_limit": 1280, "max_frame_rate": 30, "codec": "h264",
            "crf": 18, "pixel_format": "yuv420p"}
    key = digest_json(plan)
    target = cache_dir / f"{key}.mp4"
    manifest_path = cache_dir / f"{key}.json"
    if target.is_symlink() or manifest_path.is_symlink():
        raise WorkerError("proxy_cache_invalid", "Proxy cache entry cannot be a symlink")
    if target.is_file() and manifest_path.is_file():
        try:
            cached = json.loads(manifest_path.read_text())
            if (cached.get("key") == key and cached.get("plan") == plan and
                    cached.get("output_bytes") == target.stat().st_size and
                    cached.get("output_sha256") == digest_file(target)):
                return {"available": True, "path": str(target), "cache_hit": True,
                        "key": key, "timing": cached["timing"], "sha256": cached["output_sha256"],
                        "bytes": cached["output_bytes"]}
        except (OSError, KeyError, ValueError, TypeError):
            pass
    if not build:
        return {"available": False, "reason": "proxy_not_cached"}
    scratch_dir = Path(request.get("output_dir") or cache_dir)
    if not scratch_dir.is_absolute():
        raise WorkerError("output_dir_invalid", "Explicit absolute output_dir required for proxy scratch")
    scratch_dir.mkdir(parents=True, exist_ok=True)
    scratch_dir = scratch_dir.resolve()
    try:
        if scratch_dir.stat().st_dev != cache_dir.stat().st_dev:
            raise WorkerError("proxy_cache_dir_invalid", "Proxy scratch and cache must share a filesystem")
    except OSError as exc:
        raise WorkerError("proxy_cache_dir_invalid", "Proxy scratch or cache directory is unavailable") from exc
    fd, temporary_name = tempfile.mkstemp(prefix=f".proxy-{key}-", suffix=".partial.mp4", dir=scratch_dir)
    os.close(fd)
    temporary = Path(temporary_name)
    try:
        # Drop surplus source frames before the expensive resize and LUT.
        # setpts keeps the selection threshold on the source-relative clock.
        filters = ["setpts=PTS-STARTPTS",
                   "select='eq(n\\,0)+gte(t-prev_selected_t\\,1/30)'",
                   "scale=w='min(1280,trunc(iw/2)*2)':h=-2:flags=lanczos", "format=gbrpf32le"]
        if lut:
            filters.append(lut_filter(lut["path"]))
        filters.append("setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709")
        checked(["ffmpeg", "-hide_banner", "-v", "error", "-xerror", "-nostdin", "-i", str(source),
                 "-map", "0:v:0", "-vf", ",".join(filters), "-an", "-map_metadata", "-1",
                 "-map_metadata:s:v:0", "-1", "-map_chapters", "-1", "-fps_mode:v", "passthrough",
                 "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
                 "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
                 "-movflags", "+faststart", "-y", str(temporary)])
        checked(["ffmpeg", "-hide_banner", "-v", "error", "-xerror", "-i", str(temporary),
                 "-map", "0:v:0", "-f", "null", "-"])
        output_info = ffprobe(temporary)
        stream = video_stream(output_info)
        if stream.get("codec_name") != "h264" or stream.get("pix_fmt") != "yuv420p" or stream.get("width", 0) > 1280:
            raise WorkerError("proxy_readback_mismatch", "Proxy format or size differs from plan")
        if any(stream.get(field) != "bt709" for field in ("color_primaries", "color_transfer", "color_space")):
            raise WorkerError("proxy_readback_mismatch", "Proxy lacks BT.709 color tags")
        if any(item.get("codec_type") == "audio" for item in output_info["streams"]):
            raise WorkerError("proxy_readback_mismatch", "Proxy unexpectedly contains audio")
        original_pts = source_pts or video_packet_pts(source)
        encoded_pts = frame_pts(temporary)
        if not original_pts or not encoded_pts or len(encoded_pts) > len(original_pts):
            raise WorkerError("proxy_readback_mismatch", "Proxy frame count is invalid")
        source_relative_pts = [value-original_pts[0] for value in original_pts]
        max_timing_error = 0.0
        for output_pts in encoded_pts:
            selected_index = bisect_left(source_relative_pts, output_pts)
            nearest = min((source_relative_pts[index] for index in (selected_index-1,selected_index)
                           if 0 <= index < len(source_relative_pts)),
                          key=lambda value: abs(value-output_pts))
            max_timing_error = max(max_timing_error, abs(nearest-output_pts))
        if abs(encoded_pts[0]) > .003 or max_timing_error > .003:
            raise WorkerError("proxy_readback_mismatch", "Proxy frame times do not match source-relative times")
        if any(b-a < 1/30-.003 for a,b in zip(encoded_pts,encoded_pts[1:])):
            raise WorkerError("proxy_readback_mismatch", "Proxy exceeds the 30 fps cap")
        if digest_file(source) != asset["sha256"]:
            raise WorkerError("source_changed_during_render", "Source changed while building proxy")
        timing = {"origin": "source-first-video-packet", "timing_validation": "source_packet_pts_and_decoded_proxy_frames",
                  "source_packet_count": len(original_pts), "start_seconds": encoded_pts[0],
                  "last_frame_seconds": encoded_pts[-1], "duration_seconds": float(output_info["format"].get("duration") or 0),
                  "frame_count": len(encoded_pts), "max_frame_time_error_seconds": max_timing_error}
        output_hash = digest_file(temporary)
        output_bytes = temporary.stat().st_size
        os.replace(temporary, target)
        write_json(manifest_path, {"key": key, "plan": plan, "timing": timing,
                                   "output_sha256": output_hash, "output_bytes": output_bytes})
        return {"available": True, "path": str(target), "cache_hit": False,
                "key": key, "timing": timing, "sha256": output_hash, "bytes": output_bytes}
    finally:
        temporary.unlink(missing_ok=True)


def build_proxy_action(request: dict[str, Any], source: Path, asset: dict[str, Any],
                       catalog: tuple[list[dict[str, Any]], Path] | None) -> dict[str, Any]:
    if "time_seconds" in request or "timeSeconds" in request:
        raise WorkerError("request_invalid", "Proxy covers the clip; frame time applies only to preview")
    if request.get("source_sha256") is not None and request["source_sha256"] != asset["sha256"]:
        raise WorkerError("source_hash_mismatch", "Source changed since probe")
    output_name = request.get("output_dir")
    if not isinstance(output_name, str) or not Path(output_name).is_absolute():
        raise WorkerError("output_dir_invalid", "Explicit absolute output_dir required")
    output_dir = Path(output_name)
    if source.resolve() == output_dir.resolve() or source.resolve().is_relative_to(output_dir.resolve()):
        raise WorkerError("output_dir_invalid", "Output directory must not contain source")
    output_dir.mkdir(parents=True, exist_ok=True)
    if (output_dir / "result.json").exists():
        raise WorkerError("output_exists", "Proxy job result already exists")
    recipe = request.get("recipe") or {}
    lut_enabled = recipe.get("lut_enabled")
    if lut_enabled not in (True, False, None):
        raise WorkerError("recipe_invalid", "lut_enabled must be true, false, or null")
    lut = None
    if lut_enabled is True:
        lut = match_lut(asset["profile"], recipe.get("look"), catalog, grid=recipe.get("lut_grid"), verify=True)
        if not lut["available"]:
            raise WorkerError("lut_unsupported", lut["reason"])
        if request.get("lut_sha256") is not None and request["lut_sha256"] != lut["sha256"]:
            raise WorkerError("lut_plan_mismatch", "Selected LUT differs from reviewed catalog hash")
    elif recipe.get("input_domain") == "rec709" and asset["profile"]["mode"] in {"dlog", "dlog2", "dlogm"}:
        raise WorkerError("domain_conflict", "Rec.709 declaration conflicts with Log capture metadata or selected mode")
    elif recipe.get("input_domain") != "rec709" and asset["profile"]["mode"] != "rec709":
        raise WorkerError("domain_unknown", "Neutral SDR proxy requires a matched LUT or explicit Rec.709 input domain")
    proxy = preview_proxy(source, asset, lut, recipe, request)
    if not proxy["available"]:
        raise WorkerError("proxy_unavailable", proxy["reason"])
    result = {"status": "ok", "action": "proxy", "source_sha256": asset["sha256"],
              "recipe_sha256": digest_json(recipe),
              "lut": {key:value for key,value in lut.items() if key != "path"} if lut else None,
              "working_domain": "sdr_rec709_display_relative" if lut else "rec709_display_relative",
              "proxy_status": {"available": True, "reason": None},
              "proxy_path": proxy["path"], "proxy_timing": proxy["timing"],
              "proxy_cache_hit": proxy["cache_hit"], "proxy_sha256": proxy["sha256"],
              "proxy_bytes": proxy["bytes"]}
    write_json(output_dir / "result.json", result)
    return result


def ai_sample_seeks(raw: Any, duration: float, frame_rate: str | None) -> list[dict[str, Any]]:
    if not isinstance(raw, list) or not 1 <= len(raw) <= 3:
        raise WorkerError("ai_sample_times_invalid", "sample_times must contain one to three seconds values")
    if duration <= 0:
        raise WorkerError("ai_sample_times_invalid", "Video duration is unavailable")
    try:
        frame_interval = float(1/Fraction(frame_rate))
    except (TypeError, ValueError, ZeroDivisionError):
        frame_interval = .1
    # Container duration includes the last frame's display interval. Leave a
    # bounded margin when a caller asks for or beyond the end of a short clip.
    latest_safe = max(0.0, duration-max(.05,frame_interval*1.5))
    result: list[dict[str, Any]] = []
    seen: dict[float,dict[str,Any]] = {}
    for raw_time in raw:
        if isinstance(raw_time, bool) or not isinstance(raw_time, (int,float)) or not math.isfinite(raw_time) or raw_time < 0:
            raise WorkerError("ai_sample_times_invalid", "Sample times must be finite nonnegative seconds")
        requested = float(raw_time)
        seek = round(min(requested,latest_safe),6)
        if seek not in seen:
            item = {"requested_seconds":requested,"seek_seconds":seek,
                    "coalesced_requested_seconds":[requested]}
            result.append(item)
            seen[seek] = item
        else:
            seen[seek]["coalesced_requested_seconds"].append(requested)
    return result


def ai_sample_dimensions(width: int, height: int) -> tuple[int, int]:
    ratio = width/height
    sample_width = max(2,min(320,round(math.sqrt(57600*ratio))))
    sample_height = max(2,min(320,round(sample_width/ratio)))
    while sample_width*sample_height > 57600:
        if sample_width >= sample_height:
            sample_width -= 1
        else:
            sample_height -= 1
    return sample_width,sample_height


def trim_ai_sample_cache(cache_dir: Path, keep_key: str) -> None:
    """Bound only this worker's completed AI sample entries and old staging."""
    entries: list[tuple[int,int,Path,Path]] = []
    stale_before = time.time() - 24*60*60
    for item in cache_dir.iterdir():
        if item.name.startswith(".ai-samples-") and item.is_dir() and not item.is_symlink():
            try:
                if item.stat().st_mtime < stale_before:
                    shutil.rmtree(item)
            except OSError:
                pass
        match = re.fullmatch(r"ai-([a-f0-9]{64})\.json",item.name)
        if not match or item.is_symlink() or not item.is_file():
            continue
        image = cache_dir/f"ai-{match.group(1)}.png"
        if image.is_symlink() or not image.is_file():
            continue
        try:
            entries.append((item.stat().st_mtime_ns,image.stat().st_size,item,image))
        except OSError:
            continue
    entries.sort(key=lambda item:item[0])
    total_bytes = sum(item[1] for item in entries)
    while len(entries) > 24 or total_bytes > 64*1024*1024:
        index = next((index for index,entry in enumerate(entries)
                      if entry[2].stem != f"ai-{keep_key}"),None)
        if index is None:
            break
        _,size,manifest,image = entries.pop(index)
        try:
            manifest.unlink(missing_ok=True)
            image.unlink(missing_ok=True)
            total_bytes -= size
        except OSError:
            pass


def ai_samples(request: dict[str, Any], source: Path, asset: dict[str, Any], info: dict[str, Any],
               catalog: tuple[list[dict[str, Any]], Path] | None) -> dict[str, Any]:
    if request.get("source_sha256") is not None and request["source_sha256"] != asset["sha256"]:
        raise WorkerError("source_hash_mismatch", "Source changed since probe")
    source_stat = source.stat()
    source_signature = (source_stat.st_dev,source_stat.st_ino,source_stat.st_size,
                        source_stat.st_mtime_ns,source_stat.st_ctime_ns)
    def verify_source_unchanged() -> None:
        current = source.stat()
        if (current.st_dev,current.st_ino,current.st_size,current.st_mtime_ns,current.st_ctime_ns) != source_signature:
            raise WorkerError("source_changed_during_render", "Source changed while sampling")
    output_name, cache_name = request.get("output_dir"), request.get("ai_sample_cache_dir")
    if not isinstance(output_name,str) or not Path(output_name).is_absolute():
        raise WorkerError("output_dir_invalid", "Explicit absolute output_dir required")
    if not isinstance(cache_name,str) or not Path(cache_name).is_absolute():
        raise WorkerError("ai_sample_cache_dir_invalid", "Explicit absolute ai_sample_cache_dir required")
    output_dir,cache_dir = Path(output_name),Path(cache_name)
    if any(source.resolve() == directory.resolve() or source.resolve().is_relative_to(directory.resolve())
           for directory in (output_dir,cache_dir)):
        raise WorkerError("output_dir_invalid", "Output and cache directories must not contain source")
    output_dir.mkdir(parents=True,exist_ok=True)
    cache_dir.mkdir(parents=True,exist_ok=True)
    cache_dir = cache_dir.resolve()
    if (output_dir/"result.json").exists():
        raise WorkerError("output_exists", "AI sample job result already exists")
    recipe = request.get("recipe") or {}
    if recipe.get("lut_enabled") not in (True,False,None):
        raise WorkerError("recipe_invalid", "lut_enabled must be true, false, or null")
    lut = None
    if recipe.get("lut_enabled") is True:
        lut = match_lut(asset["profile"],recipe.get("look"),catalog,grid=recipe.get("lut_grid"),verify=True)
        if not lut["available"]:
            raise WorkerError("lut_unsupported",lut["reason"])
        if request.get("lut_sha256") is not None and request["lut_sha256"] != lut["sha256"]:
            raise WorkerError("lut_plan_mismatch", "Selected LUT differs from reviewed catalog hash")
    tone = recipe.get("tone") or {}
    if not isinstance(tone,dict):
        raise WorkerError("recipe_invalid", "tone must be an object")
    low_light = low_light_setting(tone)
    try: denoise = normalize_denoise(recipe.get("denoise"))
    except ValueError as exc: raise WorkerError("recipe_invalid", str(exc)) from exc
    skin = skin_settings(recipe.get("skin"))
    color = recipe.get("local_color")
    mask_formula_active = skin_enabled(skin)
    effects_enabled = bool(recipe.get("tone_segments")) or skin_enabled(skin) or any(item is not None and item["amount"] != 0 for item in
        (term(tone.get("shadows"),"tone.shadows"),term(tone.get("highlights"),"tone.highlights")))
    if isinstance(color,dict) and color.get("amount") is not None:
        color_active = (number(color["amount"],"local_color.amount",-1,1) != 0 or
                        number(color.get("hueShift",0) or 0,"local_color.hueShift",-180,180) != 0 or
                        number(color.get("luminance",0) or 0,"local_color.luminance",-1,1) != 0)
        effects_enabled = effects_enabled or color_active
        mask_formula_active = mask_formula_active or color_active
    effects_enabled = effects_enabled or recipe.get("finish") is not None or low_light > 0 or denoise is not None
    if not lut and effects_enabled:
        if recipe.get("input_domain") == "rec709" and asset["profile"]["mode"] in {"dlog","dlog2","dlogm"}:
            raise WorkerError("domain_conflict", "Rec.709 declaration conflicts with Log capture metadata or selected mode")
        if recipe.get("input_domain") != "rec709" and asset["profile"]["mode"] != "rec709":
            raise WorkerError("domain_unknown", "SDR adjustments require a matched LUT or explicit Rec.709 input domain")
    seeks = ai_sample_seeks(request.get("sample_times"),asset["duration"],asset["media_facts"]["frame_rate"])
    sample_width,sample_height = ai_sample_dimensions(asset["width"],asset["height"])
    domain = ("sdr_rec709_display_relative" if lut else
              "rec709_display_relative" if recipe.get("input_domain") == "rec709" or asset["profile"]["mode"] == "rec709" else
              "decoded_source_rgb_unknown_transfer")
    runtime_identity = vision_runtime_identity(request.get("assets") or {}) if skin_enabled(skin) else None
    plan = {"version":"ai-samples-v4","source_sha256":asset["sha256"],
            "recipe_sha256":digest_json(recipe),"lut_sha256":lut["sha256"] if lut else None,
            "sample_seeks_seconds":[item["seek_seconds"] for item in seeks],
            "requested_seconds":[item["coalesced_requested_seconds"] for item in seeks],
            "sample_dimensions":[sample_width,sample_height],
            "tone_algorithm_version":TONE_ALGORITHM_VERSION,
            "low_light_algorithm_version": LOW_LIGHT_ALGORITHM_VERSION if low_light else None,
            "denoise_sha256": digest_file(Path(__file__).with_name("video_denoise.py")) if denoise else None,
            "tone_segments_sha256":digest_file(Path(__file__).with_name("tone_segments.py")) if recipe.get("tone_segments") else None,
            "mask_formula_version":HUE_MASK_FORMULA_VERSION if mask_formula_active else None,
            "vision_tracker_sha256":digest_file(Path(__file__).with_name("vision_tracker.py")) if skin_enabled(skin) else None,
            "skin_treatment_sha256":digest_file(Path(__file__).with_name("skin_treatment.py")) if skin_enabled(skin) else None,
            "vision_runtime_identity":runtime_identity}
    key = digest_json(plan)
    target,manifest_path = cache_dir/f"ai-{key}.png",cache_dir/f"ai-{key}.json"
    if target.is_symlink() or manifest_path.is_symlink():
        raise WorkerError("ai_sample_cache_invalid", "AI sample cache entry cannot be a symlink")
    common = {"status":"ok","action":"ai-samples","source_sha256":asset["sha256"],
              "recipe_sha256":plan["recipe_sha256"],"lut":{k:v for k,v in lut.items() if k not in {"path", "shaper_path"}} if lut else None,
              "working_domain":domain,"visual_basis":"current-adjustments"}
    png_frame_tag = display_png_frame_filter() if domain in {"sdr_rec709_display_relative","rec709_display_relative"} else "null"
    png_options = display_png_options() if png_frame_tag != "null" else []
    if target.is_file() and manifest_path.is_file():
        try:
            cached = json.loads(manifest_path.read_text())
            if (cached.get("plan") == plan and cached.get("bytes") == target.stat().st_size and
                    cached.get("sha256") == digest_file(target)):
                result = {**cached["result"],**common,"contact_sheet_path":str(target),"cache_hit":True}
                verify_source_unchanged()
                os.utime(manifest_path,None)
                trim_ai_sample_cache(cache_dir,key)
                write_json(output_dir/"result.json",result)
                return result
        except (OSError,KeyError,TypeError,ValueError):
            pass
    stream = video_stream(info)
    try:
        source_start = float(stream.get("start_time") if stream.get("start_time") is not None else
                             Fraction(stream.get("start_pts") or 0)*Fraction(stream.get("time_base") or "1"))
    except (TypeError,ValueError,ZeroDivisionError) as exc:
        raise WorkerError("ai_sample_frame_unverified", "Invalid source time base") from exc
    with tempfile.TemporaryDirectory(prefix=".ai-samples-",dir=cache_dir) as staging_name:
        staging = Path(staging_name)
        tone_lut = create_tone_lut(recipe,staging) if not recipe.get("tone_segments") else None
        samples: list[dict[str,Any]] = []
        frames: list[Path] = []
        for index,requested in enumerate(seeks):
            base_path = staging/f"base-{index}.png"
            after_path = staging/f"after-{index}.png"
            filters = ["showinfo",f"scale={sample_width}:{sample_height}:flags=lanczos", "format=gbrpf32le"]
            if lut:
                filters.append(lut_filter(lut["path"]))
            filters.append("format=rgb48be")
            filters.append(png_frame_tag)
            command = ["ffmpeg","-hide_banner","-v","info","-xerror","-nostdin",
                       "-ss",fmt(requested["seek_seconds"]),"-copyts","-i",str(source),
                       "-map","0:v:0","-vf",",".join(filters),"-frames:v","1","-update","1",*png_options,"-y",str(base_path)]
            process = run(command)
            if process.returncode or not base_path.is_file():
                raise WorkerError("ai_sample_decode_failed",f"ffmpeg: {process.stderr[-1200:].strip()}")
            pts = first_showinfo_pts(process.stderr)
            actual = pts-source_start
            if actual < -.003 or actual >= asset["duration"]+.003:
                raise WorkerError("ai_sample_frame_unverified", "Sampled frame lies outside source duration")
            # Distinct requested seeks can land on the same displayed frame.
            duplicate = next((item for item in samples if abs(item["frame_pts_seconds"]-pts) < .000001),None)
            if duplicate is not None:
                duplicate["coalesced_requested_seconds"].extend(requested["coalesced_requested_seconds"])
                continue
            track = None
            face_count = None
            if skin_enabled(skin):
                track = vision_preview_frame(base_path,request.get("assets") or {},0)
                face_count = len(track["preview_regions"])
            sample_tone = (prepare_tone_transform(recipe, staging/f"tone-{index}", asset["duration"], preview_time=max(0, actual))
                           if recipe.get("tone_segments") else tone_lut)
            effect_filter = filter_graph(recipe,None,preview=False,skin_track=track,frame_offset=0 if track else None,
                                         tone_lut=sample_tone,skin_pixel_scale=sample_width/960,
                                         skin_frame_size=(sample_width,sample_height))
            checked(["ffmpeg","-hide_banner","-v","error","-xerror","-nostdin","-i",str(base_path),
                     "-filter_complex",f"[0:v]{effect_filter},format=rgb24,{png_frame_tag}[out]",
                     "-map","[out]","-frames:v","1","-update","1",*png_options,"-y",str(after_path)])
            frames.append(after_path)
            samples.append({"requested_seconds":requested["requested_seconds"],
                            "coalesced_requested_seconds":requested["coalesced_requested_seconds"],
                            "seek_seconds":requested["seek_seconds"],"actual_seconds":round(actual,6),
                            "frame_pts_seconds":pts,"skin_face_count":face_count})
        if not frames:
            raise WorkerError("ai_sample_decode_failed", "No sampled frames were decoded")
        sheet = staging/"contact-sheet.png"
        if len(frames) == 1:
            shutil.copyfile(frames[0],sheet)
        else:
            inputs = [part for frame in frames for part in ("-i",str(frame))]
            labels = "".join(f"[{index}:v]" for index in range(len(frames)))
            checked(["ffmpeg","-hide_banner","-v","error","-xerror","-nostdin",*inputs,
                     "-filter_complex",f"{labels}hstack=inputs={len(frames)},format=rgb24,{png_frame_tag}[out]",
                     "-map","[out]","-frames:v","1","-update","1",*png_options,"-y",str(sheet)])
        checked(["ffmpeg","-hide_banner","-v","error","-xerror","-i",str(sheet),"-f","null","-"])
        width,height = sample_width*len(frames),sample_height
        sheet_stream = video_stream(ffprobe(sheet))
        if (sheet_stream.get("width"),sheet_stream.get("height")) != (width,height) or width*height > 3*57600:
            raise WorkerError("ai_sample_readback_mismatch", "Contact sheet dimensions differ from plan")
        byte_count = sheet.stat().st_size
        if byte_count > 4*1024*1024:
            raise WorkerError("ai_sample_too_large", "Contact sheet exceeds the 4 MiB limit")
        verify_source_unchanged()
        sheet_hash = digest_file(sheet)
        stable_result = {"sample_times":samples,"frame_count":len(frames),"width":width,"height":height,
                         "layout":"left-to-right",
                         "contact_sheet_sha256":sheet_hash,"contact_sheet_bytes":byte_count,
                         "sampling_method":"source-relative input seeks; selected frame PTS verified with FFmpeg showinfo",
                         "skin_basis":"single-frame Haar face candidates at sample resolution" if skin_enabled(skin) else None}
        os.replace(sheet,target)
        write_json(manifest_path,{"plan":plan,"result":stable_result,"sha256":sheet_hash,"bytes":byte_count})
        trim_ai_sample_cache(cache_dir,key)
    result = {**common,**stable_result,"contact_sheet_path":str(target),"cache_hit":False}
    write_json(output_dir/"result.json",result)
    return result


def playback(request: dict[str, Any], source: Path, asset: dict[str, Any], info: dict[str, Any],
             recipe: dict[str, Any], lut: dict[str, Any] | None, output_dir: Path) -> dict[str, Any]:
    """Render at most six seconds with the same grading graph as export.

    Keep source PTS through the tone plan; reset the clock only after grading.
    A bounded lossless intermediate is needed only for face tracking.
    """
    requested = preview_time(request, asset["duration"])
    stream = video_stream(info)
    try:
        frame_interval = 1 / float(Fraction(stream.get("avg_frame_rate")))
    except (TypeError, ValueError, ZeroDivisionError):
        frame_interval = .04
    # A seek inside the final display interval may otherwise return no frame.
    requested = min(requested, max(0, asset["duration"]-max(.05,frame_interval*1.5)))
    quality=request.get("playback_quality","fast")
    if quality not in {"fast","detail"}:
        raise WorkerError("request_invalid","playback_quality must be fast or detail")
    detail=quality=="detail"
    limit=2.0 if detail else 6.0
    if detail and (asset["width"]*asset["height"]>12_000_000 or asset["width"]%2 or asset["height"]%2):
        raise WorkerError("playback_too_large","Original-size playback requires even dimensions and at most 12 megapixels; use fast playback")
    end = min(asset["duration"], requested + limit)
    source_start = float(stream.get("start_time") or 0)
    width = asset["width"] if detail else min(1280, asset["width"] // 2 * 2)
    height = max(2, round(asset["height"]*width/asset["width"]/2)*2)
    target, partial = output_dir/"playback.mp4", output_dir/".playback.partial.mp4"
    if target.exists() or partial.exists():
        raise WorkerError("output_exists", "Playback already exists; use a fresh run directory")
    source_input = source
    lossless = None
    transform = None
    track = None
    try:
        first_stage = (f"trim=end={fmt(source_start+end)},"+
                       ("" if detail else "select='eq(n\\,0)+gte(t-prev_selected_t\\,1/30)',")+
                       ("format=gbrpf32le" if detail else f"scale={width}:{height}:flags=lanczos,format=gbrpf32le"))
        seek = ["-ss", fmt(requested), "-t", fmt(end-requested), "-copyts", "-i", str(source)]
        if skin_enabled(skin_settings(recipe.get("skin"))):
            # The quality-dependent short segment is removed even on failure.
            fd, filename = tempfile.mkstemp(prefix=".playback-source-", suffix=".partial.mkv", dir=output_dir)
            os.close(fd)
            lossless = Path(filename)
            checked(["ffmpeg", "-hide_banner", "-v", "error", "-xerror", "-nostdin", *seek,
                     "-map", "0:v:0", "-vf", first_stage+",format=gbrp16le", "-an",
                     "-fps_mode", "passthrough", "-c:v", "ffv1", "-y", str(lossless)])
            track = vision_track(lossless, request.get("assets") or {})
            if track.get("frame_count") != len(frame_pts(lossless)):
                raise WorkerError("skin_tracking_mismatch", "Playback tracker frame count differs")
            if track.get("tracked_coverage", 0) < .5:
                raise WorkerError("skin_subject_unavailable", "No stable face candidate in this playback segment")
            source_input = lossless
            seek = ["-copyts", "-i", str(source_input)]
            first_stage = "format=gbrpf32le"
        if lossless is None:
            anchor_pts, _ = extract_preview_frame(source, None, requested, asset["duration"], stream)
        else:
            anchor_pts = frame_pts(lossless)[0]
        transform = prepare_tone_transform(recipe, output_dir, asset["duration"], source_start=source_start)
        effects = filter_graph(recipe, lut, preview=False, skin_track=track, tone_lut=transform,
                               skin_pixel_scale=width/960, skin_frame_size=(width,height))
        # Explicit RGB-full -> YUV-limited conversion; labels must describe the
        # actual output samples, not just overwrite the input color metadata.
        output_format="yuv420p10le" if detail else "yuv420p"
        filters = (first_stage+",showinfo,"+effects+
                   f",format=gbrpf32le,scale=iw:ih:in_range=full:out_range=tv:out_color_matrix=bt709,format={output_format},"
                   "setpts=PTS-STARTPTS,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709")
        command = ["ffmpeg", "-hide_banner", "-v", "info", "-xerror", "-nostdin", *seek]
        audio_index = 0
        if lossless is not None:
            command += ["-ss", fmt(requested), "-t", fmt(end-requested), "-i", str(source)]
            audio_index = 1
        encoder=(["-c:v","libx265","-preset","ultrafast","-profile:v","main10",
                  "-x265-params","lossless=1:bframes=0:pools=2:frame-threads=2:log-level=error","-tag:v","hvc1"] if detail else
                 ["-c:v","libx264","-preset","veryfast","-crf","16"])
        command += ["-filter_complex", f"[0:v]{filters}[outv]", "-map", "[outv]",
                    "-map", f"{audio_index}:a?", "-af", f"atrim=start={fmt(anchor_pts)},asetpts=PTS-({fmt(anchor_pts)})/TB",
                    "-t", fmt(end-requested), "-map_metadata", "-1", "-map_chapters", "-1",
                    "-fps_mode:v", "passthrough", *encoder,
                    "-pix_fmt", output_format, "-c:a", "aac", "-b:a", "160k",
                    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
                    "-movflags", "+faststart", "-y", str(partial)]
        process = run(command)
        if process.returncode:
            raise WorkerError("media_tool_failed", f"ffmpeg: {process.stderr[-1800:].strip()}")
        actual_pts = first_showinfo_pts(process.stderr)
        if abs(actual_pts-anchor_pts) > .003:
            raise WorkerError("playback_frame_unverified", "Playback first frame differs from the audio/video anchor")
        actual_start = actual_pts-source_start
        checked(["ffmpeg", "-v", "error", "-xerror", "-i", str(partial), "-f", "null", "-"])
        output_info = ffprobe(partial)
        output_stream = video_stream(output_info)
        pts = frame_pts(partial)
        duration = float(output_info["format"]["duration"])
        if (not pts or pts[0] < -.003 or pts[0] > max(.1,frame_interval*2) or duration > limit+.1 or
                actual_start < requested-.003 or actual_start >= end+.003 or
                output_stream.get("codec_name") != ("hevc" if detail else "h264") or output_stream.get("width") != width
                or detail and output_stream.get("pix_fmt")!="yuv420p10le"):
            raise WorkerError("playback_readback_mismatch", "Playback bounds, clock, or codec differ from plan")
        if source_stat_signature(source) != info.get("_source_stat_signature"):
            raise WorkerError("source_changed_during_render", "Source identity changed during playback rendering")
        os.replace(partial, target)
        result = {"status":"ok", "action":"playback", "video_path":str(target),
                  "source_sha256":asset["sha256"], "recipe_sha256":digest_json(recipe),
                  "output_sha256":digest_file(target), "input_profile":asset["profile"],
                  "source_identity":{"cache_hit":asset["media_facts"].get("source_identity_cache_hit",False)},
                  "lut":{key:value for key,value in lut.items() if key != "path"} if lut else None,
                  "low_light": {"amount": low_light_setting(recipe.get("tone") or {}), "algorithm_version": LOW_LIGHT_ALGORITHM_VERSION},
                  "denoise": denoise_metadata(recipe.get("denoise")),
                  "playback":{"start_seconds":round(actual_start,6),
                              "end_seconds":round(min(end,requested+duration),6),
                              "clock_source_start_seconds":actual_start,
                              "duration_seconds":duration, "scope":request.get("preview_scope","current"),
                              "width":width, "height":height, "frame_count":len(pts),
                              "frame_times_seconds":pts,
                              "processing_pixel_format":"gbrpf32le", "display_bit_depth":10 if detail else 8,
                              "quality":quality,"encoder":"libx265" if detail else "libx264",
                              "frame_rate_cap":None if detail else 30,
                              "encoding_lossless":detail,"original_size":detail,
                              "encoding_note":"Lossless relative to the graded YUV420p10 samples; grading, RGB/YUV conversion and chroma sampling are not lossless." if detail else "1280px 8-bit lossy H264 compatibility preview",
                              "tone_algorithm_version":TONE_ALGORITHM_VERSION},
                  "readback":{"kind":"bounded-video", "decode":"pass", "first_output_pts":pts[0]}}
        write_json(output_dir/"result.json", result)
        return result
    finally:
        partial.unlink(missing_ok=True)
        if lossless:
            lossless.unlink(missing_ok=True)
        cleanup_tone_transform(transform)


def render(request: dict[str, Any], source: Path, asset: dict[str, Any], info: dict[str, Any],
           catalog: tuple[list[dict[str, Any]], Path] | None) -> dict[str, Any]:
    action = request["action"]
    recipe = request.get("recipe") or {}
    if action == "playback" and request.get("preview_scope", "current") == "base":
        recipe = {**recipe, "tone":{}, "tone_segments":None, "denoise":None, "skin":None, "local_color":None, "finish":None}
    expected_hash = request.get("source_sha256")
    if expected_hash is not None and expected_hash != asset["sha256"]:
        raise WorkerError("source_hash_mismatch", "Source changed since probe")
    if action not in {"preview", "playback"} and ("time_seconds" in request or "timeSeconds" in request):
        raise WorkerError("request_invalid", "Frame time applies only to preview")
    # Probe, UI validation, source-relative seeks and temporal tone plans share
    # the same playable duration from the first video frame.
    preview_duration = asset["duration"]
    requested_preview_time = preview_time(request, preview_duration) if action == "preview" else None
    if action == "preview" and not isinstance(request.get("build_proxy", True), bool):
        raise WorkerError("request_invalid", "build_proxy must be a boolean")
    output_name = request.get("output_dir")
    if not isinstance(output_name, str) or not Path(output_name).is_absolute():
        raise WorkerError("output_dir_invalid", "Explicit absolute output_dir required")
    output_dir = Path(output_name)
    if source.resolve() == output_dir.resolve() or source.resolve().is_relative_to(output_dir.resolve()):
        raise WorkerError("output_dir_invalid", "Output directory must not contain source")
    output_dir.mkdir(parents=True, exist_ok=True)
    audio_codecs = {s.get("codec_name") for s in info.get("streams", []) if s.get("codec_type") == "audio"}
    container_extension = ".mp4" if audio_codecs <= {"aac","mp3","alac","ac3","eac3"} else ".mkv"
    target = output_dir / ("after.png" if action == "preview" else "render"+container_extension)
    partial = output_dir / (".after.partial.png" if action == "preview" else ".render.partial"+container_extension)
    if target.exists() or partial.exists():
        raise WorkerError("output_exists", "Output already exists; use a fresh run directory")
    lut_enabled = recipe.get("lut_enabled")
    if lut_enabled not in (True, False, None):
        raise WorkerError("recipe_invalid", "lut_enabled must be true, false, or null")
    if lut_enabled is None:
        lut_enabled = False
    lut = None
    if lut_enabled:
        lut = match_lut(asset["profile"], recipe.get("look"), catalog, grid=recipe.get("lut_grid"), verify=True)
        if not lut["available"]:
            raise WorkerError("lut_unsupported", lut["reason"])
        if request.get("lut_sha256") is not None and request["lut_sha256"] != lut["sha256"]:
            raise WorkerError("lut_plan_mismatch", "Selected LUT differs from reviewed catalog hash")
    tone = recipe.get("tone") or {}
    if not isinstance(tone, dict):
        raise WorkerError("recipe_invalid", "tone must be an object")
    low_light = low_light_setting(tone)
    try: denoise = normalize_denoise(recipe.get("denoise"))
    except ValueError as exc: raise WorkerError("recipe_invalid", str(exc)) from exc
    skin_term = skin_settings(recipe.get("skin"))
    color = recipe.get("local_color")
    effects_enabled = (bool(recipe.get("tone_segments")) or skin_enabled(skin_term) or any(item is not None and item["amount"] != 0 for item in
                          (term(tone.get("shadows"), "tone.shadows"), term(tone.get("highlights"), "tone.highlights"))))
    if isinstance(color, dict) and color.get("amount") is not None:
        effects_enabled = effects_enabled or number(color["amount"], "local_color.amount", -1, 1) != 0
        effects_enabled = effects_enabled or number(color.get("hueShift",0) or 0, "local_color.hueShift", -180, 180) != 0
        effects_enabled = effects_enabled or number(color.get("luminance",0) or 0, "local_color.luminance", -1, 1) != 0
    effects_enabled = effects_enabled or recipe.get("finish") is not None or low_light > 0 or denoise is not None
    if not lut and effects_enabled:
        if recipe.get("input_domain") == "rec709" and asset["profile"]["mode"] in {"dlog","dlog2","dlogm"}:
            raise WorkerError("domain_conflict", "Rec.709 declaration conflicts with Log capture metadata or selected mode")
        if recipe.get("input_domain") != "rec709" and asset["profile"]["mode"] != "rec709":
            raise WorkerError("domain_unknown", "SDR adjustments require a matched LUT or explicit Rec.709 input domain")
    if action == "playback":
        if request.get("preview_scope", "current") not in ("base", "current"):
            raise WorkerError("request_invalid", "preview_scope must be base or current")
        if not lut and asset["profile"]["mode"] != "rec709" and recipe.get("input_domain") != "rec709":
            raise WorkerError("domain_unknown", "Playback requires a matched SDR conversion")
        return playback(request, source, asset, info, recipe, lut, output_dir)
    preview_source = source
    preview_frame_path: Path | None = None
    preview_source_pts: float | None = None
    preview_output_pts: float | None = None
    preview_source_time_seconds: float | None = None
    preview_source_stream = video_stream(info)
    frame_index = 0
    source_start: float | None = None
    if action == "preview":
        try:
            source_start = float(preview_source_stream.get("start_time")
                                 if preview_source_stream.get("start_time") is not None else
                                 Fraction(preview_source_stream.get("start_pts") or 0) *
                                 Fraction(preview_source_stream.get("time_base") or "1"))
        except (TypeError, ValueError, ZeroDivisionError) as exc:
            raise WorkerError("preview_frame_unverified", "Invalid source time base") from exc
        try:
            frame_interval = 1 / float(Fraction(preview_source_stream.get("avg_frame_rate")))
        except (TypeError, ValueError, ZeroDivisionError):
            frame_interval = .04
        if requested_preview_time is None:
            seek_at = max(0.0, preview_duration * .5 - frame_interval * .5)
        else:
            seek_at = requested_preview_time
        needs_exact_pts = skin_enabled(skin_term) or bool(recipe.get("tone_segments"))
        near_end = seek_at >= max(0.0, preview_duration - max(.05, frame_interval * 1.5))
        needs_exact_pts = needs_exact_pts or near_end
        if needs_exact_pts:
            if skin_enabled(skin_term):
                fd, preview_name = tempfile.mkstemp(prefix=".preview-source-", suffix=".partial.mkv", dir=output_dir)
                os.close(fd)
                preview_frame_path = Path(preview_name)
            try:
                preview_source_pts, preview_output_pts = extract_preview_frame(
                    source, preview_frame_path, seek_at, preview_duration, preview_source_stream)
                preview_source_time_seconds = preview_source_pts - source_start
                if preview_source_time_seconds < -.003 or preview_source_time_seconds >= preview_duration + .003:
                    raise WorkerError("preview_frame_unverified", "Selected frame lies outside the clip")
                if preview_frame_path is not None:
                    preview_source = preview_frame_path
                    preview_source_stream = video_stream(ffprobe(preview_source))
                else:
                    # Seeking to the verified PTS makes the render pass choose
                    # the same VFR frame as the lightweight timestamp probe.
                    seek_at = max(0.0, preview_source_time_seconds)
            except Exception:
                if preview_frame_path is not None:
                    preview_frame_path.unlink(missing_ok=True)
                raise
        frame_index = 0
        preview_frame_index = 0
    skin_track = None
    source_pts = None
    mask_path = None
    skin_crop = None
    if skin_enabled(skin_term):
        if action == "render":
            source_pts = frame_pts(source)
            frame_rate = video_stream(info).get("avg_frame_rate")
            try:
                frame_interval = 1 / float(Fraction(frame_rate))
            except (ValueError, ZeroDivisionError, TypeError) as exc:
                raise WorkerError("skin_tracking_vfr_unsupported", "A fixed source frame rate is required for tracked skin") from exc
            if any(abs((b-a)-frame_interval) > .002 for a,b in zip(source_pts,source_pts[1:])):
                raise WorkerError("skin_tracking_vfr_unsupported", "Tracked skin currently requires constant frame timing")
            mask_path = output_dir / ".skin-mask.mkv"
            if mask_path.exists():
                raise WorkerError("output_exists", "Tracked mask already exists")
        try:
            if action == "render":
                skin_track = vision_track(source, request.get("assets") or {}, mask_output=mask_path, fps=frame_rate)
            else:
                skin_track = cached_preview_frame(preview_source, asset, request.get("assets") or {}, request,
                                                  preview_frame_index, source_pts_seconds=preview_source_pts)
            if action == "render":
                if skin_track["frame_count"] != len(source_pts):
                    raise WorkerError("skin_tracking_mismatch", "Tracker and FFmpeg frame counts disagree")
                if skin_track["tracked_coverage"] < .5:
                    raise WorkerError("skin_subject_unavailable", "No stable face candidate for skin correction")
            elif not track_regions_for_frame(skin_track, preview_frame_index):
                raise WorkerError("skin_subject_unavailable", "No face candidate on the selected preview frame")
            if mask_path is not None:
                mask_pts = frame_pts(mask_path)
                if len(mask_pts) != len(source_pts) or not mask_pts or max(
                    abs((a-mask_pts[0])-(b-source_pts[0])) for a,b in zip(mask_pts,source_pts)
                ) > .003:
                    raise WorkerError("skin_tracking_mismatch", "Face mask frame timing differs from source")
        except Exception:
            if mask_path is not None:
                mask_path.unlink(missing_ok=True)
            if preview_frame_path is not None:
                preview_frame_path.unlink(missing_ok=True)
            raise
    recipe_hash = digest_json(recipe)
    tone_lut_info = None
    try:
        stream = video_stream(info)
        try:
            plan_source_start = float(stream.get("start_time") if stream.get("start_time") is not None else
                                      Fraction(stream.get("start_pts") or 0)*Fraction(stream.get("time_base") or "1"))
        except (TypeError, ValueError, ZeroDivisionError) as exc:
            raise WorkerError("source_timing_invalid", "Invalid source time base") from exc
        tone_lut_info = prepare_tone_transform(recipe, output_dir, asset["duration"],
            preview_time=max(0, preview_source_time_seconds) if preview_source_time_seconds is not None else None,
            source_start=plan_source_start)
        if action == "preview":
            frame_index = 0
            if ((preview_frame_path is not None or recipe.get("tone_segments")) and
                    (preview_source_pts is None or preview_output_pts is None or preview_source_time_seconds is None)):
                raise WorkerError("preview_frame_unverified", "Selected preview frame was not verified")
            before_path = output_dir / "before.png"
            base_path = output_dir / "base.png"
            sample_path = output_dir / "sample.png" if recipe.get("local_color") is not None else target
            preview_paths = [before_path, base_path, partial]
            if sample_path != target:
                preview_paths.append(sample_path)
            if any(path.exists() for path in preview_paths):
                raise WorkerError("output_exists", "Preview frame already exists")
            converted = lut_filter(lut["path"]) if lut else "null"
            source_width = preview_source_stream.get("width") or asset["width"]
            source_height = preview_source_stream.get("height") or asset["height"]
            quality = request.get("preview_quality", "fast")
            if quality not in ("fast", "detail"):
                raise WorkerError("request_invalid", "preview_quality must be fast or detail")
            if quality == "detail" and source_width*source_height > 40_000_000:
                raise WorkerError("preview_too_large", "Detail frame exceeds 40 megapixels")
            width_limit = source_width if quality == "detail" else 1280
            preview_width = min(source_width, width_limit)
            preview_height = max(2, round(source_height*preview_width/source_width/2)*2)
            after_filters = filter_graph(recipe, None, preview=False, skin_track=skin_track,
                                         frame_offset=frame_index, tone_lut=tone_lut_info,
                                         skin_pixel_scale=preview_width/960,
                                         skin_frame_size=(preview_width,preview_height))
            sample_separate = sample_path != target
            sdr_preview = bool(lut or recipe.get("input_domain") == "rec709" or asset["profile"]["mode"] == "rec709")
            png_frame_tag = display_png_frame_filter() if sdr_preview else "null"
            png_options = display_png_options() if sdr_preview else []
            branches = "[base][effect_input][sample_input]" if sample_separate else "[base][effect_input]"
            graph = [f"[0:v]showinfo,scale=w='min({width_limit},iw)':h=-2:flags=lanczos,format=gbrpf32le,split=2[before_input][convert_input]",
                     f"[before_input]format=rgb48be,{png_frame_tag}[before]",
                     f"[convert_input]{converted},split={3 if sample_separate else 2}{branches}",
                     f"[base]{denoise_filter(denoise, label_prefix='preview_base_dn')},format=rgb48be,{png_frame_tag}[base_output]",
                     f"[effect_input]{after_filters},format=rgb48be,{png_frame_tag}[after]"]
            outputs = [("before", before_path), ("base_output", base_path), ("after", partial)]
            if sample_separate:
                sample_recipe = {**recipe, "local_color": None}
                sample_filters = filter_graph(sample_recipe, None, preview=False, skin_track=skin_track,
                                              frame_offset=frame_index, tone_lut=tone_lut_info,
                                              skin_pixel_scale=preview_width/960,
                                              skin_frame_size=(preview_width,preview_height))
                graph.append(f"[sample_input]{sample_filters},format=rgb48be,{png_frame_tag}[sample]")
                outputs.append(("sample", sample_path))
            input_seek = ["-ss", fmt(seek_at)] if preview_frame_path is None else []
            command = ["ffmpeg", "-hide_banner", "-v", "info", "-xerror", "-nostdin", *input_seek,
                       "-copyts", "-i", str(preview_source), "-filter_complex", ";".join(graph)]
            for label, path in outputs:
                command += ["-map", f"[{label}]", "-frames:v", "1", "-update", "1", *png_options, "-y", str(path)]
            process = run(command)
            if process.returncode:
                raise WorkerError("media_tool_failed", f"ffmpeg: {process.stderr[-1800:].strip()}")
            rendered_pts = first_showinfo_pts(process.stderr)
            if preview_output_pts is not None and abs(rendered_pts-preview_output_pts) > .003:
                raise WorkerError("preview_frame_unverified", "Rendered preview PTS differs from the selected source frame")
            selected_pts = preview_source_pts if preview_source_pts is not None else rendered_pts
            actual_time = (preview_source_time_seconds if preview_source_time_seconds is not None else
                           selected_pts - (source_start or 0))
            if actual_time < -.003 or actual_time >= preview_duration + .003:
                raise WorkerError("preview_frame_unverified", "Selected frame lies outside the clip")
            dimensions = []
            for _, path in outputs:
                checked(["ffmpeg", "-hide_banner", "-v", "error", "-xerror", "-i", str(path), "-f", "null", "-"])
                png_stream = video_stream(ffprobe(path))
                dimensions.append((png_stream.get("width"), png_stream.get("height")))
            if len(set(dimensions)) != 1:
                raise WorkerError("preview_dimensions_mismatch", "Preview frames have different dimensions")
            check = {"kind": "still", "decode": "pass", "sample_target_seconds": round(actual_time,6),
                     "sample_frame_pts_seconds": selected_pts, "requested_time_seconds": requested_preview_time,
                     "width": dimensions[0][0], "height": dimensions[0][1],
                     "quality": quality, "processing_pixel_format": "gbrpf32le", "still_bit_depth": 16,
                     "display_contract": "srgb-display-code-v1" if sdr_preview else None,
                     "display_signal_transform": False}
        else:
            sdr_export = bool(lut or recipe.get("input_domain") == "rec709" or asset["profile"]["mode"] == "rec709")
            input_rgb = export_input_rgb(info) if sdr_export else ""
            sdr_tail = (",format=gbrpf32le,scale=in_color_matrix=bt709:out_color_matrix=bt709:in_range=pc:out_range=tv:"
                        "flags=accurate_rnd+full_chroma_int,format=yuv420p10le,"
                        "setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709") if sdr_export else ""
            command = ["ffmpeg", "-hide_banner", "-v", "error", "-xerror", "-nostdin", "-filter_threads", "6", "-filter_complex_threads", "6", "-copyts", "-i", str(source)]
            if mask_path is not None:
                command += ["-i", str(mask_path)]
                base_recipe = {**recipe, "skin": None, "local_color": None, "finish": None}
                base_filter = filter_graph(base_recipe, lut, preview=False, tone_lut=tone_lut_info)
                skin_crop = skin_crop_rect(skin_track, asset["width"], asset["height"], skin_term["smoothness"])
                crop_x, crop_y = skin_crop["x"], skin_crop["y"]
                spatial = region_expr(skin_term["region"],
                                      x_expr=f"(X+{crop_x})/{asset['width']}",
                                      y_expr=f"(Y+{crop_y})/{asset['height']}")
                skin_filter = build_skin_filter(skin_term, f"({hue_mask(28,30)}*{spatial})",
                                                pixel_scale=asset["width"]/960)
                post_filter = filter_graph({"local_color": recipe.get("local_color"),
                                            "finish": recipe.get("finish")}, None, preview=False)
                width, height = asset["width"], asset["height"]
                source_stream = video_stream(info)
                source_time_base = source_stream.get("time_base")
                try:
                    frame_ticks = Fraction(1,1) / Fraction(frame_rate) / Fraction(source_time_base)
                    source_start_pts = int(source_stream.get("start_pts") or 0)
                except (TypeError, ValueError, ZeroDivisionError) as exc:
                    raise WorkerError("skin_tracking_mismatch", "Invalid source time base") from exc
                mask_timestamps = f"settb={source_time_base},setpts={source_start_pts}+N*{frame_ticks.numerator}/{frame_ticks.denominator}"
                color_tag_filter = sdr_tail
                complex_filter = (f"[0:v]{input_rgb}{base_filter},format=gbrp10le,split=2[base][candidate];"
                                  f"[candidate]crop={skin_crop['width']}:{skin_crop['height']}:{crop_x}:{crop_y},"
                                  f"{skin_filter},pad={width}:{height}:{crop_x}:{crop_y}:color=black[skin];"
                                  f"[1:v]{mask_timestamps},scale={width}:{height}:flags=bilinear,format=gray10le[mask];"
                                  f"[base][skin][mask]maskedmerge,{post_filter}{color_tag_filter}[outv]")
                video_graph = complex_filter
            else:
                filters = filter_graph(recipe, lut, preview=False, tone_lut=tone_lut_info)
                filters = input_rgb + filters + sdr_tail
                video_graph = f"[0:v]{filters}[outv]"
            preserve_export = request.get("export_quality", "preserve") == "preserve"
            if preserve_export:
                video_graph += ";[outv]split=2[encode_output][reference_output]"
            command += ["-filter_complex", video_graph, "-map", "[encode_output]" if preserve_export else "[outv]"]
            command += ["-map", "0:a?", "-map_metadata", "-1", "-map_metadata:s:v:0", "-1", "-map_chapters", "-1",
                       "-fps_mode:v", "passthrough", "-c:a", "copy"]
            encoder_name, encoder_args, encoder_details = export_encoder(request, info, sdr=sdr_export)
            tail = ["-pix_fmt", "yuv420p10le", "-tag:v", "hvc1"]
            if sdr_export:
                tail += ["-color_range", "tv", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"]
            tail += ["-movflags", "+faststart", "-y", str(partial)]
            if preserve_export:
                tail += ["-map", "[reference_output]", "-an", "-fps_mode:v", "passthrough", "-c:v", "rawvideo", "-threads:v", "1",
                         "-pix_fmt", "yuv420p10le", "-f", "hash", "-hash", "sha256", "-"]
            try: encode_stdout = checked(command + encoder_args + tail)
            except WorkerError:
                if encoder_name != "hevc_videotoolbox" or request.get("export_encoder", "auto") != "auto": raise
                partial.unlink(missing_ok=True)
                encoder_name, encoder_args, encoder_details = export_encoder({"export_encoder": "x265", "export_quality": "balanced"}, info, sdr=sdr_export)
                encoder_details["hardware_fallback"] = True
                encode_stdout = checked(command + encoder_args + tail)
            match = re.search(r"SHA256=([0-9a-f]{64})", encode_stdout) if preserve_export else None
            if preserve_export and not match:
                raise WorkerError("export_pixel_mismatch", "Processed reference pixel hash is missing")
            check = readback(source, partial, info, sdr_output=sdr_export,
                             reference_pixel_sha256=match[1] if match else None)
            if preserve_export:
                if not match or match[1] != check["decoded_pixel_sha256"]:
                    raise WorkerError("export_pixel_mismatch", "Encoded video differs from the processed 10-bit frame samples")
                check["encoding_pixel_check"] = {"all_frames_bit_exact": True, "reference_sha256": match[1], "decoded_sha256": match[1],
                                               "scope": "Graded YUV420p10 samples only; LUT and RGB/YUV conversion are not reversible"}
            check["encoder"] = encoder_name
            check["encoder_details"] = encoder_details
            check["range_conversion"] = "explicit RGB full to BT709 limited" if sdr_export else "source metadata preserved"
        if action == "preview":
            expected_signature = info.get("_source_stat_signature")
            if expected_signature is None or source_stat_signature(source) != expected_signature:
                raise WorkerError("source_changed_during_render", "Source identity changed while rendering preview")
        elif digest_file(source) != asset["sha256"]:
            raise WorkerError("source_changed_during_render", "Source bytes changed while rendering")
        os.replace(partial, target)
        result = {"status": "ok", "action": action, "output_path": str(target), "source_sha256": asset["sha256"],
                  "recipe_sha256": recipe_hash, "output_sha256": digest_file(target), "lut": {k: v for k,v in lut.items() if k not in {"path", "shaper_path"}} if lut else None,
                  "readback": check, "input_profile": asset["profile"],
                  "source_identity":{"cache_hit":asset["media_facts"].get("source_identity_cache_hit",False)},
                  "working_domain": "sdr_rec709_display_relative" if lut else "rec709_display_relative" if recipe.get("input_domain") == "rec709" or asset["profile"]["mode"] == "rec709" else None,
                  "low_light": {"amount": low_light, "algorithm_version": LOW_LIGHT_ALGORITHM_VERSION} if low_light else None,
                  "denoise": denoise_metadata(denoise) if denoise else None,
                  "skin_tracking": {k:v for k,v in skin_track.items() if k not in {"segments", "frame_regions", "mask_output"}} if skin_track else None}
        if skin_crop is not None:
            result["skin_processing_crop"] = skin_crop
        if tone_lut_info is not None:
            if tone_lut_info.get("basis") == "approved-source-time-ranges":
                public_tone = {"method": "temporal-tone-lut", "plan_version": 1,
                               "segment_count": len(recipe["tone_segments"]),
                               "preview_time_seconds": tone_lut_info["preview_time_seconds"],
                               "transition_max_seconds": .25}
            else:
                public_tone = {k:v for k,v in tone_lut_info.items() if k not in {"path", "shaper_path"}}
            result["tone_transform"] = public_tone | {
                "algorithm_version": TONE_ALGORITHM_VERSION,
                "shadows": term(tone.get("shadows"), "tone.shadows")["amount"] if tone.get("shadows") is not None else None,
                "highlights": term(tone.get("highlights"), "tone.highlights")["amount"] if tone.get("highlights") is not None else None}
        if action == "preview":
            live_width = min(640, preview_width)
            live_height = max(1, round(preview_height*live_width/preview_width))
            live_path = output_dir/"tone-base.rgb"
            checked(["ffmpeg", "-v", "error", "-xerror", "-i", str(base_path), "-vf",
                     f"scale={live_width}:{live_height}:flags=lanczos,format=rgb48le",
                     "-frames:v", "1", "-f", "rawvideo", "-y", str(live_path)])
            if live_path.stat().st_size != live_width*live_height*6:
                raise WorkerError("preview_dimensions_mismatch", "High precision live base size differs")
            result["tone_data_path"] = str(live_path)
            result["tone_data"] = {"width":live_width,"height":live_height,"format":"rgb48le"}
            result["before_path"] = str(before_path)
            result["base_path"] = str(base_path)
            result["after_path"] = str(target)
            result["sample_path"] = str(sample_path)
            shadow_term = term(tone.get("shadows"), "tone.shadows")
            highlight_term = term(tone.get("highlights"), "tone.highlights")
            result["preview_model"] = {
                "version": 1, "base_domain": result["working_domain"],
                "frame_time_seconds": check["sample_target_seconds"],
                "frame_pts_seconds": check["sample_frame_pts_seconds"],
                "tone": {"available": result["working_domain"] is not None and not recipe.get("tone_segments") and
                         not any(item is not None and item["region"] is not None for item in (shadow_term,highlight_term)),
                         "shadows": shadow_term["amount"] if shadow_term else None,
                         "highlights": highlight_term["amount"] if highlight_term else None,
                         "low_light": low_light,
                         "low_light_algorithm_version": LOW_LIGHT_ALGORITHM_VERSION,
                         "algorithm_version": TONE_ALGORITHM_VERSION,
                         "luminance_coefficients": [.2126,.7152,.0722],
                         "shadow_range": [SHADOW_START,SHADOW_END],
                         "highlight_range": [HIGHLIGHT_START,HIGHLIGHT_END],
                         "shadow_toe_stops_per_unit": 4, "highlight_span_stops_per_unit": 2, "output_clip": [0,1],
                         "formula": "shared-input-luminance"},
                "skin": {"amount": skin_term["amount"],
                         "brightness": skin_term["brightness"],
                         "smoothness": skin_term["smoothness"],
                         "face_regions": track_regions_for_frame(skin_track, frame_index),
                         "track_scope": skin_track.get("track_scope", "full_video")}
                        if skin_track is not None else None}
            try:
                proxy = preview_proxy(source, asset, lut, recipe, request, source_pts, build=False)
            except WorkerError as exc:
                if exc.code in {"proxy_cache_dir_invalid", "proxy_cache_invalid", "source_changed_during_render"}:
                    raise
                proxy = {"available": False, "reason": exc.code}
            result["proxy_status"] = {"available": proxy["available"],
                                      "reason": proxy.get("reason")}
            if proxy["available"]:
                result["proxy_path"] = proxy["path"]
                result["proxy_timing"] = proxy["timing"]
                result["proxy_cache_hit"] = proxy["cache_hit"]
                result["proxy_sha256"] = proxy["sha256"]
                result["proxy_bytes"] = proxy["bytes"]
        write_json(output_dir / "result.json", result)
        if mask_path is not None:
            mask_path.unlink(missing_ok=True)
        cleanup_tone_transform(tone_lut_info)
        if preview_frame_path is not None:
            preview_frame_path.unlink(missing_ok=True)
        return result
    except Exception as exc:
        partial.unlink(missing_ok=True)
        if mask_path is not None:
            mask_path.unlink(missing_ok=True)
        cleanup_tone_transform(tone_lut_info)
        if preview_frame_path is not None:
            preview_frame_path.unlink(missing_ok=True)
        if action == "preview":
            (output_dir / "before.png").unlink(missing_ok=True)
            (output_dir / "base.png").unlink(missing_ok=True)
            (output_dir / "sample.png").unlink(missing_ok=True)
            (output_dir / "tone-base.rgb").unlink(missing_ok=True)
        result = {"status": "error", "action": action, "code": exc.code if isinstance(exc, WorkerError) else "worker_failure",
                  "error": str(exc), "source_sha256": asset["sha256"], "recipe_sha256": recipe_hash}
        write_json(output_dir / "result.json", result)
        raise


def analyze(source: Path, asset: dict[str, Any], assets: dict[str, Any], recipe: dict[str, Any],
            catalog: tuple[list[dict[str, Any]], Path] | None, *, refine: bool = False) -> dict[str, Any]:
    analysis_started=time.perf_counter()
    decode_seconds=statistics_seconds=0.0
    # Seek directly to five bounded samples. A full-video FPS filter would
    # decode every frame of a long source just to keep a few RGB frames.
    scale=min(1.0,320/asset["width"],320/asset["height"])
    width=max(2,round(asset["width"]*scale/2)*2)
    height=max(2,round(asset["height"]*scale/2)*2)
    lut = None
    if recipe.get("lut_enabled") is True:
        lut = match_lut(asset["profile"], recipe.get("look"), catalog, grid=recipe.get("lut_grid"), verify=True)
        if not lut["available"]:
            raise WorkerError("lut_unsupported", lut["reason"])
    measurement_domain = ("sdr_rec709_display_relative" if lut else
                          "rec709_display_relative" if recipe.get("input_domain") == "rec709" or asset["profile"]["mode"] == "rec709" else
                          "decoded_source_rgb_unknown_transfer")
    can_suggest = measurement_domain in {"sdr_rec709_display_relative", "rec709_display_relative"}
    filter_chain = [f"scale={width}:{height}", "format=gbrpf32le"]
    if lut:
        filter_chain.append(lut_filter(lut["path"]))
    filter_chain.append("format=rgb48le")
    frame_size = width * height * 6
    try:
        frame_interval = float(1/Fraction(asset["media_facts"]["frame_rate"]))
    except (TypeError, ValueError, ZeroDivisionError):
        frame_interval = .1
    duration = asset["duration"]
    if duration <= 0:
        raise WorkerError("analyze_decode_failed", "Source duration is unavailable")
    # Stay before the final displayed frame even when container duration
    # extends one frame past its last PTS. No full-frame index is built here.
    latest_safe_seek = max(0.0,duration-max(.05,frame_interval*1.5))
    requested_times = sorted({round(min(duration*fraction,latest_safe_seek),6)
                              for fraction in (.1,.3,.5,.7,.9)})

    def decode_sample(seek_at: float) -> bytes:
        command = ["ffmpeg", "-hide_banner", "-v", "error", "-xerror", "-nostdin",
                   "-ss", fmt(seek_at), "-i", str(source), "-map", "0:v:0",
                   "-vf", ",".join(filter_chain), "-frames:v", "1", "-an", "-f", "rawvideo", "-"]
        try:
            process = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
        except FileNotFoundError as exc:
            raise WorkerError("dependency_missing", "ffmpeg unavailable") from exc
        frame = process.stdout
        if process.returncode or len(frame) != frame_size:
            raise WorkerError("analyze_decode_failed", process.stderr.decode(errors="replace")[-1000:] or "Sparse RGB seek failed")

        return frame

    # Each seek decodes only a small segment near its target. A small worker
    # pool overlaps that independent I/O/decode work without spawning five
    # high-resolution decoders at once. Executor.map retains request order.
    stage_started=time.perf_counter()
    with ThreadPoolExecutor(max_workers=min(3, len(requested_times))) as pool:
        sampled_frames = list(pool.map(decode_sample, requested_times))
    decode_seconds+=time.perf_counter()-stage_started
    stage_started=time.perf_counter()
    stats = summarize_rgb16(list(zip(requested_times, sampled_frames)), width, height, eligible=can_suggest)
    statistics_seconds+=time.perf_counter()-stage_started
    if refine and measurement_domain in {"sdr_rec709_display_relative", "rec709_display_relative"}:
        # Refinement is explicit and bounded: inspect only distribution-change
        # midpoints, never decode a full shot-detection pass in the preview path.
        sampled = dict(zip(requested_times, sampled_frames))
        for _ in range(2):
            extra = tone_refinement_times(stats["frame_summaries"], duration, budget=4)
            extra = [time for time in extra if time not in sampled]
            if not extra:
                break
            stage_started=time.perf_counter()
            with ThreadPoolExecutor(max_workers=min(3, len(extra))) as pool:
                sampled.update(zip(extra, pool.map(decode_sample, extra)))
            decode_seconds+=time.perf_counter()-stage_started
            stage_started=time.perf_counter()
            requested_times = sorted(sampled)
            sampled_frames = [sampled[time] for time in requested_times]
            stats = summarize_rgb16(list(zip(requested_times, sampled_frames)), width, height, eligible=can_suggest)
            statistics_seconds+=time.perf_counter()-stage_started
    if not stats["pixel_count"]:
        raise WorkerError("analyze_decode_failed", "No sampled video frames")
    frames = len(sampled_frames)
    p10, p50, p90, p99 = (stats["percentiles"][name]
                          for name in ("p10", "p50", "p90", "p99"))
    result = {"status": "ok", "action": "analyze", "source_sha256": asset["sha256"],
            "source_identity":{"cache_hit":asset["media_facts"].get("source_identity_cache_hit",False)},
            "measurement": {"domain": measurement_domain, "sampled_frames": frames,
                            "sample_times_seconds": requested_times,
                            "sampling_method": (("up to five duration-based seeks plus at most eight explicitly requested refinement seeks; " if refine else "up to five duration-based input seeks; ") + "times and per-frame summaries use "
                                                "requested seek positions, not decoded PTS"),
                            "refined": refine,
                            "sample_width": width, "sample_height": height,
                            "sampling_pixel_format": "rgb48le", "luma_histogram_bins":4096,
                            "statistics_backend":stats["statistics_backend"],
                            "percentiles": stats["percentiles"],
                            "dark_fraction": stats["dark_fraction"],
                            "near_white_fraction": stats["near_white_fraction"],
                            "frame_summaries": stats["frame_summaries"]},
            "profile": asset["profile"], "lut": asset["lut"], "lut_options": public_lut_options(asset["profile"], catalog)}
    person_started=time.perf_counter()
    try:
        result["skin_candidate"] = vision_sample_faces(source, assets)
    except WorkerError as exc:
        result["skin_candidate"] = {"available": False, "candidate_only": True,
                                     "confidence": "unavailable", "reason": exc.code}
    person_seconds=time.perf_counter()-person_started
    result["tone_advice"] = stats["tone_advice"]
    noise_samples = [noise_metrics(frame, width, height) for frame in sampled_frames] if min(width,height) >= 8 and can_suggest else []
    reliable_noise = [item for item in noise_samples if item.get("noise_sigma") is not None and item.get("noise_confidence",0) >= .5]
    result["noise_advice"] = {
        "available": bool(noise_samples), "sample_count": len(noise_samples),
        "reliable_samples": len(reliable_noise), "default_amount": None,
        "flat_patch_sigma": sorted(item["noise_sigma"] for item in reliable_noise)[len(reliable_noise)//2] if reliable_noise else None,
        "method": "sampled flat-patch spatial residual; coherent structure excluded",
        "limitation": "Downscaled samples are not a sensor-noise measurement; use original-size detail preview before choosing denoising.",
    }
    result["tone_intervals"] = analyze_tone_intervals(stats["frame_summaries"], duration, can_suggest)
    shadows = stats["tone_advice"]["suggestions"]["shadows"]
    highlights = stats["tone_advice"]["suggestions"]["highlights"]
    if can_suggest:
        hue_bins = stats["hue_bins"]
        total_hue_weight = sum(hue_bins)
        shares = [weight/total_hue_weight if total_hue_weight else 0 for weight in hue_bins]
        entropy = max(0.0, -sum(share*math.log(share) for share in shares if share) / math.log(len(hue_bins)))
        chromatic_fraction = stats["chromatic_pixels"]/stats["pixel_count"]
        occupied_bins = sum(share >= .02 for share in shares)
        colors_diverse = chromatic_fraction >= .25 and entropy >= .55 and occupied_bins >= 6
        dominant = [index for index in sorted(range(len(shares)), key=lambda index: shares[index], reverse=True)
                    if shares[index] > 0][:3]
        result["color_advice"] = {
            "available": True, "colors_diverse": colors_diverse,
            "summary": "抽样画面颜色较丰富；若只想调整一种颜色，可先点选该颜色并收窄颜色范围。" if colors_diverse else
                       "抽样画面的颜色相对集中；可按希望调整的颜色选择范围。",
            "confidence": "low",
            "evidence": {"chromatic_pixel_fraction": round(chromatic_fraction,4),
                         "normalized_hue_entropy": round(entropy,4),
                         "occupied_hue_bins": occupied_bins, "hue_bin_count": len(hue_bins),
                         "dominant_hues": [{"hue_degrees": (index+.5)*15,
                                             "weight_fraction": round(shares[index],4)} for index in dominant],
                         "sampled_frames": frames,
                         "method": "24-bin chroma-weighted hue histogram of sampled display RGB",
                         "limitation": "Measures color variety only; it does not measure sensor noise, quality, or visual clutter."}}
    else:
        result["color_advice"] = {"available": False, "colors_diverse": None, "summary": None,
                                  "confidence": "unavailable", "reason": "working_domain_unknown"}
    result["suggestions"] = {"shadows": shadows, "highlights": highlights, "skin": None,
                             "evidence": {"domain": measurement_domain, "p10": p10, "p50": p50, "p90": p90, "p99": p99,
                                          "basis": "precision-aware structure-guarded display-luma curve targets; user must accept any edit",
                                          "skin": "face candidate alone gives no target skin correction"},
                             "confidence": "low" if can_suggest else "unavailable"}
    result["analysis_timing_seconds"]={"decode_samples":round(decode_seconds,4),
                                       "statistics":round(statistics_seconds,4),
                                       "person_samples":round(person_seconds,4),
                                       "total":round(time.perf_counter()-analysis_started,4)}
    return result


def analyze_sample_pixels(samples: list[tuple[float, bytes]], frame_size: int) -> dict[str, Any]:
    """Summarize sampled RGB frames with bounded 8-bit luma histograms.

    Luma is rounded to the same integer display-code value as the previous
    list-and-sort path, so percentiles and advice thresholds remain exact.
    Per-frame summaries use requested seek positions; FFmpeg rawvideo carries
    no presentation timestamp to report here.
    """
    global_histogram = [0] * 256
    global_pixel_count = 0
    hue_bins = [0.0] * 24
    chromatic_pixels = 0
    frame_summaries: list[dict[str, Any]] = []

    def percentile(histogram: list[int], pixel_count: int, fraction: float) -> int:
        target = round((pixel_count - 1) * fraction)
        cumulative = 0
        for value, count in enumerate(histogram):
            cumulative += count
            if cumulative > target:
                return value
        raise WorkerError("analyze_decode_failed", "No sampled video pixels")

    for seek_at, frame in samples:
        if len(frame) != frame_size:
            raise WorkerError("analyze_decode_failed", "Sparse RGB sample has an unexpected size")
        histogram = [0] * 256
        pixel_count = 0
        luma_sum = 0
        dark_pixels = 0
        near_white_pixels = 0
        for i in range(0, frame_size, 3):
            red, green, blue = frame[i], frame[i+1], frame[i+2]
            luma = round(.2126*red + .7152*green + .0722*blue)
            histogram[luma] += 1
            pixel_count += 1
            luma_sum += luma
            dark_pixels += luma <= 5
            near_white_pixels += luma >= 250
            chroma = (max(red,green,blue)-min(red,green,blue))/255
            if chroma >= .12:
                chromatic_pixels += 1
                hue = math.degrees(math.atan2(math.sqrt(3)*(green-blue),2*red-green-blue)) % 360
                hue_bins[min(23,int(hue/15))] += chroma
        if not pixel_count:
            continue
        for value, count in enumerate(histogram):
            global_histogram[value] += count
        global_pixel_count += pixel_count
        frame_summaries.append({"time_seconds": seek_at,
                                "luma_mean": round(luma_sum/pixel_count, 3),
                                "p10": percentile(histogram, pixel_count, .10),
                                "p50": percentile(histogram, pixel_count, .50),
                                "p90": percentile(histogram, pixel_count, .90),
                                "p99": percentile(histogram, pixel_count, .99),
                                "dark_fraction": dark_pixels/pixel_count,
                                "near_white_fraction": near_white_pixels/pixel_count})

    if not global_pixel_count:
        raise WorkerError("analyze_decode_failed", "No sampled video pixels")
    percentiles = {name: percentile(global_histogram, global_pixel_count, fraction)
                   for name, fraction in (("p01", .01), ("p10", .10), ("p50", .50), ("p90", .90), ("p99", .99))}
    return {"pixel_count": global_pixel_count,
            "percentiles": percentiles,
            "dark_fraction": sum(global_histogram[:6])/global_pixel_count,
            "near_white_fraction": sum(global_histogram[250:])/global_pixel_count,
            "frame_summaries": frame_summaries,
            "hue_bins": hue_bins,
            "chromatic_pixels": chromatic_pixels}


def handle(request: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(request, dict) or request.get("action") not in {"probe", "analyze", "preview", "render", "proxy", "playback", "ai-samples"}:
        raise WorkerError("request_invalid", "action must be probe, analyze, preview, playback, render, proxy, or ai-samples")
    source_name = request.get("source_path")
    if not isinstance(source_name, str):
        raise WorkerError("source_path_invalid", "source_path must be absolute")
    source = Path(source_name)
    recipe = request.get("recipe") or {}
    assets = request.get("assets") or {}
    if not isinstance(recipe, dict) or not isinstance(assets, dict):
        raise WorkerError("request_invalid", "recipe/assets must be objects")
    catalog = load_catalog(assets)
    if request["action"] == "probe":
        paths = source_files(source)
        found: list[dict[str, Any]] = []
        errors: list[dict[str, str]] = []
        for path in paths:
            try:
                asset, _ = asset_probe(path, recipe, catalog,request.get("source_cache_dir"))
                found.append(asset)
            except WorkerError as exc:
                errors.append({"path": str(path), "code": exc.code, "error": str(exc)})
        if source.is_file() and errors:
            raise WorkerError(errors[0]["code"], errors[0]["error"])
        result = {"status": "ok", "action": "probe", "assets": found, "errors": errors}
        if source.is_file() and found:
            result["asset"] = found[0]
        return result
    if source.is_dir():
        raise WorkerError("source_path_invalid", "This action requires a video file")
    asset, info = asset_probe(source, recipe, catalog,request.get("source_cache_dir") if request["action"]!="render" else None)
    if request["action"] == "analyze":
        if not isinstance(request.get("analysis_refine", False), bool):
            raise WorkerError("request_invalid", "analysis_refine must be a boolean")
        return analyze(source, asset, assets, recipe, catalog, refine=request.get("analysis_refine", False))
    if request["action"] == "proxy":
        return build_proxy_action(request, source, asset, catalog)
    if request["action"] == "ai-samples":
        return ai_samples(request, source, asset, info, catalog)
    return render(request, source, asset, info, catalog)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request-file", type=Path)
    args = parser.parse_args()
    try:
        payload = args.request_file.read_text() if args.request_file else sys.stdin.read()
        request = json.loads(payload)
        result = handle(request)
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 0
    except Exception as exc:
        code = exc.code if isinstance(exc, WorkerError) else "worker_failure"
        print(json.dumps({"status": "error", "code": code, "error": str(exc)}, ensure_ascii=False, separators=(",", ":")))
        return 1


if __name__ == "__main__":
    sys.exit(main())
