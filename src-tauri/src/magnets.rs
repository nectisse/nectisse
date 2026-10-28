use crate::{backend::Backend, util::*};
use serde_json::{json, Value};
use std::sync::atomic::Ordering;

fn result(
    code: &str,
    source: &str,
    limit: i64,
    status: &str,
    message: &str,
    reason: &str,
) -> Value {
    json!({"code":code,"source":source,"limit":limit,"status":status,"items":[],"checkedAt":now(),"message":message,"reason":reason,"requests":0,"retryAfter":0})
}

fn valid_result(value: &Value, code: &str, source: &str) -> bool {
    if crate::contracts::validate("magnet", value).is_err() {
        return false;
    }
    if text(value, "code") != code
        || text(value, "source") != source
        || !["ready", "failed", "cancelled", "interrupted", "running"]
            .contains(&text(value, "status"))
        || array(value, "items").len() > 20
    {
        return false;
    }
    array(value, "items").iter().all(|item| {
        let id = text(item, "id");
        if !is_hash(id, 40)
            || text(item, "title").is_empty()
            || text(item, "title").chars().count() > 300
        {
            return false;
        }
        let Ok(url) = url::Url::parse(text(item, "url")) else {
            return false;
        };
        if url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return false;
        }
        let valid_url = if source == "sukebei" {
            url.host_str() == Some("sukebei.nyaa.si")
                && regex::Regex::new(r"^/view/\d+$")
                    .unwrap()
                    .is_match(url.path())
        } else {
            url.host_str() == Some("javtao.com")
                && regex::Regex::new(r"^/[a-z0-9][a-z0-9_-]{1,95}$")
                    .unwrap()
                    .is_match(url.path())
        };
        let Some(query) = text(item, "magnet").strip_prefix("magnet:?") else {
            return false;
        };
        valid_url
            && url::form_urlencoded::parse(query.as_bytes())
                .any(|(key, value)| key == "xt" && value.to_lowercase() == format!("urn:btih:{id}"))
    })
}

