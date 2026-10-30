use crate::{
    backend::{Backend, Job},
    images,
    platform::{self, Vault},
    queries,
    store::{self, Store},
    subscriptions,
    util::*,
};
use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
use serde_json::{json, Value};
use std::{io::Cursor, path::PathBuf, sync::atomic::Ordering, time::Duration};

fn temporary() -> (tempfile::TempDir, Store) {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().into()).unwrap();
    (directory, store)
}

fn candidate(provider: &str, reference: &str) -> Value {
    let mut value = json!({"provider":provider,"ref":reference,"name":"本地人物样本","url":subscriptions::canonical(provider,reference,if provider=="x"{"fixtureuser"}else{""}).unwrap(),"handle":if provider=="x"{json!("fixtureuser")}else{Value::Null},"aliases":[],"recordType":"本地样本","bio":"","evidence":"隔离测试"});
    if provider != "x" {
        value.as_object_mut().unwrap().remove("handle");
    }
    value
}

fn entry(id: &str, published: &str) -> Value {
    json!({"externalId":id,"title":"本地动态","summary":"完整正文","author":"本地人物样本","publishedAt":published,"publishedPrecision":"exact","url":format!("https://fixtureuser.fanbox.cc/posts/{id}"),"thumbnailUrl":"","code":"","restricted":false,"partial":false})
}

fn png(color: u8) -> Vec<u8> {
    let image = DynamicImage::ImageRgb8(RgbImage::from_pixel(16, 12, Rgb([color, 20, 60])));
    let mut bytes = Cursor::new(Vec::new());
    image.write_to(&mut bytes, ImageFormat::Png).unwrap();
    bytes.into_inner()
}

fn backend() -> (tempfile::TempDir, Backend) {
    let root = tempfile::tempdir().unwrap();
    let backend = Backend::open(root.path().into(), PathBuf::new(), false).unwrap();
    (root, backend)
}

fn x_post_fixture(backend: &Backend, pictures: Option<Value>) -> (Value, Value) {
    let store = backend.0.store.lock().unwrap();
    let mut preferences = store.preferences().unwrap();
    let mut enabled = array(&preferences, "enabledSources");
    if !enabled.iter().any(|source| source == "x") {
        enabled.push(json!("x"));
    }
    preferences["enabledSources"] = json!(enabled);
    store.save_preferences(&preferences).unwrap();
    let sub = store
        .follow(&candidate("x", "1722511982610538496"))
        .unwrap();
    let mut post = entry("1900000000000000000", "2026-10-29T02:00:00Z");
    merge(
        &mut post,
        &json!({"url":"https://x.com/fixtureuser/status/1900000000000000000","authorRef":sub["ref"],"authorHandle":"fixtureuser","postKind":"original","thumbnailUrl":"https://pbs.twimg.com/media/first.jpg"}),
    );
    if let Some(pictures) = pictures {
        post["images"] = pictures;
    }
    store.upsert_entry(&sub, &post).unwrap();
    (sub, store.entries().unwrap()[0].clone())
}

#[test]
fn gallery_images_keep_separate_cache_references_and_reject_invalid_indices() {
    let (_root, backend) = backend();
    let (_sub, post) = x_post_fixture(
        &backend,
        Some(
            json!([{"url":"https://pbs.twimg.com/media/first.jpg"},{"url":"https://pbs.twimg.com/media/second.jpg"}]),
        ),
    );
    let first = png(25);
    let second = png(95);
    {
        let store = backend.0.store.lock().unwrap();
        images::put(&store, text(&post["images"][0], "url"), &first, false, None).unwrap();
        images::put(
            &store,
            text(&post["images"][1], "url"),
            &second,
            false,
            None,
        )
        .unwrap();
    }
    assert_eq!(
        backend
            .image("updates", text(&post, "id"), "original")
            .unwrap()
            .unwrap()
            .bytes,
        first
    );
    assert_eq!(
        backend
            .image_at("updates", text(&post, "id"), "original", Some(1))
            .unwrap()
            .unwrap()
            .bytes,
        second
    );
    for index in [2, 20, usize::MAX] {
        assert!(backend
            .image_at("updates", text(&post, "id"), "original", Some(index))
            .unwrap()
            .is_none());
    }
    assert!(backend
        .image_at("avatars", text(&post, "id"), "original", Some(0))
        .unwrap()
        .is_none());
}

#[test]
fn saved_post_picture_uses_the_selected_cached_original_and_preserves_user_directory_permissions() {
    let (root, backend) = backend();
    let (_, post) = x_post_fixture(
        &backend,
        Some(json!([
            {"url":"https://pbs.twimg.com/media/first.jpg"},
            {"url":"https://pbs.twimg.com/media/second.jpg"}
        ])),
    );
    let first = png(25);
    let second = png(95);
    {
        let store = backend.0.store.lock().unwrap();
        images::put(&store, text(&post["images"][0], "url"), &first, false, None).unwrap();
        images::put(
            &store,
            text(&post["images"][1], "url"),
            &second,
            false,
            None,
        )
        .unwrap();
    }
    *backend.0.worker_fixture.lock().unwrap() = Some(root.path().join("worker-must-not-run.py"));
    let (picture, name) = backend.entry_image_export(text(&post, "id"), 1).unwrap();
    assert_eq!(picture.bytes, second);
    assert_eq!(name, "Nectisse-1900000000000000000-02.png");
    let destination = root.path().join("user-pictures");
    std::fs::create_dir(&destination).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&destination, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let path = destination.join(name);
    images::save_picture(&path, &picture).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), second);
    assert_eq!(std::fs::read_dir(&destination).unwrap().count(), 1);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&destination)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o755
        );
    }
    for index in [2, 20, usize::MAX] {
        assert!(backend
            .entry_image_export(text(&post, "id"), index)
            .is_err());
    }
    assert!(backend
        .entry_image_export(&hash("missing-post"), 0)
        .is_err());
    assert!(backend.entry_image_export("../image", 0).is_err());
    assert!(crate::contracts::validate(
        "imageSave",
        &json!({"id":post["id"],"index":1,"path":path})
    )
    .is_err());
}

