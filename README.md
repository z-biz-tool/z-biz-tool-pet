# 桌面萌宠（z-biz-tool-pet）

> 常驻桌面的 AI 萌宠：语音对话、截图分析、养成、任务与会议转录。

## 能力清单（对应代码，非路线图）

- **萌宠窗口**：透明无边框、`floating` 层置顶且 `showInactive()` 显示（不抢前台应用焦点）、macOS `acceptFirstMouse` 首次点击即响应、跨工作区/全屏空间可见、可拖拽、支持点击穿透、位置跨启动持久化（`~/.z-bot/window_bounds.json`，退出/隐藏时同步补写一次）
- **动画状态机**：17 种动画（idle/blink/walk/dance/roll/jump/wiggle/stretch/spin/yawn/sleep/chase/bounce/shake/wobble/petted）+ 优先级抢占 + 光标跟随 + 粒子与场景系统
- **语音链路**：whisper.cpp 本地 STT（8084）+ TTS 子进程（8086），按住说话、语音打断、麦克风自检、会议转录
- **AI 对话**：多提供商路由（ollama/openai/claude/gemini/deepseek/qwen/custom）、流式输出、工具调用确认与频控熔断
- **截图**：全屏/指定窗口截图、截图 + 视觉模型分析、截图隐身（`setContentProtection`，macOS 额外移出 Mission Control）
- **养成系统**：饥饿/快乐/精力/清洁/健康/好感六维衰减、阶段成长、成就、人设、记忆（长短期）
- **快速笔记**：全局快捷键把剪贴板文本存为 Pin 便签，托盘「快速笔记」子菜单可逐条复制回剪贴板或清空
- **任务/快捷指令**：定时任务调度、快捷指令面板
- **托盘**：显示/隐藏、语音起停、隐身、点击穿透、开机自启、笔记、设置、退出
- **自动更新**：electron-updater，feed 可用 `ZBOT_UPDATE_FEED_URL` 或 `~/.z-bot/update-feed.json` 配置

## 全局快捷键（默认值，可在设置 → 快捷键改键）

| 快捷键 | 行为 |
|---|---|
| `CommandOrControl+Shift+Z` | 显示/隐藏萌宠 |
| `CommandOrControl+Alt+S` | 截图分析 |
| `CommandOrControl+Alt+N` | 快速笔记：剪贴板文本存入 Pin 便签并弹系统通知 |
| `CommandOrControl+Alt+P` | 唤醒宠物：显示萌宠并进入语音对话 |
| `Alt+Shift+V` / `Alt+Shift+C` | 按住说话 · 开始 / 停止 |

注册失败的键会当场弹系统通知告知是哪几个键被占用，不会静默失效。

已下架的快捷键：**翻译取词（原 `CommandOrControl+Alt+T`）**。跨应用取词需要系统级选区读取能力，本仓库没有，
却占着一个全局组合键、按下只弹「（待实现）」。与其偷走用户的快捷键做一件不存在的事，不如解绑。
同类问题（笔记/唤醒只弹 toast）已在本次改为上面两行的真实行为。

## 运行方式

```bash
npm install          # 装依赖
npm run dev          # Vite + Electron 开发模式
npm run typecheck    # 三个 tsconfig（main / preload / renderer）
npm test             # vitest
npm run build:mac    # 出包（另有 build:win / build:linux）
```

## 技术栈

Electron 41 + Vite + React 19 + TypeScript + Zustand + antd；后端 `server/`（Express + Multer + CORS）；
本地语音 whisper.cpp；共享组件来自 `z-biz-tool-shared`。

## 项目结构

```
z-biz-tool-pet/
├── src/
│   ├── main/          # Electron 主进程：22 个模块
│   │                  # index / window-manager / ipc-handlers / tray-manager / shortcut-manager /
│   │                  # ai-router / ai-providers / mcp-tools / voice-service / meeting-transcriber /
│   │                  # task-system / memory-system / achievement-system / persona-system /
│   │                  # scenery-system / particle-system / quick-commands / tool-limiter /
│   │                  # security / stores / config-store / updater
│   ├── preload/       # contextBridge 白名单
│   └── renderer/      # pet/（萌宠窗口）+ admin/（管理端 5 个面板）+ shared/
├── server/            # STT/TTS 代理子进程
├── tests/             # vitest 用例
├── doc/优化方案/       # 现状审计 + Tauri 迁移设计（设计稿，尚未落地）
├── whisper.cpp/       # git submodule 指针，见下
└── vite.config.ts
```

## 命名与标识符（为什么不顺手改名）

仓库目录是 `z-biz-tool-pet`，但 `package.json` 里保留了几处 `z-bot` / `Z-Bot` / `com.zbiztool.zbot`，这是刻意的：

- `build.appId = com.zbiztool.zbot`：**不改**。macOS 的麦克风/屏幕录制授权（TCC）、Windows「打开方式」与首选项库都按
  bundle id 记账；出过包的用户改了标识符等于重新授权一遍，且自动更新的产物名也会错位。
- `build.productName = Z-Bot`：**不改**。它是 .app 显示名与 electron-updater 比对 `latest*.yml` 里文件名的依据。
- `name = z-bot`：包未发布到 npm，改动无风险但收益也几乎为零；界面文案（托盘提示、窗口标题、宠物默认名）统一用 `Z-Bot`，
  与 productName 对齐，避免出现第三个名字。
- 真正决定用户数据位置的是硬编码的 `~/.z-bot`（`src/main/config-store.ts`），与上述标识符无关，可用 `ZBOT_DATA_DIR` 覆盖。

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

## 关于 Tauri 迁移

`doc/优化方案/Tauri-迁移设计.md` 是**设计稿**：仓库里目前没有 `src-tauri/`、没有一行 Rust、CI 仍只跑 electron-builder。
迁移的真实进度与该文档的核对结论写在该文档开头的「进度核对」一节。
