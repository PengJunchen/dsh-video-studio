#!/usr/bin/env python3
"""Publishable runtime archive and hash receipt; no user media or build directories."""
import argparse
import hashlib
import json
from pathlib import Path
import tarfile

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--platform', required=True)
args = parser.parse_args()
if args.platform not in {'darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'}: raise ValueError('Unknown platform')
directory = root / 'runtime' / args.platform
info = json.loads((directory / 'runtime.json').read_text())
output = root / 'release'
output.mkdir(exist_ok=True)
archive = output / f"dsh-video-studio-runtime-{info['id']}-{args.platform}.tar.gz"
with tarfile.open(archive, 'w:gz') as target: target.add(directory, arcname=args.platform)
receipt = {'platform': args.platform, 'runtimeId': info['id'], 'file': archive.name,
           'url': f"https://github.com/PengJunchen/dsh-video-studio/releases/download/{info['id']}/{archive.name}",
           'bytes': archive.stat().st_size, 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
           'versions': info['versions'], 'minimum': json.loads((root / 'runtime' / f'inputs-{args.platform}.json').read_text())['min_os']}
(output / f'{args.platform}.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps(receipt), flush=True)
if args.platform == 'darwin-arm64':
    with tarfile.open(output / 'dsh-video-studio-media-sources.tar.gz', 'w:gz') as target:
        lock = json.loads((root / 'runtime/inputs-darwin-arm64.json').read_text())
        for entry in lock['inputs']:
            if entry['kind'] == 'source': target.add(root / 'runtime/.downloads' / entry['sha256'], arcname='sources/' + entry['name'])
        target.add(root / 'scripts/build-runtime.py', arcname='build-runtime.py')
        for path in (root / 'runtime').glob('inputs-*.json'): target.add(path, arcname=path.name)
