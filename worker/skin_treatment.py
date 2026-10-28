"""Pure skin-treatment recipe validation and FFmpeg filter construction.

The worker supplies a normalized face × skin-hue × optional-region mask. The
builder keeps that mask tied to the unmodified input, then applies a selective
exposure/saturation adjustment and, when requested, a bilateral detail pass
inside the same soft mask. It uses only the Python standard library; FFmpeg
provides the edge-preserving spatial filter.
"""

from __future__ import annotations

from itertools import count
import math
import threading
from typing import Any


_LABELS = count(1)
_LABEL_LOCK = threading.Lock()
_REGION_KEYS = {"x", "y", "width", "height", "feather"}
_SKIN_KEYS = {"amount", "brightness", "smoothness", "region"}


def _number(value: Any, name: str, minimum: float, maximum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a finite number in [{minimum}, {maximum}]")
    converted = float(value)
    if not math.isfinite(converted) or not minimum <= converted <= maximum:
        raise ValueError(f"{name} must be a finite number in [{minimum}, {maximum}]")
    return converted


def normalize_skin(value: Any) -> dict[str, Any] | None:
    """Validate a legacy or current skin recipe and return its canonical form.

    ``None`` remains disabled. A legacy scalar means saturation-only, and an
    old ``{amount, region}`` object receives neutral brightness/smoothness.
    The output shape is always ``{amount, brightness, smoothness, region}``.
    """
    if value is None:
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        settings: dict[str, Any] = {"amount": value}
    elif isinstance(value, dict):
        unknown = set(value) - _SKIN_KEYS
        if unknown:
            raise ValueError(f"skin has unsupported fields: {', '.join(sorted(map(str, unknown)))}")
        if "amount" not in value:
            raise ValueError("skin.amount is required")
        settings = value
    else:
        raise ValueError("skin must be null, a number, or an amount object")

    amount = _number(settings["amount"], "skin.amount", -1, 1)
    brightness = _number(settings.get("brightness", 0), "skin.brightness", 0, 1)
    smoothness = _number(settings.get("smoothness", 0), "skin.smoothness", 0, 1)
    region = settings.get("region")
    if region is not None:
        if not isinstance(region, dict):
            raise ValueError("skin.region must be an object or null")
        unknown = set(region) - _REGION_KEYS
        missing = {"x", "y", "width", "height"} - set(region)
        if unknown or missing:
            details = []
            if missing:
                details.append(f"missing {', '.join(sorted(missing))}")
            if unknown:
                details.append(f"unsupported {', '.join(sorted(map(str, unknown)))}")
            raise ValueError(f"skin.region has {'; '.join(details)}")
        x = _number(region["x"], "skin.region.x", 0, 1)
        y = _number(region["y"], "skin.region.y", 0, 1)
        width = _number(region["width"], "skin.region.width", 0, 1)
        height = _number(region["height"], "skin.region.height", 0, 1)
        feather = _number(region.get("feather", 0), "skin.region.feather", 0, 0.25)
        if width == 0 or height == 0 or x + width > 1 or y + height > 1:
            raise ValueError("skin.region exceeds the normalized frame")
        region = {"x": x, "y": y, "width": width, "height": height, "feather": feather}

    return {"amount": amount, "brightness": brightness, "smoothness": smoothness, "region": region}


def _fmt(value: float) -> str:
    return f"{value:.8g}"


def _adjustment_filter(settings: dict[str, Any], mask_expr: str) -> str:
    """Build the exact per-pixel adjustment, caching mask and luma per plane."""
    amount = settings["amount"]
    brightness = settings["brightness"]
    if amount == 0 and brightness == 0:
        return "null"

    mask = f"clip(({mask_expr}),0,1)"
    luminance = "((0.2126*r(X,Y)+0.7152*g(X,Y)+0.0722*b(X,Y))/1023)"
    if brightness:
        # Anchor the shoulder at black and white. For neutral pixels the output
        # is Y + k*Y*(1-Y), where k <= 2**0.7-1 < 1, so the full-range curve
        # stays monotonic instead of brightening midtones past highlights.
        requested_gain = (f"(1+(pow(2,{_fmt(brightness * 0.7)}*ld(1))-1)"
                          f"*(1-ld(0)/1023))")
        # Account for the requested saturation change before bounding exposure
        # by the hottest channel. This preserves RGB proportions through the
        # brightness lift without making brightness undo saturation or darken
        # an already out-of-gamut saturation adjustment.
        saturation_gain = f"(1+{_fmt(amount * 0.35)}*ld(1))" if amount else "1"
        saturated_channels = [
            f"(ld(0)+({channel}-ld(0))*{saturation_gain})"
            for channel in ("r(X,Y)", "g(X,Y)", "b(X,Y)")
        ]
        hottest = (f"max(max({saturated_channels[0]},{saturated_channels[1]}),"
                   f"max({saturated_channels[2]},1))")
        headroom = f"max(1,1023/{hottest})"
        brightness_gain = f"min({requested_gain},{headroom})"
    else:
        brightness_gain = "1"

    components: list[str] = []
    for channel in ("r(X,Y)", "g(X,Y)", "b(X,Y)"):
        expression = channel
        if amount:
            # Preserve the existing scalar control's saturation response.
            expression = (f"(ld(0)+({expression}-ld(0))"
                          f"*(1+{_fmt(amount * 0.35)}*ld(1)))")
        if brightness:
            expression = f"({expression}*{brightness_gain})"
        cached = f"(st(0,{luminance}*1023);st(1,{mask});{expression})"
        components.append(f"{channel[0]}='clip({cached},0,1023)'")
    return "geq=" + ":".join(components) + ":i=nearest"


def _next_prefix() -> str:
    with _LABEL_LOCK:
        serial = next(_LABELS)
    return f"hvp_skin_{serial:06d}"


def build_skin_filter(
    settings: dict[str, Any] | None,
    mask_expr: str,
    *,
    pixel_scale: float = 1.0,
) -> str:
    """Return a comma-composable, single-input/single-output FFmpeg fragment.

    ``settings`` must be the canonical output of :func:`normalize_skin`.
    ``mask_expr`` is an FFmpeg expression in [0, 1], normally the product of
    tracked-face, skin-hue, and optional user-region masks. The adjustment
    preserves the legacy soft-mask pixel equation and caches mask/luminance
    once per output component. In the smoothing branch, the same selection is
    materialized as a grayscale frame for the final mask merge.

    ``pixel_scale`` is the current processing width divided by the 960-pixel
    preview reference width. Spatial bilateral radius scales with it so a
    full-resolution export has approximately the same effect relative to the
    face as the preview. ``sigmaR`` stays fixed because it is a color-distance
    threshold, not a spatial radius.

    With ``smoothness == 0`` this is an ordinary one-chain ``geq`` fragment,
    retaining the legacy mask-weighted saturation/exposure behaviour. With
    smoothing enabled the fragment contains a private ``split`` subgraph
    separated by semicolons, but remains one input and one output and can be
    joined to surrounding filter chains with commas. Labels are namespaced and
    unique per builder call because a preview may place two treatment branches
    in one ``filter_complex``.

    Input pixels are expected in ``gbrp10le`` as in the media worker's existing
    tone pipeline. ``bilateral`` uses a restrained spatial/range sigma and the
    generated soft mask is the final gate, so pixels outside the selected skin
    region pass through unchanged.
    """
    if isinstance(pixel_scale, bool) or not isinstance(pixel_scale, (int, float)):
        raise ValueError("pixel_scale must be a finite number greater than zero")
    try:
        pixel_scale = float(pixel_scale)
    except (OverflowError, ValueError):
        raise ValueError("pixel_scale must be a finite number greater than zero") from None
    if not math.isfinite(pixel_scale) or pixel_scale <= 0:
        raise ValueError("pixel_scale must be a finite number greater than zero")
    if settings is None:
        return "null"
    if not isinstance(settings, dict) or set(settings) != _SKIN_KEYS:
        raise ValueError("settings must be the canonical normalize_skin result")
    settings = normalize_skin(settings)
    assert settings is not None
    amount = settings["amount"]
    brightness = settings["brightness"]
    smoothness = settings["smoothness"]
    if not isinstance(mask_expr, str) or not mask_expr.strip():
        raise ValueError("mask_expr must be a nonempty FFmpeg expression")
    # Avoid crossing the surrounding filtergraph's quoting/chain boundaries.
    if any(character in mask_expr for character in "':\n\r;[]"):
        raise ValueError("mask_expr contains unsupported filtergraph punctuation")

    adjustment = _adjustment_filter(settings, mask_expr)
    if amount == 0 and brightness == 0 and smoothness == 0:
        return "null"
    if smoothness == 0:
        return adjustment

    prefix = _next_prefix()
    source = f"{prefix}_source"
    mask_source = f"{prefix}_mask_source"
    toned = f"{prefix}_toned"
    original = f"{prefix}_original"
    smooth_input = f"{prefix}_smooth_input"
    blurred = f"{prefix}_blurred"
    mask = f"{prefix}_mask"

    # sigmaS controls the radius, sigmaR the edge sensitivity. Both rise gently
    # with the user's control; full-strength treatment stays local and keeps
    # strong facial boundaries. Mask alpha supplies a final soft transition.
    # FFmpeg bilateral documents sigmaS in [0, 512]. In supported workflows
    # scale is processing_width / 960 (typically <= 8.5); the clamp protects
    # malformed or future extreme dimensions while preserving the requested
    # proportional radius throughout practical video sizes.
    sigma_s = min(512.0, (1.5 + smoothness * 6.5) * pixel_scale)
    sigma_r = 0.015 + smoothness * 0.060
    mask_rgb = f"clip(({mask_expr})*{_fmt(smoothness)}*1023,0,1023)"
    return ";".join((
        f"split=2[{source}][{mask_source}]",
        f"[{mask_source}]geq=r='{mask_rgb}':g='{mask_rgb}':b='{mask_rgb}':i=nearest,format=gray10le[{mask}]",
        f"[{source}]{adjustment}[{toned}]",
        f"[{toned}]split=2[{original}][{smooth_input}]",
        f"[{smooth_input}]bilateral=sigmaS={_fmt(sigma_s)}:sigmaR={_fmt(sigma_r)}:planes=7[{blurred}]",
        f"[{original}][{blurred}][{mask}]maskedmerge=planes=7",
    ))
