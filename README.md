# 桌面萌宠

> 桌面端 AI 助手 - 支持语音对话的智能萌宠

## 功能特性

- **语音对话**：支持语音输入的 AI 对话助手
- **桌面端应用**：基于 Electron 的跨平台桌面应用
- **React前端**：现代化的响应式界面
- **状态管理**：Zustand 状态管理方案
- **后端服务**：Express 服务器处理业务逻辑

## 运行方式

```bash
# 安装依赖
npm install

# 开发模式（同时启动 Vite 和 Electron）
npm run dev

# 构建 Mac 应用
npm run build:mac

# 构建 Windows 应用
npm run build:win
```

## 技术栈

- **框架**：Electron + Vite + React 19 + TypeScript
- **后端**：Express + Multer（文件上传）+ CORS
- **状态管理**：Zustand
- **语音处理**：whisper.cpp（本地语音识别）
- **构建**：electron-builder

## 项目结构

```
z-biz-tool-bot/
├── src/
│   ├── main/          # Electron 主进程
│   ├── preload/       # 预加载脚本
│   └── renderer/      # React 前端
├── server/           # 后端服务代码
├── whisper.cpp/      # 语音识别模型
├── dist/             # 构建输出
├── package.json
└── vite.config.ts
```
## 本地语音（whisper.cpp）准备

`whisper.cpp/` 在 git 中是 submodule 指针，说明文件放一份在这里才可被跟踪
（同一份内容也在本地 `whisper.cpp/README.md`）。

1. 编译 CLI：`git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git && cd whisper.cpp && cmake -B build && cmake --build build -j`
   产物需在 `whisper.cpp/build/bin/whisper-cli`，或用 `ZBOT_WHISPER_BIN=/path/to/whisper-cli` 指定。
2. 下载模型（不进仓库）：`scripts/fetch-whisper-model.sh base` → `~/.z-bot/models/ggml-base.bin`
   换模型用 `ZBOT_WHISPER_MODEL=/path/to/ggml-small.bin`，或在设置面板里选（保存后会重启语音服务）。
3. 自检：应用启动后访问 `http://127.0.0.1:8084/health`（免鉴权），`problem` 字段会指出缺可执行文件还是缺模型；
   识别接口需带主进程下发的一次性 `x-auth-token`，服务只绑 127.0.0.1。

注意：语音输入与会议转录依赖 `ffmpeg`（webm→16k wav）。若本机 ffmpeg 动态库损坏，
STT 会返回 503 并明确提示，而不是静默失败。
