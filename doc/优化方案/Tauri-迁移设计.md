# pet → Tauri 迁移骨架设计

> 起因：`pet 改为 rust 壳子，体积太大`（09-24 用户原话）。
> `cap-img` 已落地在 `z-biz-tool-capability`（`v0.1.1`，CI 全绿），本设计说明 pet 接入它的姿势。

## 1. 现状盘点（实测）

| 指标 | 值 |
|---|---|
| 形态 | Electron 27（`main: dist/main/index.js`，`@electron/...` 工具栈全栈 Node） |
| 安装包体 | `build/mac-arm64/Z-Bot-1.0.1.dmg` 当前 ~105 MB（含 whisper.cpp 二进制 + Electron runtime） |
| 主进程模块（src/main/） | 14 个：ai-router、ai-providers、task-system、memory-system、voice-service、ipc-handlers、tray-manager、updater、mcp-tools、meeting-transcriber、scenery-system、shortcut-manager、quick-commands、particle-system |
| 渲染层 | React 19 + antd + zustand + 共享 `z-biz-tool-shared` |
| 本地服务 | `server/`（express + multer 文件上传 + 自定义 TTS/STT 代理，STT 端口、TTS 端口常量在 `voice-service.ts`） |
| 体积大头（预估） | Electron runtime ~80MB + 整个 whisper.cpp 二进制 ~25MB（！）+ node_modules 镜像 + 应用本体 |

## 2. 为什么是 Electron→Tauri 而不是其它路径

| 方案 | 收益 | 代价 |
|---|---|---|
| **Electron → Tauri 2** | 安装包 ~10MB 量级，内存减半，冷启动 <1s | 主进程全部 Node 模块要 Rust 重写 |
| Electron + V8 snapshot / partial bundling | 安装包能压到 ~70MB | whisper.cpp 二进制还在，没解决大头 |
| 纯 web 化（去掉桌面壳） | 0 MB | 失去 tray / global-shortcut / 宠物桌宠定位 |
| Tauri + 侧车进程保留 voice server | 安装包 ~15MB | 主进程仍要 Rust 重写（除 voice），语音仍 spawn Node 进程 |

裁定：Tauri 主路线。voice service 在 Rust 里用 axum/Hyper 重写比想象中简单（express 是 HttpServer 抽象，axum 是同形），whisper.cpp 通过 Rust crate `whisper-rs` 直接链接、不再要 ~25MB 二进制。

## 3. 接入 cap-img

pet 当前**没有任何图片处理**（grep `image\|canvas\|base64` 零命中）。但矩阵规划 03 §6.4 写明：**pix 立项的前置 = 能力层 img 一片 + Asset 版本链**，pet 是 pix 之前的截图/图像类操作候选消费方之一。提前把 cap-img 接进 pet，让 pet 一开始就是"统一从 capability 取像素"的 app，避免未来再发生"file 当年把 base64 自己塞进 image_utils"那种六套重复实现。

接入方式：

```toml
# pet/src-tauri/Cargo.toml
[dependencies]
tauri = { version = "2" }
cap-img = { git = "https://github.com/z-biz-tool/z-biz-tool-capability", tag = "v0.1.1" }
```

具体消费点（按迁移阶段落地）：

| 阶段 | 用 cap-img 替的 pet 现状 | 文件/位置 |
|---|---|---|
| P1 壳 | （仅验证依赖通：注册 `cap_demo` 命令调 `cap_img::info`） | pet/src-tauri/src/commands/demo.rs |
| P2 截图 | pet 截图当前用 `desktopCapturer` 拉 webview + html-to-image 转 base64 → 用户保存；改成 `cap_img::thumbnail`（PNG 内存编码 + base64）+ `cap_img::save_bytes` 落盘 | src/renderer/pet/ScreenshotPanel.tsx → 后端命令 |
| P3 图像导入 | 用户拖入图片做头像/表情包；将来 cap-img 提供缩放/裁剪/EXIF | 头像是 `App.tsx`，新命令 `resize_avatar` |
| 后续 | 截图打码 / 水印 / 多尺寸导出 / 抠图 | 逐步把 renderer canvas 路径替成 cap-img |

## 4. 主进程模块迁移优先级

按"价值 / 难度" 排序（P1 先做壳框架，其它按顺序逐步替换）：

