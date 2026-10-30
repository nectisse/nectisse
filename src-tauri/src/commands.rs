use crate::{
    backend::Backend,
    images,
    store::{self, json_rows},
    subscriptions,
    util::*,
};
use serde_json::{json, Value};
use tauri::{State, WebviewWindow};
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub async fn desktop(
    window: WebviewWindow,
    backend: State<'_, Backend>,
    channel: String,
    args: Vec<Value>,
) -> Result<Value> {
    if window.label() != "main"
        || args.len() > 3
        || serde_json::to_vec(&args)
            .map_err(|_| "输入格式不正确")?
            .len()
            > 128 * 1024
    {
        return Err("应用通信输入不正确".into());
    }
    let backend = backend.inner().clone();
    tauri::async_runtime::spawn_blocking(move || backend.dispatch(&channel, &args))
        .await
        .map_err(|_| "本机服务暂不可用")?
}

impl Backend {
    pub fn open_url(&self, value: &str) -> Result<()> {
        let url = url::Url::parse(value).map_err(|_| "外链地址不正确")?;
        if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
            return Err("只允许打开 HTTPS 来源页面".into());
        }
        let app = self
            .0
            .app
            .lock()
            .map_err(|_| "应用不可用")?
            .clone()
            .ok_or("应用不可用")?;
        app.opener()
            .open_url(url.as_str(), None::<&str>)
            .map_err(|_| "原文暂时无法打开".into())
    }

    pub fn open_follow_source(&self, input: &Value) -> Result<()> {
        let store = self.0.store.lock().map_err(|_| "存储不可用")?;
        let id = text(input, "id");
        let url = match text(input, "kind") {
            "source" => text(&store::source(id)?, "root").to_string(),
            "subscription" => {
                let sub = store.subscription(id)?.ok_or("订阅已不存在")?;
                let canonical = subscriptions::canonical(
                    text(&sub, "provider"),
                    text(&sub, "ref"),
                    text(&sub, "handle"),
                )?;
                if canonical != text(&sub, "url") {
                    return Err("来源身份不正确".into());
                }
                canonical
            }
            "entry" => {
                let entry = store.entry(id)?.ok_or("帖子已不存在")?;
                let sub = store
                    .subscription(text(&entry, "subscriptionId"))?
                    .ok_or("订阅已不存在")?;
                if !subscriptions::valid_entry(text(&sub, "provider"), text(&sub, "ref"), &entry) {
                    return Err("帖子来源身份不正确".into());
                }
                text(&entry, "url").to_string()
            }
            _ => return Err("来源类型不正确".into()),
        };
        drop(store);
        self.open_url(&url)
    }

    pub fn diagnostics(&self) -> Value {
        let runtime = self.0.runtime.lock().unwrap().clone();
        json!({"generatedAt":now(),"environment":{"appVersion":env!("CARGO_PKG_VERSION"),"system":std::env::consts::OS,"architecture":std::env::consts::ARCH,"tauriVersion":"2.12.5","pythonVersion":text(&runtime["health"],"pythonVersion"),"runtimePhase":runtime["phase"]},"entries":self.0.diagnostics.lock().unwrap().clone(),"logStatus":if self.0.diagnostics_readable.load(std::sync::atomic::Ordering::SeqCst){"ready"}else{"unreadable"},"ignoredLines":self.0.diagnostics_ignored.load(std::sync::atomic::Ordering::SeqCst)})
    }

    pub fn dispatch(&self, channel: &str, args: &[Value]) -> Result<Value> {
        let input = args.first().cloned().unwrap_or(Value::Null);
        let string = |key: &str| -> Result<String> {
            input
                .get(key)
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or("输入格式不正确".into())
        };
        match channel {
            "nectisse:runtime-get" => {
                Ok(self.0.runtime.lock().map_err(|_| "运行状态不可用")?.clone())
            }
            "nectisse:runtime-retry" => Ok(self.start_runtime()),
            "nectisse:subscriptions-get" | "nectisse:subscriptions-retry" => self
                .0
                .store
                .lock()
                .map_err(|_| "SUBSCRIPTIONS_STORAGE_READ")?
                .subscriptions_state(self.0.vault.available()),
            "nectisse:subscription-entries" => self
                .0
                .store
                .lock()
                .map_err(|_| "SUBSCRIPTIONS_STORAGE_READ")?
                .entry_page(&input),
            "nectisse:subscription-entry" => {
                self.entry_details(input.as_str().ok_or("帖子身份不正确")?)
            }
            "nectisse:subscription-image-save" => Ok(self
                .save_entry_image(&input)
                .unwrap_or_else(|error| reply(&error))),
            "nectisse:subscriptions-command" => Ok(self
                .follow_command(&input)
                .unwrap_or_else(|error| reply(&error))),
            "nectisse:subscription-avatar-upload" => {
                self.pick_avatar(input.as_str().ok_or("人物身份不正确")?)
            }
            "nectisse:metadata-get" | "nectisse:metadata-retry" => Ok(self
                .0
                .store
                .lock()
                .map_err(|_| "资料查询不可用")?
                .metadata_state()),
            "nectisse:metadata-query" => {
                Ok(self.query(&input).unwrap_or_else(|error| reply(&error)))
            }
            "nectisse:metadata-cancel" => {
                self.cancel(input.as_str().ok_or("任务身份不正确")?)?;
                Ok(Value::Null)
            }
            "nectisse:metadata-clear-history" => {
                let mut store = self.0.store.lock().map_err(|_| "存储不可用")?;
                if store.metadata.get("activeId").is_some() {
                    return Ok(reply("请先取消或等待正在进行的查询"));
                }
                let owners=json_rows(&store.images,"SELECT json_object('owner',owner) FROM pins WHERE owner LIKE 'query:%' GROUP BY owner",[])?;
                for owner in owners {
                    images::unpin(&store, text(&owner, "owner"))?;
                }
                store.metadata["tasks"] = json!([]);
                store.metadata["assets"] = json!({});
                store.commit_metadata()?;
                drop(store);
                self.publish_metadata();
                Ok(json!({"ok":true}))
            }
            "nectisse:metadata-open-source" => {
                self.open_source("query", &string("taskId")?, &string("recordId")?)?;
                Ok(Value::Null)
            }
            "nectisse:library-get" | "nectisse:library-retry" => self
                .0
                .store
                .lock()
                .map_err(|_| "收藏库不可用")?
                .library_state(),
            "nectisse:library-work" => {
                let id = input.as_str().ok_or("收藏身份不正确")?;
                if !is_hash(id, 64) {
                    return Err("收藏身份不正确".into());
                }
                Ok(self
                    .0
                    .store
                    .lock()
                    .map_err(|_| "收藏库不可用")?
                    .work(id)?
                    .unwrap_or(Value::Null))
            }
            "nectisse:library-save" => {
                Ok(self.save_work(&input).unwrap_or_else(|error| reply(&error)))
            }
            "nectisse:library-remove" => Ok(self
                .remove_work(input.as_str().ok_or("收藏身份不正确")?)
                .unwrap_or_else(|error| reply(&error))),
            "nectisse:library-open-source" => {
                self.open_source("library", &string("id")?, &string("recordId")?)?;
                Ok(Value::Null)
            }
            "nectisse:magnet-search" => self.magnet_search(&input),
            "nectisse:magnet-cancel" => {
                self.cancel(input.as_str().ok_or("任务身份不正确")?)?;
                Ok(Value::Null)
            }
            "nectisse:magnet-action" => {
                let row = self.magnet_row(&input)?;
                match text(&input, "action") {
                    "copy" => arboard::Clipboard::new()
                        .and_then(|mut clipboard| clipboard.set_text(text(&row, "magnet")))
                        .map_err(|_| "磁链未能复制")?,
                    "open" => self.open_url(text(&row, "url"))?,
                    _ => return Err("磁链操作不正确".into()),
                }
                Ok(json!(true))
            }
            "nectisse:magnet-open-site" => {
                if input != "heimacili" {
                    return Err("磁链站点不正确".into());
                }
                self.open_url("https://heimacili.org/")?;
                Ok(json!(true))
            }
            "nectisse:storage-usage" => {
                images::usage(&*self.0.store.lock().map_err(|_| "存储不可用")?)
            }
            "nectisse:storage-clear" => {
                let covers = self.0.store.lock().map_err(|_| "存储不可用")?.tasks()?;
                for task in covers.iter().filter(|task| {
                    text(task, "kind") == "covers"
                        && ["running", "cancelling"].contains(&text(task, "status"))
                }) {
                    self.cancel(text(task, "id"))?;
                }
                let jobs = self
                    .0
                    .jobs
                    .lock()
                    .map_err(|_| "任务状态不可用")?
                    .values()
                    .filter_map(std::sync::Weak::upgrade)
                    .filter(|job| job.id.starts_with("image:") || job.id.starts_with("backfill:"))
                    .collect::<Vec<_>>();
                for job in jobs {
                    self.cancel(&job.id)?;
                }
                let store = self.0.store.lock().map_err(|_| "存储不可用")?;
                self.0
                    .image_generation
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let result = images::prune(&store, 0)?;
                for mut entry in store.entries()? {
                    if entry["imageAsset"].is_object()
                        && images::read_hash(&store, text(&entry["imageAsset"], "sha256"))?
                            .is_none()
                    {
                        entry.as_object_mut().unwrap().remove("imageAsset");
                        entry["imageCache"] = json!({"status":"evicted","attempts":0,"nextAttemptAt":0,"reason":"cache_limit"});
                        store.save_entry(&entry)?;
                    }
                }
                drop(store);
                self.publish_subscriptions();
                Ok(result)
            }
            "nectisse:diagnostics-get" => Ok(self.diagnostics()),
            "nectisse:diagnostics-copy" => {
                let report = self.diagnostics();
                let environment = &report["environment"];
                let text = format!(
                    "Nectisse 诊断信息\n应用版本：{}\nTauri：2.12.5\nPython：{}\n运行阶段：{}\n{}",
                    env!("CARGO_PKG_VERSION"),
                    text(environment, "pythonVersion"),
                    text(environment, "runtimePhase"),
                    array(&report, "entries")
                        .iter()
                        .map(|entry| format!("{} {}", text(entry, "at"), text(entry, "code")))
                        .collect::<Vec<_>>()
                        .join("\n")
                );
                if arboard::Clipboard::new()
                    .and_then(|mut clipboard| clipboard.set_text(text))
                    .is_ok()
                {
                    Ok(json!({"copied":true,"report":report}))
                } else {
                    Ok(json!({"copied":false}))
                }
            }
            "nectisse:diagnostics-record-read" => {
                let code = input.as_str().ok_or("诊断代码不正确")?;
                if ![
                    "SUBSCRIPTIONS_UNAVAILABLE",
                    "SUBSCRIPTIONS_STORAGE_READ",
                    "SUBSCRIPTIONS_INVALID_DATA",
                    "SUBSCRIPTIONS_READ_TIMEOUT",
                ]
                .contains(&code)
                {
                    return Err("诊断代码不正确".into());
                }
                self.record_context(code, args.get(1));
                Ok(Value::Null)
            }
            _ => Err("应用通信方法尚未支持".into()),
        }
    }

    pub fn save_entry_image(&self, input: &Value) -> Result<Value> {
        use tauri_plugin_dialog::DialogExt;
        crate::contracts::validate("imageSave", input)?;
        let (picture, name) =
            self.entry_image_export(text(input, "id"), number(input, "index") as usize)?;
        #[cfg(feature = "native-smoke")]
        if let Some(path) = crate::smoke::image_save_path(&name) {
            images::save_picture(&path, &picture)?;
            return Ok(json!({"ok":true}));
        }
        let app = self
            .0
            .app
            .lock()
            .map_err(|_| "应用不可用")?
            .clone()
            .ok_or("应用不可用")?;
        let extension = name.rsplit('.').next().ok_or("图片格式不正确")?;
        let Some(file) = app
            .dialog()
            .file()
            .set_title("保存图片")
            .set_file_name(&name)
            .add_filter("图片", &[extension])
            .blocking_save_file()
        else {
            return Ok(json!({"ok":false,"cancelled":true}));
        };
        let path = file.into_path().map_err(|_| "请选择本机保存位置")?;
        images::save_picture(&path, &picture)?;
        Ok(json!({"ok":true}))
    }

    pub fn pick_avatar(&self, id: &str) -> Result<Value> {
        use tauri_plugin_dialog::DialogExt;
        uuid(id)?;
        if self
            .0
            .store
            .lock()
            .map_err(|_| "存储不可用")?
            .subscription(id)?
            .is_none()
        {
            return Err("该订阅不存在".into());
        }
        let app = self
            .0
            .app
            .lock()
            .map_err(|_| "应用不可用")?
            .clone()
            .ok_or("应用不可用")?;
        let Some(file) = app
            .dialog()
            .file()
            .add_filter("图片", &["png", "jpg", "jpeg", "webp"])
            .blocking_pick_file()
        else {
            return Ok(json!({"ok":false,"cancelled":true}));
        };
        let path = file.into_path().map_err(|_| "只能使用本机图片")?;
        let info = std::fs::metadata(&path).map_err(|_| "所选图片暂不可读")?;
        if !info.is_file() || info.len() > 20 * 1024 * 1024 {
            return Ok(reply("请选择不超过20 MiB的图片"));
        }
        let bytes = std::fs::read(path).map_err(|_| "所选图片暂不可读")?;
        let bytes = images::normalize_avatar(&bytes)?;
        let store = self.0.store.lock().map_err(|_| "存储不可用")?;
        let owner = format!("manual-avatar:{id}:{}", hash(&bytes));
        let saved = images::put(&store, &owner, &bytes, false, Some(&owner))?;
        let mut sub = store.subscription(id)?.ok_or("该订阅不存在")?;
        sub["manualAvatarAsset"] = saved["original"].clone();
        store.save_subscription(&sub)?;
        let owners = json_rows(
            &store.images,
            "SELECT json_object('owner',owner) FROM pins WHERE owner LIKE ? GROUP BY owner",
            [format!("manual-avatar:{id}:%")],
        )?;
        for old in owners {
            if text(&old, "owner") != owner {
                images::unpin(&store, text(&old, "owner"))?;
            }
        }
        drop(store);
        self.publish_subscriptions();
        Ok(json!({"ok":true}))
    }
}
