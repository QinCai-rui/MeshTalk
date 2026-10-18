use crate::{connection, Host};
use base64::Engine;
use serde_json::{json, Value};
use std::{collections::HashMap, path::PathBuf};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tokio::sync::Mutex;

#[derive(Default)]
pub struct Staging(pub Mutex<HashMap<String, (PathBuf, bool)>>);

pub async fn stage(
    app: &tauri::AppHandle,
    paths: Vec<PathBuf>,
    temporary: bool,
) -> Result<Value, String> {
    if paths.is_empty() || paths.len() > 32 {
        return Err("Choose between 1 and 32 files".into());
    }
    let state = app.state::<Staging>();
    let mut files = state.0.lock().await;
    if files.len() + paths.len() > 64 {
        return Err("Too many staged files. Close the attachment dialog first.".into());
    }
    let mut checked = Vec::new();
    for path in paths {
        let metadata = tokio::fs::metadata(&path)
            .await
            .map_err(|_| "Cannot read selected file")?;
        if !metadata.is_file() || metadata.len() > 50 * 1024 * 1024 {
            return Err("Choose regular files up to 50 MB each".into());
        }
        checked.push((path, metadata.len()));
    }
    let mut result = Vec::new();
    for (path, size) in checked {
        let token = uuid::Uuid::new_v4().to_string();
        result.push(json!({"token":token,"name":path.file_name().unwrap_or_default().to_string_lossy(),"size":size}));
        files.insert(token, (path, temporary));
    }
    Ok(json!({"files":result}))
}

#[tauri::command]
pub async fn choose_attachments(app: tauri::AppHandle) -> Result<Value, String> {
    let picker = app.clone();
    let chosen =
        tauri::async_runtime::spawn_blocking(move || picker.dialog().file().blocking_pick_files())
            .await
            .map_err(|e| e.to_string())?;
    match chosen {
        None => Ok(json!({"files":[]})),
        Some(files) => {
            stage(
                &app,
                files
                    .into_iter()
                    .map(|f| {
                        f.into_path()
                            .map_err(|_| "Unsupported file location".to_string())
                    })
                    .collect::<Result<Vec<_>, _>>()?,
                false,
            )
            .await
        }
    }
}

#[tauri::command]
pub async fn paste_attachment(
    app: tauri::AppHandle,
    name: String,
    bytes: Vec<u8>,
) -> Result<Value, String> {
    if bytes.is_empty() || bytes.len() > 8 * 1024 * 1024 {
        return Err("Paste supports files up to 8 MB. Use Attach for larger files.".into());
    }
    let filename = std::path::Path::new(&name)
        .file_name()
        .ok_or("Invalid filename")?
        .to_string_lossy();
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("attachments");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|_| "Cannot stage clipboard attachment")?;
    let path = dir.join(format!("{}-{}", uuid::Uuid::new_v4(), filename));
    tokio::fs::write(&path, bytes)
        .await
        .map_err(|_| "Cannot stage clipboard attachment")?;
    match stage(&app, vec![path.clone()], true).await {
        Ok(value) => Ok(value),
        Err(error) => {
            let _ = tokio::fs::remove_file(path).await;
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn discard_attachments(
    state: State<'_, Staging>,
    tokens: Vec<String>,
) -> Result<(), String> {
    let mut files = state.0.lock().await;
    for token in tokens {
        if let Some((path, temporary)) = files.remove(&token) {
            if temporary {
                let _ = tokio::fs::remove_file(path).await;
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn send_attachments(
    host: State<'_, Host>,
    state: State<'_, Staging>,
    tokens: Vec<String>,
    target: String,
    group: bool,
    caption: String,
) -> Result<Value, String> {
    if tokens.is_empty() || tokens.len() > 32 {
        return Err("Choose between 1 and 32 files".into());
    }
    let files = state.0.lock().await;
    let paths = tokens
        .iter()
        .map(|token| {
            files
                .get(token)
                .map(|(p, _)| p.clone())
                .ok_or("Attachment expired")
        })
        .collect::<Result<Vec<_>, _>>()?;
    drop(files);
    let params = if group {
        json!({"group_id":target,"paths":paths,"caption":caption})
    } else {
        json!({"recipient_id":target,"paths":paths,"caption":caption})
    };
    let result = connection(&host)
        .await?
        .request(
            if group {
                "group_file_send"
            } else {
                "file_send"
            },
            params,
        )
        .await;
    result
}

async fn attachment(host: &Host, file_id: &str) -> Result<PathBuf, String> {
    let info = connection(host)
        .await?
        .request("file_info", json!({"file_id":file_id}))
        .await?;
    let path = info["file"]["file_path"]
        .as_str()
        .ok_or("File is not available locally")?;
    let path = PathBuf::from(path);
    if !path.is_file() {
        return Err("File is not available locally".into());
    }
    Ok(path)
}

#[tauri::command]
pub async fn preview_attachment(host: State<'_, Host>, file_id: String) -> Result<String, String> {
    let path = attachment(&host, &file_id).await?;
    if tokio::fs::metadata(&path)
        .await
        .map_err(|_| "Cannot read image")?
        .len()
        > 8 * 1024 * 1024
    {
        return Err("Image exceeds the 8 MB preview limit. Save it to view externally.".into());
    }
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|_| "Cannot read image")?;
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else {
        return Err("Preview supports PNG, JPEG, GIF, and WebP".into());
    };
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

#[tauri::command]
pub async fn reveal_attachment(
    app: tauri::AppHandle,
    host: State<'_, Host>,
    file_id: String,
) -> Result<(), String> {
    app.opener()
        .reveal_item_in_dir(attachment(&host, &file_id).await?)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn choose_download_directory(
    app: tauri::AppHandle,
    host: State<'_, Host>,
    reset: bool,
) -> Result<Value, String> {
    let path = if reset {
        "default".to_string()
    } else {
        let selected = tauri::async_runtime::spawn_blocking(move || {
            app.dialog().file().blocking_pick_folder()
        })
        .await
        .map_err(|e| e.to_string())?;
        let Some(selected) = selected else {
            return Ok(json!({"cancelled":true}));
        };
        selected
            .into_path()
            .map_err(|_| "Unsupported folder")?
            .to_string_lossy()
            .into_owned()
    };
    connection(&host)
        .await?
        .request("set_files_dir", json!({"path":path}))
        .await
}
