// Windows 下默认以 GUI 子系统启动：双击 exe 不再弹出附带的控制台窗口。
// 需要看 stdout/stderr（排查启动、网络、模型加载问题）时，用 `--features console`
// 构建：`tools\Build-Windows-Test.ps1 -Console`。release 构建始终不带控制台。
#![cfg_attr(all(windows, not(feature = "console")), windows_subsystem = "windows")]

fn main() {
    zoompaper_lib::run()
}
