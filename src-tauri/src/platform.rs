use crate::util::*;
use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use serde_json::Value;
use std::sync::Mutex;

pub struct Vault {
    key: Mutex<Option<[u8; 32]>>,
}

impl Vault {
    pub fn new() -> Self {
        Self {
            key: Mutex::new(None),
        }
    }

    #[cfg(test)]
    pub fn testing() -> Self {
        Self {
            key: Mutex::new(Some([42; 32])),
        }
    }

    pub fn available(&self) -> bool {
        cfg!(target_os = "macos") || self.key.lock().unwrap().is_some()
    }

    fn key(&self) -> Result<[u8; 32]> {
        let mut cached = self.key.lock().map_err(|_| "安全存储暂不可用")?;
        if let Some(key) = *cached {
            return Ok(key);
        }
        #[cfg(target_os = "macos")]
        {
            use aes_gcm::aead::rand_core::RngCore;
            use security_framework::passwords::{get_generic_password, set_generic_password};
            let bytes = match get_generic_password("Nectisse Encryption", "database-key-v2") {
                Ok(bytes) => bytes,
                Err(error) if error.code() == -25300 => {
                    let mut bytes = vec![0; 32];
                    OsRng.fill_bytes(&mut bytes);
                    set_generic_password("Nectisse Encryption", "database-key-v2", &bytes)
                        .map_err(|_| "系统安全存储暂不可用，未保存 Cookie")?;
                    bytes
                }
                Err(_) => return Err("系统安全存储暂不可用，未保存 Cookie".into()),
            };
            let key: [u8; 32] = bytes.try_into().map_err(|_| "安全存储密钥格式不正确")?;
            *cached = Some(key);
            Ok(key)
        }
        #[cfg(not(target_os = "macos"))]
        Err("此系统尚未接入安全存储，未保存 Cookie".into())
    }

    pub fn encrypt(&self, text: &str) -> Result<Vec<u8>> {
        let cipher = Aes256Gcm::new_from_slice(&self.key()?).map_err(|_| "安全存储暂不可用")?;
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let encrypted = cipher
            .encrypt(&nonce, text.as_bytes())
            .map_err(|_| "凭据未能加密")?;
        let mut value = b"NCT2".to_vec();
        value.extend_from_slice(&nonce);
        value.extend(encrypted);
        Ok(value)
    }

    pub fn decrypt(&self, bytes: &[u8]) -> Result<String> {
        if bytes.starts_with(b"NCT2") && bytes.len() >= 32 {
            let cipher = Aes256Gcm::new_from_slice(&self.key()?).map_err(|_| "安全存储暂不可用")?;
            let plain = cipher
                .decrypt(Nonce::from_slice(&bytes[4..16]), &bytes[16..])
                .map_err(|_| "保存的凭据无法解密，原记录已保留")?;
            return String::from_utf8(plain).map_err(|_| "保存的凭据格式不正确".into());
        }
        if bytes.is_empty() {
            return Ok(String::new());
        }
        #[cfg(target_os = "macos")]
        if bytes.starts_with(b"v10") {
            let password = security_framework::passwords::get_generic_password(
                "Nectisse Safe Storage",
                "Nectisse",
            )
            .map_err(|_| {
                "无法访问旧版安全存储；请允许钥匙串访问，或重新保存 Cookie。原密文已保留"
            })?;
            return decrypt_legacy(bytes, &password);
        }
        Err("保存的凭据版本不支持，原记录已保留".into())
    }
}

pub fn decrypt_legacy(bytes: &[u8], password: &[u8]) -> Result<String> {
    use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
    if bytes.is_empty() {
        return Ok(String::new());
    }
    let encrypted = bytes.strip_prefix(b"v10").ok_or("旧凭据格式不正确")?;
    let mut key = [0u8; 16];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password, b"saltysalt", 1003, &mut key);
    let plain = cbc::Decryptor::<aes::Aes128>::new((&key).into(), (&[0x20u8; 16]).into())
        .decrypt_padded_vec_mut::<Pkcs7>(encrypted)
        .map_err(|_| "旧凭据未能解密，原记录已保留")?;
    String::from_utf8(plain).map_err(|_| "旧凭据内容格式不正确".into())
}

pub fn transport(id: &str, preferences: &Value) -> String {
    if let Some(value) = preferences["sourceTransports"][id].as_str() {
        return value.to_string();
    }
    match id {
        "fanbox" => text(preferences, "fanboxTransport"),
        "javdb" => text(preferences, "javdbTransport"),
        "fc2ppvdb" => "browser",
        "dmm" | "r18dev" | "fc2" | "x" => "httpx",
        _ => "fingerprint",
    }
    .to_string()
}

