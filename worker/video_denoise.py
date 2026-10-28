"""Camera-independent, detail-conservative video denoising.

The filter accepts display-referred, full-range ``gbrpf32le`` from the media
worker. FFmpeg's bilateral filter has integer planar RGB support, but not float
RGB support. The precision change is explicit: float -> planar 16 bit -> float.
No 8-bit intermediate, temporal averaging, frame buffering, or model is used.

Apply this fragment after input-domain conversion and before a creative LUT or
shadow lift. The same settings are used for a still frame and every video frame.
Preview resizing and proxy encoding can still change the visible result.
"""

from __future__ import annotations

from array import array
import math
import re
import statistics
import sys
from typing import Any


def normalize_denoise(value: Any) -> dict[str, float] | None:
    """Normalize an optional, user-selected denoise amount in ``[0, 1]``.

    Zero, an empty setting, and null all mean disabled. There is no automatic
    decision from noise measurements: texture and grain are artistic content.
    """
    if value is None:
        return None
    if isinstance(value, dict):
        unknown = set(value) - {"amount"}
        if unknown:
            raise ValueError(f"denoise has unsupported fields: {', '.join(sorted(map(str, unknown)))}")
        if not value:
            return None
        if "amount" not in value:
            raise ValueError("denoise.amount is required")
        amount = value["amount"]
    else:
        amount = value
    if isinstance(amount, bool) or not isinstance(amount, (int, float)):
        raise ValueError("denoise.amount must be a finite number in [0, 1]")
    try:
        amount = float(amount)
    except (OverflowError, ValueError):
        raise ValueError("denoise.amount must be a finite number in [0, 1]") from None
    if not math.isfinite(amount) or not 0 <= amount <= 1:
        raise ValueError("denoise.amount must be a finite number in [0, 1]")
    return {"amount": amount} if amount else None


def denoise_filter(value: Any, *, preview: bool = False,
                   label_prefix: str = "dn") -> str:
    """Return a comma-composable FFmpeg fragment for full-range float RGB.

    The caller must provide a unique ``label_prefix`` when it constructs more
    than one branch in a filtergraph. The prefix is validated before inclusion
    and cannot inject filtergraph syntax. Zero returns ``null`` exactly.

    ``preview`` is deliberately algorithm-neutral. The filter is spatial and
    operates independently on each frame, so using weaker or temporal settings
    in a still preview would misrepresent playback and export. The caller is
    responsible for the surrounding frame scale and source-domain transform.
    """
    if not isinstance(preview, bool):
        raise ValueError("preview must be a boolean")
    if not isinstance(label_prefix, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,63}", label_prefix):
        raise ValueError("label_prefix must be a filtergraph-safe identifier of at most 64 characters")
    settings = normalize_denoise(value)
    if settings is None:
        return "null"
    amount = settings["amount"]
    # A restrained range threshold keeps one-pixel contrast details. At full
    # strength on a synthetic dark frame (sigma 0.025), this reduces flat-field
    # noise about 29% while retaining about 88% of a 0.06-contrast fine line.
    sigma_s = 1.0 + amount
    sigma_r = 0.015 + 0.025 * amount
    original = f"{label_prefix}_original"
    candidate = f"{label_prefix}_candidate"
    filtered = f"{label_prefix}_filtered"
    # The parameter also controls how much of the spatial result replaces the
    # original. A small amount therefore cannot accidentally apply the full
    # bilateral response, even though sigmaR has a nonzero starting value.
    return (f"format=gbrp16le,split=2[{original}][{candidate}];"
            f"[{candidate}]bilateral=sigmaS={sigma_s:.6g}:sigmaR={sigma_r:.6g}:planes=7[{filtered}];"
            f"[{original}][{filtered}]blend=all_expr='A*(1-{amount:.8g})+B*{amount:.8g}',"
            "format=gbrpf32le")


def denoise_metadata(value: Any, *, preview: bool = False) -> dict[str, Any]:
    """Explain the applied precision and temporal behavior for UI receipts."""
    if not isinstance(preview, bool):
        raise ValueError("preview must be a boolean")
    settings = normalize_denoise(value)
    return {
        "enabled": settings is not None,
        "amount": settings["amount"] if settings else 0.0,
        "blend_fraction": settings["amount"] if settings else 0.0,
        "method": "spatial_bilateral" if settings else "none",
        "temporal": False,
        "spatial_only": True,
        "domain": "display_sdr_full_range_rgb",
        "processing_pixel_format": "gbrp16le" if settings else None,
        "intermediate_bit_depth": 16 if settings else None,
        "input_output_pixel_format": "gbrpf32le",
        "preview_context": "same_per_frame_filter_at_processing_resolution",
        "suggested_amounts": {"light": 0.25, "medium": 0.55, "strong": 1.0},
    }


