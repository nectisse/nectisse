use crate::{
    backend::{Backend, Job},
    images, platform,
    store::{self, json_rows},
    util::*,
};
use regex::Regex;
use serde_json::{json, Value};
use std::{
    sync::{atomic::Ordering, Arc},
    time::Duration,
};

pub fn canonical(provider: &str, reference: &str, handle: &str) -> Result<String> {
    let matches = |pattern: &str| Regex::new(pattern).unwrap().is_match(reference);
    let url = match provider {
        "fanbox" if matches(r"^[a-z0-9_-]{1,64}$") && !["www", "api"].contains(&reference) => {
            format!("https://{reference}.fanbox.cc/")
        }
        "javdb" if matches(r"^[A-Za-z0-9]{1,16}$") => {
            format!("https://javdb.com/actors/{reference}")
        }
        "javtao" if reference.len() <= 128 && matches(r"^[a-z0-9]+(?:-[a-z0-9]+)*$") => {
            format!("https://javtao.com/actress/{reference}")
        }
        "x" if matches(r"^[1-9]\d{0,24}$")
            && Regex::new(r"^[A-Za-z0-9_]{1,15}$")
                .unwrap()
                .is_match(handle) =>
        {
            format!("https://x.com/{handle}")
        }
        "patreon" if matches(r"^user/\d+$") => {
            format!("https://www.patreon.com/user?u={}", &reference[5..])
        }
        "patreon"
            if matches(r"^[A-Za-z0-9_-]{1,80}$")
                && !["posts", "join", "login", "signup", "home", "explore"]
                    .contains(&reference.to_lowercase().as_str()) =>
        {
            format!("https://www.patreon.com/cw/{reference}")
        }
        "kemono" | "pawchive" | "coomer" if matches(r"^[a-z0-9_-]{1,32}/[A-Za-z0-9_.-]{1,64}$") => {
            let (service, user) = reference.split_once('/').ok_or("来源身份不正确")?;
            if [".", ".."].contains(&user) {
                return Err("来源身份不正确".into());
            }
            format!(
                "{}{service}/user/{user}",
                text(&store::source(provider)?, "root")
            )
        }
        _ => return Err("来源原生身份不正确".into()),
    };
    Ok(url)
}

pub fn valid_entry(provider: &str, reference: &str, entry: &Value) -> bool {
    let Ok(url) = url::Url::parse(text(entry, "url")) else {
        return false;
    };
    if url.scheme() != "https"
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return false;
    }
    let external = text(entry, "externalId");
    let host = url.host_str().unwrap_or("");
    let path = url.path();
    let matches = |pattern: &str| Regex::new(pattern).unwrap().is_match(external);
    match provider {
        "fanbox" => {
            host == format!("{reference}.fanbox.cc")
                && path == format!("/posts/{external}")
                && matches(r"^\d+$")
        }
        "javdb" => host == "javdb.com" && path == external && matches(r"^/v/[A-Za-z0-9]+$"),
        "javtao" => {
            host == "javtao.com"
                && path == external
                && matches(r"^/[a-z0-9][a-z0-9_-]{1,95}$")
                && external.bytes().any(|byte| byte.is_ascii_digit())
                && canonical(provider, reference, "").is_ok()
        }
        "x" => {
            host == "x.com"
                && matches(r"^[1-9]\d{0,24}$")
                && text(entry, "authorRef") == reference
                && text(entry, "postKind") == "original"
                && Regex::new(r"^[A-Za-z0-9_]{1,15}$")
                    .unwrap()
                    .is_match(text(entry, "authorHandle"))
                && path == format!("/{}/status/{external}", text(entry, "authorHandle"))
        }
        "kemono" | "pawchive" | "coomer" => {
            matches(r"^[A-Za-z0-9_.-]{1,64}$")
                && canonical(provider, reference, "")
                    .map(|base| text(entry, "url") == format!("{base}/post/{external}"))
                    .unwrap_or(false)
        }
        "patreon" => {
            ["www.patreon.com", "patreon.com"].contains(&host)
                && matches(r"^\d+$")
                && Regex::new(&format!(r"^/posts/(?:[A-Za-z0-9_-]+-)?{external}/?$"))
                    .unwrap()
                    .is_match(path)
        }
        _ => false,
    }
}

