//! Compiled only for isolated native verification; absent from distributed builds.
use crate::{backend::Backend, images, util::*};
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};

#[tauri::command]
pub fn smoke_seed(backend: State<'_, Backend>) -> Result<Value> {
    if std::env::var_os("NECTISSE_SMOKE_OUTPUT").is_none()
        || std::env::var_os("NECTISSE_DATA_DIR").is_none()
    {
        return Err("Harness is not enabled".into());
    }
    let mut store = backend.0.store.lock().map_err(|_| "Storage unavailable")?;
    let mut preferences = store.preferences()?;
    preferences["automatic"] = json!(false);
    store.save_preferences(&preferences)?;
    let creator = store.follow(&json!({"provider":"fanbox","ref":"fixtureuser","name":"创作手记","url":"https://fixtureuser.fanbox.cc/","aliases":[],"recordType":"创作者","bio":"本地隔离测试样本。","evidence":"fixture"}))?;
    let actor = store.follow(&json!({"provider":"javdb","ref":"A123","name":"演员样本","url":"https://javdb.com/actors/A123","aliases":[],"recordType":"演员","bio":"","evidence":"fixture"}))?;
    let x_creator = store.follow(&json!({"provider":"x","ref":"1722511982610538496","handle":"gallery_fixture","name":"海岸日记","url":"https://x.com/gallery_fixture","aliases":[],"recordType":"创作者","bio":"本地多图阅读样本。","evidence":"fixture"}))?;
    let image = include_bytes!("../../src/renderer/demo/assets/editorial-sheet.png");
    let picture = images::put(
        &store,
        "https://pics.dmm.co.jp/mono/movie/adult/sone00614/sone00614pl.jpg",
        image,
        false,
        Some("avatar:fixture"),
    )?;
    for mut sub in [creator.clone(), actor.clone(), x_creator.clone()] {
        sub["avatarAsset"] = picture["original"].clone();
        sub["initialized"] = json!(true);
        sub["autoPaused"] = json!(true);
        store.save_subscription(&sub)?;
    }
    for index in 1..66 {
        store.upsert_entry(&creator,&json!({"externalId":index.to_string(),"title":format!("创作手记 {index}"),"summary":"短动态。\n".repeat(index % 7+1),"author":"创作手记","publishedAt":"2026-10-29T02:00:00Z","publishedPrecision":"exact","url":format!("https://fixtureuser.fanbox.cc/posts/{index}"),"thumbnailUrl":"","code":"","restricted":false,"partial":false}))?;
    }
    store.upsert_entry(&actor,&json!({"externalId":"/v/Ab123","title":"SONE-614 本地作品样本","summary":"","author":"演员样本","publishedAt":"2026-10-29","publishedPrecision":"date","url":"https://javdb.com/v/Ab123","thumbnailUrl":"","code":"SONE-614","restricted":false,"partial":false}))?;
    let first_url = "https://pbs.twimg.com/media/gallery-first.jpg";
    let second_url = "https://pbs.twimg.com/media/gallery-second.jpg";
    let first_photo = images::put(
        &store,
        first_url,
        include_bytes!("../../src/renderer/demo/assets/portrait-1.jpg"),
        false,
        Some("avatar:gallery-first"),
    )?;
    let mut gallery_profile = store
        .subscription(text(&x_creator, "id"))?
        .ok_or("Missing gallery profile")?;
    gallery_profile["avatarAsset"] = first_photo["original"].clone();
    store.save_subscription(&gallery_profile)?;
    images::put(
        &store,
        second_url,
        include_bytes!("../../src/renderer/demo/assets/portrait-2.jpg"),
        false,
        Some("avatar:gallery-second"),
    )?;
    store.upsert_entry(&x_creator,&json!({"externalId":"1900000000000000000","title":"图库样本标题","summary":"沿着海岸，收集两个安静的瞬间。\n照片记录日常，也记录光停留的样子。","author":"海岸日记","authorRef":x_creator["ref"],"authorHandle":"gallery_fixture","postKind":"original","publishedAt":"2026-10-29T02:00:00Z","publishedPrecision":"exact","url":"https://x.com/gallery_fixture/status/1900000000000000000","thumbnailUrl":first_url,"images":[{"url":first_url},{"url":second_url}],"code":"","restricted":false,"partial":false}))?;
    let gallery_id = hash(format!("{}:1900000000000000000", text(&x_creator, "id")));
    if let Some(mut post) = store.entry(&gallery_id)? {
        post["imageAsset"] = first_photo["thumbnail"].clone();
        store.save_entry(&post)?;
    }
    let record = json!({"id":hash("fixture-record"),"source":"dmm","parser":"fixture","parserVersion":"1","code":"SONE-614","contentId":"sone00614","sourceUrl":"https://video.dmm.co.jp/av/content/?id=sone00614","fetchedAt":now(),"title":"本地收藏样本","titleLanguage":"ja","people":[],"studio":"样本","label":"","series":"","seller":"","sellerUrl":"","releaseDate":"2026-10-29","description":"本地隔离测试","tags":[],"covers":[{"id":hash("fixture-cover"),"source":"dmm","url":"https://pics.dmm.co.jp/mono/movie/adult/sone00614/sone00614pl.jpg","identity":"source-matched","asset":picture["original"]}],"warnings":[]});
    images::pin(
        &store,
        "query:fixture",
        "https://pics.dmm.co.jp/mono/movie/adult/sone00614/sone00614pl.jpg",
    )?;
    let query = uuid::Uuid::new_v4().to_string();
    store.metadata["tasks"] = json!([{"id":query,"status":"succeeded","phase":"本地样本","plan":{"kind":"code","query":"SONE-614","code":"SONE-614","contentId":"","sources":["dmm"]},"coverPriority":["dmm"],"startedAt":now(),"finishedAt":now(),"records":[record],"outcomes":[],"requests":0}]);
    store.commit_metadata()?;
    drop(store);
    backend.publish_metadata();
    backend.publish_subscriptions();
    Ok(
        json!({"creator":creator["id"],"actor":actor["id"],"xCreator":x_creator["id"],"query":query,"avatar":picture["original"]["sha256"]}),
    )
}

