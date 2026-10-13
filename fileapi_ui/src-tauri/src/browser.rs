use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
#[cfg(windows)]
use std::collections::{HashMap, VecDeque};
#[cfg(windows)]
use std::sync::{Arc, Mutex, OnceLock};
use tauri::webview::Webview;
#[cfg(windows)]
use tauri::Emitter;
use tauri::{AppHandle, Manager};

#[cfg(windows)]
use webview2_com::{
    BytesReceivedChangedEventHandler, CallDevToolsProtocolMethodCompletedHandler, CoTaskMemPWSTR,
    ContainsFullScreenElementChangedEventHandler, DownloadStartingEventHandler,
};
#[cfg(windows)]
use windows::core::Interface;

#[cfg(any(windows, test))]
const MAX_SCREENSHOT_DIMENSION: f64 = 16_000.0;
#[cfg(any(windows, test))]
const MAX_SCREENSHOT_PIXELS: f64 = 40_000_000.0;
#[cfg(windows)]
const MAX_SCREENSHOT_TILES: usize = 4_096;
#[cfg(windows)]
const MAX_SCREENSHOT_FRAMES: usize = 128;
#[cfg(windows)]
const SCREENSHOT_SETTLE_MS: u32 = 150;
const MAX_SCREENSHOT_BASE64_BYTES: usize = 180 * 1024 * 1024;

#[cfg(windows)]
const BROWSER_VIEW_STATE_EVENT: &str = "browser-view-state";
#[cfg(windows)]
const BROWSER_NEW_PANE_EVENT: &str = "browser-new-pane";
#[cfg(windows)]
const BROWSER_DOWNLOAD_EVENT: &str = "browser-download";
const BROWSER_VIEW_PREFIX: &str = "browser-content-";

#[cfg(windows)]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserDownloadEvent {
    pane_id: String,
    download_id: String,
    url: String,
    file_name: String,
    staging_path: String,
    status: String,
    bytes_received: u64,
    total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn browser_download_staging_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("browser-downloads");
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

fn safe_browser_download_name(value: &str) -> String {
    let leaf = value.rsplit(['/', '\\']).next().unwrap_or_default();
    let safe: String = leaf
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(character, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
            {
                '_'
            } else {
                character
            }
        })
        .collect::<String>()
        .trim_end_matches([' ', '.'])
        .to_string();
    if safe.is_empty() || safe == "." || safe == ".." {
        return "download.bin".to_string();
    }
    let device_name = safe
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let reserved = matches!(device_name.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| {
            device_name.strip_prefix(prefix).is_some_and(|suffix| {
                matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            })
        });
    if reserved {
        format!("_{safe}")
    } else {
        safe
    }
}

#[cfg(windows)]
fn browser_download_id_from_path(path: &Path) -> Option<String> {
    let id = path.parent()?.file_name()?.to_str()?;
    uuid::Uuid::parse_str(id).ok().map(|_| id.to_string())
}

#[cfg(windows)]
fn emit_browser_download(
    app: &AppHandle,
    pane_id: &str,
    download_id: &str,
    url: &str,
    file_name: &str,
    staging_path: &Path,
    status: &str,
    bytes_received: u64,
    total_bytes: Option<u64>,
    error: Option<String>,
) {
    let _ = app.emit_to(
        "main",
        BROWSER_DOWNLOAD_EVENT,
        BrowserDownloadEvent {
            pane_id: pane_id.to_string(),
            download_id: download_id.to_string(),
            url: url.to_string(),
            file_name: file_name.to_string(),
            staging_path: staging_path.display().to_string(),
            status: status.to_string(),
            bytes_received,
            total_bytes,
            error,
        },
    );
}

#[cfg(windows)]
async fn register_browser_download_progress(
    view: &Webview,
    app: AppHandle,
    pane_id: String,
) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_4;
    use std::time::{Duration, Instant};

    let (sender, receiver) = tokio::sync::oneshot::channel();
    view.with_webview(move |platform| {
        let result = (|| unsafe {
            let core = platform
                .controller()
                .CoreWebView2()
                .map_err(|error| error.to_string())?;
            let core: ICoreWebView2_4 = core.cast().map_err(|error| error.to_string())?;
            let app_for_download = app.clone();
            let pane_for_download = pane_id.clone();
            let handler = DownloadStartingEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else {
                    return Ok(());
                };
                let operation = args.DownloadOperation()?;
                let mut raw_path = CoTaskMemPWSTR::default().take();
                operation.ResultFilePath(&mut raw_path)?;
                let staging_path = PathBuf::from(CoTaskMemPWSTR::from(raw_path).to_string());
                let Some(download_id) = browser_download_id_from_path(&staging_path) else {
                    return Ok(());
                };
                let mut raw_url = CoTaskMemPWSTR::default().take();
                operation.Uri(&mut raw_url)?;
                let url = CoTaskMemPWSTR::from(raw_url).to_string();
                let file_name = staging_path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("download.bin")
                    .to_string();

                let app_for_progress = app_for_download.clone();
                let pane_for_progress = pane_for_download.clone();
                let id_for_progress = download_id.clone();
                let url_for_progress = url.clone();
                let name_for_progress = file_name.clone();
                let path_for_progress = staging_path.clone();
                let last_progress_emit = Arc::new(Mutex::new(Instant::now()));
                let last_progress_emit_for_callback = last_progress_emit.clone();
                let progress_handler =
                    BytesReceivedChangedEventHandler::create(Box::new(move |download, _| {
                        let Some(download) = download else {
                            return Ok(());
                        };
                        let mut bytes_received = 0_i64;
                        let mut total_bytes = 0_i64;
                        download.BytesReceived(&mut bytes_received)?;
                        download.TotalBytesToReceive(&mut total_bytes)?;
                        let now = Instant::now();
                        let should_emit = last_progress_emit_for_callback
                            .lock()
                            .map(|mut last_emit| {
                                if now.duration_since(*last_emit) >= Duration::from_millis(120)
                                    || (total_bytes > 0 && bytes_received >= total_bytes)
                                {
                                    *last_emit = now;
                                    true
                                } else {
                                    false
                                }
                            })
                            .unwrap_or(true);
                        if !should_emit {
                            return Ok(());
                        }
                        emit_browser_download(
                            &app_for_progress,
                            &pane_for_progress,
                            &id_for_progress,
                            &url_for_progress,
                            &name_for_progress,
                            &path_for_progress,
                            "progress",
                            bytes_received.max(0) as u64,
                            (total_bytes > 0).then_some(total_bytes as u64),
                            None,
                        );
                        Ok(())
                    }));
                let mut token = 0;
                operation.add_BytesReceivedChanged(&progress_handler, &mut token)?;
                Ok(())
            }));
            let mut token = 0;
            core.add_DownloadStarting(&handler, &mut token)
                .map_err(|error| error.to_string())
        })();
        let _ = sender.send(result);
    })
    .map_err(|error| error.to_string())?;
    receiver
        .await
        .map_err(|_| "Browser download listener did not complete".to_string())?
}

#[derive(Clone, Deserialize)]
#[cfg_attr(not(windows), allow(dead_code))]
#[serde(rename_all = "camelCase")]
pub struct BrowserBounds {
    /// CSS pixels relative to the main WebView viewport.
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    /// Physical pixels per CSS pixel reported by the main WebView.
    pub device_pixel_ratio: f64,
}

/// Child WebView rectangle in physical pixels relative to the parent window
/// client area (the main WebView is created at its (0, 0) origin).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(not(windows), allow(dead_code))]
#[serde(rename_all = "camelCase")]
pub struct BrowserPhysicalBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Serialize)]
#[cfg_attr(not(windows), allow(dead_code))]
#[serde(rename_all = "camelCase")]
pub struct BrowserBoundsReadback {
    pub requested: BrowserPhysicalBounds,
    pub actual: BrowserPhysicalBounds,
}

#[cfg(windows)]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserViewStateEvent {
    pane_id: String,
    url: String,
    loading: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    can_go_back: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    can_go_forward: Option<bool>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNavigationState {
    pub url: String,
    pub can_go_back: bool,
    pub can_go_forward: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDownloadSaveResult {
    pub path: String,
    pub cleanup_warning: Option<String>,
}

/// Where one captured viewport image is drawn inside the scrolling region of
/// the stitched page. Source rectangle: the region rectangle of the tile image.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserScreenshotPlacement {
    pub tile: usize,
    /// Destination offset inside the region content, in CSS pixels.
    pub dst_x: f64,
    pub dst_y: f64,
    pub width: f64,
    pub height: f64,
}

/// The scrolling area that was expanded, in CSS pixels of the top viewport.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserScreenshotRegion {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub content_width: f64,
    pub content_height: f64,
    pub scrollbar_width: f64,
    pub scrollbar_height: f64,
    pub description: String,
    pub truncated: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserScreenshotCapture {
    pub viewport_width: f64,
    pub viewport_height: f64,
    pub region: Option<BrowserScreenshotRegion>,
    /// Base64 PNG viewport images; tile 0 is the unscrolled base image.
    pub tiles: Vec<String>,
    pub placements: Vec<BrowserScreenshotPlacement>,
    pub skipped_frames: usize,
}

#[cfg(windows)]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserNewPaneEvent {
    pane_id: String,
    url: String,
}

fn browser_view_label(pane_id: &str) -> Result<String, String> {
    let instance = pane_id
        .strip_prefix("browser:")
        .ok_or_else(|| "Invalid Browser pane id".to_string())?;
    let number = instance
        .parse::<u64>()
        .map_err(|_| "Invalid Browser pane id".to_string())?;
    if number == 0 || number.to_string() != instance {
        return Err("Invalid Browser pane id".to_string());
    }
    Ok(format!("{BROWSER_VIEW_PREFIX}{number}"))
}

fn require_main_webview(webview: &Webview) -> Result<(), String> {
    if webview.label() == "main" {
        Ok(())
    } else {
        Err("Browser controls are available only from the main application view".to_string())
    }
}

fn parse_web_url(value: &str, allow_blank: bool) -> Result<url::Url, String> {
    let url = url::Url::parse(value).map_err(|error| error.to_string())?;
    if allow_blank && url.as_str() == "about:blank" {
        return Ok(url);
    }
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("Only HTTP and HTTPS web addresses are supported".to_string());
    }
    Ok(url)
}

#[cfg_attr(not(windows), allow(dead_code))]
fn physical_edge(value: f64, round_up: bool) -> Result<i32, String> {
    let edge = if round_up { value.ceil() } else { value.floor() };
    if !edge.is_finite() || edge < f64::from(i32::MIN) || edge > f64::from(i32::MAX) {
        return Err("Browser view bounds are outside the native window range".to_string());
    }
    Ok(edge as i32)
}

/// Converts DOM CSS-pixel bounds to physical pixels.
///
/// The conversion is done here instead of passing logical values to Tauri/wry:
/// wry converts logical values with the DPI of the child HWND, which was 96 on a
/// 125% display and shrank the view to 80% of the pane. Left/top edges round
/// down and right/bottom edges round up so the view never leaves a gap.
#[cfg_attr(not(windows), allow(dead_code))]
fn map_browser_bounds_to_physical(bounds: &BrowserBounds) -> Result<BrowserPhysicalBounds, String> {
    let values = [
        bounds.x,
        bounds.y,
        bounds.width,
        bounds.height,
        bounds.device_pixel_ratio,
    ];
    if !values.into_iter().all(f64::is_finite)
        || bounds.width <= 0.0
        || bounds.height <= 0.0
        || bounds.device_pixel_ratio <= 0.0
    {
        return Err("Browser view bounds or display scale are invalid".to_string());
    }
    let scale = bounds.device_pixel_ratio;
    let left = physical_edge(bounds.x * scale, false)?;
    let top = physical_edge(bounds.y * scale, false)?;
    let right = physical_edge((bounds.x + bounds.width) * scale, true)?;
    let bottom = physical_edge((bounds.y + bounds.height) * scale, true)?;
    let width = i64::from(right) - i64::from(left);
    let height = i64::from(bottom) - i64::from(top);
    if width <= 0 || height <= 0 || width > i64::from(u32::MAX) || height > i64::from(u32::MAX) {
        return Err("Browser view size is outside the native window range".to_string());
    }
    Ok(BrowserPhysicalBounds {
        x: left,
        y: top,
        width: width as u32,
        height: height as u32,
    })
}