pub fn validate_preferences(previous: &Value, patch: &Value) -> Result<Value> {
    if !patch.is_object() {
        return Err("设置格式不正确".into());
    }
    let defaults = store::catalog()["preferences"].clone();
    let mut next = previous.clone();
    for (key, value) in patch.as_object().unwrap() {
        if defaults.get(key).is_none() {
            return Err("设置字段不正确".into());
        }
        if ["magnetSearch", "sourceTransports"].contains(&key.as_str()) {
            if !value.is_object() {
                return Err("设置格式不正确".into());
            }
            merge(&mut next[key], value);
        } else {
            next[key] = value.clone();
        }
    }
    for (key, minimum, maximum) in [
        ("creatorMinutes", 15, 10080),
        ("performerMinutes", 360, 10080),
        ("imageCacheMiB", 64, 8192),
    ] {
        if !next[key].is_i64() || !(minimum..=maximum).contains(&number(&next, key)) {
            return Err("检查频率或缓存容量格式不正确".into());
        }
    }
    if !next["automatic"].is_boolean()
        || !["cream", "night"].contains(&text(&next, "theme"))
        || !["system", "direct", "custom"].contains(&text(&next, "proxyMode"))
    {
        return Err("设置格式不正确".into());
    }
    if text(&next, "proxyMode") == "custom" {
        platform::validate_proxy(text(&next, "proxyUrl"))?;
    }
    for key in [
        "querySources",
        "enabledSources",
        "metadataPriority",
        "coverPriority",
    ] {
        let values = next[key].as_array().ok_or("来源设置格式不正确")?;
        let allowed = if key == "enabledSources" {
            array(&store::catalog(), "sources")
                .iter()
                .map(|s| s["id"].clone())
                .collect()
        } else {
            array(&store::catalog(), "metadataIds")
        };
        let mut seen = std::collections::HashSet::new();
        if values
            .iter()
            .any(|value| !allowed.contains(value) || !seen.insert(value.to_string()))
        {
            return Err("来源设置包含未支持或重复来源".into());
        }
    }
    for key in ["fanboxTransport", "javdbTransport"] {
        if !["httpx", "fingerprint"].contains(&text(&next, key)) {
            return Err("传输设置格式不正确".into());
        }
    }
    for (source, transport) in next["sourceTransports"]
        .as_object()
        .ok_or("传输设置格式不正确")?
    {
        store::source(source)?;
        if !["httpx", "fingerprint"].contains(&transport.as_str().unwrap_or(""))
            && !(source == "fc2ppvdb" && transport == "browser")
        {
            return Err("传输设置不支持".into());
        }
    }
    let magnets = &next["magnetSearch"];
    if !magnets["enabled"].is_boolean()
        || !["sukebei", "javtao"].contains(&text(magnets, "source"))
        || ![5, 10, 20].contains(&number(magnets, "maxResults"))
        || !["httpx", "fingerprint"].contains(&text(magnets, "transport"))
    {
        return Err("磁链设置格式不正确".into());
    }
    crate::contracts::validate("preferences", &next)?;
    Ok(next)
}