impl Backend {
    pub fn magnet_search(&self, request: &Value) -> Result<Value> {
        let id = text(request, "id");
        uuid(id)?;
        let source = request
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or("sukebei");
        if !["sukebei", "javtao"].contains(&source) {
            return Err("磁链来源不正确".into());
        }
        let (code, saved) = {
            let store = self.0.store.lock().map_err(|_| "存储不可用")?;
            let origin = &request["origin"];
            match text(origin, "kind") {
                "library" => (
                    store.work(text(origin, "id"))?.ok_or("收藏已不存在")?["code"]
                        .as_str()
                        .ok_or("作品编号不正确")?
                        .to_string(),
                    true,
                ),
                "query" => {
                    let task = array(&store.metadata, "tasks")
                        .into_iter()
                        .find(|task| task["id"] == origin["taskId"])
                        .ok_or("查询记录已不存在")?;
                    let record = array(&task, "records")
                        .into_iter()
                        .find(|record| record["code"] == origin["code"])
                        .ok_or("作品查询记录已不存在")?;
                    (text(&record, "code").to_string(), false)
                }
                _ => return Err("磁链查询身份不正确".into()),
            }
        };
        if !regex::Regex::new(r"^[A-Z0-9]+(?:[-_][A-Z0-9]+)*$")
            .unwrap()
            .is_match(&code)
            || code.len() > 64
        {
            return Err("作品编号不正确".into());
        }
        let settings = self.preferences()?["magnetSearch"].clone();
        let limit = number(&settings, "maxResults");
        if !flag(&settings, "enabled") {
            return Ok(result(
                &code,
                source,
                limit,
                "failed",
                "磁链搜索已关闭，可在设置中启用",
                "disabled",
            ));
        }
        let saved_path = self
            .0
            .root
            .join("magnet-search/saved")
            .join(format!("{source}-{}.json", hash(&code)));
        if !flag(request, "force") {
            if saved {
                let cached = read_json(&saved_path, 512 * 1024, Value::Null)?;
                if !cached.is_null() {
                    if !valid_result(&cached, &code, source) || text(&cached, "status") != "ready" {
                        return Err("已保存的磁链结果无法读取，请手动刷新".into());
                    }
                    return Ok(present(cached, limit));
                }
            }
            let cached = array(
                &self.0.store.lock().map_err(|_| "存储不可用")?.magnets,
                "results",
            )
            .into_iter()
            .find(|item| text(item, "code") == code && text(item, "source") == source);
            if let Some(cached) = cached {
                let fresh = millis() - stamp(text(&cached, "checkedAt"))
                    < if array(&cached, "items").is_empty() {
                        3_600_000
                    } else {
                        86_400_000
                    };
                if text(&cached, "status") == "ready"
                    && (saved || (fresh && number(&cached, "limit") >= limit))
                {
                    if saved {
                        write_json(&saved_path, &cached)?;
                    }
                    return Ok(present(cached, limit));
                }
                if ["failed", "cancelled", "interrupted"].contains(&text(&cached, "status")) {
                    return Ok(present(cached, limit));
                }
            }
        }
        if self.active("magnet:") {
            return Ok(result(
                &code,
                source,
                limit,
                "failed",
                "已有磁链查询正在进行，请稍后重试",
                "busy",
            ));
        }
        let job = self.job(
            &format!("magnet:{id}"),
            if source == "javtao" { 4 } else { 3 },
        )?;
        let operation: Result<Value> = (|| {
            let params = json!({"code":code,"source":source,"proxy":self.route(source,"magnet")?,"maxResults":limit,"transport":if source=="javtao"{"fingerprint"}else{text(&settings,"transport")}});
            let mut output = self.worker("magnet.search", params, &job, |_| Ok(()))?;
            job.running()?;
            merge(
                &mut output,
                &json!({"code":code,"source":source,"limit":limit,"checkedAt":now(),"requests":job.requests.load(Ordering::SeqCst)}),
            );
            if !valid_result(&output, &code, source) {
                return Err("磁链返回格式不正确".into());
            }
            self.hold(source, &output)?;
            Ok(output)
        })();
        let mut output = if job.cancelled.load(Ordering::SeqCst) {
            result(
                &code,
                source,
                limit,
                "cancelled",
                "查询已取消，可手动重新查询",
                "",
            )
        } else {
            operation.unwrap_or_else(|message| {
                result(&code, source, limit, "failed", &message, "network")
            })
        };
        let mut store = self.0.store.lock().map_err(|_| "存储不可用")?;
        if job.cancelled.load(Ordering::SeqCst) || store.preferences()?["magnetSearch"] != settings
        {
            output = result(
                &code,
                source,
                limit,
                "cancelled",
                "查询已取消，可手动重新查询",
                "",
            );
        }
        let mut results = array(&store.magnets, "results");
        results.retain(|item| !(text(item, "code") == code && text(item, "source") == source));
        results.insert(0, output.clone());
        results.truncate(50);
        store.magnets["results"] = json!(results);
        store.commit_magnets()?;
        if saved
            && store.work(text(&request["origin"], "id"))?.is_some()
            && text(&output, "status") == "ready"
            && !job.cancelled.load(Ordering::SeqCst)
        {
            write_json(&saved_path, &output)?;
        }
        drop(store);
        self.finish_job(&job.id);
        Ok(present(output, limit))
    }

    pub fn magnet_row(&self, command: &Value) -> Result<Value> {
        let code = text(command, "code");
        let source = command
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or("sukebei");
        if !["sukebei", "javtao"].contains(&source)
            || !is_hash(text(command, "id"), 40)
            || !regex::Regex::new(r"^[A-Z0-9]+(?:[-_][A-Z0-9]+)*$")
                .unwrap()
                .is_match(code)
        {
            return Err("磁链身份不正确".into());
        }
        let store = self.0.store.lock().map_err(|_| "存储不可用")?;
        if !flag(&store.preferences()?["magnetSearch"], "enabled") {
            return Err("磁链搜索已关闭".into());
        }
        let latest = array(&store.magnets, "results").into_iter().find(|result| {
            text(result, "code") == code
                && text(result, "source") == source
                && text(result, "status") == "ready"
        });
        let cached = read_json(
            &store
                .root
                .join("magnet-search/saved")
                .join(format!("{source}-{}.json", hash(code))),
            512 * 1024,
            Value::Null,
        )?;
        for result in latest.iter().chain(std::iter::once(&cached)) {
            if valid_result(result, code, source) {
                if let Some(row) = array(result, "items")
                    .into_iter()
                    .find(|row| row["id"] == command["id"])
                {
                    return Ok(row);
                }
            }
        }
        Err("磁链结果已不存在，请重新搜索".into())
    }
}

fn present(mut value: Value, limit: i64) -> Value {
    if let Some(items) = value["items"].as_array_mut() {
        items.truncate(limit as usize);
    }
    value["limit"] = json!(limit);
    value
}
