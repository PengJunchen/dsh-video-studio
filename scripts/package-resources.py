#!/usr/bin/env python3
"""Package the locked official DJI LUT bytes and their source references."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import tarfile

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path, help='Destination .tar.gz resource archive')
    args = parser.parse_args()
    assets = ROOT / 'assets'
    manifest = json.loads((assets / 'manifest.json').read_text(encoding='utf-8'))
    members = [(name, (assets / name).read_bytes()) for name in
               ['SOURCES.md', 'catalog.json', 'library.json']]
    for entry in sorted(manifest['payloads'], key=lambda item: item['file']):
        if not re.fullmatch(r'[a-f0-9]{64}', entry['sha256']) or entry['file'] != f"sha256-{entry['sha256']}.cube":
            raise ValueError('Unsafe locked resource filename')
        payload = (assets / 'luts' / entry['file']).read_bytes()
        if len(payload) != entry['bytes'] or hashlib.sha256(payload).hexdigest() != entry['sha256']:
            raise ValueError(f"LUT differs from lock: {entry['file']}")
        members.append(('luts/' + entry['file'], payload))
    destination = args.output.resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix('.partial')
    try:
        with temporary.open('wb') as raw, gzip.GzipFile(filename='', fileobj=raw, mode='wb', mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode='w', format=tarfile.GNU_FORMAT) as archive:
                for name, payload in members:
                    info = tarfile.TarInfo(name)
                    info.size = len(payload)
                    info.mode = 0o644
                    info.mtime = info.uid = info.gid = 0
                    archive.addfile(info, io.BytesIO(payload))
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)
    print(json.dumps({'file': str(destination), 'bytes': destination.stat().st_size,
                      'sha256': hashlib.sha256(destination.read_bytes()).hexdigest(),
                      'payloads': len(manifest['payloads'])}))


if __name__ == '__main__':
    main()