#[cfg(windows)]
fn read_browser_native_bounds(view: &Webview) -> Result<BrowserPhysicalBounds, String> {
    let position = view.position().map_err(|error| error.to_string())?;
    let size = view.size().map_err(|error| error.to_string())?;
    Ok(BrowserPhysicalBounds {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    })
}

#[cfg(windows)]
fn get_browser_webview(app: &AppHandle, pane_id: &str) -> Result<Webview, String> {
    let label = browser_view_label(pane_id)?;
    app.get_webview(&label)
        .ok_or_else(|| "Browser view is no longer available".to_string())
}

#[cfg(windows)]
struct BrowserFullscreenRecovery {
    fullscreen_before_browser_request: bool,
    fullscreen_before_active_request: Option<bool>,
}

#[cfg(windows)]
fn browser_fullscreen_recoveries(
) -> &'static Mutex<HashMap<String, Arc<Mutex<BrowserFullscreenRecovery>>>> {
    static RECOVERIES: OnceLock<Mutex<HashMap<String, Arc<Mutex<BrowserFullscreenRecovery>>>>> =
        OnceLock::new();
    RECOVERIES.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(windows)]
async fn register_browser_fullscreen_recovery(
    view: &Webview,
    label: &str,
    fullscreen_before_browser_request: bool,
) -> Result<(), String> {
    let recovery = Arc::new(Mutex::new(BrowserFullscreenRecovery {
        fullscreen_before_browser_request,
        fullscreen_before_active_request: None,
    }));
    browser_fullscreen_recoveries()
        .lock()
        .map_err(|error| error.to_string())?
        .insert(label.to_string(), recovery.clone());

    let parent = view.window();
    let event_recovery = recovery.clone();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    view.with_webview(move |platform| {
        let result = unsafe {
            platform
                .controller()
                .CoreWebView2()
                .map_err(|error| error.to_string())
                .and_then(|core| {
                    let handler = ContainsFullScreenElementChangedEventHandler::create(Box::new(
                        move |sender, _| {
                            let Some(sender) = sender else {
                                return Ok(());
                            };
                            let mut contains_fullscreen_element = Default::default();
                            sender.ContainsFullScreenElement(&mut contains_fullscreen_element)?;
                            let contains_fullscreen_element =
                                contains_fullscreen_element.as_bool();
                            if contains_fullscreen_element {
                                if let Ok(mut recovery) = event_recovery.lock() {
                                    if recovery.fullscreen_before_active_request.is_none() {
                                        // Wry also listens for this event and changes the host
                                        // window fullscreen state. Use the host state captured
                                        // before creating this child instead of making a blocking
                                        // window query from WebView2's UI-thread callback.
                                        recovery.fullscreen_before_active_request =
                                            Some(recovery.fullscreen_before_browser_request);
                                    }
                                }
                            } else {
                                let original_fullscreen = event_recovery.lock().ok().and_then(
                                    |mut recovery| recovery.fullscreen_before_active_request.take(),
                                );
                                if let Some(original_fullscreen) = original_fullscreen {
                                    if let Err(error) = parent.set_fullscreen(original_fullscreen) {
                                        eprintln!(
                                            "Unable to restore the application window after Browser fullscreen: {error}"
                                        );
                                    }
                                }
                            }
                            Ok(())
                        },
                    ));
                    let mut token = 0;
                    core.add_ContainsFullScreenElementChanged(&handler, &mut token)
                        .map_err(|error| error.to_string())
                })
        };
        let _ = sender.send(result);
    })
    .map_err(|error| error.to_string())?;

    receiver
        .await
        .map_err(|_| "Browser fullscreen listener did not complete".to_string())??;
    Ok(())
}

#[cfg(windows)]
async fn browser_contains_fullscreen_element(view: &Webview) -> Result<bool, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    view.with_webview(move |platform| {
        let contains_fullscreen_element = (|| unsafe {
            let core = platform
                .controller()
                .CoreWebView2()
                .map_err(|error| error.to_string())?;
            let mut contains_fullscreen_element = Default::default();
            core.ContainsFullScreenElement(&mut contains_fullscreen_element)
                .map_err(|error| error.to_string())?;
            Ok::<_, String>(contains_fullscreen_element.as_bool())
        })();
        let _ = sender.send(contains_fullscreen_element);
    })
    .map_err(|error| error.to_string())?;
    receiver
        .await
        .map_err(|_| "Browser fullscreen state could not be read".to_string())?
}

#[cfg(windows)]
async fn close_browser_view(view: Webview, label: &str) -> Result<(), String> {
    let contains_fullscreen_element = browser_contains_fullscreen_element(&view)
        .await
        .unwrap_or_else(|error| {
            eprintln!("Unable to read Browser fullscreen state before closing: {error}");
            false
        });
    let recovery = browser_fullscreen_recoveries()
        .lock()
        .map_err(|error| error.to_string())?
        .get(label)
        .cloned();
    let original_fullscreen = recovery.as_ref().and_then(|recovery| {
        recovery.lock().ok().and_then(|recovery| {
            recovery.fullscreen_before_active_request.or_else(|| {
                contains_fullscreen_element.then_some(recovery.fullscreen_before_browser_request)
            })
        })
    });

    if contains_fullscreen_element {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let sender = Arc::new(Mutex::new(Some(sender)));
        let sender_for_callback = sender.clone();
        let exit_result = view.eval_with_callback(
            "Promise.resolve(document.exitFullscreen()).catch(() => false)",
            move |_| {
                if let Ok(mut sender) = sender_for_callback.lock() {
                    if let Some(sender) = sender.take() {
                        let _ = sender.send(());
                    }
                }
            },
        );
        if exit_result.is_ok() {
            // Let the page's fullscreenchange event run before destroying its native view.
            let _ = tokio::time::timeout(std::time::Duration::from_secs(1), receiver).await;
        }
    }

    let restore_result = if let Some(original_fullscreen) = original_fullscreen {
        let parent = view.window();
        match parent.is_fullscreen() {
            Ok(current_fullscreen) if current_fullscreen == original_fullscreen => Ok(()),
            Ok(_) => parent
                .set_fullscreen(original_fullscreen)
                .map_err(|error| error.to_string()),
            Err(error) => Err(error.to_string()),
        }
    } else {
        Ok(())
    };
    let close_result = view.close().map_err(|error| error.to_string());
    if let Ok(mut recoveries) = browser_fullscreen_recoveries().lock() {
        recoveries.remove(label);
    }

    match (restore_result, close_result) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(restore_error), Ok(())) => Err(format!(
            "Browser view closed, but the application window fullscreen state could not be restored: {restore_error}"
        )),
        (Ok(()), Err(close_error)) => Err(close_error),
        (Err(restore_error), Err(close_error)) => Err(format!(
            "{close_error}; the application window fullscreen state could not be restored: {restore_error}"
        )),
    }
}

