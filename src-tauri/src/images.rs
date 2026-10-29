use crate::{
    backend::{Backend, Job},
    platform,
    store::{json_rows, Store},
    util::*,
};
use image::{codecs::jpeg::JpegEncoder, GenericImageView, ImageReader};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::{
    fs,
    io::Cursor,
    sync::{atomic::Ordering, Arc},
};

pub struct Picture {
    pub bytes: Vec<u8>,
    pub asset: Value,
}

pub fn read_hash(store: &Store, sha: &str) -> Result<Option<Picture>> {
    if !is_hash(sha, 64) {
        return Ok(None);
    }
    let row = store
        .images
        .query_row("SELECT asset FROM objects WHERE sha=?", [sha], |row| {
            row.get::<_, String>(0)
        })
        .optional()
        .map_err(|_| "图片记录暂不可读")?;
    if let Some(row) = row {
        let asset: Value = serde_json::from_str(&row).map_err(|_| "图片记录格式不正确")?;
        let path = store
            .root
            .join("images/objects")
            .join(format!("{sha}.image"));
        if let Ok(bytes) = fs::read(path) {
            if bytes.len() as i64 == number(&asset, "bytes") && hash(&bytes) == sha {
                store
                    .images
                    .execute(
                        "UPDATE objects SET accessed=?,hits=hits+1 WHERE sha=?",
                        params![millis(), sha],
                    )
                    .map_err(|_| "图片状态未能保存")?;
                return Ok(Some(Picture { bytes, asset }));
            }
        }
    }
    if store.root.join("images/.legacy-imported").exists() {
        return Ok(None);
    }
    for folder in [
        "cache/covers",
        "cache/subscription-covers",
        "library/covers",
    ] {
        let old = store.root.join(folder).join(format!("{sha}.image"));
        if let Ok(bytes) = fs::read(old) {
            if hash(&bytes) == sha {
                let decoded = decode(&bytes)?;
                let format = match image::guess_format(&bytes).map_err(|_| "图片格式不正确")?
                {
                    image::ImageFormat::Jpeg => "JPEG",
                    image::ImageFormat::Png => "PNG",
                    image::ImageFormat::WebP => "WEBP",
                    _ => continue,
                };
                let asset = asset(&bytes, decoded.width(), decoded.height(), format);
                atomic_write(
                    &store
                        .root
                        .join("images/objects")
                        .join(format!("{sha}.image")),
                    &bytes,
                )?;
                store
                    .images
                    .execute(
                        "INSERT OR IGNORE INTO objects(sha,asset,kind,accessed) VALUES(?,?,?,?)",
                        params![sha, asset.to_string(), "original", millis()],
                    )
                    .map_err(|_| "图片迁移未完成")?;
                return Ok(Some(Picture { bytes, asset }));
            }
        }
    }
    Ok(None)
}

pub fn linked(store: &Store, key: &str, variant: &str) -> Result<Option<Picture>> {
    let column = if variant == "thumbnail" {
        "thumbnail"
    } else {
        "original"
    };
    let row = store
        .images
        .query_row(
            &format!("SELECT {column} FROM refs WHERE key=?"),
            [key],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|_| "图片记录暂不可读")?
        .flatten();
    if let Some(sha) = row {
        return read_hash(store, &sha);
    }
    Ok(None)
}

fn decode(bytes: &[u8]) -> Result<image::DynamicImage> {
    if bytes.is_empty() || bytes.len() > 20 * 1024 * 1024 {
        return Err("请选择不超过20 MiB的图片".into());
    }
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| "无法识别图片")?;
    if !matches!(
        reader.format(),
        Some(image::ImageFormat::Png | image::ImageFormat::Jpeg | image::ImageFormat::WebP)
    ) {
        return Err("请选择 PNG、JPEG 或 WebP 图片".into());
    }
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(160_000_000);
    reader.limits(limits);
    let image = reader.decode().map_err(|_| "图片无法解码或尺寸过大")?;
    if u64::from(image.width()) * u64::from(image.height()) > 40_000_000 {
        return Err("图片尺寸超过4000万像素".into());
    }
    Ok(image)
}

