# DSH Video Studio · 影调工作台

[English](README.md) · [MIT 协议](LICENSE)

面向 **DeepSeek Harness** 的本地视频调色插件。选择文件夹和素材，确认相机
色彩还原，按需调整明暗、肤色与颜色，预览后导出新视频。统一工作台和五个
功能入口共用一个处理服务。

当前为早期版本，界面使用中文。本地统计提供可选参考，不能判断用户的创作意图。

## 功能

- 按相机与拍摄格式匹配 DJI D-Log、D-Log M、D-Log2 还原 LUT；有对应资源时
  优先 Vivid／Size 65，可切换已注册的风格和尺寸。
- 高光、暗部分别调整；可选更强的暗光增强、近似时间区间建议和手动控制。
- 可选空间降噪、人脸候选引导的肤色明亮／光滑处理、局部颜色调整。
  调整默认未设置，建议需用户采纳。
- 当前帧预览、原尺寸放大、原片播放与按需生成的处理后短片。
  素材列表和调整面板可收起，扩大观看空间。
- 明暗、肤色、局部颜色页提供可选 AI 建议，使用 Harness 已配置的模型。
  发送画面需主动选择，插件不另外保存 API 密钥。
- 默认 10-bit HEVC 细节优先导出，可选择保存位置；结果直接显示路径、视频、
  系统播放器和文件夹入口。默认保存到原片目录的 `Output/`，原片只读。

## 环境要求

DeepSeek Harness **0.2.1-rc.2／rc.3**（Node.js 22.19+）。完整系统包自带固定的
Python、FFmpeg／ffprobe、NumPy、OpenCV 和 18 个 DJI LUT，无需客户另外安装。
Desktop 提供系统文件夹选择器，Web 需明确配置素材目录。