pub fn start(app: &AppHandle) {
    if std::env::var_os("NECTISSE_SMOKE_OUTPUT").is_some() {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.eval(include_str!("../../scripts/native-smoke.js"));
        }
    }
}

#[tauri::command]
pub fn smoke_report(app: AppHandle, report: Value) -> Result<()> {
    let output =
        PathBuf::from(std::env::var_os("NECTISSE_SMOKE_OUTPUT").ok_or("Harness is not enabled")?);
    atomic_write(
        &output.join("report.json"),
        &serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?,
    )?;
    app.exit(if report["success"] == true { 0 } else { 1 });
    Ok(())
}

#[tauri::command]
pub async fn smoke_snapshot(window: tauri::WebviewWindow, name: String) -> Result<()> {
    if ![
        "actors",
        "creators",
        "profile",
        "settings",
        "library",
        "demo",
        "post",
        "post-cream",
        "image-viewer",
    ]
    .contains(&name.as_str())
    {
        return Err("Unknown snapshot".into());
    }
    let output =
        PathBuf::from(std::env::var_os("NECTISSE_SMOKE_OUTPUT").ok_or("Harness is not enabled")?)
            .join(format!("{name}.png"));
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    window
        .with_webview(move |webview| unsafe {
            use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
            use objc2_foundation::{NSDictionary, NSError, NSString};
            use objc2_web_kit::WKWebView;
            let view = &*webview.inner().cast::<WKWebView>();
            let completion =
                block2::RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                    let result = (|| -> Result<()> {
                        if !error.is_null() || image.is_null() {
                            return Err("WebKit snapshot failed".into());
                        }
                        let tiff = (&*image).TIFFRepresentation().ok_or("Missing TIFF")?;
                        let bitmap =
                            NSBitmapImageRep::imageRepWithData(&tiff).ok_or("Missing bitmap")?;
                        let png = bitmap
                            .representationUsingType_properties(
                                NSBitmapImageFileType::PNG,
                                &NSDictionary::new(),
                            )
                            .ok_or("Missing PNG")?;
                        if !png.writeToFile_atomically(
                            &NSString::from_str(output.to_str().ok_or("Invalid path")?),
                            true,
                        ) {
                            return Err("Snapshot write failed".into());
                        }
                        Ok(())
                    })();
                    let _ = sender.send(result);
                });
            view.takeSnapshotWithConfiguration_completionHandler(None, &completion);
        })
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(std::time::Duration::from_secs(15))
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())??
}