#[test]
fn legacy_x_post_images_are_backfilled_once_without_losing_read_or_discovery_state() {
    let (root, backend) = backend();
    let (_sub, post) = x_post_fixture(&backend, None);
    backend
        .0
        .store
        .lock()
        .unwrap()
        .mark_read(&[post["id"].clone()], true)
        .unwrap();
    let mut input = post.clone();
    input["images"] = json!([{"url":"https://pbs.twimg.com/media/first.jpg"},{"url":"https://pbs.twimg.com/media/second.jpg"}]);
    fixture_worker(&backend, root.path(), &format!("emit('progress',payload=dict(event='request',source='x',host='api.fxtwitter.com',sequence=1))\njson.loads(sys.stdin.readline())\nemit('result',payload=dict(status='success',reason='',message='',retryAfter=0,entry=json.loads({:?})))", input.to_string()));
    let result = backend.entry_details(text(&post, "id")).unwrap();
    assert_eq!(array(&result["entry"], "images").len(), 2);
    assert_eq!(result["entry"]["firstSeenAt"], post["firstSeenAt"]);
    assert_eq!(result["entry"]["read"], true);
    *backend.0.worker_fixture.lock().unwrap() = Some(root.path().join("worker-must-not-run.py"));
    assert_eq!(
        array(
            &backend.entry_details(text(&post, "id")).unwrap()["entry"],
            "images"
        )
        .len(),
        2
    );
}

#[test]
fn failed_or_mismatched_post_details_keep_the_legacy_picture_and_remain_retryable() {
    for wrong_identity in [false, true] {
        let (root, backend) = backend();
        let (_sub, post) = x_post_fixture(&backend, None);
        let mut input = post.clone();
        input["authorRef"] = json!("9999");
        let outcome = if wrong_identity {
            json!({"status":"success","entry":input})
        } else {
            json!({"status":"error","reason":"server_error","message":"fixture unavailable","retryAfter":0})
        };
        fixture_worker(
            &backend,
            root.path(),
            &format!(
                "emit('result',payload=json.loads({:?}))",
                outcome.to_string()
            ),
        );
        let result = backend.entry_details(text(&post, "id")).unwrap();
        assert!(result["warning"].is_string());
        assert_eq!(result["entry"]["thumbnailUrl"], post["thumbnailUrl"]);
        assert!(result["entry"].get("images").is_none());
    }
}

#[test]
fn legacy_timeline_updates_do_not_erase_known_gallery_images() {
    let (_root, backend) = backend();
    let (sub, post) = x_post_fixture(
        &backend,
        Some(
            json!([{"url":"https://pbs.twimg.com/media/first.jpg"},{"url":"https://pbs.twimg.com/media/second.jpg"}]),
        ),
    );
    let mut legacy = post.clone();
    legacy.as_object_mut().unwrap().remove("images");
    let store = backend.0.store.lock().unwrap();
    store.upsert_entry(&sub, &legacy).unwrap();
    assert_eq!(
        array(&store.entry(text(&post, "id")).unwrap().unwrap(), "images").len(),
        2
    );
}

#[test]
fn post_detail_method_reaches_the_python_connector_without_requesting_invalid_posts() {
    let (_root, backend) = backend();
    let job = Job::new("entry-dispatch-fixture".into(), 2);
    let result = backend
        .worker(
            "follow.entry",
            json!({"provider":"x","ref":"invalid","externalId":"invalid"}),
            &job,
            |_| Ok(()),
        )
        .unwrap();
    assert_eq!(result["status"], "error");
    assert_eq!(result["reason"], "unsupported");
    assert_eq!(result["requests"], 0);
}