def _sample_origins(length: int, limit: int) -> list[int]:
    count = min(limit, length // 8)
    if count <= 0:
        return []
    end = length - 8
    if count == 1:
        return [end // 2]
    return [round(i * end / (count - 1)) for i in range(count)]


def _correlation(left: list[float], right: list[float]) -> float:
    n = len(left)
    mean_l = sum(left) / n
    mean_r = sum(right) / n
    cross = sum((a - mean_l) * (b - mean_r) for a, b in zip(left, right))
    power_l = sum((a - mean_l) ** 2 for a in left)
    power_r = sum((b - mean_r) ** 2 for b in right)
    return cross / math.sqrt(power_l * power_r) if power_l and power_r else 0.0


def noise_metrics(rgb16: bytes | bytearray | memoryview, w: int, h: int) -> dict[str, Any]:
    """Estimate flat-field noise while rejecting coherent lines and texture.

    Input is packed full-range RGB48LE (``rgb48le``), exactly ``w*h*6`` bytes.
    A deterministic grid of 8x8 patches bounds work on 4K frames. Within each
    patch, a four-neighbor high-pass residual estimates stochastic variation;
    coherent gradients, repeated row/column detail, and correlated RGB detail
    mark a patch as structure. Only the lower-noise half of unstructured patches
    contributes to ``noise_sigma``. A richly textured frame may report no
    reliable estimate. These measurements are diagnostic, never an automatic
    instruction to erase texture or film grain.
    """
    if isinstance(w, bool) or isinstance(h, bool) or not isinstance(w, int) or not isinstance(h, int):
        raise ValueError("width and height must be positive integers")
    if w < 8 or h < 8:
        raise ValueError("width and height must be at least 8")
    try:
        raw = memoryview(rgb16)
    except TypeError:
        raise ValueError("rgb16 must be a bytes-like RGB48LE frame") from None
    if raw.nbytes != w * h * 6:
        raise ValueError("rgb16 byte length does not match width and height")
    raw = raw.cast("B")
    if sys.byteorder == "little":
        samples = raw.cast("H")
    else:
        copied = array("H")
        copied.frombytes(raw.tobytes())
        copied.byteswap()
        samples = copied

    patch_noise: list[float] = []
    structured = 0
    textured = 0
    patch_count = 0
    for y0 in _sample_origins(h, 8):
        for x0 in _sample_origins(w, 12):
            patch_count += 1
            channels: list[list[list[float]]] = [[[] for _ in range(8)] for _ in range(3)]
            lum: list[list[float]] = []
            for dy in range(8):
                row: list[float] = []
                for dx in range(8):
                    index = ((y0 + dy) * w + x0 + dx) * 3
                    red, green, blue = (samples[index] / 65535,
                                        samples[index + 1] / 65535,
                                        samples[index + 2] / 65535)
                    channels[0][dy].append(red)
                    channels[1][dy].append(green)
                    channels[2][dy].append(blue)
                    row.append(0.2126 * red + 0.7152 * green + 0.0722 * blue)
                lum.append(row)
            residual: list[float] = []
            rgb_residual: list[list[float]] = [[], [], []]
            col_sum = [0.0] * 6
            row_sum = [0.0] * 6
            grad_x: list[float] = []
            grad_y: list[float] = []
            for y in range(1, 7):
                for x in range(1, 7):
                    value = lum[y][x] - (lum[y][x - 1] + lum[y][x + 1]
                                            + lum[y - 1][x] + lum[y + 1][x]) / 4
                    residual.append(value)
                    col_sum[x - 1] += value
                    row_sum[y - 1] += value
                    grad_x.append(lum[y][x + 1] - lum[y][x - 1])
                    grad_y.append(lum[y + 1][x] - lum[y - 1][x])
                    for channel, plane in enumerate(channels):
                        rgb_residual[channel].append(plane[y][x] - (
                            plane[y][x - 1] + plane[y][x + 1]
                            + plane[y - 1][x] + plane[y + 1][x]) / 4)
            roughness = statistics.median(abs(item) for item in residual)
            rms = math.sqrt(sum(item * item for item in residual) / len(residual))
            edge_coherence = max(
                abs(sum(grad_x)) / (sum(map(abs, grad_x)) + 1e-12),
                abs(sum(grad_y)) / (sum(map(abs, grad_y)) + 1e-12),
            )
            line_coherence = (max(max(map(abs, col_sum)), max(map(abs, row_sum)))
                              / (6 * rms * 1.5 + 1e-12))
            color_coherence = max(
                0.0,
                _correlation(rgb_residual[0], rgb_residual[1]),
                _correlation(rgb_residual[0], rgb_residual[2]),
                _correlation(rgb_residual[1], rgb_residual[2]),
            )
            structure_score = max(edge_coherence, line_coherence, color_coherence)
            if structure_score >= 0.62:
                structured += 1
            if line_coherence >= 0.75 or color_coherence >= 0.65:
                textured += 1
            if structure_score < 0.62:
                # Median absolute high-pass residual / 0.67449 for Gaussian
                # noise, then undo the 1.25 variance of the 4-neighbor stencil.
                patch_noise.append(roughness * 1.4826 / math.sqrt(1.25))

    if patch_noise:
        patch_noise.sort()
        quiet_half = patch_noise[: max(1, (len(patch_noise) + 1) // 2)]
        sigma: float | None = statistics.median(quiet_half)
        confidence = min(1.0, len(patch_noise) / max(8, patch_count * 0.35))
    else:
        sigma = None
        confidence = 0.0
    return {
        "noise_sigma": sigma,
        "noise_confidence": round(confidence, 4),
        "structure_fraction": round(structured / patch_count, 4),
        "texture_fraction": round(textured / patch_count, 4),
        "flat_patch_count": len(patch_noise),
        "patch_count": patch_count,
        "pixel_format": "rgb48le",
    }
