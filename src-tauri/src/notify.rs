//! 系统通知：Electron 侧是 `new Notification({title, body, silent}).show()`，
//! Tauri 侧对应 tauri-plugin-notification（remote/sys 已在用同一颗插件）。
//!
//! 只有两类事情值得弹系统通知：用户按了没反应（快捷键被占用）、和托盘创建失败这种
//! "能力掉了但界面看不出来"的情况。任务提醒一类走宠物窗口自己，不从这里发。

use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

pub fn notify(app: &AppHandle, title: &str, body: &str) {
    if let Err(e) = app
        .notification()
        .builder()
        .title(title)
        .body(body)
        .show()
    {
        // 通知发不出去（Windows 需要 Toast AppUserModelID / 系统关了通知权限）不能影响主流程
        eprintln!("[Z-Bot] 系统通知发送失败: {e}");
    }
}
