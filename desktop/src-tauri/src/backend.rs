use serde_json::{json, Value};
use std::{collections::HashMap, path::PathBuf, sync::{Arc, atomic::{AtomicU64, Ordering}}};
use tauri::{AppHandle, Emitter};
use tokio::{io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader}, sync::{Mutex, oneshot}, time::{timeout, Duration}};

trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}
type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>;

pub struct Backend {
    writer: Mutex<tokio::io::WriteHalf<Box<dyn Stream>>>,
    pending: Pending,
    next: AtomicU64,
}

pub fn data_dir() -> PathBuf {
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default();
    match std::env::var("MESHTALK_DATA_DIR").ok().filter(|s| !s.trim().is_empty()) {
        Some(s) if s == "~" => home.into(),
        Some(s) if s.starts_with("~/") || s.starts_with("~\\") => PathBuf::from(home).join(&s[2..]),
        Some(s) => s.into(),
        None => PathBuf::from(home).join(".meshtalk"),
    }
}

impl Backend {
    pub async fn connect(app: AppHandle) -> Result<Arc<Self>, String> {
        let dir = data_dir();
        let stream: Box<dyn Stream>;
        #[cfg(unix)]
        {
            match tokio::net::UnixStream::connect(dir.join("meshtalk.sock")).await {
                Ok(s) => stream = Box::new(s),
                Err(_) => stream = Self::tcp(&dir).await?,
            }
        }
        #[cfg(not(unix))]
        { stream = Self::tcp(&dir).await?; }
        let (reader, mut writer) = tokio::io::split(stream);
        let token = tokio::fs::read_to_string(dir.join("meshtalk.token")).await.map_err(|_| "Cannot read backend authentication token")?;
        writer.write_all(format!("{}\n", json!({"action":"authenticate","token":token.trim()})).as_bytes()).await.map_err(|_| "Backend authentication failed")?;
        let mut reader = BufReader::new(reader);
        let mut line = String::new();
        timeout(Duration::from_secs(5), reader.read_line(&mut line)).await.map_err(|_| "Backend authentication timed out")?.map_err(|_| "Backend disconnected")?;
        let auth: Value = serde_json::from_str(&line).map_err(|_| "Invalid backend authentication response")?;
        if auth["authenticated"] != true { return Err("Backend authentication rejected".into()); }
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let backend = Arc::new(Self { writer: Mutex::new(writer), pending: pending.clone(), next: AtomicU64::new(1) });
        tauri::async_runtime::spawn(async move {
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {},
                }
                let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
                if value["event"].is_string() {
                    let _ = app.emit("backend-event", &value);
                } else if let Some(id) = value["id"].as_u64() {
                    if let Some(sender) = pending.lock().await.remove(&id) { let _ = sender.send(value); }
                }
            }
            pending.lock().await.clear();
            let _ = app.emit("backend-disconnected", ());
        });
        Ok(backend)
    }

    async fn tcp(dir: &std::path::Path) -> Result<Box<dyn Stream>, String> {
        let text = tokio::fs::read_to_string(dir.join("meshtalk.port")).await.map_err(|_| "Backend is not running")?;
        let port = text.trim().parse::<u16>().map_err(|_| "Invalid backend port")?;
        let stream = timeout(Duration::from_secs(3), tokio::net::TcpStream::connect(("127.0.0.1", port))).await.map_err(|_| "Backend connection timed out")?.map_err(|_| "Backend is not running")?;
        Ok(Box::new(stream))
    }

    pub async fn request(&self, action: &str, params: Value) -> Result<Value, String> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let mut request = params.as_object().cloned().unwrap_or_default();
        request.insert("action".into(), action.into());
        request.insert("id".into(), id.into());
        let bytes = format!("{}\n", Value::Object(request));
        if bytes.len() > 256 * 1024 { return Err("Request is too large".into()); }
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id, sender);
        let result = async {
            self.writer.lock().await.write_all(bytes.as_bytes()).await.map_err(|_| "Backend disconnected".to_string())?;
            let value = timeout(Duration::from_secs(60), receiver).await.map_err(|_| "Backend request timed out".to_string())?.map_err(|_| "Backend disconnected".to_string())?;
            if let Some(error) = value["error"].as_str() { return Err(error.to_string()); }
            Ok(value)
        }.await;
        self.pending.lock().await.remove(&id);
        result
    }
}

pub fn allowed(action: &str) -> bool {
    if matches!(action, "search_messages" | "history_page" | "files_dir" | "desktop_drafts") { return true; }
    matches!(action, "identity" | "desktop_info" | "status" | "peers" | "messages" | "send" | "groups" | "group_members" | "group_messages" | "group_send" | "room_create" | "room_join" | "room_leave" | "room_invite" | "rooms" | "group_leave" | "set_display_name" | "friend_send" | "friend_respond" | "friend_cancel" | "friends" | "friend_requests" | "unfriend" | "block_peer" | "unblock_peer" | "blocked_peers" | "remove_peer" | "mute" | "unmute" | "muted_peers" | "dnd" | "tui_presence" | "typing" | "control" | "advanced_config" | "analytics" | "accessibility" | "notifications" | "debug_info" | "debug_re_stun" | "files" | "file_info" | "file_retry" | "delete_message")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn renderer_cannot_invoke_privileged_file_or_lifecycle_actions() {
        for action in ["shutdown", "authenticate", "file_send", "group_file_send", "file_download", "set_files_dir"] { assert!(!allowed(action)); }
        assert!(allowed("send"));
        assert!(allowed("group_messages"));
    }
}
