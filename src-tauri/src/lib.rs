mod actions;
mod ai;
mod commands;
mod files;
mod limiter;
mod log;
mod memory;
mod notify;
mod router;
mod runtime;
mod screenshot;
mod secret;
mod security;
mod shortcuts;
mod skins;
mod state;
mod store;
mod tools;
mod tray;
mod voice;

use tauri::{Manager, WindowEvent};

const PET: &str = "pet";

/// 测试里要动 ZBOT_DATA_DIR，而环境变量是进程级的：并发跑测试会互相踩，统一串行化。
#[cfg(test)]
pub(crate) fn lock_test_env() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // 开机自启：Electron 的 app.setLoginItemSettings 在 Tauri 侧的对应物
        .plugin(tauri_plugin_autostart::init(Default::default(), None))
        .invoke_handler(tauri::generate_handler![
            commands::app_get_mode,
            commands::window_show,
            commands::window_hide,
            commands::window_toggle,
            commands::window_move_pet,
            commands::window_set_pet_position,
            commands::window_stick_to_edge,
            commands::pet_set_position,
            commands::pet_trigger_animation,
            commands::pet_toggle_stealth,
            commands::pet_get_stealth_mode,
            commands::pet_set_click_through,
            state::config_load,
            state::config_save,
            state::stt_models,
            state::history_load,
            state::history_save,
            state::history_clear,
            state::conversation_add_message,
            state::pin_list,
            state::pin_create,
            state::pin_remove,
            state::pet_get_stats,
            state::pet_feed,
            state::pet_play,
            state::pet_wash,
            state::pet_sleep,
            state::pet_medicine,
            state::pet_pet,
            log::console_log,
            shortcuts::shortcuts_list,
            shortcuts::shortcuts_update,
            files::file_read,
            files::file_read_as_base64,
            router::ai_chat,
            router::ai_stream_chat,
            router::ai_test_connection,
            router::ai_get_models,
            router::ai_get_builtin_providers,
            router::tools_list,
            router::tools_confirm,
            router::tools_cancel,
            router::tools_always_allowed,
            router::tools_revoke_always_allowed,
            screenshot::screenshot_capture,
            screenshot::screenshot_capture_window,
            screenshot::screenshot_capture_and_analyze,
            skins::pet_get_skins,
            skins::pet_apply_skin,
            skins::pet_apply_skin_theme,
            voice::voice_transcribe,
            voice::voice_speak,
            voice::voice_status,
            voice::voice_interrupt,
            voice::voice_check_microphone
        ])
        .on_window_event(|window, event| {
            let app = window.app_handle();
            match event {
                // 关窗不等于退出：Electron 两个窗口都是 preventDefault + hide。
                // 萌宠一旦被真销毁，进程就没有窗口了，会跟着一起退出。
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    if window.label() == PET {
                        runtime::flush_pet_bounds(app);
                    }
                    if let Some(w) = app.get_webview_window(window.label()) {
                        let _ = w.hide();
                    }
                }
                // 移动结束后再落盘，拖拽期间不落盘（Electron 的 400 ms debounce）
                WindowEvent::Moved(_) | WindowEvent::Resized(_) if window.label() == PET => {
                    runtime::schedule_bounds_flush(app);
                }
                // Tauri 的 WindowEvent 没有 Show/Hide：可见性由主动显示/隐藏的那几处挂钩
                _ => {}
            }
        })
        .setup(|app| {
            let handle = app.handle();
            store::ensure_data_dir().map_err(|e| format!("数据目录不可用: {e}"))?;
            state::init_runtime_state();
            // 长期记忆是只写存档（AI 请求并不注入它），但文件要和 Electron 时期连续
            memory::init();
            // 上一次运行留下的截图会含屏幕内容，24 小时未清理就删（Electron 在启动时做同一件事）
            screenshot::cleanup_stale_screenshots();
            // 文件白名单要在任何读取命令可用之前建好根（D05）
            files::refresh_allowed_roots(handle);

            // 先落位、再开隐身、最后显示：少一次"位置不对 + 没保护"的闪烁
            runtime::restore_pet_bounds(handle);
            runtime::stealth_from_config(handle);
            actions::show_pet(handle);
            // 顶层/跨空间/穿透/隐身四类标志再兜一次：conf 里的声明在个别平台上会被忽略
            runtime::reapply_pet_window_flags(handle);

            // 托盘失败不致命：降级成"只有快捷键"，宠物照常显示（Electron 版同一条兜底）
            if let Err(e) = tray::create_tray(handle) {
                eprintln!("[Z-Bot Main] 托盘创建失败，已降级为无托盘模式: {e}");
                notify::notify(
                    handle,
                    "托盘图标不可用",
                    &format!(
                        "萌宠仍在运行，但托盘菜单暂不可用：{e}。可用 CommandOrControl+Shift+Z 显示/隐藏。"
                    ),
                );
            }
            shortcuts::apply_from_config_with_notice(handle);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Z-Bot 启动失败");
}
