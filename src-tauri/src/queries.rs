use crate::{backend::Backend, images, platform, store, util::*};
use regex::Regex;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;

pub fn normalize(raw: &str) -> String {
    let value = raw.trim().to_uppercase();
    if let Some(capture) = Regex::new(r"^FC2(?:[-_. ]?PPV)?[-_. ]?(\d{5,})$")
        .unwrap()
        .captures(&value)
    {
        return format!("FC2-PPV-{}", &capture[1]);
    }
    if let Some(capture) = Regex::new(r"^(\d{3})?([A-Z]{2,8})[-_ ]?(\d{2,5})$")
        .unwrap()
        .captures(&value)
    {
        return format!(
            "{}{}-{:03}",
            capture.get(1).map(|m| m.as_str()).unwrap_or(""),
            &capture[2],
            capture[3].parse::<u32>().unwrap_or(0)
        );
    }
    String::new()
}

fn cid_code(cid: &str) -> String {
    Regex::new(r"^(?:h_\d+)?(\d{1,3})?([a-zA-Z]{2,8})(\d{2,5})$")
        .unwrap()
        .captures(cid)
        .map(|m| {
            normalize(&format!(
                "{}{}-{}",
                m.get(1).map(|m| m.as_str()).unwrap_or(""),
                &m[2],
                &m[3]
            ))
        })
        .unwrap_or_default()
}

