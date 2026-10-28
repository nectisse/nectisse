use crate::{
    platform::{self, Vault},
    store::{self, Store},
    util::*,
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex, Weak,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter};

pub struct Job {
    pub id: String,
    pub cancelled: AtomicBool,
    pub pids: Mutex<Vec<i32>>,
    pub requests: AtomicUsize,
    pub limit: usize,
}

impl Job {
    pub fn new(id: String, limit: usize) -> Arc<Self> {
        Arc::new(Self {
            id,
            cancelled: AtomicBool::new(false),
            pids: Mutex::new(Vec::new()),
            requests: AtomicUsize::new(0),
            limit,
        })
    }

    pub fn running(&self) -> Result<()> {
        if self.cancelled.load(Ordering::SeqCst) {
            Err("TASK_CANCELLED".into())
        } else {
            Ok(())
        }
    }
}

pub struct Inner {
    pub root: PathBuf,
    pub root_project: PathBuf,
    pub python: PathBuf,
    #[cfg(test)]
    pub worker_fixture: Mutex<Option<PathBuf>>,
    pub packaged: bool,
    pub store: Mutex<Store>,
    pub app: Mutex<Option<AppHandle>>,
    pub runtime: Mutex<Value>,
    pub jobs: Mutex<HashMap<String, Weak<Job>>>,
    pub pending_cancels: Mutex<HashMap<String, std::time::Instant>>,
    pub gates: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    pub image_io: Mutex<()>,
    pub image_refreshes: Mutex<HashMap<String, i64>>,
    pub stopped: AtomicBool,
    pub image_generation: AtomicU64,
    pub vault: Vault,
    pub diagnostics: Mutex<Vec<Value>>,
    pub diagnostics_readable: AtomicBool,
    pub diagnostics_ignored: AtomicUsize,
}

#[derive(Clone)]
pub struct Backend(pub Arc<Inner>);