#[test]
fn x_list_thumbnail_fetches_its_image_host_and_remains_cached() {
    let (root, backend) = backend();
    let post;
    {
        let store = backend.0.store.lock().unwrap();
        let mut preferences = store.preferences().unwrap();
        let mut enabled = array(&preferences, "enabledSources");
        if !enabled.iter().any(|source| source == "x") {
            enabled.push(json!("x"));
        }
        preferences["enabledSources"] = json!(enabled);
        store.save_preferences(&preferences).unwrap();
        let sub = store
            .follow(&candidate("x", "1722511982610538496"))
            .unwrap();
        let mut input = entry("1900000000000000000", "2026-10-29T02:00:00Z");
        input["url"] = json!("https://x.com/fixtureuser/status/1900000000000000000");
        input["authorRef"] = sub["ref"].clone();
        input["authorHandle"] = json!("fixtureuser");
        input["postKind"] = json!("original");
        input["thumbnailUrl"] = json!("https://pbs.twimg.com/media/fixture.jpg");
        store.upsert_entry(&sub, &input).unwrap();
        post = store.entries().unwrap()[0].clone();
    }
    let bytes = png(65);
    let asset = images::asset(&bytes, 16, 12, "PNG");
    let hex = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    fixture_worker(&backend, root.path(), &format!(
        "emit('progress',payload=dict(event='request',source='x',host='pbs.twimg.com',sequence=1))\npermit=json.loads(sys.stdin.readline())\nassert permit['method']=='permit'\nimport pathlib\npathlib.Path(request['params']['destination']).write_bytes(bytes.fromhex({hex:?}))\nemit('result',payload=dict(status='success',reason='',message='',retryAfter=0,asset=json.loads({:?})))",
        asset.to_string()
    ));
    let thumbnail = backend
        .image("updates", text(&post, "id"), "thumbnail")
        .unwrap();
    assert!(
        thumbnail.is_some(),
        "The X post's list thumbnail must load through the image request permit"
    );
    let thumbnail = thumbnail.unwrap();
    assert!(!thumbnail.bytes.is_empty());
    let store = backend.0.store.lock().unwrap();
    assert_eq!(
        store.entry(text(&post, "id")).unwrap().unwrap()["imageAsset"]["sha256"],
        thumbnail.asset["sha256"]
    );
    drop(store);
    *backend.0.worker_fixture.lock().unwrap() = Some(root.path().join("worker-must-not-run.py"));
    let original = backend
        .image("updates", text(&post, "id"), "original")
        .unwrap();
    assert!(
        original.is_some(),
        "Opening X post details must reuse the original downloaded with the list thumbnail, even offline"
    );
    assert_eq!(original.unwrap().bytes, bytes);
    assert_eq!(
        backend
            .image("updates", text(&post, "id"), "thumbnail")
            .unwrap()
            .unwrap()
            .bytes,
        thumbnail.bytes
    );
    drop(backend);
    let restored = Backend::open(root.path().into(), PathBuf::new(), false).unwrap();
    *restored.0.worker_fixture.lock().unwrap() = Some(root.path().join("worker-must-not-run.py"));
    for _ in 0..2 {
        assert_eq!(
            restored
                .image_at("updates", text(&post, "id"), "original", Some(0))
                .unwrap()
                .expect(
                    "Details and full-size views must reuse the persisted X image after restart"
                )
                .bytes,
            bytes
        );
    }
}