fn jpeg(image: &image::DynamicImage, quality: u8) -> Result<Vec<u8>> {
    let mut output = Vec::new();
    JpegEncoder::new_with_quality(&mut output, quality)
        .encode_image(&image.to_rgb8())
        .map_err(|_| "图片转换失败")?;
    Ok(output)
}

pub fn asset(bytes: &[u8], width: u32, height: u32, format: &str) -> Value {
    json!({"sha256":hash(bytes),"width":width,"height":height,"bytes":bytes.len(),"format":format,"quality":if width>=600||height>=600{"standard"}else{"small"}})
}

pub fn normalize_avatar(bytes: &[u8]) -> Result<Vec<u8>> {
    let decoded = decode(bytes)?;
    let (width, height) = decoded.dimensions();
    let edge = width.min(height);
    jpeg(
        &decoded
            .crop_imm((width - edge) / 2, (height - edge) / 2, edge, edge)
            .resize_exact(
                edge.min(512),
                edge.min(512),
                image::imageops::FilterType::Lanczos3,
            ),
        88,
    )
}

fn install(store: &Store, bytes: &[u8], asset: &Value, kind: &str) -> Result<()> {
    let sha = text(asset, "sha256");
    if !is_hash(sha, 64) || bytes.len() as i64 != number(asset, "bytes") || hash(bytes) != sha {
        return Err("图片哈希不一致".into());
    }
    if read_hash(store, sha)?.is_none() {
        atomic_write(
            &store
                .root
                .join("images/objects")
                .join(format!("{sha}.image")),
            bytes,
        )?;
    }
    store.images.execute("INSERT INTO objects(sha,asset,kind,accessed) VALUES(?,?,?,?) ON CONFLICT(sha) DO UPDATE SET asset=excluded.asset",params![sha,asset.to_string(),kind,millis()]).map(|_|()).map_err(|_|"图片未能保存".into())
}

pub fn pin(store: &Store, owner: &str, key: &str) -> Result<()> {
    let row = store
        .images
        .query_row(
            "SELECT original,thumbnail,fetched,accessed,seen FROM refs WHERE key=?",
            [key],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, f64>(2)?,
                    row.get::<_, f64>(3)?,
                    row.get::<_, f64>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|_| "图片引用不可读")?
        .ok_or("固定图片尚未保存")?;
    if row.0.is_none() {
        return Err("固定图片缺少原图".into());
    }
    let transaction = store
        .images
        .unchecked_transaction()
        .map_err(|_| "图片引用未能保存")?;
    transaction
        .execute("DELETE FROM pins WHERE owner=?", [owner])
        .map_err(|_| "图片引用未能保存")?;
    for sha in [row.0.as_ref(), row.1.as_ref()].into_iter().flatten() {
        transaction
            .execute(
                "INSERT OR IGNORE INTO pins VALUES(?,?)",
                params![owner, sha],
            )
            .map_err(|_| "图片引用未能保存")?;
    }
    transaction
        .execute(
            "INSERT OR REPLACE INTO refs VALUES(?,?,?,?,?,?,?)",
            params![owner, row.0, row.1, row.2, row.3, 0, row.4],
        )
        .map_err(|_| "图片引用未能保存")?;
    transaction.commit().map_err(|_| "图片引用未能保存".into())
}

pub fn unpin(store: &Store, owner: &str) -> Result<()> {
    store
        .images
        .execute("DELETE FROM pins WHERE owner=?", [owner])
        .map_err(|_| "固定图片状态未能保存")?;
    store
        .images
        .execute("DELETE FROM refs WHERE key=?", [owner])
        .map(|_| ())
        .map_err(|_| "固定图片状态未能保存".into())
}

