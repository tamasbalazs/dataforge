//! Jupyter wire protocol (v5.3): message construction, HMAC signing and
//! (de)serialisation of multipart ZeroMQ frames.

use anyhow::{anyhow, bail, Result};
use bytes::Bytes;
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;

pub const DELIMITER: &[u8] = b"<IDS|MSG>";
pub const PROTOCOL_VERSION: &str = "5.3";

#[derive(Debug, Clone, PartialEq)]
pub struct JupyterMessage {
    pub identities: Vec<Bytes>,
    pub header: Value,
    pub parent_header: Value,
    pub metadata: Value,
    pub content: Value,
    pub buffers: Vec<Bytes>,
}

impl JupyterMessage {
    pub fn new(msg_type: &str, session: &str, content: Value) -> Self {
        let header = json!({
            "msg_id": uuid::Uuid::new_v4().to_string(),
            "session": session,
            "username": "dataforge",
            "date": chrono::Utc::now().to_rfc3339(),
            "msg_type": msg_type,
            "version": PROTOCOL_VERSION,
        });
        Self {
            identities: vec![],
            header,
            parent_header: json!({}),
            metadata: json!({}),
            content,
            buffers: vec![],
        }
    }

    pub fn msg_id(&self) -> &str {
        self.header["msg_id"].as_str().unwrap_or_default()
    }

    pub fn msg_type(&self) -> &str {
        self.header["msg_type"].as_str().unwrap_or_default()
    }

    pub fn parent_id(&self) -> Option<&str> {
        self.parent_header["msg_id"].as_str()
    }

    /// Serialise into ZeroMQ frames, signing with `key` (empty key = no signing).
    pub fn to_frames(&self, key: &[u8]) -> Vec<Bytes> {
        let parts: [Vec<u8>; 4] = [
            serde_json::to_vec(&self.header).unwrap(),
            serde_json::to_vec(&self.parent_header).unwrap(),
            serde_json::to_vec(&self.metadata).unwrap(),
            serde_json::to_vec(&self.content).unwrap(),
        ];
        let signature = sign(key, &parts);
        let mut frames: Vec<Bytes> = self.identities.clone();
        frames.push(Bytes::from_static(DELIMITER));
        frames.push(Bytes::from(signature));
        frames.extend(parts.into_iter().map(Bytes::from));
        frames.extend(self.buffers.iter().cloned());
        frames
    }

    /// Parse frames received from a kernel and verify the signature.
    pub fn from_frames(frames: Vec<Bytes>, key: &[u8]) -> Result<Self> {
        let delim = frames
            .iter()
            .position(|f| f.as_ref() == DELIMITER)
            .ok_or_else(|| anyhow!("missing <IDS|MSG> delimiter"))?;
        if frames.len() < delim + 6 {
            bail!("incomplete message: {} frames", frames.len());
        }
        let identities = frames[..delim].to_vec();
        let signature = &frames[delim + 1];
        let parts = &frames[delim + 2..delim + 6];
        if !key.is_empty() {
            let expected = sign(key, parts);
            if expected.as_bytes() != signature.as_ref() {
                bail!("invalid message signature");
            }
        }
        let parse = |b: &Bytes| -> Result<Value> { Ok(serde_json::from_slice(b)?) };
        Ok(Self {
            identities,
            header: parse(&parts[0])?,
            parent_header: parse(&parts[1])?,
            metadata: parse(&parts[2])?,
            content: parse(&parts[3])?,
            buffers: frames[delim + 6..].to_vec(),
        })
    }
}

pub fn sign<T: AsRef<[u8]>>(key: &[u8], parts: &[T]) -> String {
    if key.is_empty() {
        return String::new();
    }
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts any key length");
    for p in parts {
        mac.update(p.as_ref());
    }
    hex::encode(mac.finalize().into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_with_signature() {
        let key = b"secret-key";
        let mut msg = JupyterMessage::new("execute_request", "sess", json!({"code": "1+1"}));
        msg.identities = vec![Bytes::from_static(b"id1")];
        let frames = msg.to_frames(key);
        assert_eq!(frames[1].as_ref(), DELIMITER);
        let parsed = JupyterMessage::from_frames(frames, key).unwrap();
        assert_eq!(parsed, msg);
        assert_eq!(parsed.msg_type(), "execute_request");
    }

    #[test]
    fn rejects_tampered_message() {
        let key = b"k";
        let msg = JupyterMessage::new("kernel_info_request", "s", json!({}));
        let mut frames = msg.to_frames(key);
        let last = frames.len() - 1;
        frames[last] = Bytes::from_static(b"{\"evil\":true}");
        assert!(JupyterMessage::from_frames(frames, key).is_err());
    }

    #[test]
    fn known_hmac_vector() {
        // HMAC-SHA256("key", "The quick brown fox jumps over the lazy dog")
        let sig = sign(b"key", &["The quick brown fox ", "jumps over the lazy dog"]);
        assert_eq!(sig, "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
    }

    #[test]
    fn empty_key_disables_signing() {
        let msg = JupyterMessage::new("x", "s", json!({}));
        let frames = msg.to_frames(b"");
        assert!(frames[1].is_empty());
        assert!(JupyterMessage::from_frames(frames, b"").is_ok());
    }
}