#[test]
fn image_permits_do_not_allow_api_hosts_or_expand_post_lookup_domains() {
    for (method, host) in [
        ("follow.image", "api.fxtwitter.com"),
        ("follow.image", "pbs.twimg.com.unrelated.example"),
        ("follow.lookup", "pbs.twimg.com"),
    ] {
        let (root, backend) = backend();
        fixture_worker(&backend, root.path(), &format!("emit('progress',payload=dict(event='request',source='x',host={host:?},sequence=1))\nsys.stdin.readline()"));
        let job = Job::new("image-domain-fixture".into(), 4);
        assert_eq!(
            backend
                .worker(method, json!({"provider":"x"}), &job, |_| Ok(()))
                .unwrap_err(),
            "来源请求超出许可范围"
        );
        assert_eq!(job.requests.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn existing_electron_sqlite_and_preferences_remain_readable() {
    let (directory, store) = temporary();
    let mut preferences = store.preferences().unwrap();
    preferences["automatic"] = json!(false);
    preferences["theme"] = json!("night");
    store.save_preferences(&preferences).unwrap();
    let sub = store.follow(&candidate("javdb", "A123")).unwrap();
    drop(store);
    let mut restored = Store::open(directory.path().into()).unwrap();
    let state = restored.subscriptions_state(false).unwrap();
    assert_eq!(state["preferences"]["theme"], "night");
    assert_eq!(state["preferences"]["automatic"], false);
    assert_eq!(state["subscriptions"][0]["id"], sub["id"]);
}

#[test]
fn creator_pages_order_by_publication_not_backfill_discovery() {
    let (_directory, store) = temporary();
    let sub = store.follow(&candidate("fanbox", "fixtureuser")).unwrap();
    store
        .upsert_entry(&sub, &entry("1", "2026-10-29T02:00:00Z"))
        .unwrap();
    store
        .upsert_entry(&sub, &entry("2", "2026-10-20T02:00:00Z"))
        .unwrap();
    let page = store
        .entry_page(&json!({"subscriptionId":sub["id"],"page":1,"pageSize":20,"unread":false}))
        .unwrap();
    assert_eq!(page["entries"][0]["externalId"], "1");
    assert_eq!(page["total"], 2);
}

#[test]
fn pagination_is_scoped_and_preserves_unread_counts() {
    let (_directory, store) = temporary();
    let sub = store.follow(&candidate("fanbox", "fixtureuser")).unwrap();
    let other = store.follow(&candidate("fanbox", "another")).unwrap();
    for index in 1..46 {
        store
            .upsert_entry(&sub, &entry(&index.to_string(), "2026-10-29T02:00:00Z"))
            .unwrap();
    }
    store
        .upsert_entry(&other, &entry("99", "2026-10-29T02:00:00Z"))
        .unwrap();
    let page = store
        .entry_page(&json!({"subscriptionId":sub["id"],"page":3,"pageSize":20,"unread":false}))
        .unwrap();
    assert_eq!(page["total"], 45);
    assert_eq!(array(&page, "entries").len(), 5);
    let read_ids = array(&page, "entries")
        .iter()
        .map(|entry| entry["id"].clone())
        .collect::<Vec<_>>();
    store.mark_read(&read_ids, true).unwrap();
    let unread = store
        .entry_page(&json!({"subscriptionId":sub["id"],"page":1,"pageSize":20,"unread":true}))
        .unwrap();
    assert_eq!(unread["total"], 40);
    let other_page = store
        .entry_page(&json!({"subscriptionId":other["id"],"page":1,"pageSize":20,"unread":true}))
        .unwrap();
    assert_eq!(other_page["total"], 1);
}

#[test]
fn later_partial_posts_do_not_erase_full_body_or_read_state() {
    let (_directory, store) = temporary();
    let sub = store.follow(&candidate("fanbox", "fixtureuser")).unwrap();
    store
        .upsert_entry(&sub, &entry("1", "2026-10-29T02:00:00Z"))
        .unwrap();
    let old = store.entries().unwrap()[0].clone();
    store.mark_read(&[old["id"].clone()], true).unwrap();
    let mut clipped = entry("1", "2026-10-29T02:00:00Z");
    clipped["summary"] = json!("截断");
    clipped["partial"] = json!(true);
    assert!(!store.upsert_entry(&sub, &clipped).unwrap());
    let saved = store.entry(text(&old, "id")).unwrap().unwrap();
    assert_eq!(saved["summary"], "完整正文");
    assert_eq!(saved["partial"], false);
    assert_eq!(saved["read"], true);
    assert_eq!(saved["firstSeenAt"], old["firstSeenAt"]);
}

#[test]
fn interrupted_jobs_are_retained_without_automatic_resume() {
    let (directory, store) = temporary();
    let sub = store.follow(&candidate("javdb", "A123")).unwrap();
    let task = json!({"id":uuid::Uuid::new_v4().to_string(),"kind":"check","provider":"javdb","subscriptionId":sub["id"],"status":"running","phase":"checking","startedAt":now(),"finishedAt":"","requests":0,"candidates":[],"added":0,"reason":"","cancelRequestedAt":""});
    store.save_task(&task).unwrap();
    drop(store);
    let restored = Store::open(directory.path().into()).unwrap();
    assert_eq!(restored.tasks().unwrap()[0]["status"], "interrupted");
    assert_eq!(
        restored.subscription(text(&sub, "id")).unwrap().unwrap()["autoPaused"],
        true
    );
}

#[test]
fn corrupt_existing_records_are_not_overwritten() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("metadata/state.json");
    crate::util::directory(path.parent().unwrap()).unwrap();
    std::fs::write(&path, b"bad json").unwrap();
    assert!(Store::open(directory.path().into()).is_err());
    assert_eq!(std::fs::read(path).unwrap(), b"bad json");
}

#[test]
fn safe_storage_legacy_ciphertext_matches_independently_verified_vectors() {
    let fixtures: Value =
        serde_json::from_str(include_str!("../../tests/fixtures/legacy-v10.json")).unwrap();
    for case in array(&fixtures, "cases") {
        let bytes = text(&case, "encodedHex")
            .as_bytes()
            .chunks(2)
            .map(|chunk| u8::from_str_radix(std::str::from_utf8(chunk).unwrap(), 16).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            platform::decrypt_legacy(&bytes, text(&fixtures, "password").as_bytes()).unwrap(),
            text(&case, "plain")
        );
        if !bytes.is_empty() {
            assert!(platform::decrypt_legacy(&bytes, b"wrong password").is_err());
        }
    }
}

#[test]
fn new_credentials_are_authenticated_and_never_plaintext() {
    let vault = Vault::testing();
    let first = vault.encrypt("fixture_cookie=not-a-secret").unwrap();
    let second = vault.encrypt("fixture_cookie=not-a-secret").unwrap();
    assert_ne!(first, second);
    assert!(!first.windows(14).any(|bytes| bytes == b"fixture_cookie"));
    assert_eq!(
        vault.decrypt(&first).unwrap(),
        "fixture_cookie=not-a-secret"
    );
    let mut tampered = first;
    tampered[20] ^= 1;
    assert!(vault.decrypt(&tampered).is_err());
}

#[test]
fn x_identity_requires_original_author_and_exact_post_url() {
    let id = "1722511982610538496";
    let valid = json!({"url":"https://x.com/fixtureuser/status/1900000000000000000","externalId":"1900000000000000000","authorRef":id,"authorHandle":"fixtureuser","postKind":"original"});
    assert!(subscriptions::valid_entry("x", id, &valid));
    for patch in [
        json!({"authorRef":"123"}),
        json!({"postKind":"reply"}),
        json!({"url":"https://x.com/another/status/1900000000000000000"}),
        json!({"url":"https://x.com/fixtureuser/status/1900000000000000000?token=bad"}),
    ] {
        let mut entry = valid.clone();
        merge(&mut entry, &patch);
        assert!(!subscriptions::valid_entry("x", id, &entry));
    }
}

#[test]
fn source_links_never_accept_credentials_http_or_unrelated_hosts() {
    assert!(platform::allowed_url(
        "javdb",
        "https://javdb.com/v/Ab123",
        "page"
    ));
    for value in [
        "http://javdb.com/v/Ab123",
        "https://javdb.com.evil.invalid/v/Ab123",
        "https://user:password@javdb.com/v/Ab123",
        "file:///tmp/image",
    ] {
        assert!(!platform::allowed_url("javdb", value, "page"));
    }
}

#[test]
fn query_planning_normalizes_codes_and_preserves_product_prefixes() {
    assert_eq!(queries::normalize(" sone00614 "), "SONE-614");
    assert_eq!(queries::normalize("259luxu1636"), "259LUXU-1636");
    assert_eq!(queries::normalize("fc2_ppv_1234567"), "FC2-PPV-1234567");
    let plan=queries::plan_query(&json!({"query":"https://video.dmm.co.jp/av/content/?id=sone00614&tracking=private","sources":["dmm"]})).unwrap();
    assert_eq!(plan["code"], "SONE-614");
    assert_eq!(plan["query"], "SONE-614");
    assert!(!plan.to_string().contains("private"));
}

#[test]
fn date_codes_need_known_publisher_and_native_links_keep_source_identity() {
    assert!(
        queries::plan_query(&json!({"query":"123456-789","sources":["dmm","1pondo"]})).is_err()
    );
    assert_eq!(
        queries::plan_query(&json!({"query":"https://javdb.com/v/AbC12","sources":["javdb"]}))
            .unwrap()["kind"],
        "url"
    );
    assert!(
        queries::plan_query(&json!({"query":"https://javdb.com/v/AbC12","sources":["dmm"]}))
            .is_err()
    );
    assert!(queries::plan_query(
        &json!({"query":"https://evil.invalid/SONE-614","sources":["dmm"]})
    )
    .is_err());
}

#[test]
fn preference_patches_preserve_false_and_require_supported_transport() {
    let previous = store::catalog()["preferences"].clone();
    let next=subscriptions::validate_preferences(&previous,&json!({"automatic":false,"proxyMode":"direct","proxyUrl":"","magnetSearch":{"enabled":false}})).unwrap();
    assert_eq!(next["automatic"], false);
    assert_eq!(next["proxyUrl"], "");
    assert_eq!(next["magnetSearch"]["enabled"], false);
    assert_eq!(next["magnetSearch"]["maxResults"], 20);
    assert!(subscriptions::validate_preferences(
        &previous,
        &json!({"sourceTransports":{"dmm":"browser"}})
    )
    .is_err());
    assert!(subscriptions::validate_preferences(&previous, &json!({"imageCacheMiB":0})).is_err());
    assert!(platform::validate_proxy("http://user:secret@localhost:7890").is_err());
}

#[test]
fn image_pins_survive_cache_clear_and_restart() {
    let (directory, store) = temporary();
    let avatar = images::put(
        &store,
        "https://example.invalid/avatar",
        &png(10),
        false,
        Some("avatar:fixture"),
    )
    .unwrap();
    let collection = images::put(
        &store,
        "https://example.invalid/collection",
        &png(20),
        false,
        Some("collection:fixture"),
    )
    .unwrap();
    let cache = images::put(
        &store,
        "https://example.invalid/cache",
        &png(30),
        false,
        None,
    )
    .unwrap();
    images::prune(&store, 0).unwrap();
    assert!(
        images::read_hash(&store, text(&avatar["original"], "sha256"))
            .unwrap()
            .is_some()
    );
    assert!(
        images::read_hash(&store, text(&collection["original"], "sha256"))
            .unwrap()
            .is_some()
    );
    assert!(
        images::read_hash(&store, text(&cache["original"], "sha256"))
            .unwrap()
            .is_none()
    );
    assert!(number(&images::usage(&store).unwrap(), "protectedBytes") > 0);
    drop(store);
    let restored = Store::open(directory.path().into()).unwrap();
    assert!(images::linked(&restored, "avatar:fixture", "original")
        .unwrap()
        .is_some());
}

#[test]
fn corrupt_images_do_not_render_and_content_hashes_deduplicate() {
    let (_directory, store) = temporary();
    let bytes = png(10);
    let first = images::put(&store, "first", &bytes, false, None).unwrap();
    let second = images::put(&store, "second", &bytes, false, None).unwrap();
    assert_eq!(first, second);
    let count: i64 = store
        .images
        .query_row("SELECT count(*) FROM objects", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 2);
    std::fs::write(
        store
            .root
            .join("images/objects")
            .join(format!("{}.image", text(&first["original"], "sha256"))),
        b"broken",
    )
    .unwrap();
    assert!(
        images::read_hash(&store, text(&first["original"], "sha256"))
            .unwrap()
            .is_none()
    );
}

#[test]
fn uploading_normalizes_avatar_and_rejects_unsupported_bytes() {
    let normalized = images::normalize_avatar(&png(10)).unwrap();
    let image = image::load_from_memory(&normalized).unwrap();
    assert_eq!(image.width(), 12);
    assert_eq!(image.height(), 12);
    assert!(images::normalize_avatar(b"<svg></svg>").is_err());
}

#[test]
fn new_avatar_failure_does_not_erase_existing_manual_or_source_avatar() {
    let (_directory, store) = temporary();
    let mut person = candidate("javdb", "A123");
    person["avatarUrl"] = json!("https://c0.jdbstatic.com/old.jpg");
    person["avatarAsset"] = json!({"sha256":"a".repeat(64),"width":1,"height":1,"format":"JPEG","quality":"small","bytes":1});
    let mut followed = store.follow(&person).unwrap();
    followed["manualAvatarAsset"] = person["avatarAsset"].clone();
    store.save_subscription(&followed).unwrap();
    person["avatarUrl"] = json!("https://c0.jdbstatic.com/new.jpg");
    person.as_object_mut().unwrap().remove("avatarAsset");
    let saved = store.follow(&person).unwrap();
    assert_eq!(saved["avatarAsset"], followed["avatarAsset"]);
    assert_eq!(saved["manualAvatarAsset"], followed["manualAvatarAsset"]);
}

#[test]
fn runtime_uses_bundled_python_in_a_clean_environment() {
    let (_directory, backend) = backend();
    let runtime = backend.start_runtime();
    assert_eq!(runtime["phase"], "ready", "{runtime}");
    assert!(text(&runtime["health"], "executable").contains(".build/python/"));
    assert_eq!(runtime["health"]["identityProbe"], "FC2-PPV-1234567");
    backend.shutdown();
}

#[test]
fn cancelled_workers_return_without_leaking_their_owned_process_group() {
    let (_directory, backend) = backend();
    let job = Job::new("cancel-fixture".into(), 0);
    let cancel = job.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(100));
        cancel.cancelled.store(true, Ordering::SeqCst);
    });
    assert!(backend
        .worker("diagnostics.wait", json!({"seconds":30}), &job, |_| Ok(()))
        .is_err());
    assert!(job.pids.lock().unwrap().is_empty());
    backend.shutdown();
}

