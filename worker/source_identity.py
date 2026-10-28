"""Reuse a verified byte identity only while the complete filesystem identity holds.

This cache never substitutes a requested SHA for a verified SHA. Export callers
must bypass it and perform their usual complete source read.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
from typing import Callable


class SourceIdentityError(ValueError):
    pass


def _digest(value: dict) -> str:
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()


def verified_digest(source: Path, signature: dict, cache_name: str | None,
                    digest_file: Callable, stat_signature: Callable) -> tuple[str, bool]:
    if cache_name is None:
        return digest_file(source), False
    if not isinstance(cache_name,str) or not Path(cache_name).is_absolute():
        raise SourceIdentityError('Source identity cache must be an absolute directory')
    directory=Path(cache_name)
    if directory.is_symlink():
        raise SourceIdentityError('Source identity cache cannot be a symlink')
    directory.mkdir(parents=True,exist_ok=True)
    directory=directory.resolve()
    canonical=source.resolve()
    if canonical.is_relative_to(directory):
        raise SourceIdentityError('Source cannot be inside its identity cache')
    plan={'version':1,'canonical_path':str(canonical),'stat':signature}
    key=_digest(plan)
    target=directory/f'source-{key}.json'
    if target.is_symlink():
        raise SourceIdentityError('Source identity record cannot be a symlink')
    if target.is_file() and target.stat().st_size<=16384:
        try:
            record=json.loads(target.read_text())
            payload=record['payload']
            if (payload['plan']==plan and re.fullmatch('[0-9a-f]{64}',payload['sha256'])
                    and record['checksum']==_digest(payload)):
                return payload['sha256'],True
        except (OSError,ValueError,KeyError,TypeError):
            pass
    value=digest_file(source)
    if stat_signature(source)!=signature:
        raise SourceIdentityError('Source changed while verifying its bytes')
    payload={'plan':plan,'sha256':value}
    record={'payload':payload,'checksum':_digest(payload)}
    fd,name=tempfile.mkstemp(prefix='.source-hash-',suffix='.partial',dir=directory)
    try:
        with os.fdopen(fd,'w') as file:
            json.dump(record,file,sort_keys=True,separators=(',',':'))
        os.replace(name,target)
    finally:
        Path(name).unlink(missing_ok=True)
    # Only own, complete records are eligible for this small bounded cache.
    entries=[p for p in directory.iterdir() if re.fullmatch(r'source-[0-9a-f]{64}\.json',p.name)
             and p.is_file() and not p.is_symlink()]
    entries.sort(key=lambda p:p.stat().st_mtime_ns,reverse=True)
    for old in entries[512:]:
        if old!=target:
            old.unlink(missing_ok=True)
    return value,False
