mod backend;
mod commands;
mod contracts;
mod images;
mod library;
mod magnets;
mod platform;
mod queries;
mod store;
mod subscriptions;
mod util;
mod worker;

#[cfg(feature = "native-smoke")]
mod smoke;

#[cfg(test)]
mod tests;

use backend::Backend;
use fs2::FileExt;
use std::{
    fs::{File, OpenOptions},
    sync::atomic::Ordering,
};
use tauri::{Manager, RunEvent, WindowEvent};

struct DataLock(#[allow(dead_code)] File);

fn install_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem as Item, Submenu};
    let settings = MenuItem::with_id(app, "settings", "设置…", true, Some("CmdOrCtrl+,"))?;
    let about = Item::about(
        app,
        Some("关于 Nectisse"),
        Some(AboutMetadata {
            name: Some("Nectisse".into()),
            version: Some(env!("CARGO_PKG_VERSION").into()),
            ..Default::default()
        }),
    )?;
    let app_menu = Submenu::with_items(
        app,
        "Nectisse",
        true,
        &[
            &about,
            &settings,
            &Item::separator(app)?,
            &Item::hide(app, Some("隐藏 Nectisse"))?,
            &Item::hide_others(app, Some("隐藏其他"))?,
            &Item::show_all(app, Some("显示全部"))?,
            &Item::separator(app)?,
            &Item::quit(app, Some("退出 Nectisse"))?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "编辑",
        true,
        &[
            &Item::undo(app, None)?,
            &Item::redo(app, None)?,
            &Item::separator(app)?,
            &Item::cut(app, None)?,
            &Item::copy(app, None)?,
            &Item::paste(app, None)?,
            &Item::select_all(app, None)?,
        ],
    )?;
    let windows = Submenu::with_items(
        app,
        "窗口",
        true,
        &[&Item::minimize(app, None)?, &Item::maximize(app, None)?],
    )?;
    app.set_menu(Menu::with_items(app, &[&app_menu, &edit, &windows])?)?;
    Ok(())
}

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            // Electron does not share Tauri's instance lock, but uses the same data directory.
            if std::env::var_os("NECTISSE_DATA_DIR").is_none() && std::process::Command::new("/usr/bin/pgrep").args(["-x","Nectisse"]).output().is_ok_and(|output|output.status.success()) {
                use tauri_plugin_dialog::DialogExt;
                app.dialog().message("请先退出仍在运行的 Electron 版 Nectisse，再打开 Tauri 版。两者使用同一份本机数据。").title("Nectisse 数据目录正在使用").blocking_show();
                return Err(std::io::Error::other("请先退出 Electron 版 Nectisse").into());
            }
            let root = std::env::var_os("NECTISSE_DATA_DIR")
                .map(std::path::PathBuf::from)
                .unwrap_or(app.path().data_dir()?.join("Nectisse"));
            util::directory(&root).map_err(std::io::Error::other)?;
            let lock = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(root.join(".tauri-data.lock"))?;
            lock.try_lock_exclusive()
                .map_err(|_| std::io::Error::other("Nectisse 数据目录正在使用"))?;
            app.manage(DataLock(lock));
            let resources = app.path().resource_dir()?;
            let packaged = resources.join("python/manifest.json").is_file() || (!cfg!(debug_assertions) && !cfg!(feature="native-smoke"));
            let backend =
                Backend::open(root, resources, packaged).map_err(std::io::Error::other)?;
            *backend.0.app.lock().unwrap() = Some(app.handle().clone());
            app.manage(backend.clone());
            install_menu(app.handle())?;
            tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                .on_navigation(|url| {
                    url.scheme() == "tauri"
                        || url.host_str() == Some("tauri.localhost")
                        || (cfg!(debug_assertions)
                            && url.host_str() == Some("127.0.0.1")
                            && url.port() == Some(1420))
                })
                .on_page_load(|webview, payload| {
                    #[cfg(feature = "native-smoke")]
                    if payload.event() == tauri::webview::PageLoadEvent::Finished {
                        smoke::start(webview.app_handle());
                    }
                    #[cfg(not(feature = "native-smoke"))]
                    let _ = (webview, payload);
                })
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .build()?;
            std::thread::spawn(move || {
                backend.start_runtime();
                backend.background();
            });
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol(
            "nectisse-cover",
            |context, request, responder| {
                let backend = context.app_handle().state::<Backend>().inner().clone();
                std::thread::spawn(move || {
                    let response = (|| {
                        if request.method() != tauri::http::Method::GET {
                            return None;
                        }
                        let url = url::Url::parse(&request.uri().to_string()).ok()?;
                        let scope = url.host_str()?;
                        let id = url.path().strip_prefix('/')?;
                        let mut index = None;
                        for (key, value) in url.query_pairs() {
                            if key == "index" {
                                if index.is_some() {
                                    return None;
                                }
                                index = Some(value.parse::<usize>().ok()?);
                            }
                        }
                        let variant = if url
                            .query_pairs()
                            .any(|(key, value)| key == "variant" && value == "thumbnail")
                        {
                            "thumbnail"
                        } else {
                            "original"
                        };
                        backend.image_at(scope, id, variant, index).ok().flatten()
                    })();
                    let response = match response {
                        Some(image) => tauri::http::Response::builder()
                            .header(
                                "Content-Type",
                                match util::text(&image.asset, "format") {
                                    "PNG" => "image/png",
                                    "WEBP" => "image/webp",
                                    _ => "image/jpeg",
                                },
                            )
                            .header("X-Content-Type-Options", "nosniff")
                            .header("Cache-Control", "no-store")
                            .body(image.bytes),
                        None => tauri::http::Response::builder()
                            .status(404)
                            .body(Vec::new()),
                    };
                    if let Ok(response) = response {
                        responder.respond(response);
                    }
                });
            },
        )
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "settings" {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                app.state::<Backend>()
                    .emit("nectisse:settings-open", serde_json::Value::Null);
            }
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        });
    #[cfg(feature = "native-smoke")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::desktop,
        smoke::smoke_seed,
        smoke::smoke_report,
        smoke::smoke_image_saved,
        smoke::smoke_snapshot
    ]);
    #[cfg(not(feature = "native-smoke"))]
    let builder = builder.invoke_handler(tauri::generate_handler![commands::desktop]);
    let application = builder
        .build(tauri::generate_context!())
        .expect("Nectisse 无法准备本机服务；原有数据已保留");
    application.run(|app, event| match event {
        RunEvent::ExitRequested { api, .. } => {
            let backend = app.state::<Backend>().inner().clone();
            if !backend.0.stopped.swap(true, Ordering::SeqCst) {
                api.prevent_exit();
                let app = app.clone();
                std::thread::spawn(move || {
                    backend.shutdown();
                    app.exit(0);
                });
            }
        }
        RunEvent::Reopen { .. } => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        _ => {}
    });
}
