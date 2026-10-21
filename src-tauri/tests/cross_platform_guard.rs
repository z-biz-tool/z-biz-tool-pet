//! **跨平台编译守卫**：钉住「Windows-only 依赖不得变成无条件依赖」。
//!
//! ## 这条测试在守什么
//!
//! 2026-10-21 实测出的真断裂：`windows = { version = "0.62", ... }` 当时是
//! **无条件依赖**，而上游 `windows-future 0.3.2` 的 `async_spawn.rs`
//! **无条件**调用 `windows_threading::submit`，而 `windows-threading` 整个 crate 是
//! `#![cfg(windows)]`
//!
//! ```text
//! error[E0425]: cannot find function `submit` in crate `windows_threading`
//! error[E0425]: cannot find type `IMarshal` in module `windows_core::imp`
//! ```
//!
//! ⇒ 在 macOS / Linux 上**编译 pet 必然失败**。
//! `windows-future` 的 0.2.1 / 0.3.0 / 0.3.1 / 0.3.2 **都有这个缺陷**
//! （逐个下载 diff 验证过）⇒ 不是版本选错能解决的，是上游长期缺陷。
//!
//! 而 pet 的 CI **只有 Windows 腿** ⇒ 这个断裂在 CI 上**永远看不见**，
//! 只有开发者在本机（非 Windows）编译时才会撞上。
//!
//! ## 为什么用「仓内守卫」而不是「加一条 macOS CI 腿」
//!
//! 试过了：加 `runs-on: macos-latest` 的 job 后，它在 GitHub 侧**排队 21 分钟**
//! 拿不到 runner，被 GitHub **自动 cancel** ⇒ 整条 CI 变红
//! （`concurrency: cancel-in-progress` 之下，cancelled 的 job 会让 run 判 failure）。
//! 一个会因 runner 资源紧张而红的门禁，比没有门禁更糟 ——
//! 它训练团队忽略红灯。
//!
//! 所以把断言从「在 macOS 上编译一遍」换成**更精确、且任何 runner 都能跑**的静态判据：
//!
//! 1. `windows` 必须声明在 `[target.'cfg(windows)'.dependencies]` 下
//!    （不是无条件的 `[dependencies]`）—— 这一条**直接**杜绝了上面那个断裂；
//! 2. 源码里每一处 `use windows::` 必须带 `#[cfg(windows)]` 守卫
//!    —— 否则依赖虽是条件依赖，import 照样让非 Windows 编不过；
//! 3. 非 Windows 侧必须提供同名 stub（能力缺口显式报错，不静默成功）。
//!
//! 这三条断言在 **Windows 腿上就能跑**（本仓 CI 的 Windows 腿 2 分钟跑完），
//! 不依赖任何特定 runner ⇒ 门禁稳定、且比「编译一遍」更早发现问题
//! （依赖声明被改错的那一刻就红，不必等某个平台的编译器报错）。
//!
//! ## 每条探测器都配了「反例自证」
//!
//! 只断言「真实仓库现在没问题」的测试，**证明不了探测器本身咬得住** ——
//! 一旦探测器写错（比如 `starts_with("windows")` 把 `windows-core` 也算进去），
//! 它会永远绿。本文件因此把探测器抽成纯函数，并**用合成输入断言探测器能报错**：
//!
//! - 合成一个把 `windows` 写进 `[dependencies]` 的 Cargo.toml ⇒ 必须报违规
//! - 合成一个没守卫的 `use windows::` 源文件 ⇒ 必须报违规
//! - 合成一个删掉 stub 文案的 screenshot.rs ⇒ 必须报违规
//! - 合成一个回退到 `build_allowed_roots` 的前缀陷阱测试 ⇒ 必须报违规
//!
//! 反例用合成输入而不是「改真仓库」，是因为改真仓库会让 crate 在 macOS 上**编译不过**
//! ⇒ 连断言都跑不到，等于什么都没验证（2026-10-21 第一次做反向钉时正是这样卡住的：
//! 把 `windows` 改回无条件依赖后 `cargo test` 直接编译失败，16 个 E0425）。
//!
//! ## 残留风险（如实说明）
//!
//! 本守卫是**文本级**的：它保证「依赖声明 + import 守卫 + stub 存在」三件事，
//! 但**不等于**「整仓在 macOS 上真的编得过」—— 编译级保证仍然需要一台非 Windows runner。
//! pet 的 CI 因此保留了一个**手动触发**（`workflow_dispatch`）的 macOS 腿做编译级验证，
//! 但它**不进 push 门禁**。这条口径记在 lead 的 `06_验收与风险清单.md` R11。

