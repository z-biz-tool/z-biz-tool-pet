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