#[cfg(windows)]
fn restore_missing_browser_view(main_webview: &Webview, label: &str) -> Result<(), String> {
    let recovery = browser_fullscreen_recoveries()
        .lock()
        .map_err(|error| error.to_string())?
        .remove(label);
    let Some(recovery) = recovery else {
        return Ok(());
    };
    let original_fullscreen = recovery
        .lock()
        .map_err(|error| error.to_string())?
        .fullscreen_before_active_request;
    let Some(original_fullscreen) = original_fullscreen else {
        return Ok(());
    };

    let parent = main_webview.window();
    match parent.is_fullscreen() {
        Ok(current_fullscreen) if current_fullscreen == original_fullscreen => Ok(()),
        Ok(_) => parent
            .set_fullscreen(original_fullscreen)
            .map_err(|error| error.to_string()),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub async fn browser_create(
    app: AppHandle,
    webview: Webview,
    pane_id: String,
    initial_url: String,
    bounds: BrowserBounds,
    visible: bool,
) -> Result<BrowserBoundsReadback, String> {
    require_main_webview(&webview)?;
    let label = browser_view_label(&pane_id)?;
    if let Some(stale_view) = app.get_webview(&label) {
        #[cfg(windows)]
        close_browser_view(stale_view, &label).await?;
        #[cfg(not(windows))]
        stale_view.close().map_err(|error| error.to_string())?;
    }
    let url = parse_web_url(&initial_url, true)?;

    #[cfg(windows)]
    {
        use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
        use tauri::{PhysicalPosition, PhysicalSize};

        let native_bounds = map_browser_bounds_to_physical(&bounds)?;

        let app_for_navigation = app.clone();
        let navigation_pane_id = pane_id.clone();
        let app_for_load = app.clone();
        let load_pane_id = pane_id.clone();
        let app_for_new_window = app.clone();
        let new_window_pane_id = pane_id.clone();
        let app_for_download = app.clone();
        let download_pane_id = pane_id.clone();
        let pending_downloads: Arc<Mutex<HashMap<String, VecDeque<String>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let pending_for_download = pending_downloads.clone();
        let download_records: Arc<Mutex<HashMap<String, (String, String, PathBuf)>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let records_for_download = download_records.clone();
        let records_for_finish = download_records.clone();
        let blank_url = url::Url::parse("about:blank").map_err(|error| error.to_string())?;
        let builder = WebviewBuilder::new(label.clone(), tauri::WebviewUrl::External(blank_url))
            .on_navigation(move |target| {
                let allowed = target.as_str() == "about:blank"
                    || (matches!(target.scheme(), "http" | "https") && target.host_str().is_some());
                if allowed {
                    let _ = app_for_navigation.emit_to(
                        "main",
                        BROWSER_VIEW_STATE_EVENT,
                        BrowserViewStateEvent {
                            pane_id: navigation_pane_id.clone(),
                            url: target.to_string(),
                            loading: true,
                            can_go_back: None,
                            can_go_forward: None,
                        },
                    );
                }
                allowed
            })
            .on_page_load(move |view, payload| {
                let url = view
                    .url()
                    .map(|current| current.to_string())
                    .unwrap_or_else(|_| payload.url().to_string());
                let _ = app_for_load.emit_to(
                    "main",
                    BROWSER_VIEW_STATE_EVENT,
                    BrowserViewStateEvent {
                        pane_id: load_pane_id.clone(),
                        url,
                        loading: matches!(payload.event(), PageLoadEvent::Started),
                        can_go_back: None,
                        can_go_forward: None,
                    },
                );
            })
            .on_new_window(move |target, _features| {
                if matches!(target.scheme(), "http" | "https") && target.host_str().is_some() {
                    let _ = app_for_new_window.emit_to(
                        "main",
                        BROWSER_NEW_PANE_EVENT,
                        BrowserNewPaneEvent {
                            pane_id: new_window_pane_id.clone(),
                            url: target.to_string(),
                        },
                    );
                }
                NewWindowResponse::Deny
            })
            .on_download(move |_, event| {
                match event {
                    tauri::webview::DownloadEvent::Requested { url, destination } => {
                        let file_name = safe_browser_download_name(
                            destination.file_name().and_then(|name| name.to_str()).unwrap_or("download.bin"),
                        );
                        let download_id = uuid::Uuid::new_v4().to_string();
                        let staging_dir = match browser_download_staging_dir(&app_for_download) {
                            Ok(directory) => directory,
                            Err(error) => {
                                eprintln!("Unable to create Browser download staging directory: {error}");
                                return false;
                            }
                        };
                        let download_dir = staging_dir.join(&download_id);
                        if let Err(error) = std::fs::create_dir(&download_dir) {
                            eprintln!("Unable to create Browser download staging folder: {error}");
                            return false;
                        }
                        let staging_path = download_dir.join(&file_name);
                        *destination = staging_path.clone();
                        if let Ok(mut records) = records_for_download.lock() {
                            records.insert(download_id.clone(), (url.to_string(), file_name.clone(), staging_path.clone()));
                        }
                        if let Ok(mut pending) = pending_for_download.lock() {
                            pending.entry(url.to_string()).or_default().push_back(download_id.clone());
                        }
                        emit_browser_download(
                            &app_for_download,
                            &download_pane_id,
                            &download_id,
                            url.as_str(),
                            &file_name,
                            &staging_path,
                            "started",
                            0,
                            None,
                            None,
                        );
                        true
                    }
                    tauri::webview::DownloadEvent::Finished { url, path, success } => {
                        let download_id = path
                            .as_deref()
                            .and_then(browser_download_id_from_path)
                            .or_else(|| {
                                pending_for_download
                                    .lock()
                                    .ok()
                                    .and_then(|mut pending| pending.get_mut(url.as_str()).and_then(VecDeque::pop_front))
                            });
                        if let Some(download_id) = download_id {
                            let record = records_for_finish.lock().ok().and_then(|mut records| records.remove(&download_id));
                            let Some((record_url, file_name, record_path)) = record else {
                                return true;
                            };
                            if let Ok(mut pending) = pending_for_download.lock() {
                                let is_empty = if let Some(ids) = pending.get_mut(url.as_str()) {
                                    ids.retain(|id| id != &download_id);
                                    ids.is_empty()
                                } else {
                                    false
                                };
                                if is_empty {
                                    pending.remove(url.as_str());
                                }
                            }
                            let staging_path = path.unwrap_or(record_path);
                            emit_browser_download(
                                &app_for_download,
                                &download_pane_id,
                                &download_id,
                                &record_url,
                                &file_name,
                                &staging_path,
                                if success { "completed" } else { "failed" },
                                std::fs::metadata(&staging_path).map(|metadata| metadata.len()).unwrap_or(0),
                                None,
                                (!success).then(|| "The browser download was interrupted.".to_string()),
                            );
                        }
                        true
                    }
                    _ => true,
                }
            });

        let parent = webview.window();
        let fullscreen_before_browser_request =
            parent.is_fullscreen().map_err(|error| error.to_string())?;
        let child = parent
            .add_child(
                builder,
                PhysicalPosition::new(native_bounds.x, native_bounds.y),
                PhysicalSize::new(native_bounds.width, native_bounds.height),
            )
            .map_err(|error| error.to_string())?;
        if let Err(error) =
            register_browser_fullscreen_recovery(&child, &label, fullscreen_before_browser_request)
                .await
        {
            let _ = close_browser_view(child, &label).await;
            return Err(error);
        }
        if let Err(error) = register_browser_download_progress(&child, app.clone(), pane_id.clone()).await {
            eprintln!("Browser download started/finished events are available, but byte progress could not be attached: {error}");
        }
        if !visible {
            child.hide().map_err(|error| error.to_string())?;
        }
        let actual = read_browser_native_bounds(&child)?;
        if url.as_str() != "about:blank" {
            if let Err(error) = child.navigate(url) {
                let _ = close_browser_view(child, &label).await;
                return Err(error.to_string());
            }
        }
        Ok(BrowserBoundsReadback {
            requested: native_bounds,
            actual,
        })
    }

    #[cfg(not(windows))]
    {
        let _ = (app, pane_id, bounds, visible, url);
        Err("Browser panes are supported only on Windows".to_string())
    }
}

#[tauri::command]
pub async fn browser_set_bounds(
    app: AppHandle,
    webview: Webview,
    pane_id: String,
    bounds: BrowserBounds,
) -> Result<BrowserBoundsReadback, String> {
    require_main_webview(&webview)?;
    #[cfg(windows)]
    {
        use tauri::{PhysicalPosition, PhysicalSize, Position, Rect, Size};
        let view = get_browser_webview(&app, &pane_id)?;
        let native_bounds = map_browser_bounds_to_physical(&bounds)?;
        view.set_bounds(Rect {
            position: Position::Physical(PhysicalPosition::new(native_bounds.x, native_bounds.y)),
            size: Size::Physical(PhysicalSize::new(
                native_bounds.width,
                native_bounds.height,
            )),
        })
        .map_err(|error| error.to_string())?;
        let actual = read_browser_native_bounds(&view)?;
        Ok(BrowserBoundsReadback {
            requested: native_bounds,
            actual,
        })
    }
    #[cfg(not(windows))]
    {
        let _ = (app, pane_id, bounds);
        Err("Browser panes are supported only on Windows".to_string())
    }
}

#[tauri::command]
pub async fn browser_set_visible(
    app: AppHandle,
    webview: Webview,
    pane_id: String,
    visible: bool,
) -> Result<(), String> {
    require_main_webview(&webview)?;
    #[cfg(windows)]
    {
        let view = get_browser_webview(&app, &pane_id)?;
        if visible {
            view.show().map_err(|error| error.to_string())
        } else {
            view.hide().map_err(|error| error.to_string())
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (app, pane_id, visible);
        Err("Browser panes are supported only on Windows".to_string())
    }
}

#[tauri::command]
pub async fn browser_navigate(
    app: AppHandle,
    webview: Webview,
    pane_id: String,
    url: String,
) -> Result<(), String> {
    require_main_webview(&webview)?;
    let url = parse_web_url(&url, false)?;
    #[cfg(windows)]
    {
        get_browser_webview(&app, &pane_id)?
            .navigate(url)
            .map_err(|error| error.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, pane_id, url);
        Err("Browser panes are supported only on Windows".to_string())
    }
}

#[tauri::command]
pub async fn browser_history(
    app: AppHandle,
    webview: Webview,
    pane_id: String,
    direction: String,
) -> Result<(), String> {
    require_main_webview(&webview)?;
    if direction != "back" && direction != "forward" {
        return Err("Invalid browser history direction".to_string());
    }
    #[cfg(windows)]
    {
        run_core_command(get_browser_webview(&app, &pane_id)?, direction).await
    }
    #[cfg(not(windows))]
    {
        let _ = (app, pane_id, direction);
        Err("Browser panes are supported only on Windows".to_string())
    }
}

#[tauri::command]
pub async fn browser_reload(
    app: AppHandle,
    webview: Webview,
    pane_id: String,
) -> Result<(), String> {
    require_main_webview(&webview)?;
    #[cfg(windows)]
    {
        get_browser_webview(&app, &pane_id)?
            .reload()
            .map_err(|error| error.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, pane_id);
        Err("Browser panes are supported only on Windows".to_string())
    }
}

#[tauri::command]
pub async fn browser_stop(app: AppHandle, webview: Webview, pane_id: String) -> Result<(), String> {
    require_main_webview(&webview)?;
    #[cfg(windows)]
    {
        run_core_command(get_browser_webview(&app, &pane_id)?, "stop".to_string()).await
    }
    #[cfg(not(windows))]
    {
        let _ = (app, pane_id);
        Err("Browser panes are supported only on Windows".to_string())
    }
}

#[tauri::command]
pub async fn browser_get_state(
    app: AppHandle,
    webview: Webview,
    pane_id: String,
) -> Result<BrowserNavigationState, String> {
    require_main_webview(&webview)?;
    #[cfg(windows)]
    {
        let view = get_browser_webview(&app, &pane_id)?;
        let url = view.url().map_err(|error| error.to_string())?.to_string();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        view.with_webview(move |platform| {
            let result = (|| unsafe {
                let core = platform
                    .controller()
                    .CoreWebView2()
                    .map_err(|error| error.to_string())?;
                let mut can_go_back = std::mem::MaybeUninit::uninit();
                let mut can_go_forward = std::mem::MaybeUninit::uninit();
                core.CanGoBack(can_go_back.as_mut_ptr())
                    .map_err(|error| error.to_string())?;
                core.CanGoForward(can_go_forward.as_mut_ptr())
                    .map_err(|error| error.to_string())?;
                Ok::<_, String>((
                    can_go_back.assume_init().0 != 0,
                    can_go_forward.assume_init().0 != 0,
                ))
            })();
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
        let (can_go_back, can_go_forward) = receiver
            .await
            .map_err(|_| "Unable to read browser history state".to_string())??;
        Ok(BrowserNavigationState {
            url,
            can_go_back,
            can_go_forward,
        })
    }
    #[cfg(not(windows))]
    {
        let _ = (app, pane_id);
        Err("Browser panes are supported only on Windows".to_string())
    }
}

#[tauri::command]
pub async fn browser_capture_full_page(
    app: AppHandle,
    webview: Webview,
    pane_id: String,
) -> Result<BrowserScreenshotCapture, String> {
    require_main_webview(&webview)?;
    #[cfg(windows)]
    {
        let view = get_browser_webview(&app, &pane_id)?;
        let mut cleanup = ScreenshotCleanup::default();
        let capture_result = capture_browser_page(view.clone(), &mut cleanup).await;
        let restore_result = cleanup_browser_screenshot(view, cleanup).await;

        match (capture_result, restore_result) {
            (Ok(capture), Ok(())) => Ok(capture),
            (Err(capture_error), Ok(())) => Err(capture_error),
            (Ok(_), Err(restore_error)) => Err(format!(
                "The screenshot was captured, but the original page state could not be restored: {restore_error}"
            )),
            (Err(capture_error), Err(restore_error)) => Err(format!(
                "{capture_error}; the original page state also could not be restored: {restore_error}"
            )),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (app, pane_id);
        Err("Browser screenshots are supported only on Windows".to_string())
    }
}

/// Captures the visible part of a Browser pane as a JPEG (base64). Used for the
/// stand-in image shown while the native view is hidden and for the taskbar
/// preview. The view has to be shown when this runs; a hidden surface cannot
/// be captured, so the request is abandoned after a short time instead of
/// blocking the caller.
#[tauri::command]
pub async fn browser_capture_preview(
    app: AppHandle,
    webview: Webview,
    pane_id: String,
) -> Result<String, String> {
    require_main_webview(&webview)?;
    #[cfg(windows)]
    {
        let view = get_browser_webview(&app, &pane_id)?;
        let request = browser_devtools_json(
            view,
            "Page.captureScreenshot",
            serde_json::json!({ "format": "jpeg", "quality": 80, "fromSurface": true }).to_string(),
        );
        let response = tokio::time::timeout(std::time::Duration::from_secs(3), request)
            .await
            .map_err(|_| "The browser preview request timed out".to_string())??;
        response
            .get("data")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "The browser did not return a preview image".to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, pane_id);
        Err("Browser previews are supported only on Windows".to_string())
    }
}

/// A scrolling area found in one frame. Coordinates are CSS pixels in the top
/// viewport (iframe offsets already added).
#[cfg(any(windows, test))]
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Clone, Debug)]
struct ScrollCandidate {
    frame_index: usize,
    execution_context_id: i64,
    index: usize,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    content_width: f64,
    content_height: f64,
    scrollbar_width: f64,
    scrollbar_height: f64,
    scroll_width: f64,
    scroll_height: f64,
    scale_x: f64,
    scale_y: f64,
    description: String,
}

#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug, PartialEq)]
struct BrowserFrameTransform {
    x: f64,
    y: f64,
    scale_x: f64,
    scale_y: f64,
}

#[cfg(any(windows, test))]
impl BrowserFrameTransform {
    const IDENTITY: Self = Self {
        x: 0.0,
        y: 0.0,
        scale_x: 1.0,
        scale_y: 1.0,
    };

    fn point(self, x: f64, y: f64) -> (f64, f64) {
        (self.x + x * self.scale_x, self.y + y * self.scale_y)
    }

    fn size(self, width: f64, height: f64) -> (f64, f64) {
        (width * self.scale_x, height * self.scale_y)
    }
}

#[cfg(any(windows, test))]
fn child_frame_transform(
    parent: BrowserFrameTransform,
    origin_x: f64,
    origin_y: f64,
    rendered_width: f64,
    rendered_height: f64,
    viewport_width: f64,
    viewport_height: f64,
) -> Option<BrowserFrameTransform> {
    let values = [
        origin_x,
        origin_y,
        rendered_width,
        rendered_height,
        viewport_width,
        viewport_height,
        parent.x,
        parent.y,
        parent.scale_x,
        parent.scale_y,
    ];
    if values.iter().any(|value| !value.is_finite())
        || rendered_width <= 0.0
        || rendered_height <= 0.0
        || viewport_width <= 0.0
        || viewport_height <= 0.0
        || parent.scale_x <= 0.0
        || parent.scale_y <= 0.0
    {
        return None;
    }
    Some(BrowserFrameTransform {
        x: parent.x + origin_x * parent.scale_x,
        y: parent.y + origin_y * parent.scale_y,
        scale_x: parent.scale_x * rendered_width / viewport_width,
        scale_y: parent.scale_y * rendered_height / viewport_height,
    })
}

/// Amount of content that is not visible: the larger it is, the more a
/// scrolling area contributes to the full page.
#[cfg(any(windows, test))]
fn hidden_content_area(candidate: &ScrollCandidate) -> f64 {
    let hidden_height = (candidate.content_height - candidate.height).max(0.0);
    let hidden_width = (candidate.content_width - candidate.width).max(0.0);
    hidden_height * candidate.width + hidden_width * candidate.height
}

/// Picks the scrolling area to expand: it has to be completely visible, large
/// enough, and actually overflow. The one hiding the most content wins; the
/// larger visible area breaks ties.
#[cfg(any(windows, test))]
fn select_scroll_candidate(
    candidates: &[ScrollCandidate],
    viewport_width: f64,
    viewport_height: f64,
) -> Option<usize> {
    const TOLERANCE: f64 = 2.0;
    candidates
        .iter()
        .enumerate()
        .filter(|(_, candidate)| {
            candidate.width >= 40.0
                && candidate.height >= 40.0
                && candidate.x >= -TOLERANCE
                && candidate.y >= -TOLERANCE
                && candidate.x + candidate.width <= viewport_width + TOLERANCE
                && candidate.y + candidate.height <= viewport_height + TOLERANCE
                && (candidate.content_width > candidate.width + 1.0
                    || candidate.content_height > candidate.height + 1.0)
        })
        .max_by(|(_, left), (_, right)| {
            hidden_content_area(left)
                .partial_cmp(&hidden_content_area(right))
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| {
                    (left.width * left.height)
                        .partial_cmp(&(right.width * right.height))
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
        })
        .map(|(index, _)| index)
}

/// Next vertical scroll offset of a capture pass, or `None` once the end of
/// the (possibly still growing) content has been reached.
#[cfg(any(windows, test))]
fn next_scroll_position(current: f64, step: f64, content: f64, client: f64) -> Option<f64> {
    let max_scroll = (content - client).max(0.0);
    if step < 1.0 || current + 1.0 > max_scroll {
        return None;
    }
    Some((current + step).min(max_scroll))
}

/// Limits the expanded content so the stitched page stays inside the maximum
/// image dimension and pixel budget (device pixels). Returns the capped
/// content size and whether anything was cut off.
#[cfg(any(windows, test))]
fn capped_content_lengths(
    fixed_width: f64,
    fixed_height: f64,
    region_width: f64,
    region_height: f64,
    content_width: f64,
    content_height: f64,
    device_pixel_ratio: f64,
) -> (f64, f64, bool) {
    let dpr = if device_pixel_ratio.is_finite() && device_pixel_ratio > 0.0 {
        device_pixel_ratio
    } else {
        1.0
    };
    let max_dimension = (MAX_SCREENSHOT_DIMENSION / dpr).floor();
    let width = content_width
        .max(region_width)
        .min((max_dimension - fixed_width).max(region_width));
    let page_width = fixed_width + width;
    let max_by_pixels = (MAX_SCREENSHOT_PIXELS / (page_width * dpr * dpr)).floor();
    let max_page_height = max_dimension.min(max_by_pixels);
    let height = content_height
        .max(region_height)
        .min((max_page_height - fixed_height).max(region_height));
    let truncated = width + 0.5 < content_width || height + 0.5 < content_height;
    (width, height, truncated)
}

/// Draw instructions for the captured tiles. `scroll_offsets` are the scroll
/// positions that were actually reached (not the requested ones).
#[cfg(any(windows, test))]
fn region_placements(
    scroll_offsets: &[(f64, f64)],
    region_width: f64,
    region_height: f64,
    content_width: f64,
    content_height: f64,
) -> Vec<BrowserScreenshotPlacement> {
    region_placements_scaled(
        scroll_offsets,
        region_width,
        region_height,
        content_width,
        content_height,
        1.0,
        1.0,
    )
}

#[cfg(any(windows, test))]
fn region_placements_scaled(
    scroll_offsets: &[(f64, f64)],
    region_width: f64,
    region_height: f64,
    content_width: f64,
    content_height: f64,
    scale_x: f64,
    scale_y: f64,
) -> Vec<BrowserScreenshotPlacement> {
    scroll_offsets
        .iter()
        .enumerate()
        .filter_map(|(tile, (scroll_x, scroll_y))| {
            let dst_x = scroll_x * scale_x;
            let dst_y = scroll_y * scale_y;
            let width = (content_width - dst_x).min(region_width);
            let height = (content_height - dst_y).min(region_height);
            if width <= 0.0 || height <= 0.0 {
                None
            } else {
                Some(BrowserScreenshotPlacement {
                    tile,
                    dst_x,
                    dst_y,
                    width,
                    height,
                })
            }
        })
        .collect()
}

#[cfg(any(windows, test))]
fn collect_browser_frame_tree(
    tree: &serde_json::Value,
    parent_frame_id: Option<String>,
    frames: &mut Vec<(String, Option<String>)>,
) -> Result<(), String> {
    let frame = tree
        .get("frame")
        .ok_or_else(|| "The browser returned an invalid frame tree".to_string())?;
    let frame_id = frame
        .get("id")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "The browser returned a frame without an id".to_string())?
        .to_string();
    frames.push((frame_id.clone(), parent_frame_id));
    if let Some(children) = tree
        .get("childFrames")
        .and_then(serde_json::Value::as_array)
    {
        for child in children {
            collect_browser_frame_tree(child, Some(frame_id.clone()), frames)?;
        }
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn tile_positions(total: f64, viewport: f64) -> Vec<f64> {
    let mut positions = vec![0.0];
    while let Some(last) = positions.last().copied() {
        if last + viewport >= total {
            break;
        }
        let next = (last + viewport).min((total - viewport).max(0.0));
        if next <= last {
            break;
        }
        positions.push(next);
    }
    positions
}

/// Everything that has to be undone after a screenshot attempt.
#[cfg(windows)]
#[derive(Default)]
struct ScreenshotCleanup {
    dom_enabled: bool,
    /// Isolated-world contexts where the helper object was installed.
    contexts: Vec<i64>,
    object_ids: Vec<String>,
}

#[cfg(windows)]
#[derive(Clone, Copy)]
struct BrowserViewport {
    width: f64,
    height: f64,
    dpr: f64,
}

#[cfg(windows)]
#[derive(Clone, Copy)]
struct RegionMetrics {
    scroll_left: f64,
    scroll_top: f64,
    content_width: f64,
    content_height: f64,
}

#[cfg(windows)]
const SCREENSHOT_WORLD_NAME: &str = "nfterm-screenshot";

/// Installed into an isolated world of every frame. It finds scrolling areas
/// (page, elements, shadow DOM) and offers scroll/sticky helpers that keep
/// the page layout untouched. Must not contain a double quote followed by `#`.
#[cfg(windows)]
const SCREENSHOT_INSPECT_JS: &str = r#"(() => {
  const previous = globalThis.__nftermShot;
  if (previous && previous.dispose) {
    try { previous.dispose(); } catch (error) { /* stale state of an earlier capture */ }
  }
  const root = document.scrollingElement || document.documentElement;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const scrollable = (value) => /^(auto|scroll|overlay)$/.test(value);
  const STYLE_PROPERTIES = ['position', 'top', 'right', 'bottom', 'left'];
  const candidates = [];
  const sticky = [];
  const scrolled = new Set();

  const describe = (element) => {
    let text = element.tagName.toLowerCase();
    if (element.id) {
      text += '#' + element.id;
    } else if (typeof element.className === 'string' && element.className.trim()) {
      text += '.' + element.className.trim().split(/\s+/).slice(0, 2).join('.');
    }
    return text;
  };

  const rootAllowed = () => {
    const html = getComputedStyle(document.documentElement);
    const body = document.body ? getComputedStyle(document.body) : null;
    const allow = (axis) => {
      const value = html[axis] !== 'visible' ? html[axis] : (body ? body[axis] : 'visible');
      return value !== 'hidden' && value !== 'clip';
    };
    return { allowX: allow('overflowX'), allowY: allow('overflowY') };
  };

  const rootAxes = rootAllowed();
  if ((rootAxes.allowY && root.scrollHeight > root.clientHeight + 1) ||
      (rootAxes.allowX && root.scrollWidth > root.clientWidth + 1)) {
    candidates.push({
      kind: 'root', element: root, allowX: rootAxes.allowX, allowY: rootAxes.allowY,
      x: 0, y: 0, width: root.clientWidth, height: root.clientHeight,
      scaleX: 1, scaleY: 1,
      contentWidth: rootAxes.allowX ? root.scrollWidth : root.clientWidth,
      contentHeight: rootAxes.allowY ? root.scrollHeight : root.clientHeight,
      scrollbarWidth: Math.max(0, window.innerWidth - root.clientWidth),
      scrollbarHeight: Math.max(0, window.innerHeight - root.clientHeight),
      description: 'page',
    });
  }

  const addElement = (element) => {
    if (element === root || element === document.documentElement) return;
    if (/^(TEXTAREA|INPUT|SELECT)$/.test(element.tagName)) return;
    if (element.scrollHeight <= element.clientHeight + 1 && element.scrollWidth <= element.clientWidth + 1) return;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return;
    const allowY = scrollable(style.overflowY) && element.scrollHeight > element.clientHeight + 1;
    const allowX = scrollable(style.overflowX) && element.scrollWidth > element.clientWidth + 1;
    if (!allowX && !allowY) return;
    const rect = element.getBoundingClientRect();
    const border = (name) => parseFloat(style[name]) || 0;
    const layoutWidth = element.offsetWidth || rect.width;
    const layoutHeight = element.offsetHeight || rect.height;
    const scaleX = layoutWidth > 0 ? rect.width / layoutWidth : 1;
    const scaleY = layoutHeight > 0 ? rect.height / layoutHeight : 1;
    candidates.push({
      kind: 'element', element, allowX, allowY,
      x: rect.left + element.clientLeft * scaleX, y: rect.top + element.clientTop * scaleY,
      width: element.clientWidth * scaleX, height: element.clientHeight * scaleY,
      scaleX, scaleY,
      contentWidth: (allowX ? element.scrollWidth : element.clientWidth) * scaleX,
      contentHeight: (allowY ? element.scrollHeight : element.clientHeight) * scaleY,
      scrollbarWidth: Math.max(0, (element.offsetWidth - element.clientWidth - border('borderLeftWidth') - border('borderRightWidth')) * scaleX),
      scrollbarHeight: Math.max(0, (element.offsetHeight - element.clientHeight - border('borderTopWidth') - border('borderBottomWidth')) * scaleY),
      description: describe(element),
    });
  };

  const visit = (scope) => {
    for (const element of scope.querySelectorAll('*')) {
      addElement(element);
      if (element.shadowRoot) visit(element.shadowRoot);
    }
  };
  visit(document);

  candidates.sort((a, b) => b.width * b.height - a.width * a.height);

  const measure = (candidate) => {
    const isRoot = candidate.kind === 'root';
    const element = candidate.element;
    return {
      scrollLeft: isRoot ? window.scrollX : element.scrollLeft,
      scrollTop: isRoot ? window.scrollY : element.scrollTop,
      contentWidth: (candidate.allowX ? element.scrollWidth : element.clientWidth) * candidate.scaleX,
      contentHeight: (candidate.allowY ? element.scrollHeight : element.clientHeight) * candidate.scaleY,
      scrollContentWidth: candidate.allowX ? element.scrollWidth : element.clientWidth,
      scrollContentHeight: candidate.allowY ? element.scrollHeight : element.clientHeight,
      clientWidth: element.clientWidth,
      clientHeight: element.clientHeight,
    };
  };

  for (const candidate of candidates) {
    const metrics = measure(candidate);
    candidate.originalLeft = metrics.scrollLeft;
    candidate.originalTop = metrics.scrollTop;
  }

  const scrollInstant = (candidate, left, top) => {
    const options = { left, top, behavior: 'instant' };
    if (candidate.kind === 'root') window.scrollTo(options);
    else candidate.element.scrollTo(options);
  };

  const scrollTo = async (index, left, top, settleMs) => {
    const candidate = candidates[index];
    scrolled.add(index);
    scrollInstant(candidate, left, top);
    await frames();
    await sleep(settleMs);
    return measure(candidate);
  };

  const neutralize = (index) => {
    const candidate = candidates[index];
    const isRoot = candidate.kind === 'root';
    const scopes = [isRoot ? document : candidate.element];
    let changed = 0;
    while (scopes.length) {
      const scope = scopes.pop();
      for (const element of scope.querySelectorAll('*')) {
        if (element.shadowRoot) scopes.push(element.shadowRoot);
        const position = getComputedStyle(element).position;
        if (position !== 'sticky' && !(isRoot && position === 'fixed')) continue;
        sticky.push({
          element,
          styles: STYLE_PROPERTIES.map((name) => [name, element.style.getPropertyValue(name), element.style.getPropertyPriority(name)]),
        });
        if (position === 'sticky') {
          element.style.setProperty('position', 'relative', 'important');
          for (const side of ['top', 'right', 'bottom', 'left']) element.style.setProperty(side, 'auto', 'important');
        } else {
          element.style.setProperty('position', 'absolute', 'important');
        }
        changed += 1;
      }
    }
    return changed;
  };

  const restoreSticky = () => {
    for (const item of sticky.splice(0).reverse()) {
      for (const [name, value, priority] of item.styles) {
        if (value) item.element.style.setProperty(name, value, priority);
        else item.element.style.removeProperty(name);
      }
    }
  };

  const api = {
    scrollTo,
    neutralize,
    dispose: () => {
      restoreSticky();
      for (const index of scrolled) {
        const candidate = candidates[index];
        scrollInstant(candidate, candidate.originalLeft, candidate.originalTop);
      }
      scrolled.clear();
      if (globalThis.__nftermShot === api) delete globalThis.__nftermShot;
    },
  };
  globalThis.__nftermShot = api;

  return {
    viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 },
    candidates: candidates.slice(0, 64).map((candidate, index) => Object.assign({
      index,
      x: candidate.x, y: candidate.y, width: candidate.width, height: candidate.height,
      scaleX: candidate.scaleX, scaleY: candidate.scaleY,
      scrollbarWidth: candidate.scrollbarWidth, scrollbarHeight: candidate.scrollbarHeight,
      description: candidate.description,
    }, measure(candidate))),
  };
})()"#;

#[cfg(windows)]
fn json_number(value: &serde_json::Value, name: &str) -> Result<f64, String> {
    value
        .get(name)
        .and_then(serde_json::Value::as_f64)
        .filter(|number| number.is_finite())
        .ok_or_else(|| format!("The browser reported an invalid {name}"))
}

#[cfg(windows)]
fn parse_region_metrics(value: &serde_json::Value) -> Result<RegionMetrics, String> {
    Ok(RegionMetrics {
        scroll_left: json_number(value, "scrollLeft")?,
        scroll_top: json_number(value, "scrollTop")?,
        content_width: json_number(value, "scrollContentWidth")?,
        content_height: json_number(value, "scrollContentHeight")?,
    })
}

#[cfg(windows)]
async fn capture_browser_page(
    view: Webview,
    cleanup: &mut ScreenshotCleanup,
) -> Result<BrowserScreenshotCapture, String> {
    browser_devtools_json(view.clone(), "DOM.enable", "{}".to_string()).await?;
    cleanup.dom_enabled = true;

    let tree = browser_devtools_json(view.clone(), "Page.getFrameTree", "{}".to_string()).await?;
    let tree = tree
        .get("frameTree")
        .ok_or_else(|| "The browser did not return its frame tree".to_string())?;
    let mut frames = Vec::new();
    collect_browser_frame_tree(tree, None, &mut frames)?;
    if frames.is_empty() || frames.len() > MAX_SCREENSHOT_FRAMES {
        return Err("The page has too many nested frames to capture safely".to_string());
    }

    let mut known: HashMap<String, (i64, BrowserFrameTransform)> = HashMap::new();
    let mut candidates = Vec::new();
    let mut root_viewport = None;
    let mut skipped_frames = 0usize;
    for (index, (frame_id, parent_id)) in frames.iter().enumerate() {
        let parent = match parent_id {
            None => None,
            Some(parent_id) => match known.get(parent_id) {
                Some(parent) => Some(*parent),
                None => {
                    skipped_frames += 1;
                    continue;
                }
            },
        };
        match inspect_browser_frame(&view, frame_id, index, parent, cleanup).await {
            Ok((context_id, frame_transform, viewport, found)) => {
                known.insert(frame_id.clone(), (context_id, frame_transform));
                if index == 0 {
                    root_viewport = Some(viewport);
                }
                candidates.extend(found);
            }
            Err(error) => {
                // A frame that cannot be inspected (for example a separate
                // process) is skipped; only the main frame is required.
                if index == 0 {
                    return Err(error);
                }
                skipped_frames += 1;
            }
        }
    }

    let viewport =
        root_viewport.ok_or_else(|| "The browser did not return a main frame".to_string())?;
    match select_scroll_candidate(&candidates, viewport.width, viewport.height) {
        Some(selected) => {
            capture_browser_scroll_region(&view, viewport, &candidates[selected], skipped_frames)
                .await
        }
        None => {
            let data = capture_browser_viewport_png(&view).await?;
            Ok(BrowserScreenshotCapture {
                viewport_width: viewport.width,
                viewport_height: viewport.height,
                region: None,
                tiles: vec![data],
                placements: Vec::new(),
                skipped_frames,
            })
        }
    }
}

#[cfg(windows)]
async fn inspect_browser_frame(
    view: &Webview,
    frame_id: &str,
    frame_index: usize,
    parent: Option<(i64, BrowserFrameTransform)>,
    cleanup: &mut ScreenshotCleanup,
) -> Result<
    (
        i64,
        BrowserFrameTransform,
        BrowserViewport,
        Vec<ScrollCandidate>,
    ),
    String,
> {
    let world = browser_devtools_json(
        view.clone(),
        "Page.createIsolatedWorld",
        serde_json::json!({ "frameId": frame_id, "worldName": SCREENSHOT_WORLD_NAME }).to_string(),
    )
    .await?;
    let context_id = world
        .get("executionContextId")
        .and_then(serde_json::Value::as_i64)
        .ok_or_else(|| "The browser could not create a frame execution context".to_string())?;

    let owner_origin = match parent {
        None => None,
        Some((parent_context_id, parent_transform)) => {
            let owner = browser_devtools_json(
                view.clone(),
                "DOM.getFrameOwner",
                serde_json::json!({ "frameId": frame_id }).to_string(),
            )
            .await?;
            let backend_node_id = owner
                .get("backendNodeId")
                .and_then(serde_json::Value::as_i64)
                .ok_or_else(|| "The browser could not locate an iframe element".to_string())?;
            let resolved = browser_devtools_json(
                view.clone(),
                "DOM.resolveNode",
                serde_json::json!({
                    "backendNodeId": backend_node_id,
                    "executionContextId": parent_context_id,
                })
                .to_string(),
            )
            .await?;
            let object_id = resolved
                .pointer("/object/objectId")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| "The browser could not resolve an iframe element".to_string())?
                .to_string();
            cleanup.object_ids.push(object_id.clone());
            let origin = call_browser_remote_object(
                view.clone(),
                &object_id,
                "function() { const rect = this.getBoundingClientRect(); const style = getComputedStyle(this); const layoutWidth = this.offsetWidth || rect.width; const layoutHeight = this.offsetHeight || rect.height; const scaleX = layoutWidth > 0 ? rect.width / layoutWidth : 1; const scaleY = layoutHeight > 0 ? rect.height / layoutHeight : 1; const paddingLeft = parseFloat(style.paddingLeft) || 0; const paddingRight = parseFloat(style.paddingRight) || 0; const paddingTop = parseFloat(style.paddingTop) || 0; const paddingBottom = parseFloat(style.paddingBottom) || 0; return { x: rect.left + (this.clientLeft + paddingLeft) * scaleX, y: rect.top + (this.clientTop + paddingTop) * scaleY, width: Math.max(0, this.clientWidth - paddingLeft - paddingRight) * scaleX, height: Math.max(0, this.clientHeight - paddingTop - paddingBottom) * scaleY }; }",
            )
            .await?;
            Some((
                parent_transform,
                json_number(&origin, "x")?,
                json_number(&origin, "y")?,
                json_number(&origin, "width")?,
                json_number(&origin, "height")?,
            ))
        }
    };

    // Registered before running the script so a half-installed helper is
    // still disposed afterwards.
    cleanup.contexts.push(context_id);
    let inspected =
        evaluate_browser_javascript(view.clone(), context_id, SCREENSHOT_INSPECT_JS.to_string())
            .await?;

    let viewport_value = inspected
        .get("viewport")
        .ok_or_else(|| "The browser did not report its viewport".to_string())?;
    let viewport = BrowserViewport {
        width: json_number(viewport_value, "width")?,
        height: json_number(viewport_value, "height")?,
        dpr: json_number(viewport_value, "dpr")?.max(0.1),
    };
    if viewport.width < 1.0 || viewport.height < 1.0 {
        return Err("The browser reported an invalid viewport".to_string());
    }
    let frame_transform = match owner_origin {
        None => BrowserFrameTransform::IDENTITY,
        Some((parent, x, y, width, height)) => {
            child_frame_transform(parent, x, y, width, height, viewport.width, viewport.height)
                .ok_or_else(|| {
                    "The browser reported invalid iframe screenshot coordinates".to_string()
                })?
        }
    };

    let mut found = Vec::new();
    if let Some(items) = inspected
        .get("candidates")
        .and_then(serde_json::Value::as_array)
    {
        for item in items {
            let (x, y) = frame_transform.point(json_number(item, "x")?, json_number(item, "y")?);
            let (width, height) =
                frame_transform.size(json_number(item, "width")?, json_number(item, "height")?);
            let local_scale_x = json_number(item, "scaleX")?;
            let local_scale_y = json_number(item, "scaleY")?;
            found.push(ScrollCandidate {
                frame_index,
                execution_context_id: context_id,
                index: json_number(item, "index")? as usize,
                x,
                y,
                width,
                height,
                content_width: json_number(item, "contentWidth")? * frame_transform.scale_x,
                content_height: json_number(item, "contentHeight")? * frame_transform.scale_y,
                scrollbar_width: json_number(item, "scrollbarWidth")? * frame_transform.scale_x,
                scrollbar_height: json_number(item, "scrollbarHeight")? * frame_transform.scale_y,
                scroll_width: json_number(item, "clientWidth")?,
                scroll_height: json_number(item, "clientHeight")?,
                scale_x: local_scale_x * frame_transform.scale_x,
                scale_y: local_scale_y * frame_transform.scale_y,
                description: item
                    .get("description")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("scrolling area")
                    .to_string(),
            });
        }
    }
    Ok((context_id, frame_transform, viewport, found))
}

#[cfg(windows)]
async fn scroll_browser_region(
    view: &Webview,
    context_id: i64,
    index: usize,
    x: f64,
    y: f64,
) -> Result<RegionMetrics, String> {
    let value = evaluate_browser_javascript(
        view.clone(),
        context_id,
        format!("globalThis.__nftermShot.scrollTo({index}, {x}, {y}, {SCREENSHOT_SETTLE_MS})"),
    )
    .await?;
    parse_region_metrics(&value)
}

#[cfg(windows)]
async fn capture_browser_viewport_png(view: &Webview) -> Result<String, String> {
    let response = browser_devtools_json(
        view.clone(),
        "Page.captureScreenshot",
        serde_json::json!({ "format": "png", "fromSurface": true }).to_string(),
    )
    .await?;
    response
        .get("data")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "The browser did not return a screenshot image".to_string())
}

