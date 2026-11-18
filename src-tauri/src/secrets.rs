//! API Key 的加密存储。
//!
//! `settings.json` 只保留非敏感字段；密钥写入同目录的 `secrets.bin`：
//! - **Windows**：DPAPI（与当前登录用户绑定，换账户或换机器都无法解密）
//! - **其他平台**：AES-256-GCM（ring），主密钥优先放系统钥匙串，取不到时落到 0600 权限的密钥文件
//!
//! 对外只暴露「按名字存取一段明文」：密钥名用 `provider:<id>` 与 `mineru`。
//! 读取失败不阻塞启动——调用方按「没有密钥」继续，用户重新填写即可。

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

/// 当前的存储后端名称，用于设置页展示与诊断。
pub fn backend() -> &'static str {
    #[cfg(windows)]
    {
        "dpapi"
    }
    #[cfg(not(windows))]
    {
        "aes-256-gcm"
    }
}

/// secrets.bin 的路径（与 settings.json 同目录）。
pub fn path() -> Result<PathBuf> {
    Ok(crate::settings::app_data_dir()?.join("secrets.bin"))
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct SecretFile {
    /// 文件格式版本，便于以后更换算法。
    #[serde(default)]
    version: u32,
    /// 写入时使用的后端；跨平台复制后可以据此提示「需要重新填写」。
    #[serde(default)]
    backend: String,
    /// 名字 → 十六进制密文。
    #[serde(default)]
    items: BTreeMap<String, String>,
}

/// 读出全部密钥（明文）。文件不存在时返回空表。
pub fn load() -> Result<BTreeMap<String, String>> {
    let path = path()?;
    if !path.exists() {
        return Ok(BTreeMap::new());
    }
    let raw = std::fs::read_to_string(&path).context("读取 secrets.bin 失败")?;
    let file: SecretFile = serde_json::from_str(&raw).context("解析 secrets.bin 失败")?;
    if file.version != 1 {
        bail!("secrets.bin 版本 {} 不受支持", file.version);
    }
    if file.backend != backend() {
        bail!(
            "密钥文件来自 {} 后端（当前为 {}）：换机器或换账户后需要重新填写 API Key",
            file.backend,
            backend()
        );
    }
    let mut out = BTreeMap::new();
    for (name, hex) in &file.items {
        let sealed = from_hex(hex).with_context(|| format!("密钥 {name} 不是合法的十六进制"))?;
        let plain = open(&sealed).with_context(|| format!("解密 {name} 失败"))?;
        out.insert(name.clone(), String::from_utf8(plain).context("密钥不是 UTF-8")?);
    }
    Ok(out)
}

/// 写入全部密钥（明文进、密文出）。原子替换，避免写到一半崩溃导致密钥全丢。
pub fn save(items: &BTreeMap<String, String>) -> Result<()> {
    let path = path()?;
    let mut file = SecretFile {
        version: 1,
        backend: backend().to_string(),
        items: BTreeMap::new(),
    };
    for (name, plain) in items {
        if plain.is_empty() {
            continue;
        }
        let sealed = protect(plain.as_bytes()).with_context(|| format!("加密 {name} 失败"))?;
        file.items.insert(name.clone(), to_hex(&sealed));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let bytes = serde_json::to_vec_pretty(&file)?;
    let temporary = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        use std::io::Write;
        let mut handle = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        restrict(&temporary)?;
        handle.write_all(&bytes)?;
        handle.sync_all()?;
        std::fs::rename(&temporary, &path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result.context("保存 secrets.bin 失败")
}

#[cfg(unix)]
fn restrict(path: &std::path::Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(unix))]
fn restrict(_path: &std::path::Path) -> Result<()> {
    Ok(())
}

fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn from_hex(text: &str) -> Result<Vec<u8>> {
    let text = text.trim();
    if text.len() % 2 != 0 {
        bail!("长度不是偶数");
    }
    (0..text.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&text[index..index + 2], 16).map_err(|e| anyhow!("{e}")))
        .collect()
}

// ---------- Windows：DPAPI ----------

#[cfg(windows)]
fn protect(plain: &[u8]) -> Result<Vec<u8>> {
    dpapi::protect(plain)
}

#[cfg(windows)]
fn open(sealed: &[u8]) -> Result<Vec<u8>> {
    dpapi::unprotect(sealed)
}

#[cfg(windows)]
mod dpapi {
    //! 只声明用到的两个 DPAPI 函数，不引入额外依赖。
    use anyhow::{bail, Result};
    use std::ffi::c_void;
    use std::ptr;

    #[repr(C)]
    struct DataBlob {
        cb_data: u32,
        pb_data: *mut u8,
    }

    #[link(name = "crypt32")]
    extern "system" {
        fn CryptProtectData(
            p_data_in: *const DataBlob,
            sz_data_descr: *const u16,
            p_optional_entropy: *const DataBlob,
            pv_reserved: *const c_void,
            p_prompt_struct: *const c_void,
            dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;
        fn CryptUnprotectData(
            p_data_in: *const DataBlob,
            ppsz_data_descr: *mut *mut u16,
            p_optional_entropy: *const DataBlob,
            pv_reserved: *const c_void,
            p_prompt_struct: *const c_void,
            dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(h_mem: *mut c_void) -> *mut c_void;
    }

    /// DPAPI 缓冲区由系统分配，必须用 LocalFree 释放。
    unsafe fn take(blob: &DataBlob) -> Vec<u8> {
        if blob.pb_data.is_null() || blob.cb_data == 0 {
            return Vec::new();
        }
        let bytes = std::slice::from_raw_parts(blob.pb_data, blob.cb_data as usize).to_vec();
        LocalFree(blob.pb_data as *mut c_void);
        bytes
    }

    pub fn protect(plain: &[u8]) -> Result<Vec<u8>> {
        let input = DataBlob {
            cb_data: plain.len() as u32,
            pb_data: plain.as_ptr() as *mut u8,
        };
        let mut output = DataBlob {
            cb_data: 0,
            pb_data: ptr::null_mut(),
        };
        // 0 表示「当前用户」作用域：只有同一 Windows 账户能解密。
        let ok = unsafe {
            CryptProtectData(
                &input,
                ptr::null(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                0,
                &mut output,
            )
        };
        if ok == 0 {
            bail!("DPAPI 加密失败：{}", std::io::Error::last_os_error());
        }
        Ok(unsafe { take(&output) })
    }

    pub fn unprotect(sealed: &[u8]) -> Result<Vec<u8>> {
        let input = DataBlob {
            cb_data: sealed.len() as u32,
            pb_data: sealed.as_ptr() as *mut u8,
        };
        let mut output = DataBlob {
            cb_data: 0,
            pb_data: ptr::null_mut(),
        };
        let ok = unsafe {
            CryptUnprotectData(
                &input,
                ptr::null_mut(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                0,
                &mut output,
            )
        };
        if ok == 0 {
            bail!("DPAPI 解密失败：{}", std::io::Error::last_os_error());
        }
        Ok(unsafe { take(&output) })
    }
}

// ---------- 其他平台：AES-256-GCM ----------

#[cfg(any(not(windows), test))]
mod aead {
    //! 密钥派生自「主密钥」（钥匙串或 0600 文件），密文格式为 nonce || ciphertext+tag。
    use anyhow::{anyhow, Result};
    use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM, NONCE_LEN};
    use ring::rand::{SecureRandom, SystemRandom};

    pub fn seal(key: &[u8; 32], plain: &[u8]) -> Result<Vec<u8>> {
        let key = LessSafeKey::new(
            UnboundKey::new(&AES_256_GCM, key).map_err(|_| anyhow!("AES-256-GCM 密钥无效"))?,
        );
        let mut nonce_bytes = [0u8; NONCE_LEN];
        SystemRandom::new()
            .fill(&mut nonce_bytes)
            .map_err(|_| anyhow!("生成随机 nonce 失败"))?;
        let mut buffer = plain.to_vec();
        key.seal_in_place_append_tag(
            Nonce::assume_unique_for_key(nonce_bytes),
            Aad::empty(),
            &mut buffer,
        )
        .map_err(|_| anyhow!("加密失败"))?;
        let mut out = nonce_bytes.to_vec();
        out.extend(buffer);
        Ok(out)
    }

    pub fn open(key: &[u8; 32], sealed: &[u8]) -> Result<Vec<u8>> {
        if sealed.len() <= NONCE_LEN {
            return Err(anyhow!("密文长度不足"));
        }
        let key = LessSafeKey::new(
            UnboundKey::new(&AES_256_GCM, key).map_err(|_| anyhow!("AES-256-GCM 密钥无效"))?,
        );
        let (nonce_bytes, payload) = sealed.split_at(NONCE_LEN);
        let mut buffer = payload.to_vec();
        let plain = key
            .open_in_place(
                Nonce::try_assume_unique_for_key(nonce_bytes).map_err(|_| anyhow!("nonce 无效"))?,
                Aad::empty(),
                &mut buffer,
            )
            .map_err(|_| anyhow!("解密失败（密钥不匹配或文件被改动）"))?;
        Ok(plain.to_vec())
    }
}

#[cfg(not(windows))]
fn protect(plain: &[u8]) -> Result<Vec<u8>> {
    aead::seal(&master_key()?, plain)
}

#[cfg(not(windows))]
fn open(sealed: &[u8]) -> Result<Vec<u8>> {
    aead::open(&master_key()?, sealed)
}

/// 主密钥：优先系统钥匙串，失败则用 0600 权限的本地密钥文件。
#[cfg(not(windows))]
fn master_key() -> Result<[u8; 32]> {
    const SERVICE: &str = "zoompaper-master-key";
    #[cfg(target_os = "macos")]
    if let Some(key) = keychain_read(SERVICE) {
        return Ok(key);
    }
    let path = crate::settings::app_data_dir()?.join("master.key");
    if let Ok(text) = std::fs::read_to_string(&path) {
        let bytes = from_hex(text.trim())?;
        if bytes.len() == 32 {
            let mut key = [0u8; 32];
            key.copy_from_slice(&bytes);
            return Ok(key);
        }
    }
    let mut key = [0u8; 32];
    ring::rand::SystemRandom::new()
        .fill(&mut key)
        .map_err(|_| anyhow!("生成主密钥失败"))?;
    #[cfg(target_os = "macos")]
    {
        if keychain_write(SERVICE, &key) {
            return Ok(key);
        }
    }
    let path = crate::settings::app_data_dir()?.join("master.key");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, to_hex(&key))?;
    restrict(&path)?;
    Ok(key)
}

#[cfg(target_os = "macos")]
fn keychain_read(service: &str) -> Option<[u8; 32]> {
    let output = std::process::Command::new("security")
        .args(["find-generic-password", "-s", service, "-w"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    let bytes = from_hex(text.trim()).ok()?;
    if bytes.len() != 32 {
        return None;
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&bytes);
    Some(key)
}

#[cfg(target_os = "macos")]
fn keychain_write(service: &str, key: &[u8; 32]) -> bool {
    std::process::Command::new("security")
        .args([
            "add-generic-password",
            "-U",
            "-s",
            service,
            "-a",
            "zoompaper",
            "-w",
            &to_hex(key),
        ])
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 用固定主密钥验证 AEAD 往返：Windows 上也会编译这段，避免非 Windows 路径长期无人编译。
    #[test]
    fn aead_roundtrip_detects_wrong_key() {
        let key = [7u8; 32];
        let sealed = aead::seal(&key, b"sk-secret-value").unwrap();
        assert_ne!(&sealed[12..], b"sk-secret-value", "密文里不能出现明文");
        assert_eq!(aead::open(&key, &sealed).unwrap(), b"sk-secret-value");

        let mut other = key;
        other[0] = 8;
        assert!(aead::open(&other, &sealed).is_err(), "换密钥必须解密失败");
    }

    #[test]
    fn hex_roundtrip_and_rejects_odd_input() {
        assert_eq!(from_hex(&to_hex(&[0, 15, 255])).unwrap(), vec![0, 15, 255]);
        assert!(from_hex("abc").is_err());
        assert!(from_hex("zz").is_err());
    }

    #[test]
    fn windows_dpapi_roundtrip() {
        #[cfg(windows)]
        {
            let sealed = protect(b"sk-dpapi-test").unwrap();
            assert_ne!(sealed.as_slice(), b"sk-dpapi-test");
            assert_eq!(open(&sealed).unwrap(), b"sk-dpapi-test");
        }
    }
}