| 完整安装包 | 系统要求 |
| --- | --- |
| [darwin-arm64](https://github.com/PengJunchen/dsh-video-studio/releases/download/v0.1.0-beta.3/dsh-video-studio-0.1.0-beta.3-darwin-arm64.tgz) | macOS 13+，Apple Silicon |
| [darwin-x64](https://github.com/PengJunchen/dsh-video-studio/releases/download/v0.1.0-beta.3/dsh-video-studio-0.1.0-beta.3-darwin-x64.tgz) | macOS 13+，Intel |
| [win32-x64](https://github.com/PengJunchen/dsh-video-studio/releases/download/v0.1.0-beta.3/dsh-video-studio-0.1.0-beta.3-win32-x64.tgz) | Windows 10 22H2+，x64 |
| [linux-x64](https://github.com/PengJunchen/dsh-video-studio/releases/download/v0.1.0-beta.3/dsh-video-studio-0.1.0-beta.3-linux-x64.tgz) | Ubuntu 22.04+／glibc 2.35+，x86-64 |

按 Harness Host 所在机器及其 Node 架构选择安装包。轻量通用包只含 LUT，可在
首次启动的“运行环境”区域点击“配置独立环境”，也可使用自己准备的 Python 3.10+
及 FFmpeg／ffprobe 8+。完整包启动时不需要下载环境。
详细版本、构建方式和平台限制见[独立运行环境说明](runtime/README.md)。

## 安装

从 [GitHub Releases](https://github.com/PengJunchen/dsh-video-studio/releases)
下载带对应系统后缀的完整 `.tgz`，在 Harness 插件安装界面选择该文件。GitHub 自动生成的源码
ZIP／tarball 不包含 LUT 载荷，不能当作完整安装包。

例如 Apple Silicon Mac 可直接安装：

```text
dsh plugin --profile desktop add 'https://github.com/PengJunchen/dsh-video-studio/releases/download/v0.1.0-beta.3/dsh-video-studio-0.1.0-beta.3-darwin-arm64.tgz'
```

使用已下载文件时，请选择自己实际使用的 profile：

```sh
dsh plugin --profile desktop add /absolute/path/to/dsh-video-studio-0.1.0-beta.3.tgz
# 使用 Web Host 时，将 desktop 改为 web。
```

当前未发布到 npm，请使用 GitHub 地址或安装包。安装后在合适时重启 Harness，
打开侧栏的 **影调工作台**。Desktop 首次使用点击“选择文件夹”；默认不授予
任何素材目录访问权。

## 配置

在当前 profile 的 `cordis.patch.yml` 中覆盖已有 `hvp-runtime` 行，
不要重复插入运行时。路径均指 **Host 所在机器**，包括浏览器在其它机器的情况。

```yaml
- id: hvp-runtime
  config:
    allowedRoots:
      - /absolute/path/to/videos
    # 可选手动覆盖；普通用户保留包内环境即可
    # python: /absolute/path/to/python
    # 可选：已安装 NumPy／OpenCV 的 Python
    # assets:
    #   vision_python: /absolute/path/to/venv/bin/python
```

Web 手动输入路径扫描时需要 `allowedRoots`。Desktop 文件夹选择器为用户明确
选中的目录授予访问权；只配置实际需要的素材目录。

草稿和任务默认存储在当前 Harness home 下的 `video-studio/`
（`dshHomePath('video-studio')`），不写入插件安装目录。
可在同一运行时行设置 `dataDir` 更换位置；升级时保留该目录，可保留草稿和
已完成导出记录。

### 注册自有 LUT

随包资源覆盖 `assets/catalog.json` 的精确映射，有对应资源时优先 Vivid／Size 65；
部分相机只有 Size 33 或普通风格。D-Log、D-Log M、D-Log2 不混用。
清单与构建方法见[资源构建说明](assets/README.md)。

只有需要使用自己的独立目录时，才覆盖随包默认资源：

```yaml
- id: hvp-runtime
  config:
    assets:
      catalog_path: /absolute/path/to/video-luts/catalog.json
      lut_root: /absolute/path/to/video-luts
```

请取得准确对应相机和 Log 格式的 **3D CUBE → Rec.709** 还原 LUT。
在源码目录中运行：

```sh
npm run catalog -- --file /path/to/vivid.cube \
  --camera pocket4p --profile dlog2 --look vivid \
  --directory /path/to/video-luts
```

脚本按 SHA-256 文件名复制 LUT，生成 version 2 catalog。加入其它相机、格式、
风格或尺寸时使用 `--append`。脚本不猜测相机或传递函数，映射由使用者明确提供。
格式支持 `dlog`、`dlogm`、`dlog2`，风格支持 `standard`、`vivid`。
随后按上方配置填写 `catalog_path` 和 `lut_root` 并重新加载插件。
已有 version 2 catalog 可继续使用；`assets.library_path` 可从 schema 1 LUT
library 补充同版本、同映射的其它尺寸。

### 高级：使用自己的 Python 环境

完整系统包已包含人物处理依赖。只有希望指定自己的环境时，才需要以下步骤。

```sh
python3 -m venv /path/to/video-vision
/path/to/video-vision/bin/python -m pip install -r requirements-vision.txt
```

将 `assets.vision_python` 指向该 Python。检测提供人脸候选，不识别人身份，
也不保证完整跟踪覆盖，导出前应预览。本地基础功能无需神经网络模型或外部权重。

## 操作与能力边界

在左侧选择素材后，依次查看 **色彩还原 → 明暗 → 肤色 → 局部颜色 → 确认**。
各项均可跳过。拖动时间条查看不同位置，只采纳需要的建议，最后选择位置导出。

- 工作域为显示相对的 **SDR Rec.709**。未知 Log 需要确认及有效还原变换，
  暂不支持 HLG／PQ 转 SDR 或 RAW／HDR 母版制作。
- 明暗建议来自少量 RGB16 抽帧，依据为 LUT 后、手动调整前的画面；
  不是精确镜头检测或物体追踪。已确认区间保持固定参数，边界短暂平滑过渡。
- 暗光增强会放大已有信息及噪点；空间降噪可能柔化细弱纹理，默认关闭，
  当前没有时域降噪模型。
- 缩小预览和原尺寸处理可能有差异；HEVC 播放取决于浏览器及系统解码能力。
  原尺寸 4K 处理**未达到实时**。
- 细节优先导出检查编码前后已处理 YUV420p10 帧的一致性，不代表 LUT 或色度
  转换可逆。文件可能明显大于原片；主动选择的快速模式为有损编码。
- AI 可能判断错误，只在明确采纳后修改当前页设置；选择发送画面时，
  代表帧会交给 Harness 中选定的模型提供方。

## 独立功能入口

默认 bundle 加载一个运行时和完整 Studio。包的子路径另提供
`lut-batch`、`tone`、`skin`、`local-color`、`finish`。
例如只注册明暗工具，可在 profile patch 中写：

```yaml
- id: hvp-studio
  disabled: true
- insert:
    - id: hvp-tone
      name: dsh-video-studio/tone
```

保留 `hvp-runtime`。共享界面按已启用功能呈现；这些入口不建立五套数据库，
也不串联五次编码。工具名为 `video_lut_batch`、`video_tone`、`video_skin`、
`video_local_color`、`video_finish`，聚合入口另提供 `video_studio`。

## 源码构建

```sh
git clone https://github.com/PengJunchen/dsh-video-studio.git
cd dsh-video-studio
npm run assets:prepare -- --download
npm run build
npm pack ./dist --ignore-scripts
```

随包 LUT 来自 DJI 官方下载。资源准备从固定资源包获取文件，先检查资源包 SHA-256，再
检查每个原始 LUT 的散列和字节大小。原始官方 URL／ZIP 成员仍在清单中，可用
`--download --official-only` 直接获取。离线构建将 `--download` 换成
`--source /path/to/luts`，目录中需有清单指定的 SHA 文件名。

构建缺少 LUT、散列不符或尺寸不符时直接失败，随后才将源码和完整资源整理到
`dist/`。构建使用 Node 标准库，不依赖相邻的 Harness／lut-app 工程或前端编译器。
客户端从 Harness 的模块加载器获取 React。安装成品后，日常运行不下载 LUT。
来源、数量和 LUT 打包步骤见[资源构建说明](assets/README.md)。
构建包含 Python／FFmpeg 的完整系统包，见[跨平台运行时构建](runtime/README.md)。

也可独立启动本机界面，此模式不集成 Harness AI：

```sh
npm start -- --input-root /absolute/path/to/videos --data-dir /path/to/standalone-data
```

访问 `http://127.0.0.1:4319/hvp/`。相机 LUT 参数为 `--catalog`、`--lut-root`，
以及可选 `--library`；人物处理使用 `--vision-python`。
独立服务仅监听本机，不提供原生文件夹选择器。

```text
index.mjs / client.js / cordis.patch.yml  Harness 包入口
adapters/harness/                       宿主工具和 AI 适配
bundles/ / plugins/                     共享运行时及功能入口
src/                                   任务、授权、存储与 HTTP
web/                                   工作台和实时预览
worker/                                Python 视频处理管线
scripts/                               构建与 LUT 导入
assets/                                锁定资源清单及构建时准备的 LUT
```

## 协议

本项目原创源码使用 **MIT** 协议，版权所有 Peng Junchen。
外部依赖、编解码器及资源来源见[第三方说明](THIRD_PARTY_NOTICES.md)。
本项目是独立社区插件，不是 DeepSeek、DJI 或剪映的官方产品。
