"""One FFmpeg decode for export pixel identity and decoded video timestamps.

The hash muxer hashes the complete yuv420p10le byte stream. The framehash
muxer records the PTS of the same split frames. Audio is decoded on the
framehash output so a bad audio stream also fails this validation pass; the
caller's source/output packet identity checks remain separate.
"""

from __future__ import annotations

from fractions import Fraction
from hashlib import sha256
import math
from pathlib import Path
import re
import subprocess
from typing import Any


_FULL_HASH = re.compile(r"SHA256=([0-9a-f]{64})\n?\Z")
_TIME_BASE = re.compile(r"#tb (\d+): ([1-9]\d*)/([1-9]\d*)\Z")
_MEDIA_TYPE = re.compile(r"#media_type (\d+): (\w+)\Z")
_FRAME = re.compile(r"(\d+),\s*(-?\d+|N/A),\s*(-?\d+|N/A),\s*(\d+|N/A),\s*(\d+),\s*([0-9a-f]{64})\Z")


class ExportValidationError(RuntimeError):
    """A failed or malformed single-pass decode, with its FFmpeg diagnostics."""

    def __init__(self, code: str, message: str, *, stderr: str = "", command: list[str] | None = None):
        self.code = code
        self.stderr = stderr
        self.command = tuple(command or ())
        diagnostic = stderr[-1800:].strip()
        super().__init__(f"{message}: {diagnostic}" if diagnostic else message)


def _command(path: Path, decoder: str) -> list[str]:
    # split=2 keeps the two muxers on one decoded, converted pixel stream.
    # -copyts, passthrough, and demux time base preserve nonzero/variable PTS.
    return [
        "ffmpeg", "-hide_banner", "-v", "error", "-xerror", "-err_detect", "explode",
        "-nostdin", "-copyts",
        *(["-hwaccel", "videotoolbox"] if decoder == "videotoolbox" else []),
        "-i", str(path),
        "-filter_complex", "[0:v:0]format=yuv420p10le,split=2[bytes][pts]",
        "-map", "[bytes]", "-an", "-fps_mode:v", "passthrough",
        "-enc_time_base:v", "demux",
        "-c:v", "rawvideo", "-threads:v", "1", "-pix_fmt", "yuv420p10le",
        "-f", "hash", "-hash", "sha256", "pipe:1",
        "-map", "[pts]", "-map", "0:a?", "-fps_mode:v", "passthrough",
        "-enc_time_base:v", "demux",
        "-c:v", "rawvideo", "-threads:v", "1", "-pix_fmt", "yuv420p10le",
        "-c:a", "pcm_s16le", "-f", "framehash", "-hash", "sha256", "pipe:2",
    ]