#[test]
fn public_dispatch_rejects_unrecognized_methods_and_invalid_scopes() {
    let (_directory, backend) = backend();
    assert!(backend
        .dispatch("execute-shell", &[json!("anything")])
        .is_err());
    assert!(backend
        .dispatch("nectisse:library-work", &[json!("../../private")])
        .is_err());
    assert!(backend.image("file", "a", "original").unwrap().is_none());
    assert!(backend
        .follow_command(&json!({"action":"credential","provider":"x","cookie":"fixture"}))
        .is_err());
    backend.shutdown();
}

fn fixture_worker(backend: &Backend, root: &std::path::Path, body: &str) {
    let path = root.join("worker-fixture.py");
    let prelude = r#"import sys,json
request=json.loads(sys.stdin.readline())
def emit(kind,**fields):
 print(json.dumps(dict(protocol=1,id=request['id'],kind=kind,**fields)),flush=True)
emit('ready')
"#;
    std::fs::write(&path, format!("{prelude}\n{body}\n")).unwrap();
    *backend.0.worker_fixture.lock().unwrap() = Some(path);
}

#[test]
fn protocol_rejects_duplicate_results_and_nonzero_exit_after_result() {
    for body in [
        "emit('result',payload={});emit('result',payload={})",
        "emit('result',payload={});raise SystemExit(2)",
        "print('x'*65537,flush=True)",
    ] {
        let (root, backend) = backend();
        fixture_worker(&backend, root.path(), body);
        let job = Job::new("protocol-fixture".into(), 0);
        assert!(backend
            .worker("health", json!({}), &job, |_| Ok(()))
            .is_err());
        assert!(job.pids.lock().unwrap().is_empty());
    }
}

