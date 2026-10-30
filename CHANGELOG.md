# Changelog

z-biz-tool-pet 版本变更记录。格式遵循 [Conventional Commits](https://www.conventionalcommits.org/)。

## [1.5.0] - 2026-10-30

核心是 **接入家族统一更新通道**（tauri-plugin-updater），此前 pet 是全家族唯一没有 `latest.json` 的 Tauri 仓——装了 pet 的机器永远收不到更新。

### Features
- 接入官方 tauri-plugin-updater v2：endpoint 指向本仓 `main/latest.json`（发版时由 build.yml 生成并推送），签名公钥与其他仓共用家族同一把；更新完成后用 tauri-plugin-process 一键重启。
- admin 窗口新增更新闸门（UpdaterDialog）：启动 5 秒后静默检查一次，有新版才弹窗，支持分块下载进度与「立即重启」。**只挂 admin 窗口**——pet 挂件窗口仅 268×512 且置顶，弹窗会被裁切或盖住挂件。

### Notes
- 手搓的 `update.rs` 仍保留，但默认不工作（必须显式配 `ZBOT_UPDATE_FEED_URL` 或 `~/.z-bot/update-feed.json` 才查，否则 `no-feed` 直接跳过），与官方插件互不打架。
- build.yml 的 manifest `notes` 改为优先读本文件的对应版本段落，取不到才回落 Release body（后者默认串对更新弹窗没有信息量）。
