//! Server-side half of #Encrypted blocks: only used by the terminal command
//! `blockseq reset-encryption-password`. Blocks themselves are encrypted and
//! decrypted in the browser (web/js/crypto.js); the server never sees the key
//! or the text. The formats here must match crypto.js exactly.

use std::io::{BufRead, Write};
use std::path::Path;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{Context, Result, bail};
use base64::Engine;
use sha2::{Digest, Sha256};

use crate::config::{Config, Encryption};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;
pub const PASSWORD_ITERATIONS: u32 = 600_000;

fn derive(secret: &str, salt: &[u8], iterations: u32) -> [u8; 32] {
    let mut out = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha256>(secret.as_bytes(), salt, iterations, &mut out);
    out
}

fn random<const N: usize>() -> Result<[u8; N]> {
    let mut buf = [0u8; N];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| std::io::Read::read_exact(&mut f, &mut buf))
        .context("reading /dev/urandom")?;
    Ok(buf)
}

/// Recovery keys are shown as groups of base32 letters; ignore case,
/// dashes and spaces when they are typed back.
pub fn normalize_recovery_key(k: &str) -> String {
    k.chars().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_uppercase()).collect()
}

pub fn key_check(key: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(b"blockseq-key-check:");
    h.update(key);
    B64.encode(h.finalize())
}

fn unwrap_key(kek: &[u8; 32], iv: &str, data: &str) -> Option<Vec<u8>> {
    let iv = B64.decode(iv).ok()?;
    let data = B64.decode(data).ok()?;
    if iv.len() != 12 {
        return None;
    }
    Aes256Gcm::new_from_slice(kek).ok()?.decrypt(Nonce::from_slice(&iv), data.as_ref()).ok()
}

fn wrap_key(kek: &[u8; 32], key: &[u8]) -> Result<(String, String)> {
    let iv = random::<12>()?;
    let data = Aes256Gcm::new_from_slice(kek)?
        .encrypt(Nonce::from_slice(&iv), key)
        .map_err(|_| anyhow::anyhow!("encrypting the key failed"))?;
    Ok((B64.encode(iv), B64.encode(data)))
}

/// Unlocks the key with a recovery key and wraps it with a new password.
pub fn reset_with_recovery(enc: &Encryption, recovery: &str, new_password: &str) -> Result<Encryption> {
    let rk_salt = B64.decode(&enc.rk_salt).context("bad recovery salt")?;
    let kek = derive(&normalize_recovery_key(recovery), &rk_salt, enc.rk_iterations);
    let Some(key) = unwrap_key(&kek, &enc.rk_iv, &enc.rk_data) else {
        bail!("that recovery key doesn't match");
    };
    if key_check(&key) != enc.check {
        bail!("the stored key check doesn't match; config.json may be damaged");
    }
    let salt = random::<16>()?;
    let pw_kek = derive(new_password, &salt, PASSWORD_ITERATIONS);
    let (pw_iv, pw_data) = wrap_key(&pw_kek, &key)?;
    Ok(Encryption { salt: B64.encode(salt), iterations: PASSWORD_ITERATIONS, pw_iv, pw_data, ..enc.clone() })
}

fn prompt(label: &str, hidden: bool) -> Result<String> {
    eprint!("{label}");
    std::io::stderr().flush().ok();
    // Hide what is typed (passwords) by turning terminal echo off.
    let stty = |arg: &str| {
        let _ = std::process::Command::new("stty")
            .arg(arg)
            .stdin(std::process::Stdio::inherit())
            .stderr(std::process::Stdio::null())
            .status();
    };
    if hidden {
        stty("-echo");
    }
    let mut line = String::new();
    let read = std::io::stdin().lock().read_line(&mut line);
    if hidden {
        stty("echo");
        eprintln!();
    }
    read.context("reading input")?;
    Ok(line.trim_end_matches(['\r', '\n']).to_string())
}

/// `blockseq reset-encryption-password`: set a new encryption password using
/// the recovery key. Blocks stay readable because the key itself is kept.
pub fn reset_command(data_dir: &Path) -> Result<()> {
    let path = data_dir.join("config.json");
    let mut cfg = Config::load(&path);
    let Some(enc) = cfg.encryption.clone() else {
        bail!("no encryption password has been set up in {}", path.display());
    };
    eprintln!("Reset the password for #Encrypted blocks ({}).", path.display());
    eprintln!("You need the recovery key that was shown when the password was first set.");
    let recovery = prompt("Recovery key: ", false)?;
    // Check the recovery key before asking for a new password.
    let rk_salt = B64.decode(&enc.rk_salt).context("bad recovery salt")?;
    if unwrap_key(&derive(&normalize_recovery_key(&recovery), &rk_salt, enc.rk_iterations), &enc.rk_iv, &enc.rk_data).is_none() {
        bail!("that recovery key doesn't match");
    }
    let password = prompt("New password: ", true)?;
    if password.chars().count() < 8 {
        bail!("use at least 8 characters");
    }
    if prompt("New password again: ", true)? != password {
        bail!("the passwords don't match");
    }
    eprintln!("Working…");
    cfg.encryption = Some(reset_with_recovery(&enc, &recovery, &password)?);
    cfg.save(&path)?;
    // Keep the file owned by whoever owns the data folder (the service user),
    // even when this command runs as root.
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if let Ok(meta) = std::fs::metadata(data_dir) {
            let _ = std::os::unix::fs::chown(&path, Some(meta.uid()), Some(meta.gid()));
        }
    }
    eprintln!("Done. Use the new password to unlock #Encrypted blocks (reload the page first).");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_reset_keeps_the_key() {
        let key = [7u8; 32];
        let rk = "ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567";
        let rk_salt = [1u8; 16];
        let (rk_iv, rk_data) = wrap_key(&derive(&normalize_recovery_key(rk), &rk_salt, 1000), &key).unwrap();
        let salt = [2u8; 16];
        let (pw_iv, pw_data) = wrap_key(&derive("old password", &salt, 1000), &key).unwrap();
        let enc = Encryption {
            version: 1, salt: B64.encode(salt), iterations: 1000, pw_iv, pw_data,
            rk_salt: B64.encode(rk_salt), rk_iterations: 1000, rk_iv, rk_data, check: key_check(&key),
        };
        assert!(reset_with_recovery(&enc, "wrong key", "x").is_err());
        let new = reset_with_recovery(&enc, "abcd efgh ijkl mnop qrst uvwx yz23 4567", "new password 1").unwrap();
        let kek = derive("new password 1", &B64.decode(&new.salt).unwrap(), new.iterations);
        assert_eq!(unwrap_key(&kek, &new.pw_iv, &new.pw_data).unwrap(), key);
        assert_eq!(new.rk_data, enc.rk_data); // recovery key still works
    }
}