| 优先级 | 模块 | 替换目标 | 难度 | 备注 |
|---|---|---|---|---|
| **P1** | 壳 + 启动 | tauri 2 run() + WebView | 低 | 复用 vite.config.ts，移除 main/index.ts 的 BrowserWindow/Tray/globalShortcut |
| **P2** | tray-manager | tauri 内置 tray feature + TrayIconBuilder | 中 | 宠物图标、菜单、点击穿透——tauri 都有原生 API；`setIgnoreMouseEvents` 改 `set_ignore_cursor_events` |
| **P2** | shortcut-manager | tauri-plugin-global-shortcut | 低 | 已有官方 plugin |
| **P2** | config-store | tauri-plugin-store 或直接 `serde_json` + `app_data_dir()` | 低 | 持久化简单 |
| **P3** | ipc-handlers | `#[tauri::command]` 一对一替换 | 中 | 50+ 个 invoke handler 需要逐个 Rust 化（最机械的活） |
| **P3** | task-system | tokio task + tokio-cron-scheduler | 中 | `cron-parser` 替换 |
| **P3** | memory-system | SQLite (rusqlite) 或 redb | 中 | 状态本地存储 |
| **P3** | particle-system | wgpu 或 canvas（renderer 不动） | 低 | 完全在 renderer，留 React |
| **P4** | ai-router / ai-providers | reqwest + axum + serde_json | 中 | 现有 fetch 改 reqwest |
| **P4** | voice-service | axum | 中 | express 替换；whisper.cpp 换 whisper-rs（crate 直接链） |
| **P4** | meeting-transcriber | 复用 P3 + P4 | 中 | 拼装 |
| **P5** | updater | tauri-plugin-updater | 低 | 官方 plugin |
| **P5** | mcp-tools | 保留为 web 端，调 Rust 命令 | 低 | MCP 协议栈本来就在 webview 跑 |
| **P5** | quick-commands / scenery-system / achievement-system | 纯前端逻辑，留 renderer | 极低 | |

## 5. 体积收益预估

| 阶段 | 安装包大小变化 | 关键路径 |
|---|---|---|
| 现状（Electron） | **~105 MB** | whisper.cpp 二进制 ~25MB + Electron ~80MB |
| P1 完（仅壳） | ~30 MB | 去掉 Electron runtime + 保留 whisper.cpp 二进制 |
| P3 完（task + memory Rust 化） | ~28 MB | 任务调度 + 状态上 Rust，少 electron 部分 |
| P4 完（voice + whisper-rs） | **~12 MB** | whisper.cpp 二进制 → whisper-rs 静态链接，省 25MB |
| P5 完（完全 Rust 主进程） | ~10 MB | 与其它 Tauri app 一致 |

P1→P3 是"打包体积换开发量"性价比最高的一段（改 ipc-handlers 一对一，机械）。P4 是技术挑战点（whisper-rs 集成 + voice service 重写），但收益最大。

## 6. CI / 打包迁移

| 阶段 | 改动 |
|---|---|
| P1 | 新增 `.github/workflows/build.yml`（参考 cpu `e5592a7` 的四腿 tauri-action），保留 `build.yml` 的 electron-builder 三腿作为 `legacy.yml`，双轨跑 |
| P3 | electron-builder 三腿标 `@deprecated`，主流程改 tauri |
| P5 | 删除 `legacy.yml`，仓库 tag `v2.0.0` 标记完成 |

## 7. 风险与红线

- **不要在 Tauri 主进程留 Node spawn**：voice-service 不许 fallback 到 `Command::new("node", "server/index.js")`——一旦这样 P4 等于白做。whisper-rs 必须用 Rust API。
- **不要把 pet 的 ipc-handlers 500 行胶水代码原样搬 Rust**：重构机会，借机拆分成多个子命令、减少单文件体积。
- **renderer 几乎不动**：React 19 + antd + zustand + z-biz-tool-shared 已经全部在 src/renderer/pet/，迁 Tauri 后**不需要改 renderer 一行**，只是 `main` 从 vite dev 服务器的 URL 改成 `tauri://localhost`，前端已经过 132 测试的验证。
- **AI 路由保持 web 端**：AI 调用是网络 IO，没有"必须本地 Rust"的理由，留在 webview 用 fetch 跑，对打包体积零影响。

## 8. 与矩阵规划其它 GAP 的关系

- 矩阵规划 03 §6.4：pix 立项 = 能力层 img + Asset 版本链。pet 不是 pix，但 pet 的截图/导入是"截屏版 pix"，提前接 cap-img 让 pet 不重造 base64/缩放。
- 矩阵规划 03 §4.2：依赖版本统一。pet 迁 Tauri 后走 workspace 级别的 tokio/reqwest 等，与 file/aigen 锁同一版本（最终要把 tokio "full" 收窄成 shared workspace）。
- 矩阵规划 03 §8 第 5 步（pix 立项）：pet 的截图能力（desktopCapturer）迁 cap-img 后，pet 就是 pix 上游的素材源——pix 接 cap-img 直接消费 pet 截的图。

## 9. 落地决策

不在本 goal 内启动 src-tauri 实写（Node 14 个模块 → Rust 的工作量远超剩余 turn）。本设计文档作为下一轮 goal 的入口文件：确认 P1 范围后，下一轮开干 P1 = 壳 + cap-img 验证 + 不动 renderer + CI 双轨。