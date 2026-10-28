"""Escape filenames for FFmpeg's option parser and outer filtergraph parser."""
import os


def filter_file(path: str) -> str:
    if not isinstance(path, str) or not path or any(ord(char) < 32 for char in path):
        raise ValueError('Invalid filter filename')
    if os.name == 'nt':
        path = path.replace('\\', '/')
    # Both parsing layers consume escapes. No shell is involved.
    option = ''.join('\\' + char if char in "\\':" else char for char in path)
    return ''.join('\\' + char if char in "\\'[],;" else char for char in option)
