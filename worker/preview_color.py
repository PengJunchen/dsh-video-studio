"""PNG metadata for qualified display-referred SDR preview branches."""

def display_png_options() -> list[str]:
    """Tag already qualified display RGB without changing sample values."""
    return ["-color_primaries", "bt709", "-color_trc", "iec61966-2-1"]

def display_png_frame_filter() -> str:
    """Set frame metadata after the final pixel-changing PNG filter.

    Call only for qualified SDR output, never for unknown Log/HDR content.
    This is a display-code contract, not a transfer-function conversion.
    """
    return "setparams=range=full:color_primaries=bt709:color_trc=iec61966-2-1:colorspace=gbr"