pub fn plan_query(request: &Value) -> Result<Value> {
    let mut query = text(request, "query").trim().to_string();
    if query.chars().count() < 2 || query.chars().count() > 500 {
        return Err("请输入2至500个字符".into());
    }
    let requested = array(request, "sources");
    if requested.is_empty()
        || requested.len() > array(&store::catalog(), "metadataIds").len()
        || requested
            .iter()
            .any(|id| !array(&store::catalog(), "metadataIds").contains(id))
    {
        return Err("资料来源格式不正确".into());
    }
    let mut code = normalize(&query);
    let mut cid = String::new();
    let mut specific = None;
    if query.contains("://") {
        let url = url::Url::parse(&query).map_err(|_| "原站链接格式不正确")?;
        if url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some_and(|port| port != 443)
        {
            return Err("只支持不含登录信息的 HTTPS 原站链接".into());
        }
        let host = url.host_str().ok_or("原站链接格式不正确")?;
        let path = url.path();
        let capture = |pattern: &str| {
            Regex::new(pattern)
                .unwrap()
                .captures(path)
                .and_then(|m| m.get(1).map(|m| m.as_str().to_string()))
        };
        match host {
            "adult.contents.fc2.com" | "contents.fc2.com" => {
                code = format!(
                    "FC2-PPV-{}",
                    capture(r"^/article/(\d{5,})/?$").ok_or("请输入 FC2 作品商品页链接")?
                );
            }
            "fc2ppv-db.com" => {
                code = format!(
                    "FC2-PPV-{}",
                    capture(r"^/(?:ja/|en/)?videos/(\d{5,})/?$")
                        .ok_or("请输入 FC2PPV-DB 作品页链接")?
                );
                specific = Some("fc2ppvdb".to_string());
            }
            "video.dmm.co.jp" | "www.dmm.co.jp" | "www.dmm.com" | "dmm.co.jp" | "dmm.com" => {
                cid = url
                    .query_pairs()
                    .find(|(key, _)| key == "id")
                    .map(|(_, value)| value.into_owned())
                    .or_else(|| capture(r"/(?:cid|id)=([a-zA-Z0-9_]+)(?:/|$)"))
                    .ok_or("未识别 DMM 商品身份")?;
                if !Regex::new(r"^[a-zA-Z0-9_]{2,100}$").unwrap().is_match(&cid) {
                    return Err("DMM 商品身份不正确".into());
                }
                code = cid_code(&cid);
            }
            "r18.dev" | "www.r18.dev" => {
                let m = Regex::new(r"/(dvd_id|combined)=([^/]+)(?:/|$)").unwrap();
                let capture = m.captures(path).ok_or("未识别 r18.dev 作品身份")?;
                if &capture[1] == "dvd_id" {
                    code = normalize(&capture[2]);
                } else {
                    cid = capture[2].to_string();
                    code = cid_code(&cid);
                }
            }
            "www.1pondo.tv" | "1pondo.tv" => {
                code =
                    capture(r"^/movies/(\d{6}_\d{2,4})/?$").ok_or("请输入一本道的单片主页链接")?;
                specific = Some("1pondo".to_string());
            }
            "javdb.com" | "javtao.com" => {
                let id = if host == "javdb.com" {
                    "javdb"
                } else {
                    "javtao"
                };
                let valid = if id == "javdb" {
                    Regex::new(r"^/v/[A-Za-z0-9]+/?$").unwrap().is_match(path)
                } else {
                    Regex::new(r"^/[a-z0-9][a-z0-9_-]{1,95}/?$")
                        .unwrap()
                        .is_match(path)
                        && path.bytes().any(|b| b.is_ascii_digit())
                };
                if !valid || !requested.iter().any(|value| value == id) {
                    return Err("请先选择对应来源并使用单片作品链接".into());
                }
                let source_url = format!("https://{host}{}", path.trim_end_matches('/'));
                return Ok(
                    json!({"kind":"url","query":source_url,"code":"","contentId":"","sourceUrl":source_url,"sources":[id]}),
                );
            }
            _ => {
                let spec = array(&store::catalog(), "sources")
                    .into_iter()
                    .find(|spec| {
                        flag(spec, "metadata")
                            && array(spec, "domains").iter().filter_map(Value::as_str).any(
                                |domain| host == domain || host.ends_with(&format!(".{domain}")),
                            )
                    })
                    .ok_or("未识别此站点，请使用已登记来源")?;
                specific = Some(text(&spec, "id").to_string());
                code = path
                    .split('/')
                    .rev()
                    .map(normalize)
                    .find(|code| !code.is_empty())
                    .unwrap_or_default();
            }
        }
        if code.is_empty() {
            return Err("链接中没有可可靠识别的作品编号，请改用编号查询".into());
        }
        query = code.clone();
    }
    if query.to_uppercase().starts_with("FC2") && code.is_empty() {
        return Err("FC2 分段编号或不完整编号不能按整部商品查询".into());
    }
    let dated = Regex::new(r"^\d{6}[-_]\d{2,4}$").unwrap().is_match(&query);
    if dated && code.is_empty() {
        if requested != vec![json!("1pondo")] {
            return Err("日期式编号需要发行方证据，请仅选择一本道或使用原站链接".into());
        }
        code = query.replace('-', "_");
        specific = Some("1pondo".to_string());
    }
    if code.is_empty()
        && query.is_ascii()
        && query.bytes().any(|b| b.is_ascii_digit())
        && !query.contains(' ')
    {
        return Err("未识别此编号，请检查完整写法".into());
    }
    let kind = if code.is_empty() { "title" } else { "code" };
    if kind == "title" && query.chars().count() > 200 {
        return Err("标题最多输入200个字符".into());
    }
    let family = if code.starts_with("FC2") {
        "fc2"
    } else if dated {
        "dated"
    } else {
        "standard"
    };
    let sources: Vec<Value> = requested
        .into_iter()
        .filter(|id| {
            if kind == "title" {
                return id == "dmm";
            }
            if let Some(specific) = &specific {
                return id == specific;
            }
            store::source(id.as_str().unwrap_or(""))
                .map(|spec| array(&spec, "families").iter().any(|v| v == family))
                .unwrap_or(false)
        })
        .collect();
    if sources.is_empty() {
        return Err("请在资料来源中选择支持此作品类型的来源，并在设置中启用".into());
    }
    Ok(json!({"kind":kind,"query":query,"code":code,"contentId":cid,"sources":sources}))
}

