use chrono::{SecondsFormat, Utc};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::Path};

pub type Result<T> = std::result::Result<T, String>;

pub fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn millis() -> i64 {
    Utc::now().timestamp_millis()
}

pub fn stamp(value: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|date| date.timestamp_millis())
        .or_else(|_| {
            chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").map(|date| {
                date.and_hms_opt(0, 0, 0)
                    .unwrap()
                    .and_utc()
                    .timestamp_millis()
            })
        })
        .unwrap_or(0)
}

pub fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

pub fn array(value: &Value, key: &str) -> Vec<Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

pub fn flag(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

pub fn number(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or(0)
}

pub fn hash(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}

pub fn is_hash(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub fn uuid(value: &str) -> Result<()> {
    uuid::Uuid::parse_str(value)
        .map(|_| ())
        .map_err(|_| "输入格式不正确".into())
}

pub fn directory(path: &Path) -> Result<()> {
    fs::create_dir_all(path).map_err(|_| "无法准备本机数据目录".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| "无法设置目录权限".to_string())?;
    }
    Ok(())
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().ok_or("无效的保存位置")?;
    directory(parent)?;
    let temporary = parent.join(format!(".temporary-{}", uuid::Uuid::new_v4()));
    let operation = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(|_| "无法保存本机文件")?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "无法保存本机文件")?;
        fs::rename(&temporary, path).map_err(|_| "无法提交本机文件")?;
        Ok(())
    })();
    let _ = fs::remove_file(temporary);
    operation
}

pub fn write_json(path: &Path, value: &Value) -> Result<()> {
    atomic_write(
        path,
        &serde_json::to_vec(value).map_err(|_| "本机记录格式不正确")?,
    )
}

pub fn read_json(path: &Path, limit: u64, default: Value) -> Result<Value> {
    match fs::metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(default),
        Ok(info) if info.is_file() && info.len() <= limit => {
            let bytes = fs::read(path).map_err(|_| "本机记录暂不可读")?;
            serde_json::from_slice(&bytes).map_err(|_| "本机记录格式不正确，原文件已保留".into())
        }
        _ => Err("本机记录暂不可读，原文件已保留".into()),
    }
}

pub fn reply(message: &str) -> Value {
    json!({"ok":false,"message":message})
}

pub fn merge(target: &mut Value, patch: &Value) {
    if let (Some(target), Some(patch)) = (target.as_object_mut(), patch.as_object()) {
        for (key, value) in patch {
            target.insert(key.clone(), value.clone());
        }
    }
}