/// Scrolls the selected area step by step and captures the unchanged viewport
/// at each step. The page size, styles and layout are never modified (only
/// sticky/fixed positioning is relaxed temporarily and restored afterwards).
#[cfg(windows)]
async fn capture_browser_scroll_region(
    view: &Webview,
    viewport: BrowserViewport,
    candidate: &ScrollCandidate,
    skipped_frames: usize,
) -> Result<BrowserScreenshotCapture, String> {
    let context_id = candidate.execution_context_id;
    let fixed_width = (viewport.width - candidate.width).max(0.0);
    let fixed_height = (viewport.height - candidate.height).max(0.0);
    let cap = |metrics: &RegionMetrics| {
        capped_content_lengths(
            fixed_width,
            fixed_height,
            candidate.width,
            candidate.height,
            metrics.content_width * candidate.scale_x,
            metrics.content_height * candidate.scale_y,
            viewport.dpr,
        )
    };

    evaluate_browser_javascript(
        view.clone(),
        context_id,
        format!("globalThis.__nftermShot.neutralize({})", candidate.index),
    )
    .await?;

    let mut metrics = scroll_browser_region(view, context_id, candidate.index, 0.0, 0.0).await?;
    let mut tiles: Vec<String> = Vec::new();
    let mut offsets: Vec<(f64, f64)> = Vec::new();
    let mut total_bytes = 0usize;
    let mut tile_limit_reached = false;
    let mut previous_top: Option<f64> = None;
    let mut row_top = 0.0;
    loop {
        let (content_width, _, _) = cap(&metrics);
        let local_content_width = content_width / candidate.scale_x;
        for x in tile_positions(local_content_width, candidate.scroll_width) {
            metrics = scroll_browser_region(view, context_id, candidate.index, x, row_top).await?;
            let data = capture_browser_viewport_png(view).await?;
            total_bytes = total_bytes
                .checked_add(data.len())
                .filter(|bytes| *bytes <= MAX_SCREENSHOT_BASE64_BYTES)
                .ok_or_else(|| {
                    "The full page image is too large to preview and select".to_string()
                })?;
            offsets.push((metrics.scroll_left, metrics.scroll_top));
            tiles.push(data);
            if tiles.len() >= MAX_SCREENSHOT_TILES {
                tile_limit_reached = true;
                break;
            }
        }
        if tile_limit_reached {
            break;
        }
        // No progress means the area cannot scroll further.
        if let Some(previous) = previous_top {
            if metrics.scroll_top <= previous + 0.5 {
                break;
            }
        }
        previous_top = Some(metrics.scroll_top);
        let (_, content_height, _) = cap(&metrics);
        match next_scroll_position(
            metrics.scroll_top,
            candidate.scroll_height,
            content_height / candidate.scale_y,
            candidate.scroll_height,
        ) {
            Some(next) => row_top = next,
            None => break,
        }
    }

    let (content_width, content_height, capped) = cap(&metrics);
    let placements = region_placements_scaled(
        &offsets,
        candidate.width,
        candidate.height,
        content_width,
        content_height,
        candidate.scale_x,
        candidate.scale_y,
    );
    let description = if candidate.frame_index > 0 {
        format!("{} (iframe)", candidate.description)
    } else {
        candidate.description.clone()
    };
    Ok(BrowserScreenshotCapture {
        viewport_width: viewport.width,
        viewport_height: viewport.height,
        region: Some(BrowserScreenshotRegion {
            x: candidate.x,
            y: candidate.y,
            width: candidate.width,
            height: candidate.height,
            content_width,
            content_height,
            scrollbar_width: candidate.scrollbar_width,
            scrollbar_height: candidate.scrollbar_height,
            description,
            truncated: capped || tile_limit_reached,
        }),
        tiles,
        placements,
        skipped_frames,
    })
}

