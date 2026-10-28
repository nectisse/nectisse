use crate::{
    backend::Backend,
    images, platform,
    store::{self},
    util::*,
};
use rusqlite::params;
use serde_json::{json, Value};

impl Backend {
    pub fn save_work(&self, input: &Value) -> Result<Value> {
        let task_id = text(input, "taskId");
        uuid(task_id)?;
        let code = text(input, "code");
        if code.is_empty() || code.chars().count() > 100 {
            return Err("作品编号不正确".into());
        }
        let mut records = {
            let store = self.0.store.lock().map_err(|_| "存储不可用")?;
            let task = array(&store.metadata, "tasks")
                .into_iter()
                .find(|task| text(task, "id") == task_id)
                .ok_or("查询记录已不在最近列表，请重新查询后收藏")?;
            let mut records: Vec<Value> = array(&task, "records")
                .into_iter()
                .filter(|record| text(record, "code") == code)
                .collect();
            let priorities = array(&store.preferences()?, "metadataPriority");
            records.sort_by_key(|record| {
                priorities
                    .iter()
                    .position(|source| source == &record["source"])
                    .unwrap_or(priorities.len())
            });
            records
        };
        if records.is_empty() {
            return Err("查询记录不存在，请重新查询后收藏".into());
        }
        let id = hash(format!("work:{code}"));
        let previous = self.0.store.lock().map_err(|_| "存储不可用")?.work(&id)?;
        if previous.is_some() && !flag(input, "replace") {
            return Ok(json!({"ok":true,"id":id}));
        }
        let covers: Vec<Value> = records
            .iter()
            .flat_map(|record| array(record, "covers"))
            .collect();
        let selected = if text(input, "coverId").is_empty() {
            covers
                .iter()
                .find(|cover| cover["asset"].is_object())
                .or_else(|| covers.first())
        } else {
            covers.iter().find(|cover| cover["id"] == input["coverId"])
        }
        .cloned();
        if input.get("coverId").is_some() && selected.is_none() {
            return Err("选定封面不在查询记录中".into());
        }
        let image = if let Some(cover) = &selected {
            if cover["asset"].is_object() {
                self.image("image", text(cover, "id"), "original")?
            } else {
                None
            }
        } else {
            None
        };
        if previous
            .as_ref()
            .is_some_and(|work| store::summary(work)["cover"]["asset"].is_object())
            && image.is_none()
        {
            return Err("选定封面尚未取得，原有收藏已保留".into());
        }
        if selected
            .as_ref()
            .is_some_and(|cover| cover["asset"].is_object())
            && image.is_none()
        {
            return Err("选定封面的本地缓存不可用，请重新查询".into());
        }
        let store = self.0.store.lock().map_err(|_| "存储不可用")?;
        let count: i64 = store
            .library
            .query_row("SELECT count(*) FROM works", [], |row| row.get(0))
            .map_err(|_| "收藏数量读取失败")?;
        if previous.is_none() && count >= 5000 {
            return Err("当前最多收藏5000部作品，请先整理收藏".into());
        }
        let owner = format!("collection:{id}");
        let pending = format!("{owner}:pending:{}", uuid::Uuid::new_v4());
        if let (Some(image), Some(cover)) = (&image, &selected) {
            images::put(
                &store,
                text(cover, "url"),
                &image.bytes,
                false,
                Some(&pending),
            )?;
        }
        for record in &mut records {
            for cover in record["covers"]
                .as_array_mut()
                .ok_or("封面记录格式不正确")?
            {
                if let Some(image) = &image {
                    if selected
                        .as_ref()
                        .is_some_and(|selected| cover["id"] == selected["id"])
                    {
                        cover["asset"] = image.asset.clone();
                        continue;
                    }
                }
                cover
                    .as_object_mut()
                    .ok_or("封面记录格式不正确")?
                    .remove("asset");
            }
        }
        let work = json!({"id":id,"code":code,"records":records,"coverId":selected.as_ref().map(|cover|cover["id"].clone()),"savedAt":previous.as_ref().map(|work|work["savedAt"].clone()).unwrap_or(json!(now())),"updatedAt":now()});
        crate::contracts::validate("work", &work)?;
        let result=store.library.execute("INSERT INTO works VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET cover_sha=excluded.cover_sha,value=excluded.value,summary=excluded.summary",params![id,image.as_ref().map(|image|text(&image.asset,"sha256")),work.to_string(),store::summary(&work).to_string()]).map_err(|_|"收藏未能保存，原有收藏已保留");
        if result.is_ok() {
            if let Some(cover) = &selected {
                if image.is_some() {
                    images::pin(&store, &owner, text(cover, "url"))?;
                }
            }
        }
        let _ = images::unpin(&store, &pending);
        result?;
        drop(store);
        self.publish_library();
        Ok(json!({"ok":true,"id":id}))
    }

    pub fn remove_work(&self, id: &str) -> Result<Value> {
        if !is_hash(id, 64) {
            return Err("收藏身份不正确".into());
        }
        let store = self.0.store.lock().map_err(|_| "存储不可用")?;
        let work = store.work(id)?;
        store
            .library
            .execute("DELETE FROM works WHERE id=?", [id])
            .map_err(|_| "取消收藏未完成")?;
        images::unpin(&store, &format!("collection:{id}"))?;
        if let Some(work) = work {
            for source in ["sukebei", "javtao"] {
                let _ = std::fs::remove_file(
                    store
                        .root
                        .join("magnet-search/saved")
                        .join(format!("{source}-{}.json", hash(text(&work, "code")))),
                );
            }
        }
        drop(store);
        self.publish_library();
        Ok(json!({"ok":true}))
    }

    pub fn open_source(&self, scope: &str, id: &str, record_id: &str) -> Result<()> {
        if !is_hash(record_id, 64) {
            return Err("作品来源身份不正确".into());
        }
        let store = self.0.store.lock().map_err(|_| "存储不可用")?;
        let records = if scope == "library" {
            if !is_hash(id, 64) {
                return Err("收藏身份不正确".into());
            }
            array(&store.work(id)?.ok_or("收藏已不存在")?, "records")
        } else {
            uuid(id)?;
            array(
                &array(&store.metadata, "tasks")
                    .into_iter()
                    .find(|task| text(task, "id") == id)
                    .ok_or("查询记录已不存在")?,
                "records",
            )
        };
        let record = records
            .into_iter()
            .find(|record| text(record, "id") == record_id)
            .ok_or("来源记录已不存在")?;
        let source = text(&record, "source");
        let url = text(&record, "sourceUrl").to_string();
        let legacy = match source {
            "fc2club" => "fc2club.top",
            "kmib" => "k-mib.com",
            "fc2cmadb" => "fc2cmadb.com",
            _ => "",
        };
        let valid = platform::allowed_url(source, &url, "page")
            || (!legacy.is_empty()
                && url::Url::parse(&url).is_ok_and(|url| {
                    url.scheme() == "https"
                        && url.host_str() == Some(legacy)
                        && url.username().is_empty()
                        && url.password().is_none()
                }));
        if !valid {
            return Err("来源地址不正确".into());
        }
        drop(store);
        self.open_url(&url)
    }
}
