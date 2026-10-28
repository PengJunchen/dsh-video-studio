#!/usr/bin/env python3
"""Prepare locked LUT payloads from local files, the release archive, or DJI."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import tarfile
from urllib.parse import urlparse
from urllib.request import Request, urlopen
import zipfile

ROOT = Path(__file__).resolve().parents[1]
LIMIT = 64 * 1024 * 1024


def checked(path: Path, entry: dict) -> bool:
    if not path.is_file() or path.stat().st_size != entry['bytes']:
        return False
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest() == entry['sha256']


def official(url: str) -> bool:
    parsed = urlparse(url)
    return parsed.scheme == 'https' and not parsed.username and not parsed.password and (
        parsed.hostname in {'dji.com', 'djicdn.com'}
        or (parsed.hostname or '').endswith(('.dji.com', '.djicdn.com')))


def trusted(url: str, mirror: bool) -> bool:
    parsed = urlparse(url)
    return official(url) or (mirror and parsed.scheme == 'https' and not parsed.username and not parsed.password and (
        parsed.hostname == 'github.com' and parsed.path.startswith('/PengJunchen/dsh-video-studio/releases/')
        or parsed.hostname == 'release-assets.githubusercontent.com'))


def download(url: str, destination: Path, expected: str, *, mirror: bool = False) -> None:
    if not trusted(url, mirror):
        raise ValueError('Only locked official DJI or maintainer release HTTPS sources are accepted')
    if destination.is_file() and hashlib.sha256(destination.read_bytes()).hexdigest() == expected:
        return
    temporary = destination.with_suffix('.partial')
    try:
        with urlopen(Request(url, headers={'User-Agent': 'DSH-Video-Studio/0.1'}), timeout=60) as response:
            if not trusted(response.url, mirror):
                raise ValueError('Download redirected outside the locked source hosts')
            total = 0
            with temporary.open('wb') as output:
                while chunk := response.read(1024 * 1024):
                    total += len(chunk)
                    if total > LIMIT:
                        raise ValueError('Resource exceeds the 64 MiB limit')
                    output.write(chunk)
        if hashlib.sha256(temporary.read_bytes()).hexdigest() != expected:
            raise ValueError('Downloaded resource SHA-256 differs from the lock; no substitute was accepted')
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, help='Directory containing already prepared SHA-named CUBE files')
    parser.add_argument('--download', action='store_true', help='Explicitly permit fetching missing resources from the locked release archive or DJI sources')
    parser.add_argument('--official-only', action='store_true', help='Fetch original DJI sources instead of the pinned maintainer resource archive')
    args = parser.parse_args()
    asset_root = ROOT / 'assets'
    manifest = json.loads((asset_root / 'manifest.json').read_text(encoding='utf-8'))
    entries = manifest['payloads']
    destination = asset_root / 'luts'
    destination.mkdir(parents=True, exist_ok=True)
    cache = asset_root / '.downloads'
    if args.download:
        cache.mkdir(exist_ok=True)
    if args.official_only and not args.download:
        raise ValueError('--official-only requires --download')
    bundle = None
    needs_network = any(not checked(destination / e['file'], e)
                        and not (args.source and checked(args.source / e['file'], e)) for e in entries)
    if args.download and needs_network and not args.official_only and manifest.get('distribution'):
        distribution = manifest['distribution']
        if distribution.get('format') != 'tar.gz' or distribution.get('member_prefix') != 'luts/' or not re.fullmatch(r'[a-f0-9]{64}', distribution.get('sha256', '')):
            raise ValueError('Invalid resource archive lock')
        bundle = cache / distribution['sha256']
        download(distribution['url'], bundle, distribution['sha256'], mirror=True)
        if bundle.stat().st_size != distribution['bytes']:
            raise ValueError('Resource archive size differs from lock')
    prepared = 0
    with tempfile.TemporaryDirectory(prefix='.lut-stage-', dir=asset_root) as temporary:
        staging = Path(temporary)
        for entry in entries:
            if not re.fullmatch(r'[a-f0-9]{64}', entry['sha256']) or entry['file'] != f"sha256-{entry['sha256']}.cube":
                raise ValueError('Unsafe locked resource filename')
            target = destination / entry['file']
            if checked(target, entry):
                prepared += 1
                continue
            candidate = staging / entry['file']
            local = args.source / entry['file'] if args.source else None
            if local and checked(local, entry):
                shutil.copyfile(local, candidate)
            elif bundle:
                with tarfile.open(bundle, 'r:gz') as archive:
                    member = archive.getmember('luts/' + entry['file'])
                    if not member.isfile() or member.size != entry['bytes'] or member.size > LIMIT:
                        raise ValueError('Resource archive member differs from lock')
                    with archive.extractfile(member) as incoming, candidate.open('wb') as output:
                        shutil.copyfileobj(incoming, output)
            elif args.download:
                expected = entry.get('archive_sha256', entry['sha256'])
                source = cache / expected
                try:
                    download(entry['source_url'], source, expected)
                except Exception as error:
                    raise ValueError(f"{entry['title']} ({entry['source_url']}): {error}") from error
                if entry.get('archive_member'):
                    with zipfile.ZipFile(source) as archive:
                        member = archive.getinfo(entry['archive_member'])
                        if member.file_size != entry['bytes'] or member.file_size > LIMIT:
                            raise ValueError('Locked ZIP member size differs')
                        with archive.open(member) as incoming, candidate.open('wb') as output:
                            shutil.copyfileobj(incoming, output)
                else:
                    shutil.copyfile(source, candidate)
            else:
                raise ValueError(f"Missing {entry['file']}; pass --source DIR or explicitly use --download")
            if not checked(candidate, entry):
                raise ValueError(f"LUT integrity failed: {entry['file']}")
            # Publish payloads only after every missing payload has been prepared.
            prepared += 1
        for candidate in staging.iterdir():
            os.replace(candidate, destination / candidate.name)
    print(json.dumps({'prepared_payloads': prepared, 'bytes': sum(e['bytes'] for e in entries),
                      'lut_root': str(destination), 'download_enabled': args.download}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        raise SystemExit(f'LUT preparation failed: {error}') from error