#[cfg(windows)]
async fn cleanup_browser_screenshot(
    view: Webview,
    cleanup: ScreenshotCleanup,
) -> Result<(), String> {
    let mut errors = Vec::new();
    for context_id in cleanup.contexts.iter().rev() {
        if let Err(error) = evaluate_browser_javascript(
            view.clone(),
            *context_id,
            "(() => { const shot = globalThis.__nftermShot; if (shot) shot.dispose(); return true; })()"
                .to_string(),
        )
        .await
        {
            errors.push(format!("Unable to restore a frame: {error}"));
        }
    }
    for object_id in &cleanup.object_ids {
        let _ = browser_devtools_json(
            view.clone(),
            "Runtime.releaseObject",
            serde_json::json!({ "objectId": object_id }).to_string(),
        )
        .await;
    }
    if cleanup.dom_enabled {
        let _ = browser_devtools_json(view.clone(), "DOM.disable", "{}".to_string()).await;
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

#[cfg(windows)]
async fn call_browser_remote_object(
    view: Webview,
    object_id: &str,
    function_declaration: &str,
) -> Result<serde_json::Value, String> {
    let response = browser_devtools_json(
        view,
        "Runtime.callFunctionOn",
        serde_json::json!({
            "objectId": object_id,
            "functionDeclaration": function_declaration,
            "returnByValue": true,
        })
        .to_string(),
    )
    .await?;
    if let Some(exception) = response.get("exceptionDetails") {
        return Err(format!(
            "The browser could not read a page element: {exception}"
        ));
    }
    response
        .pointer("/result/value")
        .cloned()
        .ok_or_else(|| "The browser did not return page element information".to_string())
}

#[cfg(windows)]
async fn browser_devtools_json(
    view: Webview,
    method: &'static str,
    parameters: String,
) -> Result<serde_json::Value, String> {
    let response = run_browser_devtools_method(view, method, parameters).await?;
    serde_json::from_str(&response)
        .map_err(|error| format!("Unable to read browser frame information: {error}"))
}

#[cfg(windows)]
async fn evaluate_browser_javascript(
    view: Webview,
    execution_context_id: i64,
    expression: String,
) -> Result<serde_json::Value, String> {
    let parameters = serde_json::json!({
        "expression": expression,
        "contextId": execution_context_id,
        "awaitPromise": true,
        "returnByValue": true,
    })
    .to_string();
    let response = run_browser_devtools_method(view, "Runtime.evaluate", parameters).await?;
    let response: serde_json::Value = serde_json::from_str(&response)
        .map_err(|error| format!("Unable to read browser page information: {error}"))?;
    if let Some(exception) = response.get("exceptionDetails") {
        let detail = exception
            .pointer("/exception/description")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| exception.to_string());
        return Err(format!("The browser could not inspect the page: {detail}"));
    }
    response
        .pointer("/result/value")
        .cloned()
        .ok_or_else(|| "The browser did not return page information".to_string())
}

#[cfg(windows)]
async fn run_browser_devtools_method(
    view: Webview,
    method: &'static str,
    parameters: String,
) -> Result<String, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel::<Result<String, String>>();
    let sender = std::sync::Arc::new(std::sync::Mutex::new(Some(sender)));
    let sender_for_callback = sender.clone();
    view.with_webview(move |platform| {
        let method = CoTaskMemPWSTR::from(method);
        let parameters = CoTaskMemPWSTR::from(parameters.as_str());
        let callback_sender = sender_for_callback.clone();
        let callback = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
            move |status, response| {
                let result = status.map(|_| response).map_err(|error| error.to_string());
                if let Ok(mut sender) = callback_sender.lock() {
                    if let Some(sender) = sender.take() {
                        let _ = sender.send(result);
                    }
                }
                Ok(())
            },
        ));
        let call_result = unsafe {
            platform
                .controller()
                .CoreWebView2()
                .map_err(|error| error.to_string())
                .and_then(|core| {
                    core.CallDevToolsProtocolMethod(
                        *method.as_ref().as_pcwstr(),
                        *parameters.as_ref().as_pcwstr(),
                        &callback,
                    )
                    .map_err(|error| error.to_string())
                })
        };
        if let Err(error) = call_result {
            if let Ok(mut sender) = sender_for_callback.lock() {
                if let Some(sender) = sender.take() {
                    let _ = sender.send(Err(error));
                }
            }
        }
    })
    .map_err(|error| error.to_string())?;
    receiver
        .await
        .map_err(|_| "The browser screenshot request was interrupted".to_string())?
}

