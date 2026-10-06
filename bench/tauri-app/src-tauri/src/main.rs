// The bench page (bench/app/index.html) in one background state, for bench/smoke-background.ts.
// BG_MODE: normal | occluded | minimized | hidden. BG_VARIANT=throttle sets the background-throttling policy to Disabled.
use std::{thread, time::Duration};
use tauri::{utils::config::BackgroundThrottlingPolicy, WebviewUrl, WebviewWindowBuilder};

fn main() {
    let mode = std::env::var("BG_MODE").unwrap_or_else(|_| "normal".into());
    let variant = std::env::var("BG_VARIANT").unwrap_or_else(|_| "none".into());
    tauri::Builder::default()
        .setup(move |app| {
            let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("bench-main")
                .position(100.0, 100.0)
                .inner_size(900.0, 700.0);
            if variant == "throttle" {
                builder = builder.background_throttling(BackgroundThrottlingPolicy::Disabled);
            }
            let win = builder.build()?;
            if mode == "occluded" {
                WebviewWindowBuilder::new(app, "cover", WebviewUrl::External("about:blank".parse()?))
                    .position(0.0, 0.0)
                    .inner_size(1200.0, 950.0)
                    .always_on_top(true)
                    .build()?;
            }
            thread::spawn(move || {
                thread::sleep(Duration::from_secs(3));
                if mode == "minimized" { let _ = win.minimize(); }
                if mode == "hidden" { let _ = win.hide(); }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("run");
}