impl Backend {
    pub fn follow_command(&self, command: &Value) -> Result<Value> {
        let action = text(command, "action");
        match action {
            "lookup" => {
                return self.start_follow(text(command, "provider"), text(command, "query"), None)
            }
            "check" => {
                let sub = self
                    .0
                    .store
                    .lock()
                    .map_err(|_| "存储不可用")?
                    .subscription(text(command, "id"))?
                    .ok_or("该订阅不存在")?;
                if !flag(&sub, "following") || !flag(&sub, "enabled") {
                    return Err("请先关注或恢复订阅".into());
                }
                return self.start_follow(text(&sub, "provider"), "", Some(sub.clone()));
            }
            "cancel" => {
                self.cancel(text(command, "id"))?;
                return Ok(json!({"ok":true}));
            }
            "follow" => {
                let sub = {
                    let store = self.0.store.lock().map_err(|_| "存储不可用")?;
                    let task = store
                        .tasks()?
                        .into_iter()
                        .find(|task| {
                            text(task, "id") == text(command, "taskId")
                                && ["succeeded", "partial"].contains(&text(task, "status"))
                        })
                        .ok_or("请先查询并确认有效候选")?;
                    let candidate = array(&task, "candidates")
                        .into_iter()
                        .find(|candidate| text(candidate, "ref") == text(command, "ref"))
                        .ok_or("候选不存在")?;
                    if canonical(
                        text(&candidate, "provider"),
                        text(&candidate, "ref"),
                        text(&candidate, "handle"),
                    )? != text(&candidate, "url")
                    {
                        return Err("候选身份不正确".into());
                    }
                    store.follow(&candidate)?
                };
                self.publish_subscriptions();
                let id = text(&sub, "id").to_string();
                let _ = self.start_follow(text(&sub, "provider"), "", Some(sub.clone()));
                return Ok(json!({"ok":true,"id":id,"message":"已关注；首次检查状态显示在订阅中"}));
            }
            "credential" => {
                self.save_credential(text(command, "provider"), text(command, "cookie"))?;
            }
            "preferences" | "preferences-patch" | "query-sources" | "source-enabled" => {
                let store = self.0.store.lock().map_err(|_| "存储不可用")?;
                let previous = store.preferences()?;
                let patch = match action {
                    "preferences" => command["value"].clone(),
                    "preferences-patch" => command["patch"].clone(),
                    "query-sources" => json!({"querySources":command["sources"]}),
                    _ => {
                        store::source(text(command, "source"))?;
                        let mut enabled = array(&previous, "enabledSources");
                        enabled.retain(|id| id != &command["source"]);
                        if flag(command, "enabled") {
                            enabled.push(command["source"].clone());
                        }
                        json!({"enabledSources":enabled})
                    }
                };
                let next = validate_preferences(&previous, &patch)?;
                store.save_preferences(&next)?;
                if previous["proxyMode"] != next["proxyMode"]
                    || previous["proxyUrl"] != next["proxyUrl"]
                    || previous["sourceTransports"] != next["sourceTransports"]
                {
                    for source in array(&store::catalog(), "sources") {
                        let id = text(&source, "id");
                        let mut policy = store.policy(id)?;
                        policy["cooldownUntil"] = json!(0);
                        store.save_policy(id, &policy)?;
                    }
                }
                let disabled = array(&previous, "enabledSources")
                    .iter()
                    .any(|source| !array(&next, "enabledSources").contains(source));
                let route_changed = previous["proxyMode"] != next["proxyMode"]
                    || previous["proxyUrl"] != next["proxyUrl"]
                    || previous["sourceTransports"] != next["sourceTransports"]
                    || previous["fanboxTransport"] != next["fanboxTransport"]
                    || previous["javdbTransport"] != next["javdbTransport"];
                let magnets_changed = previous["magnetSearch"] != next["magnetSearch"];
                let jobs = self
                    .0
                    .jobs
                    .lock()
                    .map_err(|_| "任务状态不可用")?
                    .values()
                    .filter_map(std::sync::Weak::upgrade)
                    .filter(|job| {
                        job.id != "runtime"
                            && (disabled
                                || route_changed
                                || (magnets_changed && job.id.starts_with("magnet:")))
                    })
                    .collect::<Vec<_>>();
                drop(store);
                for job in jobs {
                    self.cancel(&job.id)?;
                }
            }
            "update" => {
                let id = text(command, "id");
                uuid(id)?;
                let store = self.0.store.lock().map_err(|_| "存储不可用")?;
                let mut sub = store.subscription(id)?.ok_or("该订阅不存在")?;
                for key in ["enabled", "following"] {
                    if let Some(value) = command.get(key) {
                        if !value.is_boolean() {
                            return Err("订阅设置格式不正确".into());
                        }
                        sub[key] = value.clone();
                        sub["autoPaused"] = json!(false);
                    }
                }
                if command.get("following").is_some() {
                    sub["enabled"] = command["following"].clone();
                }
                if let Some(value) = command.get("intervalMinutes") {
                    let minutes = value.as_i64().unwrap_or(0);
                    if !value.is_null()
                        && !(if store::performer(text(&sub, "provider")) {
                            360
                        } else {
                            15
                        }..=10080)
                            .contains(&minutes)
                    {
                        return Err("检查频率不正确".into());
                    }
                    sub["intervalMinutes"] = value.clone();
                }
                store.save_subscription(&sub)?;
                let cancel = !flag(&sub, "following") || !flag(&sub, "enabled");
                let tasks = store.tasks()?;
                drop(store);
                if cancel {
                    for task in tasks.into_iter().filter(|task| {
                        text(task, "subscriptionId") == id
                            && ["running", "cancelling"].contains(&text(task, "status"))
                    }) {
                        self.cancel(text(&task, "id"))?;
                    }
                }
            }
            "read" => {
                self.0
                    .store
                    .lock()
                    .map_err(|_| "存储不可用")?
                    .mark_read(&array(command, "ids"), flag(command, "read"))?;
            }
            "restore-avatar" => {
                let id = text(command, "id");
                uuid(id)?;
                let store = self.0.store.lock().map_err(|_| "存储不可用")?;
                let mut sub = store.subscription(id)?.ok_or("该订阅不存在")?;
                sub.as_object_mut()
                    .ok_or("订阅记录格式不正确")?
                    .remove("manualAvatarAsset");
                store.save_subscription(&sub)?;
                let owners = json_rows(
                    &store.images,
                    "SELECT json_object('owner',owner) FROM pins WHERE owner LIKE ? GROUP BY owner",
                    [format!("manual-avatar:{id}:%")],
                )?;
                for owner in owners {
                    images::unpin(&store, text(&owner, "owner"))?;
                }
            }
            "retry-images" => {
                let store = self.0.store.lock().map_err(|_| "存储不可用")?;
                for mut entry in store.entries()? {
                    if (text(command, "subscriptionId").is_empty()
                        || entry["subscriptionId"] == command["subscriptionId"])
                        && !text(&entry, "thumbnailUrl").is_empty()
                        && !entry["imageAsset"].is_object()
                    {
                        entry["imageCache"] =
                            json!({"status":"queued","attempts":0,"nextAttemptAt":0,"reason":""});
                        store.save_entry(&entry)?;
                    }
                }
            }
            "open" => {
                self.open_follow_source(command)?;
            }
            _ => return Err("尚未支持此操作".into()),
        }
        self.publish_subscriptions();
        Ok(json!({"ok":true}))
    }