use std::fs;
use std::path::{Path, PathBuf};

fn crate_root() -> PathBuf {
    // CARGO_MANIFEST_DIR = src-tauri/
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn read(rel: &str) -> String {
    let p = crate_root().join(rel);
    fs::read_to_string(&p).unwrap_or_else(|e| panic!("读不到 {}: {e}", p.display()))
}

/// 从 `Cargo.toml` 里切出某个 `[section]` 的正文（到下一个 `[` 开头为止）。
fn section(cargo_toml: &str, header: &str) -> Option<String> {
    let start = cargo_toml.find(header)? + header.len();
    let rest = &cargo_toml[start..];
    let end = rest.find("\n[").unwrap_or(rest.len());
    Some(rest[..end].to_string())
}

/// **Windows-only 的 crate**：依赖树里含 `#![cfg(windows)]` 成员的。
///
/// 注意 `windows-core` / `windows-sys` / `windows-targets` / `windows-link`
/// **不在此列** —— 它们本身跨平台可编译；出问题的是 `windows` 这把伞
/// （它带 `windows-future`，而 `windows-future` 无条件调 `windows_threading::submit`，
/// 后者整个 crate 是 `#![cfg(windows)]`）。
const WINDOWS_ONLY_CRATES: &[&str] = &[
    "windows",
    "windows-future",
    "windows-threading",
    "windows-result",
];

/// 取一行 `key = value` 里的 key（TOML 行内表写法 `windows = { ... }` 也算）。
fn dep_key(line: &str) -> Option<String> {
    let t = line.trim();
    if t.is_empty() || t.starts_with('#') {
        return None;
    }
    let (k, _) = t.split_once('=')?;
    Some(k.trim().trim_matches('"').to_string())
}

/// 检 1：`[dependencies]`（无条件段）里不得出现 Windows-only crate；
/// 且 `windows` 必须声明在 `[target.'cfg(windows)'.dependencies]` 下。
fn cargo_toml_violations(cargo: &str) -> Vec<String> {
    let mut out = Vec::new();

    // (a) 无条件段
    if let Some(body) = section(cargo, "[dependencies]") {
        for line in body.lines() {
            let Some(key) = dep_key(line) else { continue };
            if WINDOWS_ONLY_CRATES.contains(&key.as_str()) {
                out.push(format!(
                    "[dependencies] 里出现了 Windows-only crate `{key}` —— \
                     它必须只出现在 [target.'cfg(windows)'.dependencies] 下，\
                     否则等于无条件依赖（非 Windows 平台会编译失败）"
                ));
            }
        }
    }
    // (a2) 行内表写法 `[dependencies.windows]`
    if let Some(body) = section(cargo, "[dependencies.windows]") {
        if !body.trim().is_empty() {
            out.push(
                "[dependencies.windows] 段存在 —— 等于把 windows 写成了无条件依赖".to_string(),
            );
        }
    }

    // (b) target 条件段里必须有 windows
    match section(cargo, "[target.'cfg(windows)'.dependencies]") {
        None => out.push(
            "Cargo.toml 缺少 [target.'cfg(windows)'.dependencies] 段 —— \
             `windows` 是 Windows-only 依赖（截图/隐身/鼠标全是 Win32 API），\
             写成无条件依赖会让 macOS / Linux **编译必然失败**"
                .to_string(),
        ),
        Some(body) => {
            if !body
                .lines()
                .any(|l| dep_key(l).as_deref() == Some("windows"))
            {
                out.push(
                    "[target.'cfg(windows)'.dependencies] 里没有 windows 依赖 —— \
                     截图/隐身/鼠标的 Win32 实现依赖它"
                        .to_string(),
                );
            }
        }
    }
    out
}

/// 检 2：源码里每一处 `use windows::` 前 3 行内必须有含 `windows` 的 `#[cfg(...)]` 守卫。
/// 返回 `(检查到的 use 次数, 违规清单)`。
fn unguarded_windows_imports(label: &str, text: &str) -> (usize, Vec<String>) {
    let lines: Vec<&str> = text.lines().collect();
    let mut checked = 0usize;
    let mut out = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let t = line.trim();
        if !t.starts_with("use windows::") {
            continue;
        }
        checked += 1;
        // 看它前面 3 行有没有 #[cfg(...)] 守卫
        let window_start = i.saturating_sub(3);
        let guarded = lines[window_start..i].iter().any(|l| {
            let t = l.trim();
            t.starts_with("#[cfg(") && t.contains("windows")
        });
        if !guarded {
            out.push(format!("{label}:{}  {t}", i + 1));
        }
    }
    (checked, out)
}

