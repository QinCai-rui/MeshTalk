#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod backend;

use backend::Backend;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_opener::OpenerExt;
use tokio::sync::Mutex;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[derive(Default)]
struct Host {
    backend: Mutex<Option<Arc<Backend>>>,
    child: Mutex<Option<tokio::process::Child>>,
    starting: Mutex<()>,
    close_mode: std::sync::Mutex<String>,
    update_channel: std::sync::Mutex<String>,
}

#[derive(Serialize, Deserialize, Default)]
struct Preferences { close_mode: String, #[serde(default = "stable")] update_channel: String }
fn stable() -> String { "stable".into() }

async fn connection(host: &Host) -> Result<Arc<Backend>, String> {
    host.backend.lock().await.clone().ok_or("Backend is not connected".into())
}

#[tauri::command]
async fn connect_backend(app: tauri::AppHandle, host: State<'_, Host>) -> Result<Value, String> {
    let _guard = host.starting.lock().await;
    if let Some(existing) = host.backend.lock().await.clone() {
        if let Ok(info) = existing.request("desktop_info", json!({})).await { return Ok(info); }
    }
    let client = match Backend::connect(app.clone()).await {
        Ok(client) => client,
        Err(_) => {
            let mut child_slot = host.child.lock().await;
            let running = match child_slot.as_mut() { Some(c) => c.try_wait().map_err(|e| e.to_string())?.is_none(), None => false };
            if !running {
                let mut command;
                if cfg!(debug_assertions) {
                    command = tokio::process::Command::new("uv");
                    command.args(["run", "--project"]).arg(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../backend")).args(["meshtalk"]);
                } else {
                    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
                    let name = if cfg!(windows) { "meshtalk-backend.exe" } else { "meshtalk-backend" };
                    command = tokio::process::Command::new(exe.parent().ok_or("Cannot locate app bundle")?.join(name));
                }
                std::fs::create_dir_all(backend::data_dir()).map_err(|e| e.to_string())?;
                let log = std::fs::OpenOptions::new().create(true).append(true).open(backend::data_dir().join("backend.log")).map_err(|e| e.to_string())?;
                command.stdin(std::process::Stdio::null()).stdout(log.try_clone().map_err(|e| e.to_string())?).stderr(log);
                #[cfg(windows)]
                command.creation_flags(0x08000000);
                command.env("MESHTALK_APP_VERSION", app.package_info().version.to_string());
                *child_slot = Some(command.spawn().map_err(|e| format!("Cannot start backend: {e}"))?);
            }
            drop(child_slot);
            let mut connected = None;
            for _ in 0..200 {
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                if let Ok(client) = Backend::connect(app.clone()).await { connected = Some(client); break; }
            }
            connected.ok_or("Backend did not start within 60 seconds")?
        }
    };
    let info = client.request("desktop_info", json!({})).await.map_err(|_| "This backend is too old for desktop. Quit other MeshTalk clients and update the terminal installation.")?;
    if info["ipc_version"] != 1 { return Err("Unsupported backend IPC version".into()); }
    *host.backend.lock().await = Some(client);
    Ok(info)
}

#[tauri::command]
async fn request(host: State<'_, Host>, action: String, params: Value) -> Result<Value, String> {
    if !backend::allowed(&action) { return Err("Unsupported desktop action".into()); }
    connection(&host).await?.request(&action, params).await
}

#[tauri::command]
async fn pick_files(app: tauri::AppHandle, host: State<'_, Host>, target: String, group: bool, caption: String) -> Result<Value, String> {
    let files = tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_files()).await.map_err(|e| e.to_string())?;
    let Some(files) = files else { return Ok(json!({"cancelled":true})); };
    let paths: Result<Vec<_>, _> = files.into_iter().map(|f| f.into_path()).collect();
    let paths = paths.map_err(|_| "Unsupported file location")?;
    let params = if group { json!({"group_id":target,"paths":paths,"caption":caption}) } else { json!({"recipient_id":target,"paths":paths,"caption":caption}) };
    connection(&host).await?.request(if group {"group_file_send"} else {"file_send"}, params).await
}

#[tauri::command]
async fn save_file(app: tauri::AppHandle, host: State<'_, Host>, file_id: String) -> Result<Value, String> {
    let client = connection(&host).await?;
    let info = client.request("file_info", json!({"file_id":file_id})).await?;
    let name = info["file"]["filename"].as_str().unwrap_or("attachment").to_string();
    let path = tauri::async_runtime::spawn_blocking(move || app.dialog().file().set_file_name(name).blocking_save_file()).await.map_err(|e| e.to_string())?;
    let Some(path) = path else { return Ok(json!({"cancelled":true})); };
    client.request("file_download", json!({"file_id":file_id,"dest_path":path.into_path().map_err(|_| "Unsupported file location")?})).await
}

#[tauri::command]
fn preferences(app: tauri::AppHandle, host: State<'_, Host>, close_mode: Option<String>, autostart: Option<bool>, update_channel: Option<String>) -> Result<Value, String> {
    let changed = close_mode.is_some() || update_channel.is_some();
    if let Some(mode) = close_mode {
        if !["ask", "quit", "tray"].contains(&mode.as_str()) { return Err("Invalid close behavior".into()); }
        *host.close_mode.lock().unwrap() = mode.clone();
    }
    if let Some(channel) = update_channel {
        if !["stable", "unstable"].contains(&channel.as_str()) { return Err("Invalid update channel".into()); }
        *host.update_channel.lock().unwrap() = channel;
    }
    if changed {
        let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        std::fs::write(dir.join("desktop.json"), serde_json::to_vec(&Preferences { close_mode: host.close_mode.lock().unwrap().clone(), update_channel: host.update_channel.lock().unwrap().clone() }).unwrap()).map_err(|e| e.to_string())?;
    }
    if let Some(enabled) = autostart {
        if enabled { app.autolaunch().enable() } else { app.autolaunch().disable() }.map_err(|e| e.to_string())?;
    }
    Ok(json!({"close_mode":host.close_mode.lock().unwrap().clone(),"update_channel":host.update_channel.lock().unwrap().clone(),"autostart":app.autolaunch().is_enabled().unwrap_or(false),"version":app.package_info().version.to_string()}))
}

#[tauri::command]
async fn check_update(app: tauri::AppHandle, host: State<'_, Host>) -> Result<Value, String> {
    let unstable = *host.update_channel.lock().unwrap() == "unstable";
    let client = reqwest::Client::builder().user_agent("MeshTalk desktop").timeout(std::time::Duration::from_secs(15)).build().map_err(|e| e.to_string())?;
    let url = if unstable { "https://api.github.com/repos/QinCai-rui/MeshTalk/releases?per_page=20" } else { "https://api.github.com/repos/QinCai-rui/MeshTalk/releases/latest" };
    let response = client.get(url).send().await.map_err(|_| "Cannot reach GitHub releases")?.error_for_status().map_err(|_| "GitHub release metadata is unavailable")?.json::<Value>().await.map_err(|_| "Invalid release metadata")?;
    let releases = if unstable { response.as_array().cloned().unwrap_or_default() } else { vec![response] };
    let current = app.package_info().version.to_string();
    for release in releases {
        if release["draft"] == true { continue; }
        let Some(tag) = release["tag_name"].as_str() else { continue; };
        let has_desktop = release["assets"].as_array().is_some_and(|assets| assets.iter().any(|a| a["name"].as_str().is_some_and(|n| n.starts_with("meshtalk-desktop-"))));
        if !has_desktop { continue; }
        let available = newer(tag, &current);
        return Ok(json!({"available":available,"tag":tag,"version":tag,"notes":release["body"]}));
    }
    Ok(json!({"available":false}))
}

fn newer(next: &str, current: &str) -> bool {
    fn parts(s: &str) -> Option<(Vec<u64>, bool, u64)> {
        let s = s.trim_start_matches('v');
        let base = s.split(['-', '+']).next()?;
        let numbers: Vec<u64> = base.split('.').map(str::parse).collect::<Result<_, _>>().ok()?;
        if numbers.len() != 3 { return None; }
        let run = s.split('+').nth(1).and_then(|s| s.split('-').next()).and_then(|s| s.parse().ok()).unwrap_or(0);
        Some((numbers, !s.contains('-'), run))
    }
    matches!((parts(next), parts(current)), (Some(a), Some(b)) if a > b)
}

#[tauri::command]
fn open_release(app: tauri::AppHandle, tag: String) -> Result<(), String> {
    if tag.is_empty() || !tag.bytes().all(|c| c.is_ascii_alphanumeric() || b".-+".contains(&c)) { return Err("Invalid release tag".into()); }
    app.opener().open_url(format!("https://github.com/QinCai-rui/MeshTalk/releases/tag/{tag}"), None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn notify(app: tauri::AppHandle, title: String) -> Result<(), String> {
    app.notification().builder().title("MeshTalk").body(title).show().map_err(|e| e.to_string())
}

#[tauri::command]
async fn quit(app: tauri::AppHandle, host: State<'_, Host>) -> Result<(), String> {
    if host.child.lock().await.is_some() {
        if let Ok(client) = connection(&host).await {
            // Leave a shared backend alive when another local client still uses it.
            let _ = client.request("desktop_release", json!({})).await;
        }
    }
    app.exit(0);
    Ok(())
}

fn show(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") { let _ = window.show(); let _ = window.set_focus(); }
}

fn main() {
    tauri::Builder::default()
        .manage(Host::default())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![connect_backend, request, pick_files, save_file, preferences, notify, quit, check_update, open_release])
        .setup(|app| {
            let path = app.path().app_config_dir()?.join("desktop.json");
            let prefs = std::fs::read(path).ok().and_then(|b| serde_json::from_slice::<Preferences>(&b).ok()).unwrap_or(Preferences { close_mode: "ask".into(), update_channel: if app.package_info().version.pre.is_empty() { "stable".into() } else { "unstable".into() } });
            *app.state::<Host>().close_mode.lock().unwrap() = prefs.close_mode;
            *app.state::<Host>().update_channel.lock().unwrap() = prefs.update_channel;
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| { show(&handle); let _ = handle.emit("invite-links", event.urls().iter().map(|u| u.to_string()).collect::<Vec<_>>()); });
            let open = tauri::menu::MenuItem::with_id(app, "open", "Open MeshTalk", true, None::<&str>)?;
            let exit = tauri::menu::MenuItem::with_id(app, "quit", "Quit MeshTalk", true, None::<&str>)?;
            let menu = tauri::menu::Menu::with_items(app, &[&open, &exit])?;
            let pixels = vec![80u8, 190, 150, 255].repeat(32 * 32);
            tauri::tray::TrayIconBuilder::new().icon(tauri::image::Image::new_owned(pixels, 32, 32)).tooltip("MeshTalk").menu(&menu).on_menu_event(|app, event| {
                if event.id.as_ref() == "open" { show(app); }
                if event.id.as_ref() == "quit" { let handle = app.clone(); tauri::async_runtime::spawn(async move { let _ = quit(handle.clone(), handle.state::<Host>()).await; }); }
            }).build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let mode = window.state::<Host>().close_mode.lock().unwrap().clone();
                if mode == "tray" { let _ = window.hide(); }
                else if mode == "quit" {
                    let app = window.app_handle().clone();
                    tauri::async_runtime::spawn(async move { let _ = quit(app.clone(), app.state::<Host>()).await; });
                } else { let _ = window.emit("choose-close-mode", ()); }
            }
        })
        .run(tauri::generate_context!())
        .expect("MeshTalk desktop failed to start");
}
