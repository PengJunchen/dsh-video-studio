"""Generate a temporary 3D LUT for global highlight and shadow adjustments.

The LUT operates on display-referred RGB after any input conversion. Spatial
adjustments deliberately return ``None`` so the caller keeps its per-pixel path.
"""

from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
from typing import Any


LUT_SIZE = 65

SHADOW_START = 0.0
SHADOW_END = .40
HIGHLIGHT_START = .55
HIGHLIGHT_END = 1.0
TONE_ALGORITHM_VERSION = "shared-tone-v3"
LOW_LIGHT_ALGORITHM_VERSION = "low-light-v1"
_TONE_ALGORITHM_HASH_VERSION = 3
SHAPER_SIZE = 16384


def _global_amount(value: Any) -> tuple[float, bool] | None:
    """Return (amount, has_region), leaving invalid values to worker validation."""
    if value is None:
        return 0.0, False
    if isinstance(value, dict):
        amount = value.get("amount")
        has_region = value.get("region") is not None
    else:
        amount = value
        has_region = False
    if isinstance(amount, bool) or not isinstance(amount, (int, float)):
        return None
    if not math.isfinite(amount) or not -1 <= amount <= 1:
        return None
    return float(amount), has_region


def _low_light_amount(value: Any) -> float | None:
    """An optional global strength; it is independent of the v3 shadows slider."""
    if value is None:
        return 0.0
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value) or not 0 <= value <= 1:
        return None
    return float(value)


def _smoothstep(value: float, start: float, end: float) -> float:
    position = max(0.0, min(1.0, (value - start) / (end - start)))
    return position * position * (3.0 - 2.0 * position)


def _unclipped_tone_rgb(red: float, green: float, blue: float,
                        shadows: float, highlights: float,
                        low_light: float = 0.0) -> tuple[float, float, float]:
    """Analytic global transform before the final output-format clamp.

    Both tonal weights inspect the same input luminance, as the shared tap in
    the feature design requires. The separated supports make the controls
    independent. The rational toe and highlight shoulder keep every allowed adjustment
    monotonic on neutral values. Out-of-range vertices preserve a smooth
    surface for tetrahedral interpolation across the final clipping boundary.
    """
    luminance = .2126 * red + .7152 * green + .0722 * blue
    gain = _tone_gain(luminance, shadows, highlights, low_light)
    if low_light and max(red, green, blue) > 0:
        # Only bound the *additional* lift. Existing v3 clipping is unchanged.
        # A common RGB multiplier keeps hue and channel ratios before output
        # quantization, while avoiding new single-channel clipping.
        base_gain = _tone_gain(luminance, shadows, highlights)
        gain = min(gain, max(base_gain, 1.0 / max(red, green, blue)))
    return red * gain, green * gain, blue * gain


def _low_light_map(luminance: float, amount: float) -> float:
    """Extra monotone toe, with black fixed and a unit-slope join at 0.4.

    Its near-black slope ranges from 1 to 8. The upper part of the display
    curve remains untouched; this is not an exposure transform or recovery of
    information discarded by an upstream LUT.
    """
    if amount == 0 or luminance <= 0 or luminance >= SHADOW_END:
        return luminance
    t = luminance / SHADOW_END
    slope = 2.0 ** (3.0 * amount)
    return luminance * (t + slope * (1.0-t)) / (1.0 + (slope-1.0)*t*(1.0-t))


def _tone_gain(luminance: float, shadows: float, highlights: float,
               low_light: float = 0.0) -> float:
    """Evaluate v3 first, then optionally compose a stronger low-light toe."""
    if luminance < SHADOW_END:
        # Monotone rational quadratic with endpoint slopes 2^(4*s), 1.
        # Black remains black; shadows join the unchanged midtones at 0.4.
        t = max(0.0, luminance) / SHADOW_END
        slope = 2.0 ** (4.0 * shadows)
        gain = (t + slope * (1.0-t)) / (1.0 + (slope-1.0)*t*(1.0-t))
    elif luminance <= HIGHLIGHT_START:
        gain = 1.0
    else:
        distance = luminance - HIGHLIGHT_START
        span = HIGHLIGHT_END - HIGHLIGHT_START
        endpoint_gain = 2.0 ** (2.0 * highlights)
        if highlights < 0:
            mapped = HIGHLIGHT_START + distance / (1.0 + (1.0/endpoint_gain-1.0)*distance/span)
        else:
            mapped = HIGHLIGHT_START + distance * (1.0 + (endpoint_gain-1.0)*distance/span)
        gain = mapped / luminance
    if low_light == 0:
        return gain
    if luminance <= 0:
        return gain * 2.0 ** (3.0 * low_light)
    return _low_light_map(luminance * gain, low_light) / luminance


def tone_lut_filter(info: dict[str, Any], enable: str | None = None) -> str:
    """Keep the dark-dense shaper and its inverse-sampled 3D LUT together."""
    import re
    paths = [info.get("shaper_path"), info.get("path")]
    if any(path is not None and (not isinstance(path, str) or re.search(r"[':,;\[\]\\]", path))
           for path in paths):
        raise ValueError("LUT path contains unsupported filter characters")
    timeline = f":enable='{enable}'" if enable is not None else ""
    return (f"lut1d=file='{paths[0]}':interp=linear{timeline}," if paths[0] else "") + \
           f"lut3d=file='{paths[1]}':interp=tetrahedral{timeline}"


