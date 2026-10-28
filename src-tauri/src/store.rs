use crate::util::*;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub const RETAINED: &str =
    "COALESCE(json_extract(value,'$.provider'),'') NOT IN ('subscribestar','rule34video')";
pub const PUBLICATION: &str = "COALESCE(julianday(json_extract(value,'$.publishedAt')),julianday(first_seen)) DESC,first_seen DESC,rowid ASC";

pub struct Store {
    pub root: PathBuf,
    pub db: Connection,
    pub library: Connection,
    pub images: Connection,
    pub metadata: Value,
    pub magnets: Value,
    pub revision: i64,
}

pub fn catalog() -> Value {
    serde_json::from_str(include_str!("../resources/catalog.json"))
        .expect("invalid bundled source catalog")
}

pub fn source(id: &str) -> Result<Value> {
    array(&catalog(), "sources")
        .into_iter()
        .find(|row| text(row, "id") == id)
        .ok_or_else(|| "来源尚未支持".into())
}

pub fn performer(id: &str) -> bool {
    ["javdb", "javtao"].contains(&id)
}

pub fn connection(path: &Path) -> Result<Connection> {
    directory(path.parent().ok_or("无效的数据目录")?)?;
    let connection =
        Connection::open(path).map_err(|_| "无法打开本机数据库，原文件已保留".to_string())?;
    connection
        .busy_timeout(std::time::Duration::from_secs(3))
        .map_err(|_| "本机数据库暂不可用")?;
    connection
        .execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
        .map_err(|_| "本机数据库格式不正确")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|_| "无法设置数据库权限")?;
    }
    Ok(connection)
}

pub fn json_rows(
    connection: &Connection,
    query: &str,
    values: impl rusqlite::Params,
) -> Result<Vec<Value>> {
    let mut statement = connection.prepare(query).map_err(|_| "本机记录读取失败")?;
    let rows = statement
        .query_map(values, |row| row.get::<_, String>(0))
        .map_err(|_| "本机记录读取失败")?;
    rows.map(|row| {
        serde_json::from_str(&row.map_err(|_| "本机记录读取失败")?)
            .map_err(|_| "本机记录格式不兼容".into())
    })
    .collect()
}

