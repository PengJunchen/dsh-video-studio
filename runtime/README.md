# Fixed platform runtimes / 独立运行环境

Full platform packages contain Python, FFmpeg/ffprobe, NumPy, OpenCV and the
DJI LUT payloads. DeepSeek Harness supplies Node and the plugin host. Customers
do not need a separate Python installation, Homebrew, pip, a compiler or FFmpeg.

| Package suffix | Target |
| --- | --- |
| darwin-arm64 | macOS 13+, Apple Silicon |
| darwin-x64 | macOS 13+, Intel |
| win32-x64 | Windows 10 22H2+, x64 |
| linux-x64 | Ubuntu 22.04+ / glibc 2.35+, x86-64 |

Select the package matching the Host machine, including when the browser runs
on a different computer. Other architectures and Linux musl/Alpine are not yet
covered by these packages.

## Runtime selection and first launch

The plugin checks Python 3.10+, FFmpeg/ffprobe 8+, LUT/bilateral/blend/maskedmerge
filters, PNG, x264 and 10-bit x265 encoding, and NumPy/OpenCV imports. A
compact inline status appears on first launch. It can be reopened with the
sidebar's **运行环境** button.

An explicitly configured `python` takes precedence. Otherwise the plugin uses
a versioned private runtime in its data directory, then the installed package's
runtime, then the system environment. Worker subprocesses receive an explicit
PATH and Python executable. This also applies to detached preview/export jobs.
Package upgrades do not write into the system Python or change the global PATH.

The small universal `.tgz` contains LUTs but no executable runtime. Its
**配置独立环境** button downloads the platform archive pinned by SHA-256/size in
`manifest.json`, checks the decoded runtime's capabilities in a staging directory,
then activates it. Failure leaves any existing installation intact. Downloading
requires the user's click, HTTPS access, and the OS-provided curl/tar tools.
The full platform packages require no runtime download at startup.

CLI equivalent, from a source checkout or installed package:

```sh
node scripts/setup-environment.mjs
node scripts/setup-environment.mjs --install
# When using a custom Harness home, set DSH_HOME or pass --data-dir.
```

The installation directory is `<dataDir>/environment/<runtime-id>/<platform>/`.
Drafts and media remain in their existing locations. An operator who explicitly
sets `python` should remove that override to use the fixed environment.

## Build the runtime from pinned inputs

`inputs-<platform>.json` records the Python Standalone Builds release, exact
wheel URLs and hashes, and FFmpeg source/build identities. Versions are fixed;
installation never resolves "latest" or upgrades dependencies through pip.
Python is a relocatable distribution, not a copied developer venv.

On the matching OS/CPU, with Node 22.19+ and Python 3.12+ for building:

```sh
# macOS build tools: Xcode command-line tools, cmake, pkgconf,
# autoconf, automake, libtool, nasm.
# Linux: build-essential, cmake, pkg-config, autoconf, automake, libtool, nasm.
python scripts/build-runtime.py --platform darwin-arm64 --download
node scripts/setup-environment.mjs
python scripts/package-runtime.py --platform darwin-arm64
```

Substitute `darwin-x64`, `linux-x64` or `win32-x64` on those systems. macOS/Linux
build FFmpeg plus static x264, 10-bit x265, zimg and zlib from locked source archives,
with unrelated optional system libraries disabled. Windows uses the pinned BtbN
GPL shared build, preserves its DLLs/docs/notices, and includes the Microsoft
redistributable CRT beside Python. The Windows builder requires Visual Studio
Build Tools with the x64 redistributable directory; customers do not.

The runtime archive has one top-level platform directory. `package-runtime.py`
prints and saves its size/SHA-256. The runtime release also includes the exact
FFmpeg/x264/x265/zimg/zlib source archives and build script for macOS/Linux; upstream
Windows build sources are recorded in its input manifest. Original upstream
Python and wheel notices stay in the runtime tree; FFmpeg/component notices
are in `licenses/`. The plugin's original source remains MIT.
Python component notices from the pinned upstream release also accompany every
plugin package in `runtime/notices/python/`.

## Build the full installation package

From pinned published runtime resources:

```sh
node scripts/prepare-runtime.mjs
npm run assets:prepare -- --download
npm run build -- --with-runtime darwin-arm64
npm pack ./dist --ignore-scripts
node scripts/check-package.mjs ./dsh-video-studio-0.1.0-beta.3.tgz
```

Or omit `prepare-runtime.mjs` when the source builder above already produced
the matching runtime. The build includes exactly the requested platform. Python
symlinks are materialized because npm omits symlinks. The release renames the
archive with its platform suffix, without changing the internal package name,
so all variants install as the same Harness plugin.

The package check extracts into a new directory, removes system tools from
worker PATH, and runs scan, adjusted preview and 10-bit HEVC export through the
installed sources. CI runs on each corresponding OS. These are capability and
small processing checks; they do not claim that every OS/device/video is covered.
macOS binaries are also checked for developer/Homebrew library paths.

`runtime/.downloads`, `.build`, prepared binaries, `dist` and `release` are
ignored build outputs. They are not committed. Delete build/cache directories
after packaging to recover disk space. Do not delete a private environment while
an export is running.

## 中文

完整包按系统和芯片区分，自带固定的 Python、FFmpeg/ffprobe、NumPy、OpenCV 和
LUT；无需客户另装 Python、FFmpeg、Homebrew 或编译工具。首次启动会检测环境，
就绪后直接使用，侧栏“运行环境”可查看版本。轻量通用包则提供一键配置按钮，
由客户主动下载并检查固定散列，安装在插件数据目录，不改系统 Python 或全局 PATH。
显式填写的 `python` 配置优先；如希望改用包内环境，请删除该覆盖。

构建支持 macOS Apple Silicon/Intel、Windows x64、Linux x64，最低系统见上表。
Mac/Linux 的视频工具由锁定源码构建，Windows 保留固定上游构建的 DLL，并附带
Python 所需的 VC++ 运行库。构建脚本、精确输入与散列均在本目录；二进制、下载
缓存和编译中间目录不进入 Git。完整包无需联网安装环境，轻量包可通过界面按钮
或 `node scripts/setup-environment.mjs --install` 配置。