def tone_rgb(red: float, green: float, blue: float,
             shadows: float, highlights: float,
             low_light: float = 0.0) -> tuple[float, float, float]:
    """Final clipped analytic target for fidelity checks."""
    return tuple(min(1.0, max(0.0, value)) for value in
                 _unclipped_tone_rgb(red, green, blue, shadows, highlights, low_light))


def create_tone_lut(recipe: dict[str, Any], output_dir: Path) -> dict[str, Any] | None:
    """Write an exclusive 65³ CUBE for global tone and return its provenance.

    The caller owns cleanup. If a region is present, or no tonal effect is
    requested, this function creates no file and returns ``None``. Invalid
    recipes also pass through so the existing worker reports its usual error.
    """
    if not isinstance(recipe, dict):
        return None
    tone = recipe.get("tone") or {}
    if not isinstance(tone, dict):
        return None
    shadow = _global_amount(tone.get("shadows"))
    highlight = _global_amount(tone.get("highlights"))
    low_light = _low_light_amount(tone.get("low_light"))
    if shadow is None or highlight is None or low_light is None:
        return None
    shadows, shadow_region = shadow
    highlights, highlight_region = highlight
    if shadow_region or highlight_region or (shadows == 0.0 and highlights == 0.0 and low_light == 0.0):
        return None

    parameters = {"version": _TONE_ALGORITHM_HASH_VERSION, "size": LUT_SIZE,
                  "shadows": shadows, "highlights": highlights}
    if low_light:
        parameters["low_light"] = low_light
    parameter_hash = hashlib.sha256(json.dumps(parameters, sort_keys=True,
                                                separators=(",", ":")).encode("ascii")).hexdigest()[:20]
    root = Path(output_dir).resolve()
    root.mkdir(parents=True, exist_ok=True)
    path = root / f".tone-{parameter_hash}.cube"
    # sqrt encoding allocates more grid cells to low light. It is an
    # internal reversible sampling transform, never an image gamma change.
    levels = [(index / (LUT_SIZE - 1)) ** 2 for index in range(LUT_SIZE)]
    shaper_path = path.with_suffix(".shaper.cube")
    created = False
    shaper_created = False
    digest = hashlib.sha256()
    try:
        with shaper_path.open("x", encoding="ascii") as shaper:
            shaper_created = True
            shaper.write(f'LUT_1D_SIZE {SHAPER_SIZE}\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n')
            shaper.writelines(f"{value:.12f} {value:.12f} {value:.12f}\n"
                             for value in (math.sqrt(index/(SHAPER_SIZE-1)) for index in range(SHAPER_SIZE)))
        # CUBE files store red as the fastest-changing axis, then green, blue.
        # Hash the exact bytes as they are written, avoiding a second file read.
        with path.open("xb") as cube:
            created = True
            header = (f'TITLE "HVP global tone"\nLUT_3D_SIZE {LUT_SIZE}\n'
                      'DOMAIN_MIN 0.0 0.0 0.0\nDOMAIN_MAX 1.0 1.0 1.0\n').encode("ascii")
            cube.write(header)
            digest.update(header)

            red_luma = [.2126 * value for value in levels]
            green_luma = [.7152 * value for value in levels]
            blue_luma = [.0722 * value for value in levels]
            rows: list[str] = []

            def flush_rows() -> None:
                if rows:
                    block = "".join(rows).encode("ascii")
                    cube.write(block)
                    digest.update(block)
                    rows.clear()

            # Precompute channel contributions and avoid computing both tone
            # weights for vertices outside their support. Mid-range vertices
            # need no power or smoothstep evaluation at all.
            for blue_index, blue in enumerate(levels):
                for green_index, green in enumerate(levels):
                    green_blue_luma = green_luma[green_index] + blue_luma[blue_index]
                    for red_index, red in enumerate(levels):
                        luminance = red_luma[red_index] + green_blue_luma
                        gain = _tone_gain(luminance, shadows, highlights, low_light)
                        if low_light and max(red, green, blue) > 0:
                            base_gain = _tone_gain(luminance, shadows, highlights)
                            gain = min(gain, max(base_gain, 1.0 / max(red, green, blue)))
                        rows.append(f"{red * gain:.9f} {green * gain:.9f} {blue * gain:.9f}\n")
                        if len(rows) == 4096:
                            flush_rows()
            flush_rows()
    except BaseException:
        if created:
            path.unlink(missing_ok=True)
        if shaper_created:
            shaper_path.unlink(missing_ok=True)
        raise
    return {"path": str(path), "sha256": digest.hexdigest(), "size": LUT_SIZE,
            "shaper_path": str(shaper_path), "shaper_sha256": hashlib.sha256(shaper_path.read_bytes()).hexdigest(),
            "method": "generated-tone-lut", "algorithm_version": TONE_ALGORITHM_VERSION,
            **({"low_light_algorithm_version": LOW_LIGHT_ALGORITHM_VERSION} if low_light else {})}