#[tauri::command]
pub async fn browser_save_screenshot(png_base64: String) -> Result<Option<String>, String> {
    if png_base64.len() > MAX_SCREENSHOT_BASE64_BYTES {
        return Err("The selected screenshot is too large to save".to_string());
    }
    let png = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, png_base64)
        .map_err(|error| format!("Invalid PNG image data: {error}"))?;
    if !png.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("The selected image is not a valid PNG file".to_string());
    }
    let selected = rfd::AsyncFileDialog::new()
        .set_file_name("browser-screenshot.png")
        .add_filter("PNG image", &["png"])
        .save_file()
        .await;
    let Some(selected) = selected else {
        return Ok(None);
    };
    std::fs::write(selected.path(), png).map_err(|error| error.to_string())?;
    Ok(Some(selected.path().display().to_string()))
}

#[tauri::command]
pub async fn browser_pick_download_folder(
    webview: Webview,
    initial_folder: Option<String>,
) -> Result<Option<String>, String> {
    require_main_webview(&webview)?;
    let mut dialog = rfd::AsyncFileDialog::new();
    if let Some(folder) = initial_folder.filter(|folder| Path::new(folder).is_dir()) {
        dialog = dialog.set_directory(folder);
    }
    Ok(dialog
        .pick_folder()
        .await
        .map(|folder| folder.path().display().to_string()))
}