impl Backend {
    pub fn open(root: PathBuf, resources: PathBuf, packaged: bool) -> Result<Self> {
        let project = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        let python = if packaged {
            resources.join("python")
        } else {
            project.join(format!(
                ".build/python/{}-{}",
                if cfg!(target_os = "macos") {
                    "darwin"
                } else {
                    std::env::consts::OS
                },
                if cfg!(target_arch = "aarch64") {
                    "arm64"
                } else {
                    std::env::consts::ARCH
                }
            ))
        };
        let store = Store::open(root.clone())?;
        crate::images::prepare(&store)?;
        let log = root.join("diagnostics/subscription-read.jsonl");
        let mut entries = Vec::new();
        let mut ignored = 0;
        let mut readable = true;
        match std::fs::metadata(&log) {
            Ok(info) if info.len() <= 128 * 1024 => match std::fs::read_to_string(&log) {
                Ok(lines) => {
                    for line in lines.lines().filter(|line| !line.trim().is_empty()) {
                        let entry = serde_json::from_str::<Value>(line).ok().filter(|entry| {
                            crate::contracts::validate("diagnostic", entry).is_ok()
                        });
                        if let Some(entry) = entry {
                            let mut clean = json!({"at":entry["at"],"code":entry["code"]});
                            if let Some(context) = entry.get("context") {
                                clean["context"] = sanitize_context(context);
                            }
                            entries.push(clean);
                        } else {
                            ignored += 1;
                        }
                    }
                }
                Err(_) => readable = false,
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            _ => readable = false,
        }
        entries.drain(..entries.len().saturating_sub(32));
        Ok(Self(Arc::new(Inner {
            root,
            root_project: project,
            python,
            #[cfg(test)]
            worker_fixture: Mutex::new(None),
            packaged,
            store: Mutex::new(store),
            app: Mutex::new(None),
            runtime: Mutex::new(
                json!({"phase":"starting","revision":0,"message":"正在准备采集环境"}),
            ),
            jobs: Mutex::new(HashMap::new()),
            pending_cancels: Mutex::new(HashMap::new()),
            gates: Mutex::new(HashMap::new()),
            image_io: Mutex::new(()),
            image_refreshes: Mutex::new(HashMap::new()),
            stopped: AtomicBool::new(false),
            image_generation: AtomicU64::new(0),
            vault: Vault::new(),
            diagnostics: Mutex::new(entries),
            diagnostics_readable: AtomicBool::new(readable),
            diagnostics_ignored: AtomicUsize::new(ignored),
        })))
    }

    pub fn emit(&self, channel: &str, payload: Value) {
        if let Some(app) = self.0.app.lock().ok().and_then(|app| app.clone()) {
            let _ = app.emit_to("main", channel, payload);
        }
    }

    pub fn publish_subscriptions(&self) {
        let snapshot = self
            .0
            .store
            .lock()
            .map_err(|_| "存储不可用".to_string())
            .and_then(|mut store| store.subscriptions_state(self.0.vault.available()));
        if let Ok(value) = snapshot {
            self.emit("nectisse:subscriptions-state", value);
        }
    }

    pub fn publish_metadata(&self) {
        if let Ok(store) = self.0.store.lock() {
            let snapshot = store.metadata_state();
            drop(store);
            self.emit("nectisse:metadata-state", snapshot);
        }
    }

    pub fn publish_library(&self) {
        let snapshot = self
            .0
            .store
            .lock()
            .map_err(|_| "存储不可用".to_string())
            .and_then(|mut store| store.library_state());
        if let Ok(value) = snapshot {
            self.emit("nectisse:library-state", value);
        }
    }

    pub fn job(&self, id: &str, limit: usize) -> Result<Arc<Job>> {
        if self.0.stopped.load(Ordering::SeqCst) {
            return Err("应用正在退出".into());
        }
        let mut jobs = self.0.jobs.lock().map_err(|_| "任务状态不可用")?;
        jobs.retain(|_, job| job.strong_count() > 0);
        if jobs.contains_key(id) {
            return Err("任务身份已被使用".into());
        }
        let mut pending = self
            .0
            .pending_cancels
            .lock()
            .map_err(|_| "任务状态不可用")?;
        pending.retain(|_, at| at.elapsed() < Duration::from_secs(60));
        if pending
            .remove(id.strip_prefix("magnet:").unwrap_or(id))
            .is_some()
        {
            return Err("TASK_CANCELLED".into());
        }
        let job = Job::new(id.to_string(), limit);
        jobs.insert(id.to_string(), Arc::downgrade(&job));
        Ok(job)
    }

    pub fn finish_job(&self, id: &str) {
        if let Ok(mut jobs) = self.0.jobs.lock() {
            jobs.remove(id);
        }
    }

    pub fn active(&self, prefix: &str) -> bool {
        self.0
            .jobs
            .lock()
            .map(|jobs| {
                jobs.iter()
                    .any(|(id, job)| id.starts_with(prefix) && job.strong_count() > 0)
            })
            .unwrap_or(true)
    }

    pub fn credential(&self, source: &str) -> Result<String> {
        let bytes = self
            .0
            .store
            .lock()
            .map_err(|_| "存储不可用")?
            .db
            .query_row(
                "SELECT ciphertext FROM credentials WHERE provider=?",
                [source],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .optional()
            .map_err(|_| "凭据读取失败")?;
        bytes
            .map(|bytes| self.0.vault.decrypt(&bytes))
            .transpose()
            .map(|value| value.unwrap_or_default())
    }

    pub fn preferences(&self) -> Result<Value> {
        self.0.store.lock().map_err(|_| "存储不可用")?.preferences()
    }

    pub fn route(&self, source: &str, kind: &str) -> Result<String> {
        let spec = if source == "sukebei" {
            json!({"root":"https://sukebei.nyaa.si"})
        } else {
            store::source(source)?
        };
        let target = if kind == "follow" {
            spec.get("apiRoot")
                .and_then(Value::as_str)
                .unwrap_or(text(&spec, "root"))
        } else {
            text(&spec, "root")
        };
        platform::proxy(&self.preferences()?, target)
    }

    pub fn permit(&self, source: &str, job: &Arc<Job>) -> Result<()> {
        job.running()?;
        if job.requests.load(Ordering::SeqCst) >= job.limit {
            return Err("已达到本次请求预算".into());
        }
        let domain = if source == "sukebei" {
            "sukebei.nyaa.si".to_string()
        } else {
            let spec = store::source(source)?;
            let domains = if array(&spec, "requestDomains").is_empty() {
                array(&spec, "domains")
            } else {
                array(&spec, "requestDomains")
            };
            domains
                .first()
                .and_then(Value::as_str)
                .unwrap_or(source)
                .to_string()
        };
        let gate = self
            .0
            .gates
            .lock()
            .map_err(|_| "来源调度不可用")?
            .entry(domain.clone())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone();
        let _guard = gate.lock().map_err(|_| "来源调度不可用")?;
        let peers: Vec<String> = array(&store::catalog(), "sources")
            .iter()
            .filter(|spec| {
                let domains = if array(spec, "requestDomains").is_empty() {
                    array(spec, "domains")
                } else {
                    array(spec, "requestDomains")
                };
                domains.first().and_then(Value::as_str) == Some(domain.as_str())
            })
            .map(|spec| text(spec, "id").to_string())
            .chain((source == "sukebei").then(|| source.to_string()))
            .collect();
        loop {
            job.running()?;
            let store = self.0.store.lock().map_err(|_| "存储不可用")?;
            if source != "sukebei"
                && !array(&store.preferences()?, "enabledSources")
                    .iter()
                    .any(|id| id == source)
            {
                return Err("来源已关闭".into());
            }
            let mut wait = 0;
            for peer in &peers {
                let policy = store.policy(peer)?;
                if number(&policy, "cooldownUntil") > millis() {
                    return Err("来源仍在冷却中".into());
                }
                wait = wait.max(number(&policy, "nextRequestAt") - millis());
            }
            if wait <= 0 {
                for peer in &peers {
                    let mut policy = store.policy(peer)?;
                    policy["nextRequestAt"] =
                        json!(millis() + if source == "javdb" { 3000 } else { 2000 });
                    store.save_policy(peer, &policy)?;
                }
                break;
            }
            drop(store);
            std::thread::sleep(Duration::from_millis(wait.min(50) as u64));
        }
        job.requests.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    pub fn hold(&self, source: &str, outcome: &Value) -> Result<()> {
        let seconds = platform::cooldown(text(outcome, "reason"), number(outcome, "retryAfter"));
        let store = self.0.store.lock().map_err(|_| "存储不可用")?;
        let mut policy = store.policy(source)?;
        policy["checkedAt"] = json!(now());
        policy["message"] = json!(text(outcome, "message"));
        policy["state"] = json!(if text(outcome, "status") == "success" {
            "最近访问成功"
        } else {
            "需要处理"
        });
        policy["cooldownUntil"] =
            json!(number(&policy, "cooldownUntil").max(millis() + seconds * 1000));
        store.save_policy(source, &policy)?;
        drop(store);
        self.publish_subscriptions();
        Ok(())
    }

    pub fn start_runtime(&self) -> Value {
        let id = "runtime";
        let Ok(job) = self.job(id, 0) else {
            return self.0.runtime.lock().unwrap().clone();
        };
        let runtime: Result<Value> = (|| {
            let manifest = read_json(&self.0.python.join("manifest.json"), 65536, Value::Null)?;
            let target = format!(
                "{}-{}",
                if cfg!(target_os = "macos") {
                    "darwin"
                } else {
                    std::env::consts::OS
                },
                if cfg!(target_arch = "aarch64") {
                    "arm64"
                } else {
                    std::env::consts::ARCH
                }
            );
            if text(&manifest, "target") != target {
                return Err("RUNTIME_WRONG_ARCH".into());
            }
            let health = self.worker("health", json!({}), &job, |_| Ok(()))?;
            if text(&health, "architecture")
                != if cfg!(target_arch = "aarch64") {
                    "arm64"
                } else {
                    std::env::consts::ARCH
                }
            {
                return Err("RUNTIME_WRONG_ARCH".into());
            }
            if text(&health, "pythonVersion") != text(&manifest, "pythonVersion") {
                return Err("RUNTIME_WRONG_VERSION".into());
            }
            if !is_hash(text(&health, "transportSha256"), 64)
                || number(&health, "pid") <= 0
                || text(&health, "identityProbe") != "FC2-PPV-1234567"
            {
                return Err("RUNTIME_PROTOCOL_ERROR".into());
            }
            let transport = if self.0.packaged {
                self.0.python.join("app/vendor/peach_core/http.py")
            } else {
                self.0.root_project.join("python/vendor/peach_core/http.py")
            };
            if hash(std::fs::read(transport).map_err(|_| "RUNTIME_CHECK_FAILED")?)
                != text(&health, "transportSha256")
            {
                return Err("RUNTIME_PROTOCOL_ERROR".into());
            }
            Ok(health)
        })();
        let state = match runtime {
            Ok(health) => {
                json!({"phase":"ready","revision":millis(),"message":"采集环境已就绪","health":health})
            }
            Err(error) => {
                self.record(if error.starts_with("RUNTIME_") {
                    &error
                } else {
                    "RUNTIME_CHECK_FAILED"
                });
                json!({"phase":"error","revision":millis(),"message":"采集环境未准备完成，请重新检查","errorCode":if ["RUNTIME_WRONG_ARCH","RUNTIME_WRONG_VERSION","RUNTIME_TIMEOUT","RUNTIME_PROTOCOL_ERROR","RUNTIME_START_FAILED","RUNTIME_UNEXPECTED_EXIT"].contains(&error.as_str()){error}else{"RUNTIME_CHECK_FAILED".to_string()}})
            }
        };
        *self.0.runtime.lock().unwrap() = state.clone();
        self.finish_job(id);
        self.emit("nectisse:runtime-state", state.clone());
        state
    }

    pub fn record(&self, code: &str) {
        self.record_context(code, None);
    }

    pub fn record_context(&self, code: &str, context: Option<&Value>) {
        let mut entry = json!({"at":now(),"code":code});
        if let Some(context) =
            context.filter(|value| crate::contracts::validate("failureContext", value).is_ok())
        {
            entry["context"] = sanitize_context(context);
        }
        if crate::contracts::validate("diagnostic", &entry).is_err() {
            return;
        }
        if let Ok(mut entries) = self.0.diagnostics.lock() {
            entries.push(entry);
            let drop = entries.len().saturating_sub(32);
            entries.drain(..drop);
            let bytes = entries
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n");
            let saved = atomic_write(
                &self.0.root.join("diagnostics/subscription-read.jsonl"),
                bytes.as_bytes(),
            )
            .is_ok();
            self.0.diagnostics_readable.store(saved, Ordering::SeqCst);
        }
    }

    pub fn cancel(&self, id: &str) -> Result<()> {
        {
            let mut pending = self
                .0
                .pending_cancels
                .lock()
                .map_err(|_| "任务状态不可用")?;
            pending.retain(|_, at| at.elapsed() < Duration::from_secs(60));
            if pending.len() < 256 {
                pending.insert(id.to_string(), std::time::Instant::now());
            }
        }
        let job = {
            let jobs = self.0.jobs.lock().map_err(|_| "任务状态不可用")?;
            jobs.get(id)
                .or_else(|| jobs.get(&format!("magnet:{id}")))
                .and_then(Weak::upgrade)
        };
        if let Some(job) = job {
            job.cancelled.store(true, Ordering::SeqCst);
            {
                let mut store = self.0.store.lock().map_err(|_| "存储不可用")?;
                if let Some(task) = store.metadata["tasks"]
                    .as_array_mut()
                    .and_then(|tasks| tasks.iter_mut().find(|task| text(task, "id") == id))
                {
                    task["status"] = json!("cancelling");
                    task["cancelRequestedAt"] = json!(now());
                    store.commit_metadata()?;
                }
                if let Some(mut task) = store
                    .tasks()?
                    .into_iter()
                    .find(|task| text(task, "id") == id)
                {
                    task["status"] = json!("cancelling");
                    task["cancelRequestedAt"] = json!(now());
                    store.save_task(&task)?;
                    if text(&task, "kind") == "check" {
                        if let Some(mut sub) = store.subscription(text(&task, "subscriptionId"))? {
                            sub["autoPaused"] = json!(true);
                            sub["lastError"] = json!("已取消；不会自动恢复");
                            store.save_subscription(&sub)?;
                        }
                    }
                }
                job.cancelled.store(true, Ordering::SeqCst);
            }
            self.publish_metadata();
            self.publish_subscriptions();
        }
        Ok(())
    }

    pub fn shutdown(&self) {
        self.0.stopped.store(true, Ordering::SeqCst);
        let jobs = self
            .0
            .jobs
            .lock()
            .map(|jobs| jobs.values().filter_map(Weak::upgrade).collect::<Vec<_>>())
            .unwrap_or_default();
        for job in &jobs {
            let _ = self.cancel(&job.id);
        }
        let until = std::time::Instant::now() + Duration::from_secs(5);
        while self
            .0
            .jobs
            .lock()
            .map(|jobs| jobs.values().any(|job| job.strong_count() > 0))
            .unwrap_or(false)
            && std::time::Instant::now() < until
        {
            std::thread::sleep(Duration::from_millis(20));
        }
        for job in &jobs {
            if let Ok(pids) = job.pids.lock() {
                for pid in pids.iter() {
                    unsafe {
                        libc::kill(-*pid, libc::SIGKILL);
                    }
                }
            }
        }
        if let Ok(mut store) = self.0.store.lock() {
            let _ = store.commit_metadata();
            let _ = store.commit_magnets();
            let _ = store.db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)");
            let _ = store
                .library
                .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)");
            let _ = store
                .images
                .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)");
        }
    }

