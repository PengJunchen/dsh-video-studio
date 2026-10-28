# DSH Video Studio

[简体中文](README.zh-CN.md) · [MIT License](LICENSE)

Local video color editing for **DeepSeek Harness**. Open a folder, choose a clip,
restore its camera color, preview optional adjustments, and export a new video.
The Studio combines five features over one shared processing runtime.

This is an early release. The interface is currently in Chinese. Local image
statistics provide optional suggestions; they do not determine creative intent.

## Features

- Camera/profile-aware DJI D-Log, D-Log M and D-Log2 LUT matching. Vivid / Size 65
  is preferred when available; choose another registered look or size.
- Independent highlights and shadows, optional stronger low-light lift,
  approximate time-range suggestions and manual control.
- Optional spatial denoising, face-guided skin brightness/smoothing, and
  selective color controls. Adjustments start unset and suggestions require acceptance.
- Current-frame previews, original-size inspection, source playback and bounded
  processed playback clips. Collapse material and adjustment panels for viewing.
- Optional, page-specific AI advice through Harness's configured models.
  Image sharing is opt-in; no separate API key is stored by this plugin.
- Detail-first 10-bit HEVC export, explicit output location, result playback,
  system-player opening and folder reveal. Default destination: the source
  folder's `Output/` directory. Original files are read-only.

## Requirements

- DeepSeek Harness **0.2.1-rc.2 / rc.3** with Web server, connection and tool services;
  Node.js **22.19+**. Desktop provides native folder selection. For Web, configure
  source roots explicitly on the machine running the Host.
- Python **3.10+**, and **FFmpeg / ffprobe 8+** on the Host's `PATH`, including
  `libx264`, `libx265` and the standard LUT, bilateral and blend filters.
- Optional: NumPy and OpenCV for face-guided skin treatment. Other adjustments
  work without these packages; NumPy can also accelerate local statistics.
- Release `.tgz` packages include **18 locked DJI LUT payloads**, 44 exact
  camera/profile/look mappings and compatible 33/65-size variants. The Studio
  locates these resources automatically; no LUT path configuration is needed.
  Model weights, FFmpeg binaries, Python and sample videos are not bundled.

macOS Desktop is the primary development environment. Linux/Windows support
depends on the installed Host and codecs; there is no broad platform or camera
compatibility guarantee.

## Install