/// 递归扫目录，返回 `(检查到的 use 次数, 违规清单)`。
fn unguarded_windows_imports_in_dir(dir: &Path) -> (usize, Vec<String>) {
    let mut checked = 0usize;
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return (0, out);
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            let (c, o) = unguarded_windows_imports_in_dir(&p);
            checked += c;
            out.extend(o);
            continue;
        }
        if p.extension().and_then(|e| e.to_str()) != Some("rs") {
            continue;
        }
        let text = fs::read_to_string(&p).unwrap_or_default();
        let label = p
            .strip_prefix(crate_root())
            .unwrap_or(&p)
            .display()
            .to_string();
        let (c, o) = unguarded_windows_imports(&label, &text);
        checked += c;
        out.extend(o);
    }
    (checked, out)
}

/// 检 3：非 Windows 侧必须有同名 stub（命令照常注册、返回明确错误）。
fn missing_stub_markers(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for (fn_name, marker) in [
        ("grab_screen", "本平台暂无屏幕截图实现"),
        ("grab_window", "本平台暂无窗口截图实现"),
    ] {
        if !text.contains(marker) {
            out.push(format!(
                "screenshot.rs 里找不到 `{fn_name}` 的非 Windows stub（应含「{marker}」）—— \
                 非 Windows 上该命令必须**存在**并返回明确错误，而不是让命令凭空消失"
            ));
        }
    }
    if !text.contains("#[cfg(not(windows))]") {
        out.push("screenshot.rs 里找不到 #[cfg(not(windows))] 的 stub 段".to_string());
    }
    out
}

/// 检 5：前缀陷阱那条测试不得回退到 `build_allowed_roots`。
fn prefix_trap_violations(security_rs: &str) -> Vec<String> {
    let mut out = Vec::new();
    if !security_rs.contains("same_prefix_sibling_directory") {
        out.push(
            "security.rs 里找不到前缀陷阱那条测试\
             （read_guard_rejects_same_prefix_sibling_directory）"
                .to_string(),
        );
        return out;
    }
    let idx = security_rs
        .find("fn read_guard_rejects_same_prefix_sibling_directory")
        .expect("前缀陷阱测试");
    let body = &security_rs[idx..];
    // 切片到**下一个测试函数**为止（不能用 "\n    }" 切 —— 函数体里嵌套的
    // assert!(...) 宏自带 }，会把范围截错，进而把注释里"绕开 build_allowed_roots"
    // 那句话当成代码而误判。2026-10-21 第一次写这个守卫就是这么错的。）
    let end = body
        .find("\n    #[cfg(")
        .or_else(|| body.find("\n    #[test]"))
        .unwrap_or(body.len());
    let body = &body[..end];
    // 只看**代码行**（剔除注释），注释里提到 build_allowed_roots 是说明，不算用法
    let code: String = body
        .lines()
        .filter(|l| {
            let t = l.trim();
            !t.starts_with("//")
        })
        .collect::<Vec<_>>()
        .join("\n");
    if code.contains("build_allowed_roots") {
        out.push(
            "前缀陷阱那条测试用了 build_allowed_roots —— 它会无条件把 temp_dir 放进白名单，\
             断言永远不成立（2026-10-21 修过的测试前提错，不该回退）"
                .to_string(),
        );
    }
    if !code.contains("vec![base") {
        out.push("前缀陷阱那条测试必须用只含 base 一个根的 roots".to_string());
    }
    out
}

// ────────────────────────────── 反例自证（探测器咬得住） ──────────────────────────────