pub fn put(
    store: &Store,
    key: &str,
    bytes: &[u8],
    thumbnail_only: bool,
    owner: Option<&str>,
) -> Result<Value> {
    let decoded = decode(bytes)?;
    if bytes.len() > 12 * 1024 * 1024 {
        return Err("图片文件超过12 MiB".into());
    }
    let format = match image::guess_format(bytes).map_err(|_| "图片格式不正确")? {
        image::ImageFormat::Jpeg => "JPEG",
        image::ImageFormat::Png => "PNG",
        image::ImageFormat::WebP => "WEBP",
        _ => return Err("图片格式不支持".into()),
    };
    let original = asset(bytes, decoded.width(), decoded.height(), format);
    let thumb = decoded.thumbnail(800, 800);
    let thumb_bytes = jpeg(&thumb, 78)?;
    let thumbnail = asset(&thumb_bytes, thumb.width(), thumb.height(), "JPEG");
    if !thumbnail_only {
        install(store, bytes, &original, "original")?;
    }
    install(store, &thumb_bytes, &thumbnail, "thumbnail")?;
    store.images.execute("INSERT INTO refs VALUES(?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET original=excluded.original,thumbnail=excluded.thumbnail,fetched=excluded.fetched",params![key,if thumbnail_only{None}else{Some(text(&original,"sha256"))},text(&thumbnail,"sha256"),millis(),millis(),0,millis()]).map_err(|_|"图片引用未能保存")?;
    if let Some(owner) = owner {
        pin(store, owner, key)?;
    }
    Ok(json!({"original":if thumbnail_only{Value::Null}else{original},"thumbnail":thumbnail}))
}

pub fn usage(store: &Store) -> Result<Value> {
    let mut statement=store.images.prepare("SELECT o.sha,o.asset,CASE WHEN EXISTS(SELECT 1 FROM refs r WHERE r.thumbnail=o.sha) THEN 'thumbnail' ELSE o.kind END,EXISTS(SELECT 1 FROM pins p WHERE p.sha=o.sha),EXISTS(SELECT 1 FROM pins p WHERE p.sha=o.sha AND p.owner LIKE 'collection:%') FROM objects o").map_err(|_|"图片用量读取失败")?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, bool>(3)?,
                row.get::<_, bool>(4)?,
            ))
        })
        .map_err(|_| "图片用量读取失败")?;
    let mut collection = 0u64;
    let mut protected = 0u64;
    let mut originals = 0u64;
    let mut thumbnails = 0u64;
    let mut files = 0;
    for row in rows {
        let (sha, _asset, kind, pinned, saved) = row.map_err(|_| "图片用量读取失败")?;
        files += 1;
        let bytes = fs::metadata(
            store
                .root
                .join("images/objects")
                .join(format!("{sha}.image")),
        )
        .map(|info| info.len())
        .unwrap_or(0);
        if saved {
            collection += bytes;
        } else if pinned {
            protected += bytes;
        } else if kind == "original" {
            originals += bytes;
        } else {
            thumbnails += bytes;
        }
    }
    for name in ["library.sqlite", "library.sqlite-wal"] {
        collection += fs::metadata(store.root.join("library").join(name))
            .map(|info| info.len())
            .unwrap_or(0);
    }
    Ok(
        json!({"collectionBytes":collection,"protectedBytes":protected,"cacheBytes":originals+thumbnails,"originalBytes":originals,"thumbnailBytes":thumbnails,"limitBytes":number(&store.preferences()?,"imageCacheMiB")*1024*1024,"files":files}),
    )
}