    pub fn save_credential(&self, id: &str, cookie: &str) -> Result<()> {
        if !flag(&store::source(id)?, "credential") {
            return Err("此来源不接收 Cookie".into());
        }
        if cookie.len() > 12000 || cookie.contains(['\r', '\n']) {
            return Err("Cookie 格式不正确".into());
        }
        let encrypted = if cookie.trim().is_empty() {
            None
        } else {
            Some(self.0.vault.encrypt(cookie.trim())?)
        };
        let store = self.0.store.lock().map_err(|_| "存储不可用")?;
        if let Some(bytes) = encrypted {
            store.db.execute("INSERT INTO credentials VALUES(?,?) ON CONFLICT(provider) DO UPDATE SET ciphertext=excluded.ciphertext",params![id,bytes]).map_err(|_|"Cookie 未能保存")?;
        } else {
            store
                .db
                .execute("DELETE FROM credentials WHERE provider=?", [id])
                .map_err(|_| "Cookie 未能删除")?;
        }
        Ok(())
    }
}

fn sanitize_context(value: &Value) -> Value {
    let mut clean = json!({});
    for key in ["stage", "kind", "systemCode", "sqliteCode"] {
        if let Some(value) = value.get(key) {
            clean[key] = value.clone();
        }
    }
    clean
}