impl Store {
    pub fn open(root: PathBuf) -> Result<Self> {
        directory(&root)?;
        let db = connection(&root.join("nectisse.sqlite"))?;
        db.execute_batch("CREATE TABLE IF NOT EXISTS preferences (id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS credentials (provider TEXT PRIMARY KEY,ciphertext BLOB NOT NULL);
            CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY,provider TEXT NOT NULL,ref TEXT NOT NULL,value TEXT NOT NULL,UNIQUE(provider,ref));
            CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY,subscription_id TEXT NOT NULL,external_id TEXT NOT NULL,value TEXT NOT NULL,first_seen TEXT NOT NULL,UNIQUE(subscription_id,external_id));
            CREATE INDEX IF NOT EXISTS entries_subscription ON entries(subscription_id);
            CREATE TABLE IF NOT EXISTS follow_tasks (id TEXT PRIMARY KEY,started_at TEXT NOT NULL,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS source_status (id TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS follow_images (url TEXT PRIMARY KEY,value TEXT NOT NULL,saved_at INTEGER NOT NULL);
            PRAGMA user_version=1;").map_err(|_| "本机订阅数据库未准备完成")?;
        let library = connection(&root.join("library/library.sqlite"))?;
        library.execute_batch("CREATE TABLE IF NOT EXISTS works (id TEXT PRIMARY KEY,cover_sha TEXT,value TEXT NOT NULL,summary TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS works_cover ON works(cover_sha);").map_err(|_| "本机收藏库未准备完成")?;
        let columns = library
            .prepare("PRAGMA table_info(works)")
            .map_err(|_| "本机收藏库读取失败")?
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|_| "本机收藏库读取失败")?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|_| "本机收藏库读取失败")?;
        if !columns.iter().any(|column| column == "summary") {
            library
                .execute_batch("ALTER TABLE works ADD COLUMN summary TEXT")
                .map_err(|_| "本机收藏库迁移失败，原文件已保留")?;
            for work in json_rows(&library, "SELECT value FROM works", [])? {
                library
                    .execute(
                        "UPDATE works SET summary=? WHERE id=?",
                        params![summary(&work).to_string(), text(&work, "id")],
                    )
                    .map_err(|_| "本机收藏库迁移失败")?;
            }
        }
        let images = connection(&root.join("images/images.sqlite"))?;
        images.execute_batch("CREATE TABLE IF NOT EXISTS objects (sha TEXT PRIMARY KEY,asset TEXT NOT NULL,kind TEXT NOT NULL,accessed REAL NOT NULL,hits INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS refs (key TEXT PRIMARY KEY,original TEXT,thumbnail TEXT,fetched REAL NOT NULL,accessed REAL NOT NULL,unread INTEGER NOT NULL DEFAULT 0,seen REAL NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS pins (owner TEXT NOT NULL,sha TEXT NOT NULL,PRIMARY KEY(owner,sha));
            CREATE INDEX IF NOT EXISTS refs_original ON refs(original);
            CREATE INDEX IF NOT EXISTS refs_thumbnail ON refs(thumbnail);
            CREATE INDEX IF NOT EXISTS pins_sha ON pins(sha);").map_err(|_| "本机图片库未准备完成")?;
        let image_columns = images
            .prepare("PRAGMA table_info(objects)")
            .map_err(|_| "图片数据库不可读")?
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|_| "图片数据库不可读")?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|_| "图片数据库不可读")?;
        if !image_columns.iter().any(|column| column == "hits") {
            images
                .execute_batch("ALTER TABLE objects ADD COLUMN hits INTEGER NOT NULL DEFAULT 0")
                .map_err(|_| "图片数据库迁移失败")?;
        }
        directory(&root.join("images/objects"))?;
        let metadata = read_json(
            &root.join("metadata/state.json"),
            16 * 1024 * 1024,
            json!({"version":1,"revision":0,"tasks":[],"assets":{},"policies":{}}),
        )?;
        let magnets = read_json(
            &root.join("magnet-search/state.json"),
            6 * 1024 * 1024,
            json!({"version":1,"results":[],"nextRequestAt":0,"cooldownUntil":0,"policies":{}}),
        )?;
        let mut store = Self {
            root,
            db,
            library,
            images,
            metadata,
            magnets,
            revision: millis(),
        };
        if !store.metadata["tasks"].is_array() || !store.magnets["results"].is_array() {
            return Err("本机记录格式不兼容".into());
        }
        for task in store.metadata["tasks"].as_array_mut().unwrap() {
            if ["running", "cancelling"].contains(&text(task, "status")) {
                task["status"] = json!(if text(task, "cancelRequestedAt").is_empty() {
                    "interrupted"
                } else {
                    "cancelled"
                });
                task["phase"] = json!("上次查询已中断，可手动重新查询");
                task["finishedAt"] = json!(now());
            }
        }
        store.metadata.as_object_mut().unwrap().remove("activeId");
        for result in store.magnets["results"]
            .as_array_mut()
            .ok_or("磁链记录格式不正确")?
        {
            if ["running", "cancelling"].contains(&text(result, "status")) {
                result["status"] = json!("interrupted");
                result["message"] = json!("上次查询已中断，可手动重新查询");
            }
        }
        for mut task in store.tasks()? {
            if ["running", "cancelling"].contains(&text(&task, "status")) {
                task["status"] = json!(if text(&task, "cancelRequestedAt").is_empty() {
                    "interrupted"
                } else {
                    "cancelled"
                });
                task["finishedAt"] = json!(now());
                task["phase"] = json!("上次任务已停止，不会自动恢复");
                if let Some(mut sub) = store.subscription(text(&task, "subscriptionId"))? {
                    sub["autoPaused"] = json!(true);
                    sub["lastError"] = json!("上次任务已停止；请手动检查或恢复自动检查");
                    store.save_subscription(&sub)?;
                }
                store.save_task(&task)?;
            }
        }
        store.preferences()?;
        crate::contracts::validate("metadata", &store.metadata_state())?;
        Ok(store)
    }

    pub fn preferences(&self) -> Result<Value> {
        let mut defaults = catalog()["preferences"].clone();
        let rows = json_rows(&self.db, "SELECT value FROM preferences WHERE id=1", [])?;
        if let Some(saved) = rows.first() {
            let mut magnets = defaults["magnetSearch"].clone();
            merge(&mut magnets, &saved["magnetSearch"]);
            merge(&mut defaults, saved);
            defaults["magnetSearch"] = magnets;
        }
        for key in [
            "querySources",
            "enabledSources",
            "metadataPriority",
            "coverPriority",
        ] {
            let values = defaults[key].as_array_mut().ok_or("设置记录格式不正确")?;
            values.retain(|id| {
                ![
                    "rule34video",
                    "subscribestar",
                    "rule34xxx",
                    "rule34paheal",
                    "fc2club",
                    "kmib",
                    "fc2cmadb",
                ]
                .contains(&id.as_str().unwrap_or(""))
            });
        }
        crate::contracts::validate("preferences", &defaults)?;
        Ok(defaults)
    }

    pub fn save_preferences(&self, value: &Value) -> Result<()> {
        self.db.execute("INSERT INTO preferences VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",[value.to_string()]).map(|_|()).map_err(|_|"设置未能保存".into())
    }

    pub fn subscriptions(&self) -> Result<Vec<Value>> {
        let mut values = json_rows(
            &self.db,
            &format!("SELECT value FROM subscriptions WHERE {RETAINED} ORDER BY rowid DESC"),
            [],
        )?;
        for value in &mut values {
            let id = text(value, "id").to_string();
            let total: i64 = self
                .db
                .query_row(
                    "SELECT count(*) FROM entries WHERE subscription_id=?",
                    [&id],
                    |row| row.get(0),
                )
                .map_err(|_| "订阅数量读取失败")?;
            let unread: i64 = self.db.query_row("SELECT count(*) FROM entries WHERE subscription_id=? AND json_extract(value,'$.read')=0",[&id],|row|row.get(0)).map_err(|_|"未读数量读取失败")?;
            value["collected"] = json!(total);
            value["unread"] = json!(unread);
            let order = if performer(text(value, "provider")) {
                "first_seen DESC,rowid ASC"
            } else {
                PUBLICATION
            };
            if let Some(latest) = json_rows(
                &self.db,
                &format!(
                    "SELECT value FROM entries WHERE subscription_id=? ORDER BY {order} LIMIT 1"
                ),
                [&id],
            )?
            .first()
            {
                value["latestEntry"] = latest.clone();
            }
        }
        Ok(values)
    }

    pub fn subscription(&self, id: &str) -> Result<Option<Value>> {
        Ok(json_rows(
            &self.db,
            &format!("SELECT value FROM subscriptions WHERE id=? AND {RETAINED}"),
            [id],
        )?
        .into_iter()
        .next())
    }

    pub fn save_subscription(&self, value: &Value) -> Result<()> {
        self.db.execute("INSERT INTO subscriptions VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",params![text(value,"id"),text(value,"provider"),text(value,"ref"),value.to_string()]).map(|_|()).map_err(|_|"关注记录未能保存".into())
    }

    pub fn follow(&self, candidate: &Value) -> Result<Value> {
        crate::contracts::validate("candidate", candidate)?;
        let previous = json_rows(
            &self.db,
            "SELECT value FROM subscriptions WHERE provider=? AND ref=?",
            params![text(candidate, "provider"), text(candidate, "ref")],
        )?
        .into_iter()
        .next();
        let mut value=previous.unwrap_or_else(||{
            let mut value=candidate.clone();
            merge(&mut value,&json!({"id":uuid::Uuid::new_v4().to_string(),"kind":if performer(text(candidate,"provider")){"performer_releases"}else{"creator_posts"},"following":true,"enabled":true,"autoPaused":false,"intervalMinutes":null,"createdAt":now(),"initialized":false,"lastCheckedAt":"","nextCheckAt":"","lastError":"","coverage":"等待首次检查","failureCount":0,"unread":0}));value
        });
        merge(
            &mut value,
            &json!({"following":true,"enabled":true,"autoPaused":false}),
        );
        if text(candidate, "provider") == "x" {
            for key in ["name", "handle", "url", "bio"] {
                if let Some(field) = candidate.get(key) {
                    value[key] = field.clone();
                }
            }
        }
        if !text(candidate, "avatarUrl").is_empty() {
            value["avatarUrl"] = candidate["avatarUrl"].clone();
            if candidate["avatarAsset"].is_object() {
                value["avatarAsset"] = candidate["avatarAsset"].clone();
            }
        }
        self.save_subscription(&value)?;
        Ok(value)
    }

    pub fn entries(&self) -> Result<Vec<Value>> {
        json_rows(&self.db,&format!("SELECT value FROM entries WHERE {RETAINED} ORDER BY first_seen DESC,rowid ASC LIMIT 500"),[])
    }

    pub fn entry(&self, id: &str) -> Result<Option<Value>> {
        Ok(json_rows(
            &self.db,
            &format!("SELECT value FROM entries WHERE id=? AND {RETAINED}"),
            [id],
        )?
        .into_iter()
        .next())
    }

    pub fn entry_page(&self, request: &Value) -> Result<Value> {
        let id = text(request, "subscriptionId");
        uuid(id)?;
        let page = number(request, "page");
        let size = number(request, "pageSize");
        if !(1..=1_000_000).contains(&page) || !(1..=100).contains(&size) {
            return Err("分页格式不正确".into());
        }
        let filter = if flag(request, "unread") {
            " AND json_extract(value,'$.read')=0"
        } else {
            ""
        };
        let predicate = format!("subscription_id=? AND {RETAINED}{filter}");
        let order = if self
            .subscription(id)?
            .is_some_and(|s| text(&s, "kind") == "creator_posts")
        {
            PUBLICATION
        } else {
            "first_seen DESC,rowid ASC"
        };
        let total: i64 = self
            .db
            .query_row(
                &format!("SELECT count(*) FROM entries WHERE {predicate}"),
                [id],
                |row| row.get(0),
            )
            .map_err(|_| "帖子数量读取失败")?;
        let entries = json_rows(
            &self.db,
            &format!(
                "SELECT value FROM entries WHERE {predicate} ORDER BY {order} LIMIT ? OFFSET ?"
            ),
            params![id, size, (page - 1) * size],
        )?;
        let retryable=self.db.query_row("SELECT 1 FROM entries WHERE subscription_id=? AND json_extract(value,'$.thumbnailUrl')<>'' AND json_extract(value,'$.imageAsset') IS NULL AND json_extract(value,'$.imageCache.status') IN ('failed','cancelled','evicted','retry') LIMIT 1",[id],|row|row.get::<_,i64>(0)).optional().map_err(|_|"帖子读取失败")?.is_some();
        Ok(
            json!({"entries":entries,"total":total,"page":page,"pageSize":size,"retryable":retryable}),
        )
    }

    pub fn upsert_entry(&self, sub: &Value, input: &Value) -> Result<bool> {
        crate::contracts::validate("entry", input)?;
        let id = hash(format!("{}:{}", text(sub, "id"), text(input, "externalId")));
        let previous = self.entry(&id)?;
        let mut entry = input.clone();
        if let Some(old) = &previous {
            if !flag(old, "partial") && flag(input, "partial") {
                entry["summary"] = old["summary"].clone();
                entry["partial"] = json!(false);
            }
            if text(&entry, "thumbnailUrl").is_empty() {
                entry["thumbnailUrl"] = old["thumbnailUrl"].clone();
            }
            if text(&entry, "thumbnailUrl") == text(old, "thumbnailUrl") {
                for key in ["imageAsset", "imageCache"] {
                    if let Some(value) = old.get(key) {
                        entry[key] = value.clone();
                    }
                }
            }
        }
        merge(
            &mut entry,
            &json!({"id":id,"subscriptionId":sub["id"],"provider":sub["provider"],"name":if text(sub,"provider")=="x"{input["author"].clone()}else{sub["name"].clone()},"firstSeenAt":previous.as_ref().map(|row|row["firstSeenAt"].clone()).unwrap_or(json!(now())),"read":previous.as_ref().is_some_and(|row|flag(row,"read")),"initial":previous.as_ref().map(|row|flag(row,"initial")).unwrap_or(!flag(sub,"initialized"))}),
        );
        self.save_entry(&entry)?;
        Ok(previous.is_none())
    }

    pub fn save_entry(&self, entry: &Value) -> Result<()> {
        self.db.execute("INSERT INTO entries VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",params![text(entry,"id"),text(entry,"subscriptionId"),text(entry,"externalId"),entry.to_string(),text(entry,"firstSeenAt")]).map(|_|()).map_err(|_|"帖子未能保存".into())
    }

    pub fn mark_read(&self, ids: &[Value], read: bool) -> Result<()> {
        if ids.len() > 500 {
            return Err("单次最多处理500条".into());
        }
        let transaction = self
            .db
            .unchecked_transaction()
            .map_err(|_| "无法开始保存已读状态")?;
        for id in ids {
            if let Some(mut entry) = self.entry(id.as_str().ok_or("帖子身份不正确")?)? {
                entry["read"] = json!(read);
                self.save_entry(&entry)?;
            }
        }
        transaction.commit().map_err(|_| "已读状态未能保存".into())
    }

    pub fn tasks(&self) -> Result<Vec<Value>> {
        json_rows(&self.db,&format!("SELECT value FROM follow_tasks WHERE {RETAINED} ORDER BY started_at DESC,rowid DESC LIMIT 20"),[])
    }

    pub fn save_task(&self, task: &Value) -> Result<()> {
        let transaction = self
            .db
            .unchecked_transaction()
            .map_err(|_| "任务未能保存")?;
        transaction.execute("INSERT INTO follow_tasks VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",params![text(task,"id"),text(task,"startedAt"),task.to_string()]).map_err(|_|"任务未能保存")?;
        transaction.execute("DELETE FROM follow_tasks WHERE id NOT IN (SELECT id FROM follow_tasks ORDER BY started_at DESC,rowid DESC LIMIT 20)",[]).map_err(|_|"任务列表未能保存")?;
        transaction.commit().map_err(|_| "任务列表未能保存".into())
    }

    pub fn policy(&self, id: &str) -> Result<Value> {
        Ok(json_rows(&self.db,"SELECT value FROM source_status WHERE id=?",[id])?.into_iter().next().unwrap_or(json!({"checkedAt":"","state":"未检查","message":"","cooldownUntil":0,"nextRequestAt":0})))
    }

    pub fn save_policy(&self, id: &str, value: &Value) -> Result<()> {
        self.db.execute("INSERT INTO source_status VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",params![id,value.to_string()]).map(|_|()).map_err(|_|"来源状态未能保存".into())
    }

    pub fn subscriptions_state(&mut self, encryption: bool) -> Result<Value> {
        self.revision += 1;
        let sources: Result<Vec<Value>> = array(&catalog(), "sources")
            .into_iter()
            .map(|spec| {
                let id = text(&spec, "id");
                let mut policy = self.policy(id)?;
                let credential = self
                    .db
                    .query_row("SELECT 1 FROM credentials WHERE provider=?", [id], |row| {
                        row.get::<_, i64>(0)
                    })
                    .optional()
                    .map_err(|_| "凭据状态读取失败")?
                    .is_some();
                policy["id"] = json!(id);
                policy["credentialPresent"] = json!(credential);
                Ok(policy)
            })
            .collect();
        Ok(
            json!({"revision":self.revision,"preferences":self.preferences()?,"subscriptions":self.subscriptions()?,"entries":self.entries()?,"tasks":self.tasks()?,"sources":sources?,"encryptionAvailable":encryption,"notice":""}),
        )
    }

    pub fn metadata_state(&self) -> Value {
        let mut value = self.metadata.clone();
        if let Some(object) = value.as_object_mut() {
            object.remove("assets");
            object.remove("policies");
            object.remove("version");
        }
        value
    }

    pub fn commit_metadata(&mut self) -> Result<()> {
        crate::contracts::validate("metadata", &self.metadata_state())?;
        self.metadata["revision"] = json!(number(&self.metadata, "revision") + 1);
        write_json(&self.root.join("metadata/state.json"), &self.metadata)
    }

    pub fn commit_magnets(&self) -> Result<()> {
        write_json(&self.root.join("magnet-search/state.json"), &self.magnets)
    }

    pub fn work(&self, id: &str) -> Result<Option<Value>> {
        Ok(
            json_rows(&self.library, "SELECT value FROM works WHERE id=?", [id])?
                .into_iter()
                .next(),
        )
    }

    pub fn library_state(&mut self) -> Result<Value> {
        self.revision += 1;
        Ok(
            json!({"revision":self.revision,"works":json_rows(&self.library,"SELECT summary FROM works ORDER BY json_extract(summary,'$.savedAt') DESC",[])?}),
        )
    }
}

