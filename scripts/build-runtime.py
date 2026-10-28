#!/usr/bin/env python3
"""Build a private, relocatable runtime from the platform's pinned inputs."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def digest(path):
    return hashlib.file_digest(path.open('rb'), 'sha256').hexdigest() if hasattr(hashlib, 'file_digest') else hashlib.sha256(path.read_bytes()).hexdigest()


def unpack(archive, destination):
    destination.mkdir(parents=True, exist_ok=True)
    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as source:
            for member in source.infolist():
                target = (destination / member.filename).resolve()
                if not target.is_relative_to(destination.resolve()): raise ValueError('Unsafe ZIP path')
            source.extractall(destination)
    else:
        with tarfile.open(archive) as source:
            for member in source.getmembers():
                target = (destination / member.name).resolve()
                if not target.is_relative_to(destination.resolve()): raise ValueError('Unsafe TAR path')
                if member.issym() and not (target.parent / member.linkname).resolve().is_relative_to(destination.resolve()): raise ValueError('Unsafe TAR link')
                if member.islnk() and not (destination / member.linkname).resolve().is_relative_to(destination.resolve()): raise ValueError('Unsafe TAR hardlink')
                if member.isdev() or member.isfifo(): raise ValueError('Unsupported TAR member')
            source.extractall(destination, filter='data')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--platform', required=True, choices=['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'])
    parser.add_argument('--download', action='store_true')
    args = parser.parse_args()
    actual = {'Darwin': 'darwin', 'Linux': 'linux', 'Windows': 'win32'}[platform.system()] + '-' + {'aarch64': 'arm64', 'arm64': 'arm64', 'x86_64': 'x64', 'AMD64': 'x64'}[platform.machine()]
    if actual != args.platform: raise ValueError(f'Build on {args.platform}, current machine is {actual}')
    lock_path = ROOT / 'runtime' / f'inputs-{args.platform}.json'
    lock = json.loads(lock_path.read_text(encoding='utf-8'))
    cache = ROOT / 'runtime/.downloads'
    cache.mkdir(exist_ok=True)

    def fetch(entry):
        path = cache / entry['sha256']
        named = cache / entry['name']
        if not path.exists() and named.exists() and digest(named) == entry['sha256']: shutil.move(named, path)
        if path.exists() and digest(path) == entry['sha256']: return
        if not args.download: raise ValueError(f"Missing {entry['name']}; use --download")
        partial = path.with_suffix('.partial')
        subprocess.run(['curl', '--fail', '--location', '--silent', '--show-error', '--retry', '2', '--proto', '=https',
                        '--max-time', '600', '--output', str(partial), entry['url']], check=True)
        if digest(partial) != entry['sha256'] or ('bytes' in entry and partial.stat().st_size != entry['bytes']): raise ValueError(f"Input differs from lock: {entry['name']}")
        partial.replace(path)
        print('Downloaded ' + entry['name'], flush=True)

    with ThreadPoolExecutor(max_workers=4) as pool: list(pool.map(fetch, lock['inputs']))
    build = ROOT / 'runtime/.build' / args.platform
    output = ROOT / 'runtime' / args.platform
    if output.exists(): raise ValueError(f'{output} already exists; move/remove it explicitly before rebuilding')
    build.mkdir(parents=True, exist_ok=True)
    output.mkdir()
    log = (build / 'build.log').open('w')
    env = {**os.environ, 'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8'}

    def run(command, cwd=build, custom_env=env):
        print('Build: ' + command[0] + ' ' + ' '.join(command[1:3]), flush=True)
        result = subprocess.run(command, cwd=cwd, env=custom_env, stdout=log, stderr=subprocess.STDOUT)
        log.flush()
        if result.returncode:
            print((build / 'build.log').read_text(errors='replace')[-10000:], flush=True)
            raise ValueError('Build command failed; see ' + str(build / 'build.log'))

    sources = {}
    for entry in lock['inputs']:
        if entry['kind'] == 'python': unpack(cache / entry['sha256'], output)
        if entry['kind'] == 'source':
            directory = build / entry['project']
            if directory.exists(): shutil.rmtree(directory)
            unpack(cache / entry['sha256'], directory)
            sources[entry['project']] = next(path for path in directory.iterdir() if path.is_dir())
        if entry['kind'] == 'ffmpeg-prebuilt':
            directory = build / 'ffmpeg-prebuilt'
            unpack(cache / entry['sha256'], directory)
            tree = next(path for path in directory.iterdir() if path.is_dir())
            shutil.copytree(tree / 'bin', output / 'bin')
            for name in ['lib', 'doc']:
                if (tree / name).exists(): shutil.copytree(tree / name, output / name)
            for path in tree.glob('*LICENSE*'):
                (output / 'licenses').mkdir(exist_ok=True); shutil.copyfile(path, output / 'licenses' / path.name)

    if sources:
        prefix = build / 'prefix'
        prefix.mkdir(exist_ok=True)
        env.update(PKG_CONFIG_LIBDIR=str(prefix / 'lib/pkgconfig'), PKG_CONFIG_PATH=str(prefix / 'lib/pkgconfig'))
        cpu = str(min(os.cpu_count() or 2, 8))
        flags = ['-DCMAKE_POLICY_VERSION_MINIMUM=3.5', '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_INSTALL_PREFIX=' + str(prefix)]
        if args.platform.startswith('darwin'):
            env['MACOSX_DEPLOYMENT_TARGET'] = '13.0'
            flags.append('-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0')
        run(['./configure', '--prefix=' + str(prefix), '--static'], sources['zlib'])
        run(['make', '-j' + cpu], sources['zlib']); run(['make', 'install'], sources['zlib'])
        run(['./configure', '--prefix=' + str(prefix), '--enable-static', '--enable-pic', '--disable-cli', '--disable-opencl'], sources['x264'])
        run(['make', '-j' + cpu], sources['x264']); run(['make', 'install'], sources['x264'])
        run(['cmake', '-S', str(sources['x265'] / 'source'), '-B', str(build / 'x265-cmake'), *flags,
             '-DENABLE_SHARED=OFF', '-DENABLE_CLI=OFF', '-DENABLE_PIC=ON', '-DHIGH_BIT_DEPTH=ON', '-DMAIN12=OFF', '-DENABLE_LIBNUMA=OFF'])
        run(['cmake', '--build', str(build / 'x265-cmake'), '--parallel', cpu])
        run(['cmake', '--install', str(build / 'x265-cmake')])
        run(['./autogen.sh'], sources['zimg'])
        run(['./configure', '--prefix=' + str(prefix), '--disable-shared', '--enable-static', '--with-pic'], sources['zimg'])
        run(['make', '-j' + cpu], sources['zimg']); run(['make', 'install'], sources['zimg'])
        configure = ['./configure', '--prefix=' + str(prefix), '--pkg-config-flags=--static', '--disable-autodetect',
                     '--enable-gpl', '--enable-version3', '--enable-libx264', '--enable-libx265', '--enable-libzimg', '--enable-zlib',
                     '--enable-static', '--disable-shared', '--disable-ffplay', '--disable-doc',
                     '--extra-cflags=-I' + str(prefix / 'include'), '--extra-ldflags=-L' + str(prefix / 'lib'),
                     '--extra-libs=-lc++' if args.platform.startswith('darwin') else '--extra-libs=-lstdc++ -lm -lpthread']
        if args.platform.startswith('darwin'): configure += ['--enable-videotoolbox', '--enable-audiotoolbox']
        run(configure, sources['ffmpeg'])
        run(['make', '-j' + cpu, 'ffmpeg', 'ffprobe'], sources['ffmpeg'])
        (output / 'bin').mkdir(exist_ok=True)
        for name in ['ffmpeg', 'ffprobe']: shutil.copy2(sources['ffmpeg'] / name, output / 'bin' / name)
        for project, directory in sources.items():
            licenses = output / 'licenses' / project; licenses.mkdir(parents=True, exist_ok=True)
            for path in directory.iterdir():
                if path.is_file() and path.name.upper().startswith(('COPYING', 'LICENSE')): shutil.copyfile(path, licenses / path.name)

    python = output / ('python/python.exe' if args.platform.startswith('win32') else 'python/bin/python3')
    wheels = []
    for entry in lock['inputs']:
        if entry['kind'] == 'wheel':
            wheel = build / entry['name']; shutil.copyfile(cache / entry['sha256'], wheel); wheels.append(str(wheel))
    run([str(python), '-m', 'pip', 'install', '--no-index', '--no-deps', '--disable-pip-version-check', *wheels])
    if args.platform.startswith('win32'):
        # Include the redistributable CRT next to Python, independent of globally installed VC++.
        vswhere = Path(os.environ.get('ProgramFiles(x86)', 'C:/Program Files (x86)')) / 'Microsoft Visual Studio/Installer/vswhere.exe'
        installation = subprocess.check_output([str(vswhere), '-latest', '-property', 'installationPath'], text=True).strip()
        crt = sorted(Path(installation).glob('VC/Redist/MSVC/*/x64/Microsoft.VC*.CRT'))[-1]
        for dll in crt.glob('*.dll'): shutil.copy2(dll, output / 'python' / dll.name)
    run([str(python), '-c', 'import numpy,cv2,ssl; print(numpy.__version__,cv2.__version__)'])
    for path in output.rglob('__pycache__'): shutil.rmtree(path)
    info = {'schema': 1, 'id': lock['id'], 'platform': args.platform, 'versions': {key: lock[key] for key in
            ['python_version', 'ffmpeg_version', 'numpy_version', 'opencv_version']}, 'inputs_sha256': digest(lock_path)}
    (output / 'runtime.json').write_text(json.dumps(info, indent=2) + '\n')
    shutil.copyfile(lock_path, output / 'inputs.json')
    print(json.dumps({'runtime': str(output), 'platform': args.platform, 'status': 'built'}), flush=True)


if __name__ == '__main__':
    main()