#[test]
fn protocol_rejects_foreign_source_and_out_of_order_permit() {
    for payload in [
        json!({"event":"request","source":"x","host":"api.fxtwitter.com","sequence":1}),
        json!({"event":"request","source":"dmm","host":"video.dmm.co.jp","sequence":2}),
    ] {
        let (root, backend) = backend();
        fixture_worker(
            &backend,
            root.path(),
            &format!(
                "emit('progress',payload=json.loads({:?}));sys.stdin.readline()",
                payload.to_string()
            ),
        );
        let job = Job::new("permit-fixture".into(), 24);
        assert!(backend
            .worker("metadata.query", json!({"source":"dmm"}), &job, |_| Ok(()))
            .is_err());
        assert_eq!(job.requests.load(Ordering::SeqCst), 0);
        assert!(job.pids.lock().unwrap().is_empty());
    }
}

#[test]
fn cancelling_a_magnet_request_by_public_id_also_handles_prearrival() {
    let (_root, backend) = backend();
    let id = uuid::Uuid::new_v4().to_string();
    let job = backend.job(&format!("magnet:{id}"), 3).unwrap();
    backend.cancel(&id).unwrap();
    assert!(job.running().is_err());
    backend.finish_job(&job.id);
    let other = uuid::Uuid::new_v4().to_string();
    backend.cancel(&other).unwrap();
    assert!(backend.job(&format!("magnet:{other}"), 3).is_err());
}

#[test]
fn legacy_avatar_files_are_imported_and_protected_before_cache_eviction() {
    let (root, store) = temporary();
    let bytes = png(15);
    let sha = hash(&bytes);
    let old = root.path().join("cache/subscription-covers");
    directory(&old).unwrap();
    std::fs::write(old.join(format!("{sha}.image")), &bytes).unwrap();
    let mut sub = store.follow(&candidate("javdb", "A123")).unwrap();
    sub["avatarAsset"] = images::asset(&bytes, 16, 12, "PNG");
    store.save_subscription(&sub).unwrap();
    images::prepare(&store).unwrap();
    images::prune(&store, 0).unwrap();
    assert!(images::read_hash(&store, &sha).unwrap().is_some());
    assert!(
        images::linked(&store, &format!("avatar:{}", text(&sub, "id")), "original")
            .unwrap()
            .is_some()
    );
}

#[test]
fn fc2_browser_transport_is_isolated_from_ordinary_http_sources() {
    let defaults = store::catalog()["preferences"].clone();
    assert_eq!(platform::transport("fc2ppvdb", &defaults), "browser");
    assert!(subscriptions::validate_preferences(
        &defaults,
        &json!({"sourceTransports":{"javdb":"browser"}})
    )
    .is_err());
    assert!(subscriptions::validate_preferences(
        &defaults,
        &json!({"sourceTransports":{"fc2ppvdb":"httpx"}})
    )
    .is_ok());
    let plan=queries::plan_query(&json!({"query":"https://fc2ppv-db.com/ja/videos/4898837?tracking=discard","sources":["fc2","fc2ppvdb"]})).unwrap();
    assert_eq!(plan["code"], "FC2-PPV-4898837");
    assert_eq!(plan["sources"], json!(["fc2ppvdb"]));
}

fn query_fixture_record() -> Value {
    json!({"id":hash("fixture-record"),"source":"dmm","parser":"fixture","parserVersion":"1","code":"SONE-614","contentId":"sone00614","sourceUrl":"https://video.dmm.co.jp/av/content/?id=sone00614","fetchedAt":now(),"title":"Fixture","titleLanguage":"ja","people":[],"studio":"","label":"","series":"","seller":"","sellerUrl":"","releaseDate":"2026-10-29","description":"","tags":[],"covers":[],"warnings":[]})
}

