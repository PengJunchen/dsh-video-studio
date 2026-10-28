# Release resources / 发行资源构建

## What the complete package contains

The prepared `.tgz` includes the JavaScript/Python processing sources, Studio
client, **18 original DJI 3D CUBE files** (37,449,680 bytes before compression),
44 exact automatic camera/profile/look mappings, and a library of 33 source
records. Different source records can share the same payload: these counts
describe different things. Compatible size variants include Pocket 4P D-Log2
Standard/Vivid at 33³ and 65³; the default preference remains Vivid / Size 65
when that exact camera/profile combination provides it.

There are no creative-look, HDR-output, Linear-to-Log or 1D LUT payloads in
this release subset. Supported mappings are the explicit rows in
[`catalog.json`](catalog.json); the plugin never infers compatibility from a
shared hash or substitutes another camera/profile.

The source repository tracks manifests, not `.cube` files. GitHub's generated
source archives therefore require preparation; the attached release `.tgz`
is the complete installation package. It is built with the exact same commands
in the repository's `Release` workflow.

## Locked inputs

- [`catalog.json`](catalog.json): version-2 automatic mappings.
- [`library.json`](library.json): selected schema-1 source records and size variants.
- [`manifest.json`](manifest.json): one row per unique payload, with exact byte
  size, SHA-256, 3D grid, original official page and download URL. ZIP resources
  also pin the container SHA-256 and exact member name. The `distribution`
  record pins the resource archive separately.
- [`SOURCES.md`](SOURCES.md): the bundled LUTs come from DJI's official downloads.

The manifest pins its catalog source to a specific `lut-app` Git commit.
Builds do not read a sibling checkout. Values are copied byte-for-byte, not
regenerated, resampled, gamma-adjusted or replaced with a similar LUT.

## Prerequisites and external components

| Component | In the `.tgz`? | Preparation / runtime requirement |
| --- | --- | --- |
| Node/Cordis/React | Host supplies them | Install DeepSeek Harness; Node 22.19+ for local builds. The client uses the Host's React. |
| Python | Yes in full platform packages | Fixed standalone runtime. Source resource preparation needs Python 3.10+. |
| FFmpeg / ffprobe | Yes in full platform packages | Fixed builds include x264, 10-bit x265 and the required filters. |
| DJI restoration LUTs | **Yes** | Prepared from locked local copies or official downloads before packaging. |
| NumPy / OpenCV | Yes in full platform packages | The universal package can obtain the same fixed environment through first-run setup. |
| Model weights | No | The implemented baseline needs no neural model weights. |

Full platform packages contain these runtimes; the small universal package offers
an explicit environment setup button. Both use the same LUT preparation process.
See [runtime/README.md](../runtime/README.md) for platform requirements, source
builds, first-run configuration and complete package construction.

## Online build

```sh
git clone https://github.com/PengJunchen/dsh-video-studio.git
cd dsh-video-studio
npm run assets:prepare -- --download
npm run build
npm pack ./dist --ignore-scripts
```

`--download` obtains the resource archive from the pinned
GitHub release URL, checks its complete SHA-256/size, then checks every original
LUT independently. This avoids vendor-origin 403 responses seen from the cloud
build network. It is a delivery mirror, not a replacement or a new LUT formula.
Already valid payloads are reused; incomplete downloads are never published as LUTs.
The downloader honors standard proxy environment variables if the local network
requires them. Download caches live in ignored `assets/.downloads/`; they are
excluded from the package and may be removed after a successful build.

To reconstruct directly from the original DJI HTTPS sources instead, use:

```sh
npm run assets:prepare -- --download --official-only
```

This route also checks the two ZIP containers and exact members independently.
It fails clearly if an original URL is inaccessible or its bytes have changed;
it does not accept different bytes. The same `--source` offline route remains
available even when a network origin is unavailable.

`npm run build` checks every required file's hash, size and declared grid,
and checks that all catalog/library references resolve. It fails if any LUT
is missing or altered. It then copies sources, manifests, source references and the
prepared `assets/luts/` into `dist/`. `npm pack ./dist` uses the package file
allowlist to produce `dsh-video-studio-<version>.tgz`.

## Offline build from prepared files

```sh
npm run assets:prepare -- --source /absolute/path/to/sha-named-luts
npm run build
npm pack ./dist --ignore-scripts
```

Only the 18 locked SHA-named files are read. No network is used without
`--download`. For the same original source bytes, LUT payloads are reproducible;
this is not a claim that video encoders or npm's compressed archives produce
identical bytes across operating systems/tool versions.

## Resource archive construction

The separately published resource archive is assembled from the same prepared
files with the included standard-library script:

```sh
python3 scripts/package-resources.py --output /tmp/dsh-video-studio-dji-restoration-luts-v2.tar.gz
```

It checks every LUT's hash/size, then packs the original bytes, `catalog.json`,
`library.json` and `SOURCES.md` in a fixed order with normalized timestamps and
file modes. Its printed SHA-256/size are pinned in `manifest.json` before the
application release build. The outer manifest is excluded to avoid a circular
archive hash. Downloading the complete application `.tgz` needs no resource
archive preparation.

## Automatic discovery after installation

The runtime uses `<installed-package>/assets/catalog.json`, `library.json`
and `luts/`. No absolute developer paths are embedded. Explicit user-provided
`catalog_path` / `lut_root` settings take precedence. A separate `dataDir`
holds drafts and jobs, so upgrading the plugin does not overwrite user media
or put generated files into the resource directory.

## 中文摘要

完整发行包包含 18 个 DJI 原始 3D CUBE 文件、44 条精确自动映射及 33 条来源记录。
清单由同一维护者的 lut-app 目录固定到具体提交，只选当前视频还原需要的部分，
不把所有创意／HDR／1D 资源一起塞入插件。多个来源可共用相同字节，不能把
来源数、机型映射数和实际文件数混为一谈。

源码仓库保存清单和构建工具，`.cube` 不进入 Git 历史；完整发行 `.tgz` 则包含
实际 LUT。构建时显式选择 `--download` 获取已锁定的资源包，再检查
各个 DJI 原始文件；`--official-only` 可改为直连官方来源。官方路径可能因云端
网络返回 403，不能把本机缓存成功当作官网下载必定可用。也可用 `--source` 指向
已有的 SHA 文件目录。每个原文件均检查 SHA-256、字节大小、格点；两个 ZIP 来源
还检查压缩包散列及精确成员。任一资源缺失或不符，构建失败，不发布空壳包。

安装成品后，插件自动寻找包内资源，用户无需手工找 LUT 或配置路径；日常视频
处理可离线运行，主动调用 AI 时才需要相应模型服务。完整系统包自带固定的 Python、FFmpeg 和人物处理依赖；轻量通用包可在首次启动
时配置同一套独立环境。具体构建见 runtime/README.md。

随包 LUT 来自 DJI 官方下载，出处见 SOURCES。所有构建资料与清单均随包提供，
下载缓存不随包提供。

资源包本身由 `scripts/package-resources.py --output /tmp/dsh-video-studio-dji-restoration-luts-v2.tar.gz`
构建：先检查每个 LUT，再以固定顺序、时间戳和文件权限打包来源说明、目录清单及
原始文件；输出的散列与字节大小写入 manifest，随后构建插件安装包。用户直接
下载完整插件 `.tgz` 时，无需执行这个步骤。