pub fn prune(store: &Store, limit: i64) -> Result<Value> {
    let mut statement=store.images.prepare("SELECT o.sha,json_extract(o.asset,'$.bytes'),o.accessed,CASE WHEN EXISTS(SELECT 1 FROM refs r WHERE r.thumbnail=o.sha) THEN 1 ELSE 0 END,COALESCE((SELECT MAX(unread) FROM refs r WHERE r.thumbnail=o.sha),0),COALESCE((SELECT MAX(seen) FROM refs r WHERE r.thumbnail=o.sha),0),o.hits FROM objects o WHERE NOT EXISTS(SELECT 1 FROM pins p WHERE p.sha=o.sha) ORDER BY 4 ASC,5 ASC,7 ASC,3 ASC,6 ASC").map_err(|_|"图片清理状态不可读")?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|_| "图片清理状态不可读")?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|_| "图片清理状态不可读")?;
    let mut remaining = rows.iter().map(|row| row.1).sum::<i64>();
    let mut freed = 0;
    let mut removed = 0;
    for (sha, bytes) in rows {
        if remaining <= limit {
            break;
        }
        let path = store
            .root
            .join("images/objects")
            .join(format!("{sha}.image"));
        if let Ok(info) = fs::metadata(&path) {
            fs::remove_file(&path).map_err(|_| "图片缓存未能清理")?;
            freed += info.len();
            removed += 1;
        }
        store
            .images
            .execute("DELETE FROM objects WHERE sha=?", [&sha])
            .map_err(|_| "图片缓存记录未能清理")?;
        store
            .images
            .execute("UPDATE refs SET original=NULL WHERE original=?", [&sha])
            .map_err(|_| "图片缓存记录未能清理")?;
        store
            .images
            .execute("UPDATE refs SET thumbnail=NULL WHERE thumbnail=?", [&sha])
            .map_err(|_| "图片缓存记录未能清理")?;
        remaining -= bytes;
    }
    store.images.execute("DELETE FROM refs WHERE original IS NULL AND thumbnail IS NULL AND NOT EXISTS(SELECT 1 FROM pins WHERE pins.owner=refs.key)",[]).map_err(|_|"图片缓存记录未能清理")?;
    Ok(json!({"freedBytes":freed,"removedFiles":removed,"usage":usage(store)?}))
}

/// Rebuild protection from stored identities before ordinary cache eviction is allowed.
pub fn prepare(store: &Store) -> Result<()> {
    let mut pictures = Vec::new();
    for sub in store.subscriptions()? {
        for (field, prefix) in [
            ("avatarAsset", "avatar"),
            ("manualAvatarAsset", "manual-avatar"),
        ] {
            if sub[field].is_object() {
                let sha = text(&sub[field], "sha256");
                let owner = if prefix == "manual-avatar" {
                    format!("{prefix}:{}:{sha}", text(&sub, "id"))
                } else {
                    format!("{prefix}:{}", text(&sub, "id"))
                };
                pictures.push((owner, text(&sub, "avatarUrl").to_string(), sha.to_string()));
            }
        }
    }
    for work in json_rows(&store.library, "SELECT summary FROM works", [])? {
        if work["cover"]["asset"].is_object() {
            pictures.push((
                format!("collection:{}", text(&work, "id")),
                text(&work["cover"], "url").into(),
                text(&work["cover"]["asset"], "sha256").into(),
            ));
        }
    }
    for task in array(&store.metadata, "tasks") {
        for record in array(&task, "records") {
            for cover in array(&record, "covers") {
                if cover["asset"].is_object() {
                    pictures.push((
                        format!("query:{}:{}", text(&task, "id"), text(&record, "code")),
                        text(&cover, "url").into(),
                        text(&cover["asset"], "sha256").into(),
                    ));
                }
            }
        }
    }
    for (owner, key, sha) in pictures {
        let pinned: bool = store
            .images
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pins WHERE owner=? AND sha=?)",
                params![owner, sha],
                |row| row.get(0),
            )
            .map_err(|_| "图片引用不可读")?;
        if pinned {
            continue;
        }
        if let Some(image) = read_hash(store, &sha)? {
            let key = if key.is_empty() {
                owner.as_str()
            } else {
                key.as_str()
            };
            put(store, key, &image.bytes, false, Some(&owner))?;
        }
    }
    if !store.root.join("images/.legacy-imported").exists() {
        for entry in store.entries()? {
            if entry["imageAsset"].is_object() && !text(&entry, "thumbnailUrl").is_empty() {
                if let Some(image) = read_hash(store, text(&entry["imageAsset"], "sha256"))? {
                    put(
                        store,
                        text(&entry, "thumbnailUrl"),
                        &image.bytes,
                        true,
                        None,
                    )?;
                }
            }
        }
        atomic_write(&store.root.join("images/.legacy-imported"), b"1")?;
    }
    Ok(())
}