fn wait_query(backend: &Backend) -> Value {
    let until = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        let task = backend.0.store.lock().unwrap().metadata["tasks"][0].clone();
        if !["running", "cancelling"].contains(&text(&task, "status")) {
            return task;
        }
        assert!(std::time::Instant::now() < until, "Query did not finish");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn query_worker_records_survive_collection_and_restart_without_a_node_process() {
    let (root, backend) = backend();
    let record = query_fixture_record();
    fixture_worker(&backend,root.path(),&format!("emit('progress',payload=dict(event='record',record=json.loads({:?})));emit('result',payload=dict(status='success',reason='',message='',retryAfter=0,warnings=[]))",record.to_string()));
    let request = json!({"query":"SONE-614","sources":["dmm"],"force":false});
    let reply = backend.query(&request).unwrap();
    assert_eq!(reply["ok"], true);
    let task = wait_query(&backend);
    assert_eq!(task["status"], "succeeded", "{task}");
    assert_eq!(backend.query(&request).unwrap()["cached"], true);
    let saved = backend
        .save_work(&json!({"taskId":task["id"],"code":"SONE-614","replace":false}))
        .unwrap();
    assert_eq!(saved["ok"], true);
    backend.shutdown();
    drop(backend);
    let mut restored = Store::open(root.path().into()).unwrap();
    let state = restored.library_state().unwrap();
    assert_eq!(state["works"][0]["code"], "SONE-614");
    assert_eq!(
        restored.work(text(&saved, "id")).unwrap().unwrap()["records"][0],
        record
    );
}

#[test]
fn collected_magnet_results_do_not_expire_or_invoke_another_worker() {
    let (root, backend) = backend();
    let task_id = uuid::Uuid::new_v4().to_string();
    {
        let mut store = backend.0.store.lock().unwrap();
        store.metadata["tasks"] = json!([{"id":task_id,"status":"succeeded","phase":"fixture","plan":{"kind":"code","query":"SONE-614","code":"SONE-614","contentId":"","sources":["dmm"]},"startedAt":now(),"finishedAt":now(),"records":[query_fixture_record()],"outcomes":[],"requests":0}]);
        store.commit_metadata().unwrap();
        let mut prefs = store.preferences().unwrap();
        prefs["magnetSearch"]["enabled"] = json!(true);
        store.save_preferences(&prefs).unwrap();
    }
    let work = backend
        .save_work(&json!({"taskId":task_id,"code":"SONE-614","replace":false}))
        .unwrap();
    fixture_worker(
        &backend,
        root.path(),
        "emit('result',payload=dict(status='ready',items=[],message='',reason='',retryAfter=0))",
    );
    let request = json!({"id":uuid::Uuid::new_v4().to_string(),"source":"sukebei","origin":{"kind":"library","id":work["id"]},"force":false});
    let first = backend.magnet_search(&request).unwrap();
    assert_eq!(first["status"], "ready", "{first}");
    let path = root
        .path()
        .join("magnet-search/saved")
        .join(format!("sukebei-{}.json", hash("SONE-614")));
    let mut cached = read_json(&path, 65536, Value::Null).unwrap();
    cached["checkedAt"] = json!("2020-01-01T00:00:00.000Z");
    write_json(&path, &cached).unwrap();
    fixture_worker(
        &backend,
        root.path(),
        "raise SystemExit('Unexpected worker invocation')",
    );
    let second = backend.magnet_search(&request).unwrap();
    assert_eq!(second["status"], "ready");
    assert_eq!(second["checkedAt"], cached["checkedAt"]);
}

#[test]
fn failed_job_setup_does_not_leave_a_permanent_busy_registration() {
    let (_root, backend) = backend();
    let job = backend.job("fixture", 1).unwrap();
    assert!(backend.active("fixture"));
    drop(job);
    assert!(!backend.active("fixture"));
    assert!(backend.job("fixture", 1).is_ok());
}

#[test]
fn cancellation_pauses_subscription_automatic_checks_until_explicit_resume() {
    let (_root, backend) = backend();
    let sub = backend
        .0
        .store
        .lock()
        .unwrap()
        .follow(&candidate("javdb", "A123"))
        .unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let job = backend.job(&id, 24).unwrap();
    backend.0.store.lock().unwrap().save_task(&json!({"id":id,"kind":"check","provider":"javdb","subscriptionId":sub["id"],"status":"running","phase":"fixture","startedAt":now(),"finishedAt":"","requests":0,"candidates":[],"added":0,"reason":"","cancelRequestedAt":""})).unwrap();
    backend.cancel(&id).unwrap();
    assert!(job.running().is_err());
    let saved = backend
        .0
        .store
        .lock()
        .unwrap()
        .subscription(text(&sub, "id"))
        .unwrap()
        .unwrap();
    assert_eq!(saved["autoPaused"], true);
    assert!(!text(&saved, "lastError").is_empty());
}

#[test]
fn diagnostics_preserve_fixed_labels_across_restart_and_drop_unknown_data() {
    let (root, backend) = backend();
    backend.record_context("SUBSCRIPTIONS_STORAGE_READ",Some(&json!({"stage":"entries","kind":"storage_error","systemCode":"EACCES","cookie":"must-not-be-recorded"})));
    drop(backend);
    let log =
        std::fs::read_to_string(root.path().join("diagnostics/subscription-read.jsonl")).unwrap();
    assert!(!log.contains("must-not-be-recorded"));
    let restored = Backend::open(root.path().into(), PathBuf::new(), false).unwrap();
    let report = restored.diagnostics();
    assert_eq!(report["entries"][0]["context"]["stage"], "entries");
    assert_eq!(report["logStatus"], "ready");
}

#[test]
fn stale_images_return_cached_pixels_and_cache_clear_fences_late_refreshes() {
    for clear in [false, true] {
        let (root, backend) = backend();
        let old = png(25);
        let new = png(95);
        let url = "https://pics.dmm.co.jp/mono/movie/adult/sone00614/sone00614pl.jpg";
        let cover_id = hash("stale-cover");
        let task_id = uuid::Uuid::new_v4().to_string();
        let old_asset;
        {
            let mut store = backend.0.store.lock().unwrap();
            let saved = images::put(
                &store,
                url,
                &old,
                false,
                Some(&format!("query:{task_id}:SONE-614")),
            )
            .unwrap();
            old_asset = saved["original"].clone();
            store
                .images
                .execute("UPDATE refs SET fetched=0 WHERE key=?", [url])
                .unwrap();
            let mut record = query_fixture_record();
            record["covers"] = json!([{"id":cover_id,"source":"dmm","url":url,"identity":"source-matched","asset":old_asset}]);
            store.metadata["tasks"] = json!([{"id":task_id,"status":"succeeded","phase":"fixture","plan":{"kind":"code","query":"SONE-614","code":"SONE-614","contentId":"","sources":["dmm"]},"startedAt":now(),"finishedAt":now(),"records":[record],"outcomes":[],"requests":0}]);
            store.commit_metadata().unwrap();
        }
        let hex = new
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let asset = images::asset(&new, 16, 12, "PNG");
        fixture_worker(&backend,root.path(),&format!("import time,pathlib\ntime.sleep(0.2)\npathlib.Path(request['params']['destination']).write_bytes(bytes.fromhex({hex:?}))\nemit('result',payload=dict(status='success',reason='',message='',retryAfter=0,asset=json.loads({:?})))",asset.to_string()));
        assert!(backend
            .image("image", &cover_id, "thumbnail")
            .unwrap()
            .is_some());
        if clear {
            backend.dispatch("nectisse:storage-clear", &[]).unwrap();
        }
        let until = std::time::Instant::now() + Duration::from_secs(5);
        while backend.active("image:refresh:") {
            assert!(std::time::Instant::now() < until, "Refresh did not finish");
            std::thread::sleep(Duration::from_millis(10));
        }
        let store = backend.0.store.lock().unwrap();
        let saved = &store.metadata["tasks"][0]["records"][0]["covers"][0]["asset"];
        assert_eq!(
            saved["sha256"],
            if clear {
                old_asset["sha256"].clone()
            } else {
                asset["sha256"].clone()
            }
        );
    }
}

#[test]
fn actual_electron_sqlite_fixture_keeps_people_posts_settings_and_read_state() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(
        root.path().join("nectisse.sqlite"),
        include_bytes!("../../tests/fixtures/electron-0.1.sqlite"),
    )
    .unwrap();
    let mut store = Store::open(root.path().into()).unwrap();
    let snapshot = store.subscriptions_state(false).unwrap();
    crate::contracts::validate("subscriptions", &snapshot).unwrap();
    assert_eq!(snapshot["preferences"]["theme"], "night");
    assert_eq!(snapshot["preferences"]["automatic"], false);
    assert_eq!(array(&snapshot, "subscriptions").len(), 2);
    assert_eq!(array(&snapshot, "entries").len(), 2);
    assert_eq!(snapshot["entries"][0]["summary"], "原始正文");
    let entry = snapshot["entries"][0].clone();
    store.mark_read(&[entry["id"].clone()], true).unwrap();
    drop(store);
    let restored = Store::open(root.path().into()).unwrap();
    assert_eq!(
        restored.entry(text(&entry, "id")).unwrap().unwrap()["read"],
        true
    );
}