/// 反例 1：把 `windows` 写进无条件 `[dependencies]` ⇒ 必须报违规。
#[test]
fn detector_catches_unconditional_windows_dependency() {
    let bad = r#"
[package]
name = "x"

[dependencies]
tauri = "2"
windows = { version = "0.62" }

[target.'cfg(windows)'.dependencies]
windows = { version = "0.62" }
"#;
    let v = cargo_toml_violations(bad);
    assert!(
        !v.is_empty(),
        "探测器没咬住：把 windows 写进 [dependencies] 竟然没报违规 —— 守卫本身失效了"
    );
    assert!(
        v.iter().any(|s| s.contains("[dependencies]")),
        "报出来的违规应指向 [dependencies]，实际：{v:?}"
    );
}

/// 反例 2：完全删掉 `[target.'cfg(windows)'.dependencies]` 段 ⇒ 必须报违规。
#[test]
fn detector_catches_missing_target_section() {
    let bad = r#"
[package]
name = "x"

[dependencies]
tauri = "2"
"#;
    let v = cargo_toml_violations(bad);
    assert!(
        v.iter().any(|s| s.contains("cfg(windows)")),
        "探测器没咬住：缺 [target.'cfg(windows)'.dependencies] 段竟然没报违规，实际：{v:?}"
    );
}

/// 反例 3：**跨平台可编译**的 windows-* 子 crate 放在无条件段里 ⇒ **不得**报违规。
///
/// （这条是防误报的：探测器第一版用 `starts_with("windows")` 判 key，
/// 会把 `windows-core` / `windows-sys` 也当成 Windows-only 依赖 —— 那是误报。
/// 2026-10-21 重写时改成精确键名匹配。）
#[test]
fn detector_does_not_flag_cross_platform_windows_crates() {
    let ok = r#"
[package]
name = "x"

[dependencies]
windows-core = "0.62"
windows-sys = "0.59"

[target.'cfg(windows)'.dependencies]
windows = { version = "0.62" }
"#;
    let v = cargo_toml_violations(ok);
    assert!(
        v.is_empty(),
        "探测器误报了跨平台可编译的 windows-* crate：{v:?}"
    );
}

/// 反例 4：没有守卫的 `use windows::` ⇒ 必须报违规（**并且**走真实目录遍历路径）。
#[test]
fn detector_catches_unguarded_windows_import() {
    // 4a：纯文本路径
    let (_, v) = unguarded_windows_imports("synthetic.rs", "use windows::core::BOOL;\n");
    assert_eq!(v.len(), 1, "没守卫的 use windows:: 必须被报出，实际：{v:?}");

    // 4b：有守卫 ⇒ 不报
    let (_, v) = unguarded_windows_imports(
        "synthetic.rs",
        "#[cfg(windows)]\nuse windows::core::BOOL;\n",
    );
    assert!(v.is_empty(), "有 #[cfg(windows)] 守卫却被报出，实际：{v:?}");

    // 4c：真实目录遍历路径 —— 造一个临时目录放一个坏文件，必须被抓到
    let tmp = std::env::temp_dir().join(format!("pet-guard-probe-{}", std::process::id()));
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).expect("建临时目录");
    fs::write(tmp.join("broken.rs"), "use windows::core::BOOL;\n").expect("写临时文件");
    let (checked, v) = unguarded_windows_imports_in_dir(&tmp);
    let _ = fs::remove_dir_all(&tmp);
    assert_eq!(checked, 1, "目录遍历没数到那个 use windows::");
    assert_eq!(v.len(), 1, "目录遍历没抓到没守卫的 import，实际：{v:?}");
}

/// 反例 5：删掉非 Windows stub 的错误文案 ⇒ 必须报违规。
#[test]
fn detector_catches_missing_non_windows_stub() {
    let v = missing_stub_markers("pub fn grab_screen() { }\n");
    assert!(
        v.len() >= 2,
        "探测器没咬住：stub 文案全没了只报了 {v:?}"
    );
}

