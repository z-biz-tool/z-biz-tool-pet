# 桌面萌宠（z-biz-tool-pet）

> 常驻桌面的 AI 看板娘：记得住你说过的话，也会自己找点事做。语音对话、截图分析、养成、任务与会议转录。

## 能力清单（对应代码，非路线图）

- **长期记忆（v2，真正闭环）**：`src-tauri/src/memory.rs` + `mind.rs`。
  1. 抽取双路：`mind.rs` 用 LLM 从对话里抽出 `fact/preference/person/event/plan/trait`
  六类记忆（带 key / 置信度 / 出处），正则做零延迟兜底；写前过一道**反幻觉闸门**
  （content 的实词必须在原文出现过 —— 模型会在讲述职的对话里顺手编出「喜欢冰美式」）。
  2. 检索：中文 2-gram + 西文分词，按「命中度 + 置信度 + 时间衰减（半衰期 45 天）+
     被想起次数 + 置顶」打分；命中即累加 `hits`，越常用越容易被再想起。
  3. 注入：`router::inject_memory` 在**每一次** chat / stream 请求前把相关记忆拼进
     system prompt 尾部（v1 的致命伤就是只写不读 —— 记忆从没进过任何一次请求）。
  4. 管理：管理端「她的记忆」面板可搜索/按类型筛/置顶/删除/手动教她记，
     还有一个「她会怎么想起」预览，直接展示某句话会唤出哪几条记忆、拼成什么 prompt。
     旧版 `long_term_memory.json`（裸数组）在启动时就地迁移，不丢历史。

- **自主行为（她真的会自己动）**：`src-tauri/src/mind.rs` 的 `reflect()` +
  `src/renderer/pet/companion/autonomy.ts` 的 `AutonomyDirector`。
  每隔 1~5 分钟（默认 2 分钟，±35% 抖动）问一次「你现在想干嘛」，
  **两阶段推理**：先发散出 3 个念头（温柔的/调皮的/安静的各一个），再自评挑一个、
  拆成 1~3 步可播放的动作脚本（走过去 → 探头 → 说半句）。她掌握当下的时间、
  你多久没理她、今天专注了多久、好感度、以及她记得的事——所以深夜会打哈欠去睡，
  而不是每两分钟重复同一句台词。重要度 70+ 的会写进日记（`event` 类记忆）。
  模型不可用、超时、返回垃圾时**静默降级**到本地台词池，不弹任何错误：
  她"比平时安静一点"是允许的状态。

- **陪伴层（她自己的状态机）**：`src/renderer/pet/companion/` 里一个 `CompanionEngine`，每秒 `tick` 一次，
  统一管所有「她主动做的事」—— 自言自语、需求表达（饿/困/脏/病/寂寞）、久坐与喝水提醒、时段问候、
  好感里程碑、专注钟。台词分「通用池 + 六角色各自语癖」，同一句话她能换六种说法。
  专注模式下入口直接 `return`，从机制上保证不打扰
- **手势分层**：单击 = 摸头（1~2 下普通、3~5 下害羞、6 下起傲娇拒绝并冷却 4 秒）、**长按 480ms = 说话**
  （松手结束）、拖拽 = 挣扎着被搬走（4 秒节流）、滚轮 = 立绘缩放 0.85~1.15（跨启动记住）。
  单击原本直接开麦，随手点一下就会弹权限框或录半秒环境音就发出去 —— 最容易被误触的手势不该挂最重的功能
- **专注钟**：右键起 25 / 50 分钟，倒计时常驻在名牌上（点它暂停），过半给一次鼓励，结束庆祝并计入当日统计。
  菜单底部一行「今天 · 摸头 N 次 · 专注 M 分钟」，让陪伴有积累感
- **萌宠窗口**：268×512 透明无边框、置顶显示且不抢前台焦点、可拖拽、支持点击穿透（`WS_EX_TRANSPARENT`）、
  位置跨启动持久化（`~/.z-bot/window_bounds.json`，退出/隐藏时同步补写一次）
- **管理端**：左侧聊天列 + 右侧栏并列布局——设置/会议转录打开时**聊天列让位**（`padding-right` 过渡），
  而不是被浮层盖住切掉一半；设置按 AI / 对话 / 语音 / 外观 / 心智 / 快捷键 / 更新 7 个分区收进卡片，
  标签与分区标题共用同一条左对齐线；关闭的侧栏带 `inert`，不会被 Tab 键误入。
  顶栏不用 antd `Header`（它自带的 `line-height: 64px` 会被内部两行文本继承，把标题顶出容器被窗口裁掉）
- **立绘看板娘**：7 个角色。默认是原创的**桃夭**（2026-10-28 新画：奶白长发 + 桃粉大摆裙 + 琥珀色眼睛，
  人设就是"记得你说过的话"，对上记忆主线；也是唯一不为任何 AI 产品做娘化的角色 —— 门面不该是别人的 logo）。
  其余 6 位（茉白/夜汐/星璃/砚秋/棠青/音橘，源自「AI 娘化全家福」6 张立绘，
  同样已抠成透明底 webp，520×872 供 2x 显示）。右键「换角色」即时切换，同时换配色、
  轮廓光与人设（人设只在用户没自定义过 prompt 时才跟着换）。立绘用三层变形堆出「活着」的手感：
  动画系统的 transform、呼吸缩放、跟随鼠标的微小倾斜各占一层，互不覆盖；
  另有三道阴影（近身暗边 / 角色色柔光 / 落地影）保证浅色与深色壁纸下都不糊在背景里
- **动画状态机**：17 种动画（idle/blink/walk/dance/roll/jump/wiggle/stretch/spin/yawn/sleep/chase/bounce/shake/wobble/petted）
  + 优先级抢占 + 光标跟随（Rust 侧 `GetCursorPos` 轮询推送，渲染层不再计时轮询）+ 粒子与场景系统。
  换成静态立绘后自动眨眼定时器已退役（图片没法眨眼，硬做会变成整张图缩放），`blink` 动画本身仍可经 IPC 触发
- **语音链路**：本地 whisper.cpp STT + TTS，全部在本进程直接驱动子进程（`whisper-cli` / PowerShell `System.Speech`），
  不再有 8084/8086 两个 Node sidecar，也不再有一次性 token；按住说话、语音打断、麦克风自检、会议转录照旧
- **AI 对话**：多提供商路由（ollama/openai/claude/gemini/deepseek/qwen/custom）、流式输出、工具调用确认与频控熔断
- **截图**：全屏/指定窗口截图（Win32 GDI `BitBlt`/`PrintWindow`）、截图 + 视觉模型分析、
  截图隐身（`SetWindowDisplayAffinity`，隐身时窗口对截屏与拓印都不可见）
- **养成系统**：饥饿/快乐/精力/清洁/健康/好感六维衰减、阶段成长、成就、人设（记忆见上面第一条）
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
npm test                    # 渲染层单测 37 条（node --experimental-strip-types）
npx tauri build --bundles nsis   # 出 Windows 安装包
cd src-tauri && cargo test --lib # Rust 单测（96 条）
```

> `npm test` 直接跑 `tests/*.test.ts`，Node 的 ESM 解析不做扩展名补全 —— 所以
> `companion/engine.ts` 里对 `lines.ts` 的引用是**带 `.ts` 后缀**的（对应 tsconfig 的
> `allowImportingTsExtensions`）。其余源码仍按 Vite 习惯省略后缀。

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