impl Backend {
    pub fn fetch_image(
        &self,
        source: &str,
        url: &str,
        code: Option<&str>,
        job: &Arc<Job>,
        thumbnail_only: bool,
        owner: Option<&str>,
    ) -> Result<Value> {
        job.running()?;
        let generation = self.0.image_generation.load(Ordering::SeqCst);
        if !platform::allowed_url(source, url, "image") {
            return Err("图片不属于来源范围".into());
        }
        let path = self
            .0
            .root
            .join("images/requests")
            .join(format!("{}.image", uuid::Uuid::new_v4()));
        directory(path.parent().unwrap())?;
        let result = (|| {
            let preferences = self.preferences()?;
            let mut params = json!({"source":source,"provider":source,"url":url,"destination":path,"proxy":platform::proxy(&preferences,url)?,"transport":platform::transport(source,&preferences)});
            let method = if let Some(code) = code {
                params["code"] = json!(code);
                params["cookie"] = json!(self.credential(source)?);
                "metadata.cover"
            } else {
                "follow.image"
            };
            let result = self.worker(method, params, job, |_| Ok(()))?;
            self.hold(source, &result)?;
            job.running()?;
            if !result["asset"].is_object() {
                return Err("来源图片暂未取得".into());
            }
            let bytes = fs::read(&path).map_err(|_| "采集图片暂不可读")?;
            if hash(&bytes) != text(&result["asset"], "sha256")
                || bytes.len() as i64 != number(&result["asset"], "bytes")
            {
                return Err("图片哈希不一致".into());
            }
            let store = self.0.store.lock().map_err(|_| "存储不可用")?;
            job.running()?;
            if generation != self.0.image_generation.load(Ordering::SeqCst) {
                return Err("图片缓存已清理".into());
            }
            if !array(&store.preferences()?, "enabledSources")
                .iter()
                .any(|id| id == source)
            {
                return Err("来源已关闭".into());
            }
            put(&store, url, &bytes, thumbnail_only, owner)
        })();
        let _ = fs::remove_file(&path);
        result
    }

