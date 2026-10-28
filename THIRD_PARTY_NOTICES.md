# Third-party components

DSH Video Studio's original source is licensed under MIT.

| Component | Role | Distribution |
| --- | --- | --- |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) / Cordis | Host services, tools and client module loading | Peer dependencies; supplied by the user's Harness installation. Consult the licenses of the installed packages. |
| [React](https://github.com/facebook/react) | Studio panel integration | Resolved from the Harness client; no bundled React copy. MIT. |
| [Python Standalone Builds](https://docs.astral.sh/python-build-standalone/) | Relocatable Python interpreter | Included in full platform packages; upstream Python and component notices remain in the runtime tree. Exact release and hash are in `runtime/inputs-*.json`. |
| [FFmpeg](https://ffmpeg.org/legal.html), x264, x265, zimg | Video decoding, filtering and encoding | Included as separate executables in full platform packages. macOS/Linux use the pinned source build with GPL components; Windows uses the pinned [BtbN GPL build](https://github.com/BtbN/FFmpeg-Builds). Component notices, sources and build identities are provided with the runtime release; see `runtime/README.md`. |
| [NumPy](https://numpy.org/doc/stable/license.html) | Analysis acceleration | Fixed wheel included in full platform packages, BSD-3-Clause. Wheel notices are preserved. |
| [OpenCV](https://opencv.org/license/) / [opencv-python](https://github.com/opencv/opencv-python) | Face candidates and optical-flow tracking | Fixed headless wheel included in full platform packages. OpenCV uses Apache-2.0; bundled components/data retain their upstream notices in the wheel. |
| Microsoft Visual C++ runtime | Windows Python/OpenCV runtime dependencies | Redistributable CRT DLLs are included beside the Windows Python interpreter. |
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
