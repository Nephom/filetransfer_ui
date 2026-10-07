use serde::{Deserialize, Serialize};
#[cfg(windows)]
use std::collections::HashMap;
use tauri::webview::Webview;
#[cfg(windows)]
use tauri::Emitter;
use tauri::{AppHandle, Manager};

#[cfg(windows)]
use webview2_com::{CallDevToolsProtocolMethodCompletedHandler, CoTaskMemPWSTR};

#[cfg(windows)]
const MAX_SCREENSHOT_DIMENSION: f64 = 16_000.0;
#[cfg(windows)]
const MAX_SCREENSHOT_PIXELS: f64 = 40_000_000.0;
#[cfg(windows)]
const MAX_SCREENSHOT_TILES: usize = 4_096;
#[cfg(windows)]
const MAX_SCREENSHOT_FRAMES: usize = 128;
#[cfg(windows)]
const MAX_SCREENSHOT_SCROLL_CONTAINERS: usize = 512;
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserScreenshotTile {
    pub x: f64,
    pub y: f64,
    pub viewport_width: f64,
    pub viewport_height: f64,
    pub data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserScreenshotCapture {
    pub page_width: f64,
    pub page_height: f64,
    pub viewport_width: f64,
    pub viewport_height: f64,
    pub tiles: Vec<BrowserScreenshotTile>,
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
        let mut frame_scroll_positions = Vec::new();
        let mut expanded_scroll_containers = Vec::new();
        let mut expanded_frames = Vec::new();
        let preparation = prepare_browser_screenshot_frames(
            view.clone(),
            &mut frame_scroll_positions,
            &mut expanded_scroll_containers,
            &mut expanded_frames,
        )
        .await;
        let capture_result = match preparation {
            Ok(root_context_id) => match read_browser_page_metrics(view.clone(), root_context_id)
                .await
            {
                Ok(metrics) => {
                    match validate_browser_screenshot_size(metrics.page_width, metrics.page_height)
                    {
                        Ok(()) => {
                            capture_browser_page_tiles(view.clone(), root_context_id, metrics).await
                        }
                        Err(error) => Err(error),
                    }
                }
                Err(error) => Err(error),
            },
            Err(error) => Err(error),
        };
        let restore_result = restore_browser_screenshot_frames(
            view,
            expanded_frames,
            expanded_scroll_containers,
            frame_scroll_positions,
        )
        .await;

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

#[cfg(windows)]
#[derive(Clone, Copy)]
struct BrowserPageMetrics {
    page_width: f64,
    page_height: f64,
    viewport_width: f64,
    viewport_height: f64,
    scroll_x: f64,
    scroll_y: f64,
}

#[cfg(windows)]
#[derive(Clone)]
struct BrowserFrameContext {
    frame_id: String,
    parent_frame_id: Option<String>,
    execution_context_id: i64,
}

#[cfg(windows)]
#[derive(Clone, Copy)]
struct BrowserFrameScrollPosition {
    execution_context_id: i64,
    x: f64,
    y: f64,
}

#[cfg(windows)]
#[derive(Clone, Copy)]
struct BrowserScrollContainerState {
    execution_context_id: i64,
}

#[cfg(windows)]
struct ExpandedBrowserFrame {
    object_id: String,
    original_width: String,
    original_width_priority: String,
    original_height: String,
    original_priority: String,
    original_max_width: String,
    original_max_width_priority: String,
    original_max_height: String,
    original_max_height_priority: String,
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

#[cfg(windows)]
async fn prepare_browser_screenshot_frames(
    view: Webview,
    scroll_positions: &mut Vec<BrowserFrameScrollPosition>,
    expanded_scroll_containers: &mut Vec<BrowserScrollContainerState>,
    expanded_frames: &mut Vec<ExpandedBrowserFrame>,
) -> Result<i64, String> {
    let tree = browser_devtools_json(view.clone(), "Page.getFrameTree", "{}".to_string()).await?;
    let tree = tree
        .get("frameTree")
        .ok_or_else(|| "The browser did not return its frame tree".to_string())?;
    let mut frame_ids = Vec::new();
    collect_browser_frame_tree(tree, None, &mut frame_ids)?;
    if frame_ids.is_empty() || frame_ids.len() > MAX_SCREENSHOT_FRAMES {
        return Err("The page has too many nested frames to capture safely".to_string());
    }

    let mut contexts = Vec::with_capacity(frame_ids.len());
    let mut context_by_frame = HashMap::with_capacity(frame_ids.len());
    for (index, (frame_id, parent_frame_id)) in frame_ids.into_iter().enumerate() {
        let world_name = format!("nfterm-screenshot-frame-{index}");
        let response = browser_devtools_json(
            view.clone(),
            "Page.createIsolatedWorld",
            serde_json::json!({ "frameId": frame_id, "worldName": world_name }).to_string(),
        )
        .await?;
        let execution_context_id = response
            .get("executionContextId")
            .and_then(serde_json::Value::as_i64)
            .ok_or_else(|| "The browser could not create a frame execution context".to_string())?;
        context_by_frame.insert(frame_id.clone(), execution_context_id);
        contexts.push(BrowserFrameContext {
            frame_id,
            parent_frame_id,
            execution_context_id,
        });
    }

    for context in &contexts {
        let metrics = read_browser_page_metrics(view.clone(), context.execution_context_id).await?;
        validate_browser_screenshot_size(metrics.page_width, metrics.page_height)?;
        scroll_positions.push(BrowserFrameScrollPosition {
            execution_context_id: context.execution_context_id,
            x: metrics.scroll_x,
            y: metrics.scroll_y,
        });
    }

    // Put every frame at its content origin before resizing iframe owners. This
    // keeps the screenshot aligned while nested frames are temporarily expanded.
    for context in &contexts {
        set_browser_scroll_position(view.clone(), context.execution_context_id, 0.0, 0.0).await?;
    }

    // Child frames are processed before parents so a parent frame's measured
    // document height already includes any expanded descendants.
    for context in contexts.iter().rev() {
        expanded_scroll_containers.push(BrowserScrollContainerState {
            execution_context_id: context.execution_context_id,
        });
        expand_browser_scroll_containers(view.clone(), context.execution_context_id).await?;
        let Some(parent_frame_id) = context.parent_frame_id.as_ref() else {
            continue;
        };
        let metrics = read_browser_page_metrics(view.clone(), context.execution_context_id).await?;
        validate_browser_screenshot_size(metrics.page_width, metrics.page_height)?;
        if metrics.page_width <= metrics.viewport_width + 1.0
            && metrics.page_height <= metrics.viewport_height + 1.0
        {
            continue;
        }
        let parent_context_id = *context_by_frame
            .get(parent_frame_id)
            .ok_or_else(|| "The browser frame tree has a missing parent".to_string())?;
        let owner = browser_devtools_json(
            view.clone(),
            "DOM.getFrameOwner",
            serde_json::json!({ "frameId": context.frame_id }).to_string(),
        )
        .await?;
        let backend_node_id = owner
            .get("backendNodeId")
            .and_then(serde_json::Value::as_i64)
            .ok_or_else(|| "The browser could not locate an iframe owner element".to_string())?;
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
            .ok_or_else(|| "The browser could not resolve an iframe owner element".to_string())?
            .to_string();
        let original = call_browser_remote_object(
            view.clone(),
            &object_id,
            "function() { return { width: this.style.getPropertyValue('width'), widthPriority: this.style.getPropertyPriority('width'), height: this.style.getPropertyValue('height'), heightPriority: this.style.getPropertyPriority('height'), maxWidth: this.style.getPropertyValue('max-width'), maxWidthPriority: this.style.getPropertyPriority('max-width'), maxHeight: this.style.getPropertyValue('max-height'), maxHeightPriority: this.style.getPropertyPriority('max-height') }; }",
            Vec::new(),
        )
        .await?;
        let expansion = ExpandedBrowserFrame {
            object_id: object_id.clone(),
            original_width: original
                .get("width")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_string(),
            original_width_priority: original
                .get("widthPriority")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_string(),
            original_height: original
                .get("height")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_string(),
            original_priority: original
                .get("heightPriority")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_string(),
            original_max_width: original
                .get("maxWidth")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_string(),
            original_max_width_priority: original
                .get("maxWidthPriority")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_string(),
            original_max_height: original
                .get("maxHeight")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_string(),
            original_max_height_priority: original
                .get("maxHeightPriority")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_string(),
        };
        // Keep restoration information before mutating the live DOM so any
        // subsequent DevTools error still restores this iframe's original style.
        expanded_frames.push(expansion);
        let mut resized_metrics = metrics;
        for attempt in 0..3 {
            let expand_width = resized_metrics.page_width > resized_metrics.viewport_width + 1.0;
            let expand_height = resized_metrics.page_height > resized_metrics.viewport_height + 1.0;
            if !expand_width && !expand_height {
                break;
            }
            call_browser_remote_object(
                view.clone(),
                &object_id,
                "function(width, height) { if (width !== null) { this.style.setProperty('width', `${width}px`, 'important'); this.style.setProperty('max-width', 'none', 'important'); } if (height !== null) { this.style.setProperty('height', `${height}px`, 'important'); this.style.setProperty('max-height', 'none', 'important'); } return true; }",
                vec![
                    if expand_width {
                        serde_json::json!({ "value": resized_metrics.page_width.ceil() })
                    } else {
                        serde_json::json!({ "value": null })
                    },
                    if expand_height {
                        serde_json::json!({ "value": resized_metrics.page_height.ceil() })
                    } else {
                        serde_json::json!({ "value": null })
                    },
                ],
            )
            .await?;
            wait_browser_frame_layout(view.clone(), context.execution_context_id).await?;
            wait_browser_frame_layout(view.clone(), parent_context_id).await?;
            resized_metrics =
                read_browser_page_metrics(view.clone(), context.execution_context_id).await?;
            validate_browser_screenshot_size(
                resized_metrics.page_width,
                resized_metrics.page_height,
            )?;
            if attempt == 2
                && (resized_metrics.page_width > resized_metrics.viewport_width + 1.0
                    || resized_metrics.page_height > resized_metrics.viewport_height + 1.0)
            {
                return Err(
                    "An iframe still has overflowing content after expanding its frame".to_string(),
                );
            }
        }
    }

    contexts
        .first()
        .map(|root| root.execution_context_id)
        .ok_or_else(|| "The browser did not return a root frame".to_string())
}

#[cfg(windows)]
async fn restore_browser_screenshot_frames(
    view: Webview,
    expanded_frames: Vec<ExpandedBrowserFrame>,
    expanded_scroll_containers: Vec<BrowserScrollContainerState>,
    scroll_positions: Vec<BrowserFrameScrollPosition>,
) -> Result<(), String> {
    let mut errors = Vec::new();
    for frame in expanded_frames.iter().rev() {
        if let Err(error) = call_browser_remote_object(
            view.clone(),
            &frame.object_id,
            "function(width, widthPriority, height, heightPriority, maxWidth, maxWidthPriority, maxHeight, maxHeightPriority) { if (width) this.style.setProperty('width', width, widthPriority); else this.style.removeProperty('width'); if (height) this.style.setProperty('height', height, heightPriority); else this.style.removeProperty('height'); if (maxWidth) this.style.setProperty('max-width', maxWidth, maxWidthPriority); else this.style.removeProperty('max-width'); if (maxHeight) this.style.setProperty('max-height', maxHeight, maxHeightPriority); else this.style.removeProperty('max-height'); return true; }",
            vec![
                serde_json::json!({ "value": frame.original_width }),
                serde_json::json!({ "value": frame.original_width_priority }),
                serde_json::json!({ "value": frame.original_height }),
                serde_json::json!({ "value": frame.original_priority }),
                serde_json::json!({ "value": frame.original_max_width }),
                serde_json::json!({ "value": frame.original_max_width_priority }),
                serde_json::json!({ "value": frame.original_max_height }),
                serde_json::json!({ "value": frame.original_max_height_priority }),
            ],
        )
        .await
        {
            errors.push(format!("Unable to restore an iframe's original size: {error}"));
        }
        let _ = browser_devtools_json(
            view.clone(),
            "Runtime.releaseObject",
            serde_json::json!({ "objectId": frame.object_id }).to_string(),
        )
        .await;
    }

    for container in expanded_scroll_containers.iter().rev() {
        if let Err(error) =
            restore_browser_scroll_containers(view.clone(), container.execution_context_id).await
        {
            errors.push(format!(
                "Unable to restore a frame's scrollable elements: {error}"
            ));
        }
    }

    for position in scroll_positions {
        if let Err(error) = set_browser_scroll_position(
            view.clone(),
            position.execution_context_id,
            position.x,
            position.y,
        )
        .await
        {
            errors.push(format!(
                "Unable to restore a frame's scroll position: {error}"
            ));
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

#[cfg(windows)]
async fn expand_browser_scroll_containers(
    view: Webview,
    execution_context_id: i64,
) -> Result<(), String> {
    let expanded = evaluate_browser_javascript(
        view,
        execution_context_id,
        "(() => { const key = '__nftermScreenshotScrollContainers'; const roots = new Set([document.documentElement, document.body]); const elements = Array.from(document.querySelectorAll('*')).filter(element => { if (roots.has(element)) return false; const style = getComputedStyle(element); const vertical = /^(auto|scroll|overlay)$/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1; const horizontal = /^(auto|scroll|overlay)$/.test(style.overflowX) && element.scrollWidth > element.clientWidth + 1; return vertical || horizontal; }); elements.sort((a, b) => { const depth = element => { let count = 0; for (let node = element; node; node = node.parentElement) count++; return count; }; return depth(b) - depth(a); }); const saved = []; for (const element of elements) { const vertical = element.scrollHeight > element.clientHeight + 1; const horizontal = element.scrollWidth > element.clientWidth + 1; saved.push({ element, scrollLeft: element.scrollLeft, scrollTop: element.scrollTop, width: element.style.getPropertyValue('width'), widthPriority: element.style.getPropertyPriority('width'), height: element.style.getPropertyValue('height'), heightPriority: element.style.getPropertyPriority('height'), maxWidth: element.style.getPropertyValue('max-width'), maxWidthPriority: element.style.getPropertyPriority('max-width'), maxHeight: element.style.getPropertyValue('max-height'), maxHeightPriority: element.style.getPropertyPriority('max-height'), overflowX: element.style.getPropertyValue('overflow-x'), overflowXPriority: element.style.getPropertyPriority('overflow-x'), overflowY: element.style.getPropertyValue('overflow-y'), overflowYPriority: element.style.getPropertyPriority('overflow-y') }); if (horizontal) { element.style.setProperty('width', `${element.scrollWidth}px`, 'important'); element.style.setProperty('max-width', 'none', 'important'); element.style.setProperty('overflow-x', 'hidden', 'important'); } if (vertical) { element.style.setProperty('height', `${element.scrollHeight}px`, 'important'); element.style.setProperty('max-height', 'none', 'important'); element.style.setProperty('overflow-y', 'hidden', 'important'); } } globalThis[key] = saved; return saved.length; })()".to_string(),
    )
    .await?;
    let count = expanded
        .as_u64()
        .ok_or_else(|| "The browser did not report expanded scroll containers".to_string())?;
    if count > MAX_SCREENSHOT_SCROLL_CONTAINERS as u64 {
        return Err(
            "The page has too many nested scrollable elements to capture safely".to_string(),
        );
    }
    Ok(())
}

#[cfg(windows)]
async fn restore_browser_scroll_containers(
    view: Webview,
    execution_context_id: i64,
) -> Result<(), String> {
    evaluate_browser_javascript(
        view,
        execution_context_id,
        "(() => { const key = '__nftermScreenshotScrollContainers'; const saved = globalThis[key] || []; for (const item of saved.slice().reverse()) { const { element } = item; for (const [property, value, priority] of [['width', item.width, item.widthPriority], ['height', item.height, item.heightPriority], ['max-width', item.maxWidth, item.maxWidthPriority], ['max-height', item.maxHeight, item.maxHeightPriority], ['overflow-x', item.overflowX, item.overflowXPriority], ['overflow-y', item.overflowY, item.overflowYPriority]]) { if (value) element.style.setProperty(property, value, priority); else element.style.removeProperty(property); } } for (const item of saved) { item.element.scrollLeft = item.scrollLeft; item.element.scrollTop = item.scrollTop; } delete globalThis[key]; return true; })()".to_string(),
    )
    .await
    .map(|_| ())
}

#[cfg(windows)]
async fn wait_browser_frame_layout(view: Webview, execution_context_id: i64) -> Result<(), String> {
    evaluate_browser_javascript(
        view,
        execution_context_id,
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))".to_string(),
    )
    .await
    .map(|_| ())
}

#[cfg(windows)]
async fn call_browser_remote_object(
    view: Webview,
    object_id: &str,
    function_declaration: &str,
    arguments: Vec<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let response = browser_devtools_json(
        view,
        "Runtime.callFunctionOn",
        serde_json::json!({
            "objectId": object_id,
            "functionDeclaration": function_declaration,
            "arguments": arguments,
            "returnByValue": true,
        })
        .to_string(),
    )
    .await?;
    if let Some(exception) = response.get("exceptionDetails") {
        return Err(format!(
            "The browser could not update an iframe: {exception}"
        ));
    }
    response
        .pointer("/result/value")
        .cloned()
        .ok_or_else(|| "The browser did not return iframe information".to_string())
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
async fn read_browser_page_metrics(
    view: Webview,
    execution_context_id: i64,
) -> Result<BrowserPageMetrics, String> {
    let value = evaluate_browser_javascript(
        view,
        execution_context_id,
        "(() => { const root = document.documentElement; const body = document.body; return { pageWidth: Math.ceil(Math.max(window.innerWidth, root ? root.scrollWidth : 0, body ? body.scrollWidth : 0)), pageHeight: Math.ceil(Math.max(window.innerHeight, root ? root.scrollHeight : 0, body ? body.scrollHeight : 0)), viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY }; })()".to_string(),
    )
    .await?;
    let number = |name: &str| {
        value
            .get(name)
            .and_then(serde_json::Value::as_f64)
            .ok_or_else(|| format!("The browser reported an invalid {name}"))
    };
    let metrics = BrowserPageMetrics {
        page_width: number("pageWidth")?,
        page_height: number("pageHeight")?,
        viewport_width: number("viewportWidth")?,
        viewport_height: number("viewportHeight")?,
        scroll_x: number("scrollX")?,
        scroll_y: number("scrollY")?,
    };
    if ![
        metrics.page_width,
        metrics.page_height,
        metrics.viewport_width,
        metrics.viewport_height,
        metrics.scroll_x,
        metrics.scroll_y,
    ]
    .into_iter()
    .all(f64::is_finite)
        || metrics.viewport_width < 1.0
        || metrics.viewport_height < 1.0
    {
        return Err("The browser reported invalid page or viewport dimensions".to_string());
    }
    Ok(metrics)
}

#[cfg(windows)]
fn validate_browser_screenshot_size(width: f64, height: f64) -> Result<(), String> {
    if !width.is_finite()
        || !height.is_finite()
        || width < 1.0
        || height < 1.0
        || width > MAX_SCREENSHOT_DIMENSION
        || height > MAX_SCREENSHOT_DIMENSION
        || width * height > MAX_SCREENSHOT_PIXELS
    {
        return Err(format!(
            "The page is too large to capture as one image (maximum {} × {} pixels and {} million pixels total)",
            MAX_SCREENSHOT_DIMENSION as u32,
            MAX_SCREENSHOT_DIMENSION as u32,
            (MAX_SCREENSHOT_PIXELS / 1_000_000.0) as u32,
        ));
    }
    Ok(())
}

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

#[cfg(windows)]
async fn capture_browser_page_tiles(
    view: Webview,
    root_context_id: i64,
    initial_metrics: BrowserPageMetrics,
) -> Result<BrowserScreenshotCapture, String> {
    let mut metrics = initial_metrics;
    for attempt in 0..3 {
        validate_browser_screenshot_size(metrics.page_width, metrics.page_height)?;
        let x_positions = tile_positions(metrics.page_width, metrics.viewport_width);
        let y_positions = tile_positions(metrics.page_height, metrics.viewport_height);
        let tile_count = x_positions
            .len()
            .checked_mul(y_positions.len())
            .ok_or_else(|| "The full page requires too many screenshot tiles".to_string())?;
        if tile_count > MAX_SCREENSHOT_TILES {
            return Err("The full page requires too many screenshot tiles".to_string());
        }

        let mut tiles = Vec::with_capacity(tile_count);
        let mut total_base64_bytes = 0usize;
        for y in &y_positions {
            for x in &x_positions {
                let position =
                    set_browser_scroll_position(view.clone(), root_context_id, *x, *y).await?;
                let screenshot = run_browser_devtools_method(
                    view.clone(),
                    "Page.captureScreenshot",
                    serde_json::json!({ "format": "png", "fromSurface": true }).to_string(),
                )
                .await?;
                let screenshot: serde_json::Value = serde_json::from_str(&screenshot)
                    .map_err(|error| format!("Unable to read a page image tile: {error}"))?;
                let data = screenshot
                    .get("data")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| {
                        "The browser did not return a screenshot image tile".to_string()
                    })?
                    .to_string();
                total_base64_bytes =
                    total_base64_bytes.checked_add(data.len()).ok_or_else(|| {
                        "The full page image is too large to preview and select".to_string()
                    })?;
                if total_base64_bytes > MAX_SCREENSHOT_BASE64_BYTES {
                    return Err(
                        "The full page image is too large to preview and select".to_string()
                    );
                }
                tiles.push(BrowserScreenshotTile {
                    x: position.0,
                    y: position.1,
                    viewport_width: metrics.viewport_width,
                    viewport_height: metrics.viewport_height,
                    data,
                });
            }
        }

        let current_metrics = read_browser_page_metrics(view.clone(), root_context_id).await?;
        if current_metrics.page_width == metrics.page_width
            && current_metrics.page_height == metrics.page_height
        {
            return Ok(BrowserScreenshotCapture {
                page_width: metrics.page_width,
                page_height: metrics.page_height,
                viewport_width: metrics.viewport_width,
                viewport_height: metrics.viewport_height,
                tiles,
            });
        }
        metrics.page_width = current_metrics.page_width;
        metrics.page_height = current_metrics.page_height;
        if attempt == 2 {
            return Err("The page dimensions kept changing during capture; wait for the page to finish loading and try again".to_string());
        }
    }
    Err("Unable to capture the full page".to_string())
}

#[cfg(windows)]
async fn set_browser_scroll_position(
    view: Webview,
    execution_context_id: i64,
    x: f64,
    y: f64,
) -> Result<(f64, f64), String> {
    let expression = format!(
        "(async () => {{ window.scrollTo({{ left: {x}, top: {y}, behavior: 'instant' }}); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); return {{ x: window.scrollX, y: window.scrollY }}; }})()"
    );
    let value = evaluate_browser_javascript(view, execution_context_id, expression).await?;
    let x = value
        .get("x")
        .and_then(serde_json::Value::as_f64)
        .ok_or_else(|| "The browser did not report its horizontal scroll position".to_string())?;
    let y = value
        .get("y")
        .and_then(serde_json::Value::as_f64)
        .ok_or_else(|| "The browser did not report its vertical scroll position".to_string())?;
    Ok((x, y))
}

#[cfg(windows)]
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
        return Err(format!(
            "The browser could not inspect the page: {exception}"
        ));
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
        browser_view_label, collect_browser_frame_tree, map_browser_bounds_to_physical,
        parse_web_url, tile_positions, BrowserBounds, BrowserPhysicalBounds,
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
}