#[test]
fn cached_avatars_remain_readable_during_a_slow_remote_cover_download() {
    let (root, backend) = backend();
    let avatar;
    let cover_id = hash("slow-cover");
    {
        let mut store = backend.0.store.lock().unwrap();
        avatar = images::put(&store, "avatar:fast", &png(75), false, Some("avatar:fast")).unwrap()
            ["original"]
            .clone();
        let mut record = query_fixture_record();
        record["covers"] = json!([{"id":cover_id,"source":"dmm","url":"https://pics.dmm.co.jp/mono/movie/adult/sone00614/sone00614pl.jpg","identity":"source-matched","asset":images::asset(&png(15),16,12,"PNG")}]);
        store.metadata["tasks"] = json!([{"id":uuid::Uuid::new_v4().to_string(),"status":"succeeded","phase":"fixture","plan":{"kind":"code","query":"SONE-614","code":"SONE-614","contentId":"","sources":["dmm"]},"startedAt":now(),"finishedAt":now(),"records":[record],"outcomes":[],"requests":0}]);
        store.commit_metadata().unwrap();
    }
    fixture_worker(&backend,root.path(),"import time\ntime.sleep(1.5)\nemit('result',payload=dict(status='error',reason='network',message='',retryAfter=0))");
    let download = backend.clone();
    let thread = std::thread::spawn(move || download.image("image", &cover_id, "original"));
    let until = std::time::Instant::now() + Duration::from_secs(3);
    while !backend.active("image:") {
        assert!(std::time::Instant::now() < until);
        std::thread::sleep(Duration::from_millis(5));
    }
    let started = std::time::Instant::now();
    assert!(backend
        .image("avatars", text(&avatar, "sha256"), "original")
        .unwrap()
        .is_some());
    assert!(started.elapsed() < Duration::from_millis(700));
    assert!(thread.join().unwrap().unwrap().is_none());
}
