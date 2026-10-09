# 桌面萌宠（z-biz-tool-pet）

> 常驻桌面的 AI 萌宠：语音对话、截图分析、养成、任务与会议转录。

## 能力清单（对应代码，非路线图）

- **萌宠窗口**：透明无边框、置顶显示且不抢前台焦点、可拖拽、支持点击穿透（`WS_EX_TRANSPARENT`）、
  位置跨启动持久化（`~/.z-bot/window_bounds.json`，退出/隐藏时同步补写一次）
- **动画状态机**：17 种动画（idle/blink/walk/dance/roll/jump/wiggle/stretch/spin/yawn/sleep/chase/bounce/shake/wobble/petted）
  + 优先级抢占 + 光标跟随（Rust 侧 `GetCursorPos` 轮询推送，渲染层不再计时轮询）+ 粒子与场景系统
- **语音链路**：本地 whisper.cpp STT + TTS，全部在本进程直接驱动子进程（`whisper-cli` / PowerShell `System.Speech`），
  不再有 8084/8086 两个 Node sidecar，也不再有一次性 token；按住说话、语音打断、麦克风自检、会议转录照旧
- **AI 对话**：多提供商路由（ollama/openai/claude/gemini/deepseek/qwen/custom）、流式输出、工具调用确认与频控熔断
- **截图**：全屏/指定窗口截图（Win32 GDI `BitBlt`/`PrintWindow`）、截图 + 视觉模型分析、
  截图隐身（`SetWindowDisplayAffinity`，隐身时窗口对截屏与拓印都不可见）
- **养成系统**：饥饿/快乐/精力/清洁/健康/好感六维衰减、阶段成长、成就、人设、记忆（长短期）
- **快速笔记**：全局快捷键把剪贴板文本存为 Pin 便签，托盘「快速笔记」子菜单可逐条复制回剪贴板或清空
- **任务/快捷指令**：定时任务调度、快捷指令面板
- **托盘**：显示/隐藏、语音起停、隐身、点击穿透、开机自启、笔记、设置、退出
- **自动更新**：查本仓 GitHub Releases 的最新版 → 下载到 `~/Downloads` → 唤起安装器；
  源可用 `ZBOT_UPDATE_FEED_URL` 或 `~/.z-bot/update-feed.json` 覆盖，启动后 5 秒静默查一次

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

## 运行方式

```bash
npm install                 # 只装前端依赖（Rust 侧由 cargo 管）
npm run tauri dev           # 开发：自动起 Vite（127.0.0.1:5173）+ 编译 Rust + 开两个窗口
npm run dev                 # 只起前端（浏览器里看不到托盘/快捷键，端点会显式报未接通）
npm run typecheck           # 渲染层 tsc --noEmit
npm run lint                # eslint（error 为门禁，react-hooks warning 暂不阻断）
npm run port:status         # 端点台账：契约 78 项必须全部接通，否则退出码 1
npx tauri build --bundles nsis   # 出 Windows 安装包
cd src-tauri && cargo test --lib # Rust 单测（88 条）
```

## 技术栈

Tauri 2 + Rust（本进程直调 Win32）+ Vite + React 19 + antd 6；本地语音 whisper.cpp；共享组件来自 `z-biz-tool-shared`。
**当前只出 Windows 包**：截图、隐身、点击穿透都是 Win32 直调，macOS 侧还没有对应实现。

## 项目结构

```
z-biz-tool-pet/
├── src-tauri/          # Rust 宿主，24 个模块约 8.3k 行
│   ├── src/lib.rs      # 插件注册 + 窗口事件 + setup（快捷键、托盘、启动更新检查）
│   ├── src/state.rs    # 配置/历史/Pin/养成数值的读写通道（~/.z-bot/*.json）
│   ├── src/store.rs    # 带内存缓存的 JSON 存储 + 损坏备份 + 文件锁
│   ├── src/secret.rs   # AES-GCM 密钥存储（master.key + secrets.json，明文不落盘）
│   ├── src/ai.rs       # 7 家提供商协议 + 流式；router.rs 做供应商切换与确认
│   ├── src/tools.rs    # 工具编排：确认、白名单、频控（limiter.rs）、危险特征（security.rs）
│   ├── src/voice.rs    # whisper-cli STT + 三平台 TTS
│   ├── src/meeting.rs  # ffmpeg dshow 抓系统音频 → 分段转写 → 滚动摘要 → 总结
│   ├── src/screenshot.rs / runtime.rs / skins.rs / memory.rs / update.rs / tray.rs / shortcuts.rs …
│   └── tauri.conf.json # 两个窗口（pet / admin）、bundle 配置
├── src/renderer/       # pet/（萌宠窗口）+ admin/（管理端 5 个面板）+ shared/
│   ├── api.d.ts        # window.electronAPI 的类型面（79 个方法，抄自删除前的 preload）
│   └── shared/tauri-bridge.ts # 把 electronAPI 映射到 invoke/listen 的桥
├── scripts/
│   ├── port-status.mjs          # 端点台账（现算，不看副本）
│   ├── endpoint-contract.json   # 删除 preload 时导出的契约快照
│   └── fetch-whisper-model.sh   # 下载 ggml 模型到 ~/.z-bot/models
├── doc/优化方案/       # 现状审计 + Tauri 迁移设计 + 实施路线
├── whisper.cpp/        # 语音引擎构建产物目录（git 里只跟踪 README）
└── assets/             # 图标源文件（SVG → 由 P0 生成 src-tauri/icons）
```