#[tauri::command]
pub async fn browser_pick_download_file(
    webview: Webview,
    file_name: String,
    initial_folder: Option<String>,
) -> Result<Option<String>, String> {
    require_main_webview(&webview)?;
    let mut dialog = rfd::AsyncFileDialog::new().set_file_name(&safe_browser_download_name(&file_name));
    if let Some(folder) = initial_folder.filter(|folder| Path::new(folder).is_dir()) {
        dialog = dialog.set_directory(folder);
    }
    Ok(dialog
        .save_file()
        .await
        .map(|file| file.path().display().to_string()))
}

fn validate_browser_staged_path(
    app: &AppHandle,
    download_id: &str,
    staging_path: &str,
) -> Result<(PathBuf, PathBuf), String> {
    uuid::Uuid::parse_str(download_id).map_err(|_| "Invalid Browser download id".to_string())?;
    let staging_root = std::fs::canonicalize(browser_download_staging_dir(app)?)
        .map_err(|error| error.to_string())?;
    let path = Path::new(staging_path);
    if !path.is_absolute()
        || path.file_name().is_none()
        || path.parent().and_then(Path::file_name).and_then(|name| name.to_str()) != Some(download_id)
    {
        return Err("Invalid Browser download staging path".to_string());
    }
    let parent = std::fs::canonicalize(path.parent().ok_or_else(|| "Invalid Browser staging path".to_string())?)
        .map_err(|error| error.to_string())?;
    if parent.parent() != Some(staging_root.as_path())
        || parent.file_name().and_then(|name| name.to_str()) != Some(download_id)
    {
        return Err("Browser download staging file is outside its managed directory".to_string());
    }
    Ok((path.to_path_buf(), parent))
}

fn resolve_browser_staged_download(
    app: &AppHandle,
    download_id: &str,
    staging_path: &str,
) -> Result<PathBuf, String> {
    let (path, staging_dir) = validate_browser_staged_path(app, download_id, staging_path)?;
    let resolved = std::fs::canonicalize(path).map_err(|error| error.to_string())?;
    if resolved.parent() != Some(staging_dir.as_path()) || !resolved.is_file() {
        return Err("Browser download staging file is outside its managed directory".to_string());
    }
    Ok(resolved)
}

fn resolve_browser_download_destination_folder(folder: &str) -> Result<PathBuf, String> {
    let input = Path::new(folder);
    if input
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("Download destination must not contain '..'".to_string());
    }
    let candidate = if input.is_absolute() {
        input.to_path_buf()
    } else {
        dirs::home_dir()
            .ok_or_else(|| "Unable to locate the current user's home directory".to_string())?
            .join(input)
    };
    let resolved = std::fs::canonicalize(&candidate).map_err(|error| error.to_string())?;
    if !resolved.is_dir() {
        return Err("The selected download destination is not a folder".to_string());
    }
    Ok(resolved)
}

fn unique_browser_download_destination(requested: &Path) -> Result<PathBuf, String> {
    let name = requested
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Invalid Browser download filename".to_string())?;
    let mut candidate = requested.to_path_buf();
    let mut attempt = 1;
    while candidate.exists() {
        let path = Path::new(name);
        let stem = path.file_stem().and_then(|value| value.to_str()).unwrap_or("download");
        let extension = path.extension().and_then(|value| value.to_str());
        let next_name = match extension {
            Some(extension) => format!("{stem}_({attempt}).{extension}"),
            None => format!("{stem}_({attempt})"),
        };
        candidate = requested
            .parent()
            .ok_or_else(|| "Invalid Browser download destination".to_string())?
            .join(next_name);
        attempt += 1;
    }
    Ok(candidate)
}

#[tauri::command]
pub async fn browser_save_download(
    app: AppHandle,
    webview: Webview,
    download_id: String,
    staging_path: String,
    destination_folder: Option<String>,
    selected_path: Option<String>,
) -> Result<BrowserDownloadSaveResult, String> {
    require_main_webview(&webview)?;
    let staged = resolve_browser_staged_download(&app, &download_id, &staging_path)?;
    let suggested_name = staged
        .file_name()
        .and_then(|name| name.to_str())
        .map(safe_browser_download_name)
        .unwrap_or_else(|| "download.bin".to_string());

    let requested = if let Some(selected_path) = selected_path {
        let selected = PathBuf::from(selected_path);
        if !selected.is_absolute() || selected.file_name().is_none() {
            return Err("Choose a valid local download filename".to_string());
        }
        let parent = selected
            .parent()
            .ok_or_else(|| "Invalid local download destination".to_string())?;
        let parent = std::fs::canonicalize(parent).map_err(|error| error.to_string())?;
        parent.join(safe_browser_download_name(
            selected.file_name().and_then(|name| name.to_str()).unwrap_or(&suggested_name),
        ))
    } else {
        let folder = destination_folder
            .ok_or_else(|| "Choose a local download destination".to_string())?;
        resolve_browser_download_destination_folder(&folder)?.join(suggested_name)
    };
    let destination = unique_browser_download_destination(&requested)?;
    let name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Invalid Browser download filename".to_string())?;
    let temporary = destination
        .parent()
        .ok_or_else(|| "Invalid Browser download destination".to_string())?
        .join(format!(".{name}.{}.part", uuid::Uuid::new_v4()));

    if let Err(error) = std::fs::copy(&staged, &temporary) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    if let Err(error) = std::fs::rename(&temporary, &destination) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    let cleanup_warning = std::fs::remove_file(&staged)
        .err()
        .or_else(|| staged.parent().and_then(|parent| std::fs::remove_dir(parent).err()))
        .map(|error| format!("The temporary copy could not be removed: {error}"));
    Ok(BrowserDownloadSaveResult {
        path: destination.display().to_string(),
        cleanup_warning,
    })
}

