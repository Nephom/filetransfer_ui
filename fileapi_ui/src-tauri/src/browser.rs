use serde::{Deserialize, Serialize};
#[cfg(windows)]
use std::collections::HashMap;
use tauri::webview::Webview;
#[cfg(windows)]
use tauri::Emitter;
use tauri::{AppHandle, Manager};

#[cfg(windows)]
use webview2_com::{CallDevToolsProtocolMethodCompletedHandler, CoTaskMemPWSTR};

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
const BROWSER_VIEW_PREFIX: &str = "browser-content-";

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
        let builder = WebviewBuilder::new(label, tauri::WebviewUrl::External(url))
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
            });

        let parent = webview.window();
        let child = parent
            .add_child(
                builder,
                PhysicalPosition::new(native_bounds.x, native_bounds.y),
                PhysicalSize::new(native_bounds.width, native_bounds.height),
            )
            .map_err(|error| error.to_string())?;
        if !visible {
            child.hide().map_err(|error| error.to_string())?;
        }
        let actual = read_browser_native_bounds(&child)?;
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
        run_core_command(get_browser_webview(&app, &pane_id)?, direction)
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
        run_core_command(get_browser_webview(&app, &pane_id)?, "stop".to_string())
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
        let history = std::sync::Arc::new(std::sync::Mutex::new(None));
        let history_result = history.clone();
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
            if let Ok(mut slot) = history_result.lock() {
                *slot = Some(result);
            }
        })
        .map_err(|error| error.to_string())?;
        let (can_go_back, can_go_forward) = history
            .lock()
            .map_err(|error| error.to_string())?
            .take()
            .ok_or_else(|| "Unable to read browser history state".to_string())??;
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
    description: String,
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
    scroll_offsets
        .iter()
        .enumerate()
        .filter_map(|(tile, (scroll_x, scroll_y))| {
            let width = (content_width - scroll_x).min(region_width);
            let height = (content_height - scroll_y).min(region_height);
            if width <= 0.0 || height <= 0.0 {
                None
            } else {
                Some(BrowserScreenshotPlacement {
                    tile,
                    dst_x: *scroll_x,
                    dst_y: *scroll_y,
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
    candidates.push({
      kind: 'element', element, allowX, allowY,
      x: rect.left + element.clientLeft, y: rect.top + element.clientTop,
      width: element.clientWidth, height: element.clientHeight,
      scrollbarWidth: Math.max(0, Math.round(rect.width - element.clientWidth - border('borderLeftWidth') - border('borderRightWidth'))),
      scrollbarHeight: Math.max(0, Math.round(rect.height - element.clientHeight - border('borderTopWidth') - border('borderBottomWidth'))),
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
      contentWidth: candidate.allowX ? element.scrollWidth : element.clientWidth,
      contentHeight: candidate.allowY ? element.scrollHeight : element.clientHeight,
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
        content_width: json_number(value, "contentWidth")?,
        content_height: json_number(value, "contentHeight")?,
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

    let mut known: HashMap<String, (i64, (f64, f64))> = HashMap::new();
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
            Ok((context_id, offset, viewport, found)) => {
                known.insert(frame_id.clone(), (context_id, offset));
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
    parent: Option<(i64, (f64, f64))>,
    cleanup: &mut ScreenshotCleanup,
) -> Result<(i64, (f64, f64), BrowserViewport, Vec<ScrollCandidate>), String> {
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

    let offset = match parent {
        None => (0.0, 0.0),
        Some((parent_context_id, parent_offset)) => {
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
                "function() { const rect = this.getBoundingClientRect(); const style = getComputedStyle(this); return { x: rect.left + this.clientLeft + (parseFloat(style.paddingLeft) || 0), y: rect.top + this.clientTop + (parseFloat(style.paddingTop) || 0) }; }",
            )
            .await?;
            (
                parent_offset.0 + json_number(&origin, "x")?,
                parent_offset.1 + json_number(&origin, "y")?,
            )
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

    let mut found = Vec::new();
    if let Some(items) = inspected
        .get("candidates")
        .and_then(serde_json::Value::as_array)
    {
        for item in items {
            found.push(ScrollCandidate {
                frame_index,
                execution_context_id: context_id,
                index: json_number(item, "index")? as usize,
                x: json_number(item, "x")? + offset.0,
                y: json_number(item, "y")? + offset.1,
                width: json_number(item, "width")?,
                height: json_number(item, "height")?,
                content_width: json_number(item, "contentWidth")?,
                content_height: json_number(item, "contentHeight")?,
                scrollbar_width: json_number(item, "scrollbarWidth")?,
                scrollbar_height: json_number(item, "scrollbarHeight")?,
                description: item
                    .get("description")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("scrolling area")
                    .to_string(),
            });
        }
    }
    Ok((context_id, offset, viewport, found))
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
            metrics.content_width,
            metrics.content_height,
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
        for x in tile_positions(content_width, candidate.width) {
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
            candidate.height,
            content_height,
            candidate.height,
        ) {
            Some(next) => row_top = next,
            None => break,
        }
    }

    let (content_width, content_height, capped) = cap(&metrics);
    let placements = region_placements(
        &offsets,
        candidate.width,
        candidate.height,
        content_width,
        content_height,
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
            view.close().map_err(|error| error.to_string())?;
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
                view.close().map_err(|error| error.to_string())?;
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
fn run_core_command(view: Webview, action: String) -> Result<(), String> {
    let result = std::sync::Arc::new(std::sync::Mutex::new(None));
    let result_from_main_thread = result.clone();
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
        if let Ok(mut slot) = result_from_main_thread.lock() {
            *slot = Some(operation);
        }
    })
    .map_err(|error| error.to_string())?;
    let operation = result
        .lock()
        .map_err(|error| error.to_string())?
        .take()
        .ok_or_else(|| "Browser command did not complete".to_string())?;
    operation
}

#[cfg(test)]
mod tests {
    use super::{
        browser_view_label, capped_content_lengths, collect_browser_frame_tree,
        map_browser_bounds_to_physical, next_scroll_position, parse_web_url, region_placements,
        select_scroll_candidate, tile_positions, BrowserBounds, BrowserPhysicalBounds,
        ScrollCandidate,
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
            description: "test".to_string(),
        }
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