def _video_frame_pts(framehash: str, command: list[str]) -> tuple[list[float], list[int], Fraction, str | None, int, int]:
    time_bases: dict[int, Fraction] = {}
    media_types: dict[int, str] = {}
    frame_rows: list[tuple[int, int]] = []
    audio_rows: dict[int, list[str]] = {}
    saw_sha256 = False
    for line in framehash.splitlines():
        if line.startswith("#"):
            if line == "#hash: SHA256":
                saw_sha256 = True
            elif match := _TIME_BASE.fullmatch(line):
                index = int(match[1])
                if index in time_bases:
                    raise ExportValidationError("framehash_invalid", "Duplicate framehash time base", stderr=framehash, command=command)
                time_bases[index] = Fraction(int(match[2]), int(match[3]))
            elif match := _MEDIA_TYPE.fullmatch(line):
                index = int(match[1])
                if index in media_types:
                    raise ExportValidationError("framehash_invalid", "Duplicate framehash media type", stderr=framehash, command=command)
                media_types[index] = match[2]
            continue
        if not (match := _FRAME.fullmatch(line)):
            raise ExportValidationError("framehash_invalid", "Malformed framehash packet", stderr=framehash, command=command)
        stream = int(match[1])
        if stream not in time_bases or stream not in media_types:
            raise ExportValidationError("framehash_invalid", "Framehash packet lacks stream metadata", stderr=framehash, command=command)
        if stream == 0:
            if match[3] == "N/A" or int(match[5]) <= 0:
                raise ExportValidationError("framehash_invalid", "Video frame lacks PTS or bytes", stderr=framehash, command=command)
            frame_rows.append((int(match[3]), int(match[5])))
        elif media_types[stream] == "audio":
            audio_rows.setdefault(stream, []).append(line)
        else:
            raise ExportValidationError("framehash_invalid", "Unexpected framehash stream", stderr=framehash, command=command)
    if not saw_sha256 or media_types.get(0) != "video" or 0 not in time_bases or not frame_rows:
        raise ExportValidationError("framehash_invalid", "Framehash lacks video frames or SHA256 metadata", stderr=framehash, command=command)
    ticks = [row[0] for row in frame_rows]
    if any(a >= b for a, b in zip(ticks, ticks[1:])):
        raise ExportValidationError("frame_pts_invalid", "Decoded frame PTS are not strictly increasing", stderr=framehash, command=command)
    time_base = time_bases[0]
    try:
        seconds = [float(Fraction(tick) * time_base) for tick in ticks]
    except OverflowError as exc:
        raise ExportValidationError("frame_pts_invalid", "Decoded frame PTS overflow seconds", stderr=framehash, command=command) from exc
    if any(not math.isfinite(value) for value in seconds):
        raise ExportValidationError("frame_pts_invalid", "Decoded frame PTS are not finite", stderr=framehash, command=command)
    audio_streams = sorted(index for index, kind in media_types.items() if kind == "audio")
    audio_fingerprint = None
    if audio_streams:
        if any(index not in time_bases for index in audio_streams):
            raise ExportValidationError("framehash_invalid", "Audio framehash stream lacks time base", stderr=framehash, command=command)
        lines = [item for index in audio_streams for item in
                 (f"#tb {index}: {time_bases[index]}", *audio_rows.get(index, []))]
        audio_fingerprint = sha256("\n".join(lines).encode("utf-8")).hexdigest()
    return seconds, ticks, time_base, audio_fingerprint, len(audio_streams), sum(map(len, audio_rows.values()))


def decoded_video_facts(path: str | Path, *, decoder: str = "software") -> dict[str, Any]:
    """Hash decoded YUV10 pixels and collect exact-source PTS in one decode.

    ``frame_pts`` uses seconds as floats for the existing readback comparison;
    ``frame_pts_ticks`` and ``frame_time_base`` retain the exact rational times.
    A failed audio or video decode, empty stream, or malformed muxer report
    raises ExportValidationError and never returns a partial result. ``decoder``
    requests an input decoder; it does not prove FFmpeg used hardware.
    """
    if decoder not in {"software", "videotoolbox"}:
        raise ExportValidationError("decoder_invalid", f"Unsupported decoder: {decoder}")
    command = _command(Path(path), decoder)
    try:
        process = subprocess.run(command, capture_output=True, text=True,
                                 encoding="utf-8", errors="replace", check=False)
    except FileNotFoundError as exc:
        raise ExportValidationError("dependency_missing", "FFmpeg is unavailable", command=command) from exc
    except OSError as exc:
        raise ExportValidationError("decode_failed", f"Cannot start FFmpeg: {exc}", command=command) from exc
    if process.returncode != 0:
        raise ExportValidationError("decode_failed", f"FFmpeg decode failed (exit {process.returncode})",
                                    stderr=process.stderr, command=command)
    match = _FULL_HASH.fullmatch(process.stdout)
    if not match:
        raise ExportValidationError("hash_invalid", "FFmpeg did not return one full-stream SHA256",
                                    stderr=process.stderr, command=command)
    frame_pts, ticks, time_base, audio_fingerprint, audio_streams, audio_packets = _video_frame_pts(process.stderr, command)
    return {
        "pixel_sha256": match[1],
        "frame_pts": frame_pts,
        "frame_count": len(frame_pts),
        "decode": "pass",
        "pixel_format": "yuv420p10le",
        "frame_pts_ticks": ticks,
        "frame_time_base": f"{time_base.numerator}/{time_base.denominator}",
        "audio_framehash_sha256": audio_fingerprint,
        "audio_stream_count": audio_streams,
        "audio_packet_count": audio_packets,
        "method": "ffmpeg-single-decode-split-hash-framehash",
        "requested_decoder": decoder,
        "command": command,
    }