#[tauri::command]
pub async fn browser_discard_download(
    app: AppHandle,
    webview: Webview,
    download_id: String,
    staging_path: String,
) -> Result<(), String> {
    require_main_webview(&webview)?;
    let (staged, staging_dir) = validate_browser_staged_path(&app, &download_id, &staging_path)?;
    if !staged.exists() {
        if let Some(parent) = staged.parent() {
            let _ = std::fs::remove_dir(parent);
        }
        return Ok(());
    }
    let resolved = std::fs::canonicalize(&staged).map_err(|error| error.to_string())?;
    if resolved.parent() != Some(staging_dir.as_path()) || !resolved.is_file() {
        return Err("Browser download staging file is outside its managed directory".to_string());
    }
    std::fs::remove_file(&resolved).map_err(|error| error.to_string())?;
    if let Some(parent) = resolved.parent() {
        let _ = std::fs::remove_dir(parent);
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_destroy(
    app: AppHandle,
    webview: Webview,
    pane_id: String,
) -> Result<(), String> {
    require_main_webview(&webview)?;
    #[cfg(windows)]
    {
        let label = browser_view_label(&pane_id)?;
        if let Some(view) = app.get_webview(&label) {
            close_browser_view(view, &label).await?;
        } else {
            restore_missing_browser_view(&webview, &label)?;
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, pane_id);
        Err("Browser panes are supported only on Windows".to_string())
    }
}

#[tauri::command]
pub async fn browser_cleanup_stale(app: AppHandle, webview: Webview) -> Result<(), String> {
    require_main_webview(&webview)?;
    #[cfg(windows)]
    {
        for (label, view) in app.webviews() {
            if label.starts_with(BROWSER_VIEW_PREFIX) {
                close_browser_view(view, &label).await?;
            }
        }
        let recovery_labels = browser_fullscreen_recoveries()
            .lock()
            .map_err(|error| error.to_string())?
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for label in recovery_labels {
            if app.get_webview(&label).is_none() {
                restore_missing_browser_view(&webview, &label)?;
            }
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("Browser panes are supported only on Windows".to_string())
    }
}

#[cfg(windows)]
async fn run_core_command(view: Webview, action: String) -> Result<(), String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    view.with_webview(move |platform| {
        let operation = (|| unsafe {
            let core = platform
                .controller()
                .CoreWebView2()
                .map_err(|error| error.to_string())?;
            match action.as_str() {
                "back" => core.GoBack().map_err(|error| error.to_string()),
                "forward" => core.GoForward().map_err(|error| error.to_string()),
                "stop" => core.Stop().map_err(|error| error.to_string()),
                _ => Err("Invalid browser action".to_string()),
            }
        })();
        let _ = sender.send(operation);
    })
    .map_err(|error| error.to_string())?;
    receiver
        .await
        .map_err(|_| "Browser command did not complete".to_string())?
}

#[cfg(test)]
mod tests {
    use super::{
        browser_view_label, capped_content_lengths, child_frame_transform,
        collect_browser_frame_tree, map_browser_bounds_to_physical, next_scroll_position,
        parse_web_url, region_placements, region_placements_scaled, safe_browser_download_name,
        select_scroll_candidate, tile_positions, unique_browser_download_destination,
        BrowserBounds, BrowserFrameTransform, BrowserPhysicalBounds, ScrollCandidate,
    };

    fn css_bounds(x: f64, y: f64, width: f64, height: f64, dpr: f64) -> BrowserBounds {
        BrowserBounds {
            x,
            y,
            width,
            height,
            device_pixel_ratio: dpr,
        }
    }

    #[test]
    fn browser_view_labels_only_accept_canonical_positive_pane_ids() {
        assert_eq!(
            browser_view_label("browser:1").unwrap(),
            "browser-content-1"
        );
        assert_eq!(
            browser_view_label("browser:28").unwrap(),
            "browser-content-28"
        );
        for invalid in [
            "browser:0",
            "browser:01",
            "browser:x",
            "ssh:a#1",
            "browser:1/other",
        ] {
            assert!(browser_view_label(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn browser_navigation_accepts_only_http_https_and_initial_blank() {
        assert_eq!(
            parse_web_url("https://example.com/path", false)
                .unwrap()
                .scheme(),
            "https"
        );
        assert_eq!(
            parse_web_url("http://localhost:9443", false)
                .unwrap()
                .scheme(),
            "http"
        );
        assert_eq!(
            parse_web_url("about:blank", true).unwrap().as_str(),
            "about:blank"
        );
        for invalid in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "ftp://example.com",
            "about:blank",
        ] {
            assert!(parse_web_url(invalid, false).is_err(), "{invalid}");
        }
    }

    #[test]
    fn browser_download_names_are_leaf_only_and_safe_for_windows_paths() {
        assert_eq!(safe_browser_download_name("C:\\temp\\report.pdf"), "report.pdf");
        assert_eq!(safe_browser_download_name("../folder/unsafe:name?.zip"), "unsafe_name_.zip");
        assert_eq!(safe_browser_download_name("... "), "download.bin");
        assert_eq!(safe_browser_download_name("CON.txt"), "_CON.txt");
    }

    #[test]
    fn browser_download_destination_keeps_existing_files_and_uses_a_unique_name() {
        let directory = std::env::temp_dir().join(format!(
            "nfterm-browser-download-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let requested = directory.join("report.pdf");
        std::fs::write(&requested, b"existing").unwrap();
        let selected = unique_browser_download_destination(&requested).unwrap();
        assert_eq!(
            selected.file_name().and_then(|name| name.to_str()),
            Some("report_(1).pdf")
        );
        assert_eq!(std::fs::read(&requested).unwrap(), b"existing");
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn browser_css_bounds_map_to_physical_pixels_at_common_display_scales() {
        // 100%: physical values equal CSS values.
        assert_eq!(
            map_browser_bounds_to_physical(&css_bounds(55.0, 114.0, 1225.0, 506.0, 1.0)).unwrap(),
            BrowserPhysicalBounds { x: 55, y: 114, width: 1225, height: 506 }
        );
        // 125%: the issue #264 pane (1225 x 506 CSS px) must become 1532 x 633
        // physical px, not stay 1225 x 506 (80% of the pane).
        assert_eq!(
            map_browser_bounds_to_physical(&css_bounds(55.0, 114.0, 1225.0, 506.0, 1.25)).unwrap(),
            BrowserPhysicalBounds { x: 68, y: 142, width: 1532, height: 633 }
        );
        // 150%
        assert_eq!(
            map_browser_bounds_to_physical(&css_bounds(10.0, 20.0, 100.0, 50.0, 1.5)).unwrap(),
            BrowserPhysicalBounds { x: 15, y: 30, width: 150, height: 75 }
        );
    }

    #[test]
    fn browser_physical_bounds_never_leave_a_gap_on_fractional_edges() {
        // left/top floor, right/bottom ceil: 10.3*1.25=12.875 -> 12, (10.3+100.2)*1.25=138.125 -> 139.
        assert_eq!(
            map_browser_bounds_to_physical(&css_bounds(10.3, 20.5, 100.2, 40.1, 1.25)).unwrap(),
            BrowserPhysicalBounds { x: 12, y: 25, width: 127, height: 51 }
        );
        // Origin is 0 and the window-relative position is not offset by screen coordinates.
        let at_origin = map_browser_bounds_to_physical(&css_bounds(0.0, 0.0, 200.0, 100.0, 1.25)).unwrap();
        assert_eq!((at_origin.x, at_origin.y), (0, 0));
    }

    #[test]
    fn browser_physical_bounds_reject_invalid_input() {
        for bounds in [
            css_bounds(f64::NAN, 0.0, 10.0, 10.0, 1.25),
            css_bounds(0.0, f64::INFINITY, 10.0, 10.0, 1.25),
            css_bounds(0.0, 0.0, 0.0, 10.0, 1.25),
            css_bounds(0.0, 0.0, 10.0, -1.0, 1.25),
            css_bounds(0.0, 0.0, 10.0, 10.0, 0.0),
            css_bounds(0.0, 0.0, 10.0, 10.0, f64::NAN),
            css_bounds(1.0e12, 0.0, 10.0, 10.0, 1.25),
        ] {
            assert!(map_browser_bounds_to_physical(&bounds).is_err());
        }
    }

    #[test]
    fn screenshot_tiles_cover_the_page_using_viewport_sized_steps() {
        assert_eq!(tile_positions(700.0, 1000.0), vec![0.0]);
        assert_eq!(tile_positions(2000.0, 1000.0), vec![0.0, 1000.0]);
        assert_eq!(tile_positions(2400.0, 1000.0), vec![0.0, 1000.0, 1400.0]);

        for (total, viewport) in [(2400.0, 1000.0), (4097.0, 1024.0), (16000.0, 700.0)] {
            let positions = tile_positions(total, viewport);
            assert_eq!(positions.first(), Some(&0.0));
            assert!(positions.windows(2).all(|pair| pair[1] > pair[0]));
            assert!(positions
                .windows(2)
                .all(|pair| pair[0] + viewport >= pair[1]));
            assert!(positions
                .last()
                .is_some_and(|last| last + viewport >= total));
        }
    }

    #[test]
    fn screenshot_frame_tree_keeps_nested_parent_relationships() {
        let tree = serde_json::json!({
            "frame": { "id": "root" },
            "childFrames": [
                {
                    "frame": { "id": "child-a" },
                    "childFrames": [{ "frame": { "id": "grandchild-a1" } }]
                },
                { "frame": { "id": "child-b" } }
            ]
        });
        let mut frames = Vec::new();
        collect_browser_frame_tree(&tree, None, &mut frames).unwrap();

        assert_eq!(
            frames,
            vec![
                ("root".to_string(), None),
                ("child-a".to_string(), Some("root".to_string())),
                ("grandchild-a1".to_string(), Some("child-a".to_string())),
                ("child-b".to_string(), Some("root".to_string())),
            ]
        );
    }

    fn candidate(
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        content_width: f64,
        content_height: f64,
    ) -> ScrollCandidate {
        ScrollCandidate {
            frame_index: 0,
            execution_context_id: 1,
            index: 0,
            x,
            y,
            width,
            height,
            content_width,
            content_height,
            scrollbar_width: 0.0,
            scrollbar_height: 0.0,
            scroll_width: width,
            scroll_height: height,
            scale_x: 1.0,
            scale_y: 1.0,
            description: "test".to_string(),
        }
    }

    #[test]
    fn nested_frame_transform_maps_origin_and_scaled_content_to_the_root_viewport() {
        let parent = BrowserFrameTransform {
            x: 100.0,
            y: 40.0,
            scale_x: 2.0,
            scale_y: 1.5,
        };
        let child = child_frame_transform(parent, 20.0, 30.0, 200.0, 150.0, 400.0, 300.0).unwrap();

        assert_eq!(
            child,
            BrowserFrameTransform {
                x: 140.0,
                y: 85.0,
                scale_x: 1.0,
                scale_y: 0.75
            }
        );
        assert_eq!(child.point(10.0, 20.0), (150.0, 100.0));
        assert_eq!(child.size(80.0, 40.0), (80.0, 30.0));
        assert!(child_frame_transform(parent, 0.0, 0.0, 200.0, 150.0, 0.0, 300.0).is_none());
    }

    #[test]
    fn scroll_region_selection_prefers_the_area_hiding_the_most_content() {
        let candidates = vec![
            // The page itself scrolls by 10 px only.
            candidate(0.0, 0.0, 1000.0, 700.0, 1000.0, 710.0),
            // The log table hides thousands of pixels.
            candidate(200.0, 100.0, 800.0, 500.0, 800.0, 3000.0),
            // Hides more content but is partly outside the viewport.
            candidate(200.0, 400.0, 800.0, 500.0, 800.0, 90000.0),
            // Does not overflow at all.
            candidate(0.0, 0.0, 1000.0, 700.0, 1000.0, 700.0),
            // Too small to be the main content.
            candidate(10.0, 10.0, 20.0, 20.0, 20.0, 5000.0),
        ];
        assert_eq!(select_scroll_candidate(&candidates, 1000.0, 700.0), Some(1));
        assert_eq!(
            select_scroll_candidate(&candidates[3..], 1000.0, 700.0),
            None
        );
        assert_eq!(select_scroll_candidate(&[], 1000.0, 700.0), None);
    }

    #[test]
    fn next_scroll_position_walks_to_the_end_and_follows_growing_content() {
        assert_eq!(next_scroll_position(0.0, 600.0, 2000.0, 600.0), Some(600.0));
        assert_eq!(
            next_scroll_position(600.0, 600.0, 2000.0, 600.0),
            Some(1200.0)
        );
        // The last step is clamped to the end of the content.
        assert_eq!(
            next_scroll_position(1200.0, 600.0, 2000.0, 600.0),
            Some(1400.0)
        );
        assert_eq!(next_scroll_position(1400.0, 600.0, 2000.0, 600.0), None);
        // Content that fits needs no scrolling.
        assert_eq!(next_scroll_position(0.0, 600.0, 500.0, 600.0), None);

        // A log that loads more rows while scrolling: 3000 px grows to 5000 px.
        let mut positions = vec![0.0];
        loop {
            let content = if positions.len() >= 3 { 5000.0 } else { 3000.0 };
            match next_scroll_position(*positions.last().unwrap(), 600.0, content, 600.0) {
                Some(next) => positions.push(next),
                None => break,
            }
            assert!(positions.len() < 100);
        }
        assert_eq!(positions.last(), Some(&4400.0));
        let placements = region_placements(
            &positions.iter().map(|top| (0.0, *top)).collect::<Vec<_>>(),
            800.0,
            600.0,
            800.0,
            5000.0,
        );
        // Every pixel row of the content is covered by at least one tile.
        let mut covered_until = 0.0;
        for placement in &placements {
            assert!(placement.dst_y <= covered_until);
            covered_until = f64::max(covered_until, placement.dst_y + placement.height);
        }
        assert_eq!(covered_until, 5000.0);
    }

    #[test]
    fn region_placements_clip_to_the_content_and_skip_empty_tiles() {
        let placements = region_placements(
            &[(0.0, 0.0), (0.0, 600.0), (300.0, 1400.0), (0.0, 9000.0)],
            800.0,
            600.0,
            1000.0,
            2000.0,
        );
        assert_eq!(placements.len(), 3);
        assert_eq!((placements[0].width, placements[0].height), (800.0, 600.0));
        // Scrolled 300 px to the right: only 700 px of content remain.
        assert_eq!((placements[2].width, placements[2].height), (700.0, 600.0));
        assert_eq!((placements[2].dst_x, placements[2].dst_y), (300.0, 1400.0));
    }

    #[test]
    fn scaled_region_placements_map_scroll_offsets_and_partial_tiles_to_display_pixels() {
        let placements = region_placements_scaled(
            &[(0.0, 0.0), (30.0, 40.0), (50.0, 70.0)],
            120.0,
            80.0,
            170.0,
            135.0,
            2.0,
            1.5,
        );

        assert_eq!(placements.len(), 3);
        assert_eq!((placements[1].dst_x, placements[1].dst_y), (60.0, 60.0));
        assert_eq!((placements[1].width, placements[1].height), (110.0, 75.0));
        assert_eq!((placements[2].dst_x, placements[2].dst_y), (100.0, 105.0));
        assert_eq!((placements[2].width, placements[2].height), (70.0, 30.0));
    }

    #[test]
    fn capped_content_lengths_respect_dimension_and_pixel_limits() {
        // Fits: nothing is cut off.
        assert_eq!(
            capped_content_lengths(200.0, 200.0, 800.0, 500.0, 800.0, 3000.0, 1.0),
            (800.0, 3000.0, false)
        );
        // Too tall at 100% scale: page height is capped at 16,000 px.
        let (_, height, truncated) =
            capped_content_lengths(200.0, 200.0, 800.0, 500.0, 800.0, 90000.0, 1.0);
        assert!(truncated);
        assert_eq!(height + 200.0, 16000.0);
        // At 125% scaling the same limit applies to device pixels.
        let (_, height, truncated) =
            capped_content_lengths(200.0, 200.0, 800.0, 500.0, 800.0, 90000.0, 1.25);
        assert!(truncated);
        assert!((height + 200.0) * 1.25 <= 16000.0);
        // Wide pages are limited by the 40 million pixel budget.
        let (width, height, _) =
            capped_content_lengths(0.0, 0.0, 1000.0, 700.0, 8000.0, 90000.0, 1.0);
        assert_eq!(width, 8000.0);
        assert!(width * height <= 40_000_000.0);
        // Never smaller than the visible region.
        let (width, height, _) = capped_content_lengths(0.0, 0.0, 1000.0, 700.0, 10.0, 10.0, 1.0);
        assert_eq!((width, height), (1000.0, 700.0));
    }
}