    pub fn start_follow(&self, provider: &str, query: &str, sub: Option<Value>) -> Result<Value> {
        let cover_tasks = self.0.store.lock().map_err(|_| "存储不可用")?.tasks()?;
        for task in cover_tasks
            .iter()
            .filter(|task| text(task, "kind") == "covers" && text(task, "status") == "running")
        {
            self.cancel(text(task, "id"))?;
        }
        if cover_tasks
            .iter()
            .any(|task| text(task, "kind") == "covers" && text(task, "status") == "running")
        {
            let until = std::time::Instant::now() + Duration::from_secs(3);
            while self
                .0
                .store
                .lock()
                .map_err(|_| "存储不可用")?
                .tasks()?
                .iter()
                .any(|task| {
                    text(task, "kind") == "covers"
                        && ["running", "cancelling"].contains(&text(task, "status"))
                })
                && std::time::Instant::now() < until
            {
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        if !flag(&store::source(provider)?, "follow") {
            return Err("此来源尚不支持关注".into());
        }
        if sub.is_none() && (query.trim().is_empty() || query.chars().count() > 500) {
            return Err("请输入账号、演员名或主页链接".into());
        }
        let preferences = self.preferences()?;
        if !array(&preferences, "enabledSources")
            .iter()
            .any(|id| id == provider)
        {
            return Err("请先在设置中启用此来源".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let job;
        {
            let store = self.0.store.lock().map_err(|_| "存储不可用")?;
            if store
                .tasks()?
                .iter()
                .any(|task| ["running", "cancelling"].contains(&text(task, "status")))
            {
                return Err("请先等待或取消当前订阅任务".into());
            }
            job = self.job(&id, 24)?;
            let mut task = json!({"id":id,"kind":if sub.is_some(){"check"}else{"lookup"},"provider":provider,"status":"running","phase":"正在准备来源检查","startedAt":now(),"finishedAt":"","requests":0,"candidates":[],"added":0,"reason":"","cancelRequestedAt":""});
            if let Some(sub) = &sub {
                task["subscriptionId"] = sub["id"].clone();
            }
            store.save_task(&task)?;
        }
        self.publish_subscriptions();
        let backend = self.clone();
        let provider = provider.to_string();
        let query = query.to_string();
        let task_id = id.clone();
        std::thread::spawn(move || {
            backend.execute_follow(&task_id, &provider, &query, sub, &job);
            backend.finish_job(&task_id);
        });
        Ok(json!({"ok":true,"id":id}))
    }

    pub fn mutate_follow(&self, id: &str, change: impl FnOnce(&mut Value)) -> Result<()> {
        let store = self.0.store.lock().map_err(|_| "存储不可用")?;
        let mut task = store
            .tasks()?
            .into_iter()
            .find(|task| text(task, "id") == id)
            .ok_or("任务已不存在")?;
        change(&mut task);
        store.save_task(&task)?;
        drop(store);
        self.publish_subscriptions();
        Ok(())
    }

    fn execute_follow(
        &self,
        id: &str,
        provider: &str,
        query: &str,
        sub: Option<Value>,
        job: &Arc<Job>,
    ) {
        let operation = (|| {
            let preferences = self.preferences()?;
            let seen = if let Some(sub) = &sub {
                json_rows(&self.0.store.lock().map_err(|_|"存储不可用")?.db,"SELECT value FROM entries WHERE subscription_id=? ORDER BY first_seen DESC LIMIT 200",[text(sub,"id")])?.iter().map(|entry|entry["externalId"].clone()).collect::<Vec<_>>()
            } else {
                Vec::new()
            };
            let params = json!({"provider":provider,"query":query,"ref":sub.as_ref().map(|s|s["ref"].clone()),"name":sub.as_ref().map(|s|s["name"].clone()),"initialized":sub.as_ref().is_some_and(|s|flag(s,"initialized")),"xSyncState":sub.as_ref().and_then(|s|s.get("xSyncState").cloned()),"seen":seen,"proxy":self.route(provider,"follow")?,"cookie":self.credential(provider)?,"transport":platform::transport(provider,&preferences)});
            let outcome = self.worker(
                if sub.is_some() {
                    "follow.check"
                } else {
                    "follow.lookup"
                },
                params,
                job,
                |payload| {
                    job.running()?;
                    if text(&payload, "event") == "entry" {
                        if let Some(sub) = &sub {
                            let entry = &payload["entry"];
                            if !valid_entry(provider, text(sub, "ref"), entry)
                                || text(entry, "title").chars().count() > 1000
                                || text(entry, "summary").chars().count() > 3000
                            {
                                return Err("条目身份不属于当前来源".into());
                            }
                            let store = self.0.store.lock().map_err(|_| "存储不可用")?;
                            job.running()?;
                            let added = store.upsert_entry(sub, entry)?;
                            drop(store);
                            if added {
                                self.mutate_follow(id, |task| {
                                    task["added"] = json!(number(task, "added") + 1)
                                })?;
                            }
                        }
                    }
                    self.mutate_follow(id, |task| {
                        task["requests"] = json!(job.requests.load(Ordering::SeqCst))
                    })
                },
            )?;
            job.running()?;
            self.hold(provider, &outcome)?;
            let mut candidates: Vec<Value> = array(&outcome, "candidates")
                .into_iter()
                .filter(|candidate| {
                    text(candidate, "provider") == provider
                        && canonical(provider, text(candidate, "ref"), text(candidate, "handle"))
                            .is_ok_and(|url| url == text(candidate, "url"))
                })
                .take(8)
                .collect();
            if let Some(sub) = &sub {
                let store = self.0.store.lock().map_err(|_| "存储不可用")?;
                job.running()?;
                let mut latest = store.subscription(text(sub, "id"))?.ok_or("订阅已不存在")?;
                if provider == "x" && text(&outcome, "status") != "error" {
                    let profile = &outcome["profile"];
                    if profile["ref"] != sub["ref"]
                        || text(profile, "provider") != "x"
                        || canonical("x", text(profile, "ref"), text(profile, "handle"))?
                            != text(profile, "url")
                    {
                        return Err("账号资料与订阅身份不一致".into());
                    }
                    for key in ["name", "handle", "url", "bio", "avatarUrl"] {
                        if let Some(value) = profile.get(key) {
                            latest[key] = value.clone();
                        }
                    }
                } else if !text(&outcome, "avatarUrl").is_empty() {
                    latest["avatarUrl"] = outcome["avatarUrl"].clone();
                }
                latest["lastCheckedAt"] = json!(now());
                if let Some(coverage) = outcome.get("coverage") {
                    latest["coverage"] = coverage.clone();
                }
                latest["failureCount"] = json!(if text(&outcome, "status") == "error" {
                    number(&latest, "failureCount") + 1
                } else {
                    0
                });
                latest["lastError"] = json!(if text(&outcome, "status") == "error" {
                    text(&outcome, "message")
                } else if flag(&outcome, "gap") {
                    text(&outcome, "coverage")
                } else {
                    ""
                });
                latest["autoPaused"] = json!(false);
                if provider != "x" {
                    latest["initialized"] =
                        json!(text(&outcome, "status") != "error" || flag(&latest, "initialized"));
                }
                let minutes = latest["intervalMinutes"].as_i64().unwrap_or(number(
                    &preferences,
                    if store::performer(provider) {
                        "performerMinutes"
                    } else {
                        "creatorMinutes"
                    },
                ));
                let minutes = (minutes
                    * (1i64 << (number(&latest, "failureCount") - 1).clamp(0, 3)))
                .min(10080);
                let next = (millis() + minutes * 60_000)
                    .max(number(&store.policy(provider)?, "cooldownUntil"));
                latest["nextCheckAt"] = json!(chrono::DateTime::from_timestamp_millis(next)
                    .ok_or("检查时间不正确")?
                    .to_rfc3339());
                store.save_subscription(&latest)?;
                candidates = vec![latest];
            }
            let mut image_issue = false;
            for profile in &mut candidates {
                job.running()?;
                let url = text(profile, "avatarUrl").to_string();
                if url.is_empty() || !platform::allowed_url(provider, &url, "image") {
                    continue;
                }
                let cached = {
                    let store = self.0.store.lock().map_err(|_| "存储不可用")?;
                    images::linked(&store, &url, "original")?
                };
                let owner = sub.as_ref().map(|s| format!("avatar:{}", text(s, "id")));
                let asset = if let Some(cached) = cached {
                    Some(cached.asset)
                } else {
                    self.fetch_image(provider, &url, None, job, false, owner.as_deref())
                        .ok()
                        .map(|saved| saved["original"].clone())
                };
                if let Some(asset) = asset {
                    profile["avatarAsset"] = asset.clone();
                    if let Some(sub) = &sub {
                        let store = self.0.store.lock().map_err(|_| "存储不可用")?;
                        job.running()?;
                        let mut latest =
                            store.subscription(text(sub, "id"))?.ok_or("订阅已不存在")?;
                        latest["avatarAsset"] = asset;
                        latest["avatarUrl"] = json!(url);
                        store.save_subscription(&latest)?;
                        images::pin(&store, owner.as_deref().unwrap(), &url)?;
                    }
                } else {
                    image_issue = true;
                }
            }
            job.running()?;
            if let Some(sub) = &sub {
                if provider == "x" {
                    let store = self.0.store.lock().map_err(|_| "存储不可用")?;
                    job.running()?;
                    let mut latest = store.subscription(text(sub, "id"))?.ok_or("订阅已不存在")?;
                    if text(&outcome, "status") == "success" && outcome["xSyncState"].is_object() {
                        crate::contracts::validate("xSync", &outcome["xSyncState"])?;
                        let gap = latest["xSyncState"].get("gapSince").cloned();
                        latest["xSyncState"] = outcome["xSyncState"].clone();
                        if let Some(gap) = gap {
                            latest["xSyncState"]["gapSince"] = gap;
                        }
                    }
                    if flag(&outcome, "gap")
                        && latest["xSyncState"].is_object()
                        && latest["xSyncState"].get("gapSince").is_none()
                    {
                        latest["xSyncState"]["gapSince"] = json!(now());
                    }
                    if latest["xSyncState"].is_object() {
                        latest["initialized"] = json!(true);
                    }
                    store.save_subscription(&latest)?;
                }
            }

            self.mutate_follow(id, |task| {
                if sub.is_none() {
                    task["candidates"] = json!(candidates);
                }
                task["status"] = json!(if text(&outcome, "status") == "error" {
                    if number(task, "added") > 0 {
                        "partial"
                    } else {
                        "failed"
                    }
                } else if image_issue
                    || text(&outcome, "status") == "partial"
                    || flag(&outcome, "gap")
                {
                    "partial"
                } else {
                    "succeeded"
                });
                task["phase"] = json!(if text(&outcome, "status") == "error" {
                    text(&outcome, "message")
                } else if sub.is_none() {
                    "已取得候选，请核对后关注"
                } else {
                    text(&outcome, "coverage")
                });
                task["reason"] = json!(text(&outcome, "reason"));
            })
        })();
        if let (Err(error), Some(sub)) = (&operation, &sub) {
            if !job.cancelled.load(Ordering::SeqCst) {
                if let Ok(store) = self.0.store.lock() {
                    if let Ok(Some(mut latest)) = store.subscription(text(sub, "id")) {
                        latest["autoPaused"] = json!(true);
                        latest["lastError"] = json!(error);
                        let _ = store.save_subscription(&latest);
                    }
                }
            }
        }
        let cancelled = job.cancelled.load(Ordering::SeqCst);
        let _ = self.mutate_follow(id, |task| {
            if cancelled {
                task["status"] = json!("cancelled");
                task["phase"] = json!("已取消；不会自动恢复");
            } else if let Err(error) = &operation {
                task["status"] = json!(if number(task, "added") > 0 {
                    "partial"
                } else {
                    "failed"
                });
                task["phase"] = json!(error);
                task["reason"] = json!("network");
            }
            task["finishedAt"] = json!(now());
            task["requests"] = json!(job.requests.load(Ordering::SeqCst));
        });
        self.publish_subscriptions();
    }

    pub fn background(&self) {
        let backend = self.clone();
        std::thread::spawn(move || {
            while !backend.0.stopped.load(Ordering::SeqCst) {
                let _ = backend.tick();
                for _ in 0..100 {
                    if backend.0.stopped.load(Ordering::SeqCst) {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
        });
    }

    pub fn tick(&self) -> Result<()> {
        let store = self.0.store.lock().map_err(|_| "存储不可用")?;
        if store
            .tasks()?
            .iter()
            .any(|task| ["running", "cancelling"].contains(&text(task, "status")))
        {
            return Ok(());
        }
        let preferences = store.preferences()?;
        if flag(&preferences, "automatic") {
            let due = store.subscriptions()?.into_iter().find(|sub| {
                flag(sub, "following")
                    && flag(sub, "enabled")
                    && !flag(sub, "autoPaused")
                    && array(&preferences, "enabledSources").contains(&sub["provider"])
                    && stamp(text(sub, "nextCheckAt")) <= millis()
                    && store
                        .policy(text(sub, "provider"))
                        .is_ok_and(|policy| number(&policy, "cooldownUntil") <= millis())
            });
            if let Some(sub) = due {
                drop(store);
                self.start_follow(text(&sub, "provider"), "", Some(sub.clone()))?;
                return Ok(());
            }
        }
        let pending = store
            .entries()?
            .into_iter()
            .filter(|entry| {
                !entry["imageAsset"].is_object()
                    && !text(entry, "thumbnailUrl").is_empty()
                    && ["", "queued", "retry"].contains(&text(&entry["imageCache"], "status"))
                    && number(&entry["imageCache"], "nextAttemptAt") <= millis()
                    && store
                        .subscription(text(entry, "subscriptionId"))
                        .ok()
                        .flatten()
                        .is_some_and(|sub| {
                            flag(&sub, "following")
                                && flag(&sub, "enabled")
                                && !flag(&sub, "autoPaused")
                                && array(&preferences, "enabledSources").contains(&sub["provider"])
                                && valid_entry(text(&sub, "provider"), text(&sub, "ref"), entry)
                                && platform::allowed_url(
                                    text(&sub, "provider"),
                                    text(entry, "thumbnailUrl"),
                                    "image",
                                )
                                && store.policy(text(&sub, "provider")).is_ok_and(|policy| {
                                    number(&policy, "cooldownUntil") <= millis()
                                })
                        })
            })
            .collect::<Vec<_>>();
        let Some(first) = pending.first() else {
            return Ok(());
        };
        let ids = pending
            .iter()
            .filter(|entry| entry["subscriptionId"] == first["subscriptionId"])
            .map(|entry| entry["id"].clone())
            .collect::<Vec<_>>();
        let id = uuid::Uuid::new_v4().to_string();
        let task = json!({"id":id,"kind":"covers","provider":first["provider"],"subscriptionId":first["subscriptionId"],"imageIds":ids,"completed":0,"total":ids.len(),"status":"running","phase":"准备补齐封面","startedAt":now(),"finishedAt":"","requests":0,"candidates":[],"added":0,"reason":"","cancelRequestedAt":""});
        let job = self.job(&id, 2000)?;
        store.save_task(&task)?;
        drop(store);
        self.publish_subscriptions();
        let backend = self.clone();
        std::thread::spawn(move || {
            backend.backfill(&task, &job);
            backend.finish_job(&id);
        });
        Ok(())
    }

    fn backfill(&self, task: &Value, job: &Arc<Job>) {
        let ids = array(task, "imageIds");
        let operation: Result<()> = (|| {
            for id in &ids {
                job.running()?;
                let entry = {
                    let store = self.0.store.lock().map_err(|_| "存储不可用")?;
                    let Some(entry) = store.entry(id.as_str().ok_or("帖子身份不正确")?)?
                    else {
                        continue;
                    };
                    let sub = store
                        .subscription(text(&entry, "subscriptionId"))?
                        .ok_or("订阅已不存在")?;
                    if !flag(&sub, "following")
                        || !flag(&sub, "enabled")
                        || flag(&sub, "autoPaused")
                    {
                        return Err("订阅已暂停".into());
                    }
                    entry
                };
                let cached = images::linked(
                    &*self.0.store.lock().map_err(|_| "存储不可用")?,
                    text(&entry, "thumbnailUrl"),
                    "thumbnail",
                )?;
                let result = if let Some(cached) = cached {
                    Ok(json!({"thumbnail":cached.asset}))
                } else {
                    self.fetch_image(
                        text(&entry, "provider"),
                        text(&entry, "thumbnailUrl"),
                        None,
                        job,
                        true,
                        None,
                    )
                };
                let store = self.0.store.lock().map_err(|_| "存储不可用")?;
                job.running()?;
                if let Some(mut latest) = store.entry(text(&entry, "id"))? {
                    if let Ok(saved) = &result {
                        latest["imageAsset"] = saved["thumbnail"].clone();
                        latest
                            .as_object_mut()
                            .ok_or("帖子格式不正确")?
                            .remove("imageCache");
                    } else {
                        let attempts = number(&entry["imageCache"], "attempts") + 1;
                        latest["imageCache"] = json!({"status":if attempts>=3{"failed"}else{"retry"},"attempts":attempts,"nextAttemptAt":millis()+30_000*(1i64 << attempts.clamp(0,3)),"reason":"network"});
                    }
                    store.save_entry(&latest)?;
                }
                let _ = images::prune(
                    &store,
                    number(&store.preferences()?, "imageCacheMiB") * 1024 * 1024,
                );
                drop(store);
                self.mutate_follow(&job.id, |task| {
                    task["completed"] = json!(number(task, "completed") + 1);
                    if result.is_ok() {
                        task["added"] = json!(number(task, "added") + 1);
                    }
                    task["requests"] = json!(job.requests.load(Ordering::SeqCst));
                    task["phase"] = json!(format!(
                        "正在补齐封面 {}/{}",
                        number(task, "completed"),
                        ids.len()
                    ));
                })?;
                result?;
            }
            Ok(())
        })();
        let cancelled = job.cancelled.load(Ordering::SeqCst);
        if cancelled {
            if let Ok(store) = self.0.store.lock() {
                for id in ids {
                    if let Ok(Some(mut entry)) = store.entry(id.as_str().unwrap_or("")) {
                        if !entry["imageAsset"].is_object() {
                            entry["imageCache"] = json!({"status":"cancelled","attempts":0,"nextAttemptAt":0,"reason":"cancelled"});
                            let _ = store.save_entry(&entry);
                        }
                    }
                }
            }
        }
        let _ = self.mutate_follow(&job.id, |task| {
            task["status"] = json!(if cancelled {
                "cancelled"
            } else if operation.is_ok() {
                "succeeded"
            } else {
                "partial"
            });
            task["phase"] = json!(if cancelled {
                "封面补齐已取消；不会自动恢复"
            } else if operation.is_ok() {
                "封面已补齐"
            } else {
                "部分封面等待重试"
            });
            task["finishedAt"] = json!(now());
        });
    }
}