    fn refresh_image(&self, source: &str, url: &str, code: Option<&str>, updates: bool) {
        let Ok(mut refreshes) = self.0.image_refreshes.lock() else {
            return;
        };
        refreshes.retain(|_, at| millis() - *at < 86_400_000);
        if refreshes
            .get(url)
            .is_some_and(|at| millis() - *at < 900_000)
        {
            return;
        }
        if refreshes.len() >= 500 {
            return;
        }
        refreshes.insert(url.into(), millis());
        drop(refreshes);
        let Ok(job) = self.job(&format!("image:refresh:{}", hash(url)), 4) else {
            return;
        };
        let backend = self.clone();
        let source = source.to_string();
        let url = url.to_string();
        let code = code.map(str::to_string);
        std::thread::spawn(move || {
            let result = backend.fetch_image(&source, &url, code.as_deref(), &job, updates, None);
            if let Ok(saved) = result {
                if let Ok(mut store) = backend.0.store.lock() {
                    if job.running().is_ok() {
                        if updates {
                            for mut entry in json_rows(&store.db,"SELECT value FROM entries WHERE json_extract(value,'$.thumbnailUrl')=?",[&url]).unwrap_or_default() {
                                entry["imageAsset"]=saved["thumbnail"].clone();
                                let _=store.save_entry(&entry);
                            }
                        } else {
                            let mut tasks = array(&store.metadata, "tasks");
                            for task in &mut tasks {
                                if ["cancelled", "cancelling"].contains(&text(task, "status")) {
                                    continue;
                                }
                                let task_id = text(task, "id").to_string();
                                if let Some(records) = task["records"].as_array_mut() {
                                    for record in records {
                                        let code = text(record, "code").to_string();
                                        if let Some(covers) = record["covers"].as_array_mut() {
                                            for cover in covers {
                                                if text(cover, "url") == url
                                                    && cover["asset"].is_object()
                                                {
                                                    cover["asset"] = saved["original"].clone();
                                                    let _ = pin(
                                                        &store,
                                                        &format!("query:{task_id}:{code}"),
                                                        &url,
                                                    );
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            store.metadata["tasks"] = json!(tasks);
                            let _ = store.commit_metadata();
                        }
                        if let Ok(preferences) = store.preferences() {
                            let _ =
                                prune(&store, number(&preferences, "imageCacheMiB") * 1024 * 1024);
                        }
                    }
                }
                backend.publish_metadata();
                backend.publish_subscriptions();
            }
            backend.finish_job(&job.id);
        });
    }

    pub fn image(&self, scope: &str, id: &str, variant: &str) -> Result<Option<Picture>> {
        self.image_at(scope, id, variant, None)
    }

    pub fn image_at(
        &self,
        scope: &str,
        id: &str,
        variant: &str,
        index: Option<usize>,
    ) -> Result<Option<Picture>> {
        if !["image", "updates", "avatars", "library"].contains(&scope) || !is_hash(id, 64) {
            return Ok(None);
        }
        if index.is_some_and(|index| index >= 20) || (index.is_some() && scope != "updates") {
            return Ok(None);
        }
        if self.0.stopped.load(Ordering::SeqCst) {
            return Ok(None);
        }
        let store = self.0.store.lock().map_err(|_| "存储不可用")?;
        let mut source: String;
        let mut code = None;
        let mut owner = None;
        let mut expected = None;
        let key = match scope {
            "image" => {
                let picture = array(&store.metadata, "tasks")
                    .iter()
                    .flat_map(|task| array(task, "records"))
                    .flat_map(|record| {
                        array(&record, "covers")
                            .into_iter()
                            .map(move |cover| (record.clone(), cover))
                    })
                    .find(|(_, cover)| {
                        text(cover, "id") == id || text(&cover["asset"], "sha256") == id
                    });
                if let Some((record, cover)) = picture {
                    source = text(&record, "source").into();
                    code = Some(text(&record, "code").to_string());
                    if !cover["asset"].is_object() {
                        source.clear();
                    }
                    text(&cover, "url").to_string()
                } else {
                    return read_hash(&store, id);
                }
            }
            "library" => {
                let picture=json_rows(&store.library,"SELECT summary FROM works WHERE json_extract(summary,'$.cover.id')=? OR cover_sha=? LIMIT 1",params![id,id])?.into_iter().next();
                if let Some(work) = picture {
                    owner = Some(format!("collection:{}", text(&work, "id")));
                    source = text(&work["cover"], "source").into();
                    code = Some(text(&work, "code").to_string());
                    expected = Some(text(&work["cover"]["asset"], "sha256").to_string());
                    text(&work["cover"], "url").to_string()
                } else {
                    return Ok(None);
                }
            }
            "avatars" => return read_hash(&store, id),
            _ => {
                let found=json_rows(&store.db,"SELECT value FROM entries WHERE id=? OR json_extract(value,'$.imageAsset.sha256')=? LIMIT 1",params![id,id])?.into_iter().next();
                if let Some(entry) = found {
                    let index = index.unwrap_or(0);
                    let key = entry["images"]
                        .get(index)
                        .map(|image| text(image, "url"))
                        .filter(|url| !url.is_empty())
                        .or_else(|| (index == 0).then(|| text(&entry, "thumbnailUrl")));
                    let Some(key) = key else {
                        return Ok(None);
                    };
                    let Some(sub) = store.subscription(text(&entry, "subscriptionId"))? else {
                        return Ok(None);
                    };
                    source = if flag(&sub, "following")
                        && flag(&sub, "enabled")
                        && !flag(&sub, "autoPaused")
                        && text(&entry["imageCache"], "status") != "cancelled"
                    {
                        text(&entry, "provider").into()
                    } else {
                        String::new()
                    };
                    store
                        .images
                        .execute(
                            "UPDATE refs SET unread=?,seen=? WHERE key=?",
                            params![
                                !flag(&entry, "read"),
                                stamp(text(&entry, "firstSeenAt")),
                                key
                            ],
                        )
                        .map_err(|_| "图片优先级未能保存")?;
                    key.to_string()
                } else {
                    return read_hash(&store, id);
                }
            }
        };
        if let Some(image) = linked(&store, owner.as_deref().unwrap_or(&key), variant)? {
            let fetched: i64 = store
                .images
                .query_row(
                    "SELECT CAST(fetched AS INTEGER) FROM refs WHERE key=?",
                    [&key],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|_| "图片状态不可读")?
                .unwrap_or(millis());
            let stale =
                owner.is_none() && !source.is_empty() && millis() - fetched > 30 * 86_400_000;
            drop(store);
            if stale {
                self.refresh_image(&source, &key, code.as_deref(), scope == "updates");
            }
            return Ok(Some(image));
        }
        if variant == "thumbnail" {
            if let Some(original) = linked(&store, &key, "original")? {
                let saved = put(&store, &key, &original.bytes, false, owner.as_deref())?;
                return read_hash(&store, text(&saved["thumbnail"], "sha256"));
            }
        }
        if source.is_empty() {
            return Ok(None);
        }
        drop(store);
        // Cached reads remain available while the remote-fetch queue waits on a source.
        let _gate = self.0.image_io.lock().map_err(|_| "图片存储不可用")?;
        {
            let store = self.0.store.lock().map_err(|_| "存储不可用")?;
            if let Some(cached) = linked(&store, owner.as_deref().unwrap_or(&key), variant)? {
                return Ok(Some(cached));
            }
        }
        let job = self.job(&format!("image:{}", uuid::Uuid::new_v4()), 4)?;
        let fetched = self.fetch_image(
            &source,
            &key,
            code.as_deref(),
            &job,
            variant == "thumbnail",
            None,
        );
        self.finish_job(&job.id);
        let store = self.0.store.lock().map_err(|_| "存储不可用")?;
        if let Ok(saved) = fetched {
            if let Some(expected) = expected {
                if text(&saved["original"], "sha256") != expected {
                    return Err("收藏封面已变化，原收藏已保留".into());
                }
                if let Some(owner) = owner {
                    pin(&store, &owner, &key)?;
                }
            }
            if scope == "updates" {
                for mut entry in json_rows(
                    &store.db,
                    "SELECT value FROM entries WHERE json_extract(value,'$.thumbnailUrl')=?",
                    [&key],
                )
                .unwrap_or_default()
                {
                    entry["imageAsset"] = saved["thumbnail"].clone();
                    let _ = store.save_entry(&entry);
                }
            }
            let result = read_hash(
                &store,
                text(
                    &saved[if variant == "thumbnail" {
                        "thumbnail"
                    } else {
                        "original"
                    }],
                    "sha256",
                ),
            )?;
            let _ = prune(
                &store,
                number(&store.preferences()?, "imageCacheMiB") * 1024 * 1024,
            );
            return Ok(result);
        }
        let fallback = linked(&store, &key, variant)?;
        let mut changed = false;
        if scope == "updates" && fallback.is_none() && job.running().is_ok() {
            for mut entry in json_rows(
                &store.db,
                "SELECT value FROM entries WHERE json_extract(value,'$.thumbnailUrl')=?",
                [&key],
            )? {
                if entry["imageAsset"].is_object()
                    && read_hash(&store, text(&entry["imageAsset"], "sha256"))?.is_none()
                {
                    entry
                        .as_object_mut()
                        .ok_or("帖子记录格式不正确")?
                        .remove("imageAsset");
                    entry["imageCache"] = json!({"status":"failed","attempts":0,"nextAttemptAt":0,"reason":"network"});
                    store.save_entry(&entry)?;
                    changed = true;
                }
            }
        }
        drop(store);
        if changed {
            self.publish_subscriptions();
        }
        Ok(fallback)
    }
}