impl Backend {
    pub fn query(&self, request: &Value) -> Result<Value> {
        let preferences = self.preferences()?;
        let mut plan = plan_query(request)?;
        plan["sources"]
            .as_array_mut()
            .unwrap()
            .retain(|source| array(&preferences, "enabledSources").contains(source));
        if array(&plan, "sources").is_empty() {
            return Ok(reply("请选择并启用至少一个来源"));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let job;
        {
            let mut store = self.0.store.lock().map_err(|_| "存储不可用")?;
            if store.metadata.get("activeId").is_some() {
                return Ok(reply("已有查询正在进行，请先取消或等待完成"));
            }
            if !flag(request, "force") {
                if let Some(cached) = array(&store.metadata, "tasks").iter().find(|task| {
                    task["plan"] == plan
                        && ["succeeded", "partial"].contains(&text(task, "status"))
                        && millis() - stamp(text(task, "finishedAt")) < 86_400_000
                }) {
                    return Ok(json!({"ok":true,"cached":true,"taskId":cached["id"]}));
                }
            }
            job = self.job(&id, 24)?;
            let task = json!({"id":id,"status":"running","phase":"正在准备查询","plan":plan,"coverPriority":preferences["coverPriority"],"startedAt":now(),"records":[],"outcomes":[],"requests":0});
            let mut tasks = array(&store.metadata, "tasks");
            tasks.insert(0, task);
            tasks.truncate(20);
            store.metadata["tasks"] = json!(tasks);
            store.metadata["activeId"] = json!(id);
            let retained = array(&store.metadata, "tasks")
                .iter()
                .map(|task| format!("query:{}:", text(task, "id")))
                .collect::<Vec<_>>();
            for owner in store::json_rows(&store.images,"SELECT json_object('owner',owner) FROM pins WHERE owner LIKE 'query:%' GROUP BY owner",[])? {
                if !retained.iter().any(|prefix|text(&owner,"owner").starts_with(prefix)) {images::unpin(&store,text(&owner,"owner"))?;}
            }
            store.commit_metadata()?;
        }
        self.publish_metadata();
        let backend = self.clone();
        let task_id = id.clone();
        std::thread::spawn(move || {
            backend.execute_query(&task_id, &job);
            backend.finish_job(&task_id);
        });
        Ok(json!({"ok":true,"taskId":id,"cached":false}))
    }

    pub fn mutate_query(&self, id: &str, change: impl FnOnce(&mut Value)) -> Result<()> {
        let mut store = self.0.store.lock().map_err(|_| "存储不可用")?;
        let task = store.metadata["tasks"]
            .as_array_mut()
            .and_then(|tasks| tasks.iter_mut().find(|task| text(task, "id") == id))
            .ok_or("查询已不在最近记录中")?;
        change(task);
        store.commit_metadata()?;
        drop(store);
        self.publish_metadata();
        Ok(())
    }

    fn query_task(&self, id: &str) -> Result<Value> {
        array(
            &self.0.store.lock().map_err(|_| "存储不可用")?.metadata,
            "tasks",
        )
        .into_iter()
        .find(|task| text(task, "id") == id)
        .ok_or("查询记录不存在".into())
    }

    fn execute_query(&self, id: &str, job: &std::sync::Arc<crate::backend::Job>) {
        let result = (|| {
            let plan = self.query_task(id)?["plan"].clone();
            for source in array(&plan, "sources").iter().filter_map(Value::as_str) {
                job.running()?;
                let preferences = self.preferences()?;
                let mut params = plan.clone();
                merge(
                    &mut params,
                    &json!({"source":source,"proxy":self.route(source,"metadata")?,"cookie":if platform::transport(source,&preferences)=="browser"{String::new()}else{self.credential(source)?},"transport":platform::transport(source,&preferences)}),
                );
                let _ = self.mutate_query(id, |task| {
                    task["phase"] = json!(format!(
                        "正在查询 {}",
                        store::source(source)
                            .map(|s| text(&s, "name").to_string())
                            .unwrap_or(source.to_string())
                    ))
                });
                let before = job.requests.load(Ordering::SeqCst);
                let outcome = self.worker("metadata.query", params, job, |payload| {
                    job.running()?;
                    if text(&payload, "event") == "record" {
                        let mut record = payload["record"].clone();
                        if text(&record, "source") != source
                            || !is_hash(text(&record, "id"), 64)
                            || !platform::allowed_url(source, text(&record, "sourceUrl"), "page")
                        {
                            return Err("来源返回的作品身份不正确".into());
                        }
                        let expected = text(&plan, "code");
                        if !expected.is_empty()
                            && normalize(text(&record, "code")) != normalize(expected)
                            && text(&record, "code") != expected
                        {
                            return Err("来源作品编号与查询不一致".into());
                        }
                        for cover in record["covers"]
                            .as_array_mut()
                            .ok_or("来源封面格式不正确")?
                        {
                            cover
                                .as_object_mut()
                                .ok_or("来源封面格式不正确")?
                                .remove("asset");
                        }
                        crate::contracts::validate("record", &record)?;
                        self.mutate_query(id, |task| {
                            if text(task, "status") == "running" {
                                if let Some(records) = task["records"].as_array_mut() {
                                    if records.len() < 30
                                        && !records.iter().any(|r| r["id"] == record["id"])
                                    {
                                        records.push(record);
                                    }
                                }
                            }
                        })?;
                    } else if text(&payload, "event") == "browser" {
                        self.mutate_query(id, |task| {
                            task["phase"] = json!(text(&payload, "message")
                                .chars()
                                .take(250)
                                .collect::<String>())
                        })?;
                    }
                    self.mutate_query(id, |task| {
                        task["requests"] = json!(job.requests.load(Ordering::SeqCst))
                    })
                });
                job.running()?;
                let mut outcome=outcome.unwrap_or_else(|error|json!({"status":"error","reason":"network","message":error,"requests":0,"retryAfter":30,"warnings":[]}));
                outcome["source"] = json!(source);
                outcome["requests"] = json!(job.requests.load(Ordering::SeqCst) - before);
                if !outcome["warnings"].is_array() {
                    outcome["warnings"] = json!([]);
                }
                self.hold(source, &outcome)?;
                self.mutate_query(id, |task| {
                    task["outcomes"].as_array_mut().unwrap().push(outcome)
                })?;
            }
            self.collect_covers(id, job)
        })();
        let cancelled = job.cancelled.load(Ordering::SeqCst);
        let _ = self.mutate_query(id, |task| {
            let records = array(task, "records");
            let issues = result.is_err()
                || array(task, "outcomes")
                    .iter()
                    .any(|o| ["error", "partial"].contains(&text(o, "status")))
                || records.iter().any(|r| {
                    !array(r, "warnings").is_empty()
                        || array(r, "covers").iter().any(|c| c.get("error").is_some())
                });
            task["status"] = json!(if cancelled {
                "cancelled"
            } else if records.is_empty() {
                "failed"
            } else if issues {
                "partial"
            } else {
                "succeeded"
            });
            task["phase"] = json!(if cancelled {
                "已取消；不会自动恢复"
            } else if records.is_empty() {
                "来源未返回可采用资料，请查看来源状态"
            } else if issues {
                "已取得部分资料，请查看来源状态"
            } else {
                "资料查询完成"
            });
            task["finishedAt"] = json!(now());
            task["requests"] = json!(job.requests.load(Ordering::SeqCst));
        });
        if let Ok(mut store) = self.0.store.lock() {
            if text(&store.metadata, "activeId") == id {
                store.metadata.as_object_mut().unwrap().remove("activeId");
                let _ = store.commit_metadata();
            }
        }
        self.publish_metadata();
    }

    fn collect_covers(&self, id: &str, job: &std::sync::Arc<crate::backend::Job>) -> Result<()> {
        let task = self.query_task(id)?;
        let priorities = array(&task, "coverPriority");
        let mut codes = Vec::new();
        for record in array(&task, "records") {
            let code = text(&record, "code").to_string();
            if !codes.contains(&code) {
                codes.push(code);
            }
        }
        for code in codes {
            let mut candidates: Vec<(Value, Value)> = array(&task, "records")
                .into_iter()
                .filter(|r| text(r, "code") == code)
                .flat_map(|r| array(&r, "covers").into_iter().map(move |c| (r.clone(), c)))
                .collect();
            candidates.sort_by_key(|(record, cover)| {
                (
                    priorities
                        .iter()
                        .position(|source| source == &cover["source"])
                        .unwrap_or(priorities.len()),
                    text(record, "source") != "dmm",
                )
            });
            let mut selected = None;
            let rank = |cover: &Value| {
                priorities
                    .iter()
                    .position(|source| source == &cover["source"])
                    .unwrap_or(priorities.len())
            };
            let mut available: Vec<(Value, Value, Option<Value>)> = Vec::new();
            for (record, mut cover) in candidates {
                job.running()?;
                if available
                    .first()
                    .is_some_and(|(_, best, _)| rank(best) != rank(&cover))
                {
                    break;
                }
                let source = text(&record, "source");
                let url = text(&cover, "url").to_string();
                if !platform::allowed_url(source, &url, "image") {
                    continue;
                }
                let cached = {
                    let store = self.0.store.lock().map_err(|_| "存储不可用")?;
                    images::linked(&store, &url, "original")?
                };
                if let Some(cached) = cached {
                    cover["probe"] = json!({"width":cached.asset["width"],"height":cached.asset["height"],"format":cached.asset["format"]});
                    available.push((record, cover, Some(cached.asset)));
                    continue;
                }
                if job.requests.load(Ordering::SeqCst) >= 23 {
                    break;
                }
                let prefs = self.preferences()?;
                let probe=self.worker("metadata.coverProbe",json!({"source":source,"code":code,"url":url,"proxy":platform::proxy(&prefs,&url)?,"cookie":self.credential(source)?,"transport":platform::transport(source,&prefs)}),job,|_|Ok(()));
                if let Ok(outcome) = probe {
                    self.hold(source, &outcome)?;
                    if outcome["probe"].is_object()
                        && number(&outcome["probe"], "width") > 0
                        && number(&outcome["probe"], "height") > 0
                    {
                        cover["probe"] = outcome["probe"].clone();
                        available.push((record, cover, None));
                    }
                }
            }
            // Keep source priority, then choose the largest verified image in that source tier.
            available.sort_by_key(|(_, cover, _)| {
                std::cmp::Reverse(
                    number(&cover["probe"], "width")
                        .saturating_mul(number(&cover["probe"], "height")),
                )
            });
            for (record, cover, cached) in available {
                job.running()?;
                let asset = if let Some(asset) = cached {
                    Some(asset)
                } else {
                    self.fetch_image(
                        text(&record, "source"),
                        text(&cover, "url"),
                        Some(&code),
                        job,
                        false,
                        None,
                    )
                    .ok()
                    .map(|saved| saved["original"].clone())
                };
                if let Some(asset) = asset {
                    selected = Some((record, cover, asset));
                    break;
                }
            }
            if let Some((_record, cover, asset)) = selected {
                job.running()?;
                let cover_id = text(&cover, "id").to_string();
                self.mutate_query(id, |task| {
                    if text(task, "status") == "running" {
                        for record in task["records"].as_array_mut().unwrap() {
                            for candidate in record["covers"].as_array_mut().unwrap() {
                                if text(candidate, "id") == cover_id {
                                    candidate["asset"] = asset.clone();
                                    candidate.as_object_mut().unwrap().remove("error");
                                }
                            }
                        }
                    }
                })?;
                let mut store = self.0.store.lock().map_err(|_| "存储不可用")?;
                job.running()?;
                let mut cached = asset.clone();
                cached["cachedAt"] = json!(millis());
                store.metadata["assets"][&cover_id] = cached;
                images::pin(&store, &format!("query:{id}:{code}"), text(&cover, "url"))?;
                store.commit_metadata()?;
            }
        }
        Ok(())
    }
}
