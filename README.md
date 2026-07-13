# AI剪口播

一个面向 coding agent 的本地剪口播 / 剪播客 skill。人类先在多轨编辑器里组织素材，agent 再完成混音转录、AI 口误预选和审核页生成；审核确认后可导出引用原始素材的 FCPXML、剪好音频或 SRT，并生成可分发的便携审核包。

本仓库是 [lcbuaaliu/ai-jian-koubo](https://github.com/lcbuaaliu/ai-jian-koubo) 的功能扩展 fork。核心工作流定义在 [`SKILL.md`](SKILL.md)，不绑定特定 agent。

> 上游项目说明：项目灵感最初来自 GitHub 开源项目 `videocut-skills`，为适配作者的剪辑工作流，重写和扩展了工程导出、前端交互、视频预览、核心剪辑逻辑、语音识别和音频字幕等功能。

## 相比上游原版

| 能力 | 上游原版 | 本 fork |
| --- | --- | --- |
| 项目模型 | 单一 `videoFile + deleteList` | `assets[] + clips[]` 多素材时间线，兼容旧项目自动迁移 |
| 转录前流程 | 直接处理单素材 | 先用 `editor.html` 编辑多轨，再混合启用音轨进行转录 |
| 素材编辑 | 无独立时间线编辑器 | 素材库、上传去重、拖放、多轨移动/修剪、缩放、禁用与 Solo |
| 波形 | 单一审核音频的 `peaks.json` | 每个 clip 的真实波形；长素材按可视范围绘制；素材波形独立缓存 |
| 审核时间线 | 单波形审核 | 只读多轨时间线；叠加模式 / 独立模式；正常、删减、气口三态 |
| 审核播放 | 单一旧素材 | 时间线变化后重建多轨审核混音，避免播放旧音频 |
| 审核进度 | 页面内操作 | 自动保存草稿，可导入 / 导出审核进度 JSON，并校验项目签名 |
| 切口处理 | 句首 / 句尾留白 | 保留留白控制，并支持全局 Crossfade 实时试听及音频 / FCPXML 同步导出 |
| 工程导出 | 单素材 FCPXML | 音频与视频项目均可导出；多 `<asset>`、多轨 `asset-clip` 按原始 source range 裁切 |
| 附加导出 | FCPXML | FCPXML、MP3（96–256 kbps）、剪后 SRT |
| 人机交接 | 依赖对话说明 | 编辑完成和审核导出后都有可复制提示词，引导 agent 创建后续任务 |
| 审核包 | 无便携打包流程 | 收集全部引用素材、改写相对路径，同时生成便携目录和 ZIP |
| 页面协作 | 单一审核页 | 编辑页与审核页双向切换，统一导航和状态提示；素材变更会标记需重新转录 |
| 交换文件体积 | 无多素材项目交换格式 | 真实 waveform 存本地 `waveform_cache.json`，不进入项目 JSON / 审核包 JSON |

## 主流程

1. 告诉 agent：`使用 AI剪口播 skill 处理这些素材`。
2. agent 创建项目并打开素材编辑页。
3. 人类上传、排列和修剪多轨 clip，点击右上角「完成编辑并交给 AI」。
4. 页面保存项目、标记需要转录，并弹出提示词；复制后粘贴回对话。
5. agent 创建“转录与智能裁切”任务，渲染多轨审核音频、转录、分析口误并打开审核页。
6. 人类在逐字稿和时间线上确认删减 / 气口，按需回编辑页调整素材。
7. 审核页导出 FCPXML、MP3 或 SRT，并弹出收尾提示词。
8. agent 创建“打包并分发审核页”任务，生成自包含审核包目录和 ZIP 并交付。

旧单素材项目无需转换脚本：启动后会自动得到等价的 `assets[0] + clips[0]`，仍可回编辑页添加素材和轨道。

## 安装

把本 fork 地址发给 coding agent，让它安装并读取 `SKILL.md`：

```text
https://github.com/bowencraft/ai-jian-koubo
```

首次使用会运行环境自检。需要：

- Node.js、Python 3、ffmpeg、curl
- 火山引擎「录音文件识别 1.0」API Key
- 建议同时开通标准版与极速版，默认轮流使用两份免费额度

API Key 建议放在 skill 目录的 `.env`：

```bash
VOLCENGINE_API_KEY=your_api_key_here
```

`.env` 已被 Git 忽略。转录音频直传火山引擎，不依赖第三方图床。

## 使用

模式 A，剪口播 / 剪播客：

```text
使用 AI剪口播 skill，帮我处理这些音视频素材：/path/to/media
```

模式 B，只转字幕：

```text
使用 AI剪口播 skill，把 /path/to/video.mp4 转成字幕
```

素材编辑页也可单独启动：

```bash
bash scripts/serve_project.sh "/path/to/project/剪口播" scripts/review_server.js
```

审核完成后可手动生成分发包：

```bash
bash scripts/package_review.sh "/path/to/project/剪口播/3_审核"
```

脚本会输出 `PACKAGE_DIR=...` 和 `PACKAGE_ARCHIVE=...`。

## 输出

```text
output/<日期_项目名>/剪口播/
├── project.json
├── 1_转录/
├── 2_分析/
├── 3_审核/
│   ├── editor.html / review.html
│   ├── project.json / data.json
│   ├── audio.mp3 / peaks.json / silence_periods.json
│   └── *_cut.fcpxml / *_cut_128k.mp3 / *_cut.srt
├── <项目名>_review_package_<时间>/
└── <项目名>_review_package_<时间>.zip
```

完整命令、AI 判断规则、首次配置和自进化学习流程见 [`SKILL.md`](SKILL.md)。

## License

[AGPL-3.0](LICENSE)。修改版和对外提供的网络服务需遵守同一许可证公开源码。

上游项目由栗氪聊AI创建，并注明灵感来自 `videocut-skills`；本 fork 保留原项目许可证与归属，并在其上扩展多轨编辑、审核、导出和交付工作流。