## 命名与标识符

- 数据目录仍是硬编码的 `~/.z-bot`，可用 `ZBOT_DATA_DIR` 覆盖 —— 换壳前后同一个目录，老的 config.json / 历史 / 便签直接可用。
- `package.json` 的 `name = z-bot`、界面文案与窗口标题里的 `Z-Bot` 保持不动。
- **应用标识符换了**：Electron 时代的 `appId = com.zbiztool.zbot` 变成 Tauri 的
  `identifier = com.zifang.z-biz-tool-pet`，安装包名也从 `Z-Bot Setup` 变成 `z-biz-tool-pet_*_x64-setup.exe`。
  后果是新旧两版在 Windows 眼里是两个应用：NSIS 不会替你卸载旧的，**装 Tauri 版前先卸载 Electron 版 Z-Bot**，
  否则托盘会同时出现两只、开机自启也会重复注册。

## 本地语音（whisper.cpp）准备

`whisper.cpp/` 在 git 中是 submodule 指针，说明文件放一份在这里才可被跟踪（同一份内容也在本地 `whisper.cpp/README.md`）。

1. 编译 CLI：`git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git && cd whisper.cpp && cmake -B build && cmake --build build -j`
   产物需在 `whisper.cpp/build/bin/whisper-cli`，或用 `ZBOT_WHISPER_BIN=/path/to/whisper-cli` 指定。
2. 下载模型（不进仓库）：`scripts/fetch-whisper-model.sh base` → `~/.z-bot/models/ggml-base.bin`
   换模型用 `ZBOT_WHISPER_MODEL=/path/to/ggml-small.bin`，或在设置面板里选。
3. 自检：设置面板的语音状态（端点 `voiceStatus`）会直接给出缺的是可执行文件还是模型，并带上找到的路径 ——
   以前是 curl `127.0.0.1:8084/health`，现在没有端口可 curl 了。
4. 会议转录与系统音频抓取依赖 `ffmpeg`（`dshow` 的 `virtual-audio-capturer`），STT 也用它做 wav 转码。
   ffmpeg 或 whisper-cli 不在机器上时，对应端点返回可读的失败原因而不是静默无输出。

## Electron → Tauri 迁移现状

- 端点：preload 契约 78 项全部接通（`npm run port:status` 是 CI 门禁），Rust 侧 61 个 `#[tauri::command]` 全部注册。
- 测试：Rust 单测 88 条（2 条要真实引擎才能跑，标了 `#[ignore]`）；原 `tests/` 下 17 个 vitest 文件随被测代码一起删除
  （其中 2 个是拉 Node sidecar 的集成用例，sidecar 没了），可迁移的断言逐条搬进了对应 Rust 模块的 `#[cfg(test)]`。
- 体积（本机实测，同一台 Win10 x64）：安装包 `Z-Bot Setup 1.0.2.exe` 88.7 MB → `z-biz-tool-pet_1.0.2_x64-setup.exe` **3.94 MiB**；
  装后目录 306.3 MB / 723 个文件 → **16.1 MB / 2 个文件**（exe + 卸载器）。
- 出包：`npx tauri build --bundles nsis`，装后落在 `%LOCALAPPDATA%\z-biz-tool-pet`（currentUser 模式，不需要管理员）。
- 删掉的 Electron 资产：`src/main`（22 个模块）、`src/preload`、`server/`（Express STT/TTS sidecar）、
  `scripts/build.sh` 与 `scripts/stage-server-deps.cjs`、electron / electron-builder / electron-updater / express / multer / cors 等 450 个包。
  出包只需要一条 `npx tauri build --bundles nsis`，仓库里不再留第二套构建脚本。
- 渲染层一行没动：`window.electronAPI` 的名字和返回形状都保持原样，映射集中在 `shared/tauri-bridge.ts`。
- 设计稿与逐条核对结论见 `doc/优化方案/Tauri-迁移设计.md`。