pub fn cooldown(reason: &str, retry: i64) -> i64 {
    match reason {
        "rate_limited" => retry.clamp(60, 86400),
        "challenge" | "access_denied" | "auth_required" | "region_restricted" => 300,
        "network" | "timeout" | "server_error" => 30,
        _ => 0,
    }
}

pub fn allowed_url(source: &str, value: &str, kind: &str) -> bool {
    let Ok(spec) = crate::store::source(source) else {
        return false;
    };
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some_and(|port| port != 443)
    {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let mut domains = array(
        &spec,
        if kind == "image" {
            "images"
        } else if kind == "request" {
            "requestDomains"
        } else {
            "domains"
        },
    );
    if kind == "request" && domains.is_empty() {
        domains = array(&spec, "domains");
    }
    domains
        .iter()
        .filter_map(Value::as_str)
        .any(|domain| host == domain || host.ends_with(&format!(".{domain}")))
}

pub fn proxy(preferences: &Value, target: &str) -> Result<String> {
    match text(preferences, "proxyMode") {
        "direct" => Ok(String::new()),
        "custom" => validate_proxy(text(preferences, "proxyUrl")),
        "system" => system_proxy(target),
        _ => Err("代理设置格式不正确".into()),
    }
}

pub fn validate_proxy(value: &str) -> Result<String> {
    let url = url::Url::parse(value).map_err(|_| "代理地址格式不正确")?;
    if !["http", "https", "socks5", "socks5h"].contains(&url.scheme())
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("请输入不含账号密码的 HTTP / HTTPS / SOCKS 代理地址".into());
    }
    Ok(value.trim_end_matches('/').to_string())
}

#[cfg(not(target_os = "macos"))]
fn system_proxy(_target: &str) -> Result<String> {
    Err("此系统的系统代理尚未接入，请选择直接连接或自定义代理".into())
}