/// 反例 6：前缀陷阱那条测试回退到 `build_allowed_roots` ⇒ 必须报违规。
#[test]
fn detector_catches_prefix_trap_regression() {
    let bad = r#"
#[test]
fn read_guard_rejects_same_prefix_sibling_directory() {
    let base = std::env::temp_dir().join("guard-base");
    let roots = build_allowed_roots(&[base.clone()]);
    assert!(!is_within(&roots, &base.join("x")));
}
"#;
    let v = prefix_trap_violations(bad);
    assert!(
        v.iter().any(|s| s.contains("build_allowed_roots")),
        "探测器没咬住：回退到 build_allowed_roots 竟然没报违规，实际：{v:?}"
    );
}

// ────────────────────────────── 真实仓库的断言 ──────────────────────────────

#[test]
fn windows_crate_must_be_a_target_conditioned_dependency() {
    let cargo = read("Cargo.toml");
    let v = cargo_toml_violations(&cargo);
    assert!(
        v.is_empty(),
        "Cargo.toml 里的 Windows-only 依赖声明有问题：\n{}",
        v.join("\n")
    );
}

#[test]
fn every_windows_import_is_cfg_guarded() {
    let src_dir = crate_root().join("src");
    let (checked, offenders) = unguarded_windows_imports_in_dir(&src_dir);
    assert!(
        checked > 0,
        "这个测试没找到任何 `use windows::` —— 源码结构变了？"
    );
    assert!(
        offenders.is_empty(),
        "这些 windows import 没有 #[cfg(windows)] 守卫，非 Windows 平台会编不过：\n{}",
        offenders.join("\n")
    );
}

#[test]
fn non_windows_stubs_exist_for_the_screenshot_commands() {
    let text = read("src/screenshot.rs");
    let v = missing_stub_markers(&text);
    assert!(
        v.is_empty(),
        "screenshot.rs 的非 Windows stub 有问题：\n{}",
        v.join("\n")
    );
}

/// 顺带钉住 Cargo.lock：不能在 lock 里把 windows 拉成两套不一致的 windows-core。
/// （2026-10-21 实测 lock 里有 `windows-threading 0.2.1` + `windows-future 0.3.2`
/// 这个不兼容组合；它只在 Windows 上触发，Windows 腿跑不出问题，
/// 但 lock 里若出现**两份不同版本的 windows-core** 就是危险信号。）
#[test]
fn cargo_lock_has_a_single_windows_core_version() {
    let lock = read("Cargo.lock");
    let versions: Vec<&str> = lock
        .lines()
        .collect::<Vec<_>>()
        .windows(2)
        .filter(|w| w[0].trim() == "name = \"windows-core\"")
        .filter_map(|w| w[1].trim().strip_prefix("version = \""))
        .map(|v| v.trim_end_matches('"'))
        .collect();
    assert!(
        versions.len() <= 1,
        "Cargo.lock 里有多个 windows-core 版本：{versions:?} —— \
         不同 windows-* 子 crate 用了不同版本的 windows-core，\
         会出现「某个子 crate 的 API 在另一个版本里不存在」的编译错"
    );
}

/// 路径守卫测试的一个前提：前缀陷阱那条用例必须用**只含 base 的 roots**。
///
/// 2026-10-21 修的测试前提错：旧用例用 `build_allowed_roots(&[base])`，
/// 而该函数**无条件**把 `std::env::temp_dir()` 也放进白名单 ⇒ base 与它的
/// `-evil` 兄弟目录都在 temp_dir 下 ⇒ 放行**符合设计** ⇒ 那条断言在任何 unix
/// 机器上都必然失败，从来没测到前缀陷阱。
///
/// 这里从**外部**钉住那个前提：仓库里不该再有把前缀陷阱断言挂在
/// `build_allowed_roots` 结果上的写法。
#[test]
fn prefix_trap_assertion_does_not_use_build_allowed_roots() {
    let text = read("src/security.rs");
    let v = prefix_trap_violations(&text);
    assert!(
        v.is_empty(),
        "前缀陷阱那条测试的前提被改坏了：\n{}",
        v.join("\n")
    );
}

/// 路径守卫：不要用 `..` 相对路径拼仓库内的文件（shell 工具与 CI 都会出问题）。
#[test]
fn manifest_dir_is_used_instead_of_relative_parent_paths() {
    let p: &Path = &crate_root();
    assert!(
        p.ends_with("src-tauri"),
        "CARGO_MANIFEST_DIR 应指向 src-tauri/，实际是 {}",
        p.display()
    );
}