Download the complete `.tgz` from
[GitHub Releases](https://github.com/PengJunchen/dsh-video-studio/releases)
and select it in Harness's plugin installer. This is the prepared distribution;
GitHub's automatically generated source ZIP/tarball does not contain LUT payloads.

The CLI can install the release URL directly:

```text
dsh plugin --profile desktop add 'https://github.com/PengJunchen/dsh-video-studio/releases/download/v0.1.0-beta.2/dsh-video-studio-0.1.0-beta.2.tgz'
```

Or install a downloaded package, selecting the profile you actually use:

```sh
dsh plugin --profile desktop add /absolute/path/to/dsh-video-studio-0.1.0-beta.2.tgz
# For a Web Host, use --profile web instead.
```

The bare npm name is not a published installation channel. After installation,
restart Harness when convenient and open **影调工作台** in the sidebar.
Choose a source folder on Desktop. There are no source grants by default.

## Configuration

Add overrides to the active profile's `cordis.patch.yml`. Modify the existing
`hvp-runtime` row; do not insert a second runtime. Paths refer to the **Host's**
filesystem, including when the browser is on another machine.

```yaml
- id: hvp-runtime
  config:
    allowedRoots:
      - /absolute/path/to/videos
    python: python3
    # Optional Python containing NumPy/OpenCV:
    # assets:
    #   vision_python: /absolute/path/to/venv/bin/python
```

`allowedRoots` is required for manual path scanning in Web. Desktop's folder
picker grants access to the folder explicitly selected by the user. Do not
grant an entire drive just to make one folder accessible.

The bundle stores drafts and jobs in `video-studio/` under the active Harness
home (`dshHomePath('video-studio')`), outside installed plugin files.
To relocate it, set `dataDir` on the same runtime row. Keep this directory
across upgrades if you want to preserve drafts and completed export records.

### Bring your own LUTs

The included resources cover the exact mappings in `assets/catalog.json`.
Vivid / Size 65 is preferred where provided; some cameras only have a 33-size
or Standard LUT. D-Log, D-Log M and D-Log2 are never substituted for one another.
See [resource construction and inventory](assets/README.md).

For a separate, custom catalog, override the defaults with:

```yaml
- id: hvp-runtime
  config:
    assets:
      catalog_path: /absolute/path/to/video-luts/catalog.json
      lut_root: /absolute/path/to/video-luts
```

Obtain an authorized **3D CUBE → Rec.709** LUT for the exact camera and Log
profile. From a source checkout, register it with:

```sh
npm run catalog -- --file /path/to/authorized-vivid.cube \
  --camera pocket4p --profile dlog2 --look vivid \
  --directory /path/to/video-luts
```

The command copies the LUT under a SHA-256 filename and writes a version-2
catalog. Use `--append` to add other camera/profile/look/grid mappings. It does
not infer a file's camera or transfer function: the mapping is your declaration.
Profiles: `dlog`, `dlogm`, `dlog2`; looks: `standard`, `vivid`.
Configure `catalog_path` and `lut_root` as above, then reload the plugin.
Already prepared version-2 catalogs remain supported; `assets.library_path`
can optionally add compatible sizes from a schema-1 LUT library.

### Optional face-guided treatment

```sh
python3 -m venv /path/to/video-vision
/path/to/video-vision/bin/python -m pip install -r requirements-vision.txt
```

Set `assets.vision_python` to that Python executable. Detection supplies face
candidates, not identities or guaranteed coverage; preview the result before export.
No small neural model or external model weights are required by the baseline.

## Workflow and limits

Select a clip in the left list, confirm restoration, then visit **明暗 → 肤色 →
局部颜色 → 确认**. Each adjustment is optional. Scrub to inspect different
positions, accept only the changes you want, and choose an export destination.

- The working domain is display-referred **SDR Rec.709**. Unknown Log requires
  confirmation and a valid transform; HDR HLG/PQ and RAW mastering are not supported.
- Tone suggestions use sparse RGB16 samples, not exact shot detection or
  object tracking. They are based on the restored baseline, before manual edits.
  Accepted ranges use fixed controls with short boundary transitions.
- Low-light lift amplifies existing information and noise. Spatial denoising
  can soften fine texture; it is optional and has no temporal denoising model.
- Fast reduced previews and original-size processing can differ. HEVC playback
  depends on browser/OS codecs. Original-size 4K processing is **not real-time**.
- Detail-first export checks that encoding preserves the processed YUV420p10
  frames. This does not make LUTs or chroma conversion reversible. Files may be
  much larger than the source; the explicitly selected fast mode is lossy.
- AI suggestions may be wrong. They change only the current page's controls
  after acceptance; enabling image analysis shares sampled frames with the
  provider selected in Harness.

## Independent features

The default bundle loads one runtime plus the full Studio. Package subpaths
also expose `lut-batch`, `tone`, `skin`, `local-color` and `finish`. For example,
to register only tone tools instead of all Studio tools, add:

```yaml
- id: hvp-studio
  disabled: true
- insert:
    - id: hvp-tone
      name: dsh-video-studio/tone
```

Keep `hvp-runtime` enabled. The shared client shows available features; these
entries do not create independent databases or chain five video encodes.
Tool names are `video_lut_batch`, `video_tone`, `video_skin`,
`video_local_color`, `video_finish` and, for the aggregate entry, `video_studio`.

## Build from source

```sh
git clone https://github.com/PengJunchen/dsh-video-studio.git
cd dsh-video-studio
npm run assets:prepare -- --download
npm run build
npm pack ./dist --ignore-scripts
```

Resource preparation explicitly downloads locked files from DJI's original
HTTPS sources, verifies SHA-256 / sizes, and extracts exact members of two ZIP
sources. For an offline build, replace `--download` with `--source /path/to/luts`.
The source directory must contain the SHA-named files in the manifest.

The build refuses missing, modified or wrong-grid LUTs, then copies the runtime
and exact resources into `dist/`. It uses Node's standard library; no adjacent
Harness/lut-app checkout or frontend compiler is required. The client resolves
React from Harness. The resulting package runs without downloading LUTs at runtime.
See [the full resource build recipe](assets/README.md) for origin, counts,
licensing, prerequisites and release construction.

A standalone local UI is also available without Harness AI integration:

```sh
npm start -- --input-root /absolute/path/to/videos --data-dir /path/to/standalone-data
```

Open `http://127.0.0.1:4319/hvp/`. Camera LUT options are `--catalog`,
`--lut-root` and optionally `--library`; face treatment uses `--vision-python`.
The standalone server is local-only and has no native folder picker.

```text
index.mjs / client.js / cordis.patch.yml  Harness package entry points
adapters/harness/                       Host tool and AI integration
bundles/ / plugins/                     Shared runtime and feature entries
src/                                   Jobs, permissions, storage and HTTP
web/                                   Studio interface and live preview
worker/                                Python media-processing pipeline
scripts/                               Build and LUT import
assets/                                Locked resource manifests and prepared LUTs
```

## License

Original project source: **MIT**, copyright Peng Junchen.
See [third-party notices](THIRD_PARTY_NOTICES.md) for external dependencies
and camera LUT terms. This is an independent community plugin, not an official
DeepSeek, DJI or CapCut product.
