# Third-party components

DSH Video Studio's original source is licensed under MIT.

| Component | Role | Distribution |
| --- | --- | --- |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) / Cordis | Host services, tools and client module loading | Peer dependencies; supplied by the user's Harness installation. Consult the licenses of the installed packages. |
| [React](https://github.com/facebook/react) | Studio panel integration | Resolved from the Harness client; no bundled React copy. MIT. |
| [FFmpeg](https://ffmpeg.org/legal.html) | Video decoding, filtering and encoding | External executable, not redistributed. Its license depends on build configuration and enabled components. Builds with libx264/libx265 have additional licensing terms. |
| [NumPy](https://numpy.org/doc/stable/license.html) | Optional analysis acceleration | Optional external Python dependency, BSD-3-Clause. |
| [OpenCV](https://opencv.org/license/) / [opencv-python](https://github.com/opencv/opencv-python) | Optional face candidates and optical-flow tracking | Optional external dependency. OpenCV 4.5+ uses Apache-2.0; wheels and bundled data include their own notices. No cascade files or model weights are copied into this repository. |
| DJI LUTs | Camera-specific input restoration | From DJI's official downloads; included in prepared release packages. Original sources, versions and hashes: `assets/manifest.json` and `assets/SOURCES.md`. Source checkouts prepare them explicitly with `assets:prepare`. |

The repository layout was informed by public plugin manifests from
[dsh-bot](https://github.com/wqty123/dsh-bot),
[dsh-layerfs](https://github.com/Ephemeral-AI-Lab/dsh-layerfs),
[dsh-purge](https://github.com/YuJunZhiXue/dsh-purge) and
[DS Bot](https://github.com/Fei2411/DS-Bot).
Their implementations, assets, prompts and host-patching behavior are not
included. This project uses additive plugin registration and does not patch
Harness's installed source or install other plugins.

The resource catalogs originate from the same maintainer's MIT-licensed
[lut-app](https://github.com/PengJunchen/lut-app); the source commit is pinned
in `assets/manifest.json`. Only restoration resources relevant to this plugin
are prepared. The LUT files come from DJI's official downloads.