#[cfg(target_os = "macos")]
fn system_proxy(target: &str) -> Result<String> {
    use core_foundation::{base::TCFType, string::CFString, url::CFURL};
    use core_foundation_sys::{
        array::{CFArrayGetCount, CFArrayGetValueAtIndex, CFArrayRef},
        base::{CFEqual, CFRelease, CFTypeRef},
        dictionary::{CFDictionaryGetValue, CFDictionaryRef},
        number::{kCFNumberSInt32Type, CFNumberGetValue},
        string::CFStringRef,
        url::{CFURLCreateWithString, CFURLRef},
    };
    #[link(name = "CFNetwork", kind = "framework")]
    unsafe extern "C" {
        fn CFNetworkCopySystemProxySettings() -> CFDictionaryRef;
        fn CFNetworkCopyProxiesForURL(url: CFURLRef, settings: CFDictionaryRef) -> CFArrayRef;
        fn CFNetworkCopyProxiesForAutoConfigurationScript(
            script: CFStringRef,
            url: CFURLRef,
            error: *mut CFTypeRef,
        ) -> CFArrayRef;
        static kCFProxyTypeKey: CFStringRef;
        static kCFProxyTypeNone: CFStringRef;
        static kCFProxyTypeHTTP: CFStringRef;
        static kCFProxyTypeHTTPS: CFStringRef;
        static kCFProxyTypeSOCKS: CFStringRef;
        static kCFProxyTypeAutoConfigurationURL: CFStringRef;
        static kCFProxyTypeAutoConfigurationJavaScript: CFStringRef;
        static kCFProxyHostNameKey: CFStringRef;
        static kCFProxyPortNumberKey: CFStringRef;
        static kCFProxyAutoConfigurationURLKey: CFStringRef;
        static kCFProxyAutoConfigurationJavaScriptKey: CFStringRef;
    }
    unsafe fn string(value: CFTypeRef) -> Result<String> {
        if value.is_null() {
            return Err("系统代理格式不正确".into());
        }
        if unsafe { core_foundation_sys::base::CFGetTypeID(value) } != CFString::type_id() {
            return Err("系统代理格式不正确".into());
        }
        Ok(unsafe { CFString::wrap_under_get_rule(value.cast()) }.to_string())
    }
    unsafe fn resolve(list: CFArrayRef, target: CFURLRef, depth: usize) -> Result<String> {
        if list.is_null() || unsafe { CFArrayGetCount(list) } == 0 || depth > 1 {
            return Err("系统代理暂不可用，请改用自定义代理".into());
        }
        let dictionary = unsafe { CFArrayGetValueAtIndex(list, 0) } as CFDictionaryRef;
        let kind = unsafe { CFDictionaryGetValue(dictionary, kCFProxyTypeKey.cast()) };
        if kind.is_null() {
            return Err("系统代理类型不正确".into());
        }
        if unsafe { CFEqual(kind, kCFProxyTypeNone.cast()) } != 0 {
            return Ok(String::new());
        }
        for (key, scheme) in unsafe {
            [
                (kCFProxyTypeHTTP, "http"),
                (kCFProxyTypeHTTPS, "https"),
                (kCFProxyTypeSOCKS, "socks5h"),
            ]
        } {
            if unsafe { CFEqual(kind, key.cast()) } != 0 {
                let host = unsafe {
                    string(CFDictionaryGetValue(dictionary, kCFProxyHostNameKey.cast()))
                }?;
                let port_value =
                    unsafe { CFDictionaryGetValue(dictionary, kCFProxyPortNumberKey.cast()) };
                let mut port = 0i32;
                if port_value.is_null()
                    || !unsafe {
                        CFNumberGetValue(
                            port_value.cast(),
                            kCFNumberSInt32Type,
                            (&mut port as *mut i32).cast(),
                        )
                    }
                    || !(1..=65535).contains(&port)
                {
                    return Err("系统代理端口不正确".into());
                }
                let host = if host.contains(':') {
                    format!("[{host}]")
                } else {
                    host
                };
                return validate_proxy(&format!("{scheme}://{host}:{port}"));
            }
        }
        let script = if unsafe { CFEqual(kind, kCFProxyTypeAutoConfigurationJavaScript.cast()) }
            != 0
        {
            unsafe {
                string(CFDictionaryGetValue(
                    dictionary,
                    kCFProxyAutoConfigurationJavaScriptKey.cast(),
                ))
            }?
        } else if unsafe { CFEqual(kind, kCFProxyTypeAutoConfigurationURL.cast()) } != 0 {
            let value =
                unsafe { CFDictionaryGetValue(dictionary, kCFProxyAutoConfigurationURLKey.cast()) };
            if value.is_null() {
                return Err("系统 PAC 地址不正确".into());
            }
            let url = unsafe { CFURL::wrap_under_get_rule(value.cast()) }
                .get_string()
                .to_string();
            let parsed = url::Url::parse(&url).map_err(|_| "系统 PAC 地址不正确")?;
            if !["https", "http"].contains(&parsed.scheme())
                || parsed.password().is_some()
                || !parsed.username().is_empty()
            {
                return Err("系统 PAC 地址暂不支持".into());
            }
            let output = std::process::Command::new("/usr/bin/curl")
                .args([
                    "--silent",
                    "--fail",
                    "--max-time",
                    "5",
                    "--max-filesize",
                    "262144",
                    "--noproxy",
                    "*",
                    "--url",
                    &url,
                ])
                .output()
                .map_err(|_| "系统 PAC 暂不可读")?;
            if !output.status.success() {
                return Err("系统 PAC 暂不可读，请选择自定义代理".into());
            }
            String::from_utf8(output.stdout).map_err(|_| "系统 PAC 格式不正确")?
        } else {
            return Err("系统代理类型暂不支持，请选择自定义代理".into());
        };
        let script = CFString::new(&script);
        let mut error = std::ptr::null();
        let resolved = unsafe {
            CFNetworkCopyProxiesForAutoConfigurationScript(
                script.as_concrete_TypeRef(),
                target,
                &mut error,
            )
        };
        if !error.is_null() {
            unsafe { CFRelease(error) };
        }
        let result = unsafe { resolve(resolved, target, depth + 1) };
        if !resolved.is_null() {
            unsafe { CFRelease(resolved.cast()) };
        }
        result
    }
    let target = CFString::new(target);
    unsafe {
        let target = CFURLCreateWithString(
            std::ptr::null(),
            target.as_concrete_TypeRef(),
            std::ptr::null(),
        );
        if target.is_null() {
            return Err("请求地址格式不正确".into());
        }
        let settings = CFNetworkCopySystemProxySettings();
        if settings.is_null() {
            CFRelease(target.cast());
            return Err("系统代理读取失败".into());
        }
        let list = CFNetworkCopyProxiesForURL(target, settings);
        let result = resolve(list, target, 0);
        if !list.is_null() {
            CFRelease(list.cast());
        }
        CFRelease(settings.cast());
        CFRelease(target.cast());
        result
    }
}