pub fn summary(work: &Value) -> Value {
    let records = array(work, "records");
    let first = |key: &str| {
        records
            .iter()
            .find_map(|record| {
                let value = &record[key];
                if if ["people", "tags"].contains(&key) {
                    value.as_array().is_some_and(|a| !a.is_empty())
                } else {
                    value.as_str().is_some_and(|s| !s.is_empty())
                } {
                    Some(value.clone())
                } else {
                    None
                }
            })
            .unwrap_or_else(|| {
                if ["people", "tags"].contains(&key) {
                    json!([])
                } else {
                    json!("")
                }
            })
    };
    let mut value = json!({"id":work["id"],"code":work["code"],"savedAt":work["savedAt"],"updatedAt":work["updatedAt"],"title":first("title"),"people":first("people").as_array().unwrap().iter().filter(|p|text(p,"role")=="performer").map(|p|p["name"].clone()).collect::<Vec<_>>(),"studio":first("studio"),"releaseDate":first("releaseDate"),"tags":first("tags")});
    if text(&value, "title").is_empty() {
        value["title"] = work["code"].clone();
    }
    if let Some(cover) = records
        .iter()
        .flat_map(|r| array(r, "covers"))
        .find(|c| c["id"] == work["coverId"])
    {
        value["cover"] = cover;
    }
    value
}
