use serde::{Deserialize, Serialize};
use tauri::webview::Webview;
#[cfg(windows)]
use tauri::Emitter;
use tauri::{AppHandle, Manager};

#[cfg(windows)]
const BROWSER_VIEW_STATE_EVENT: &str = "browser-view-state";
#[cfg(windows)]
const BROWSER_NEW_PANE_EVENT: &str = "browser-new-pane";
const BROWSER_VIEW_PREFIX: &str = "browser-content-";

#[derive(Clone, Deserialize)]
#[cfg_attr(not(windows), allow(dead_code))]
#[serde(rename_all = "camelCase")]
pub struct BrowserBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub device_pixel_ratio: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPhysicalBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Serialize)]
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

fn physical_edge_floor(value: f64) -> Result<i32, String> {
    let edge = value.floor();
    if !edge.is_finite() || edge < i32::MIN as f64 || edge > i32::MAX as f64 {
        return Err("Browser view position is outside the native window bounds".to_string());
    }
    Ok(edge as i32)
}

fn physical_edge_ceil(value: f64) -> Result<i32, String> {
    let edge = value.ceil();
    if !edge.is_finite() || edge < i32::MIN as f64 || edge > i32::MAX as f64 {
        return Err("Browser view size is outside the native window bounds".to_string());
    }
    Ok(edge as i32)
}

fn map_browser_bounds_to_physical(
    bounds: &BrowserBounds,
    root_webview_offset: (i32, i32),
) -> Result<BrowserPhysicalBounds, String> {
    if ![
        bounds.x,
        bounds.y,
        bounds.width,
        bounds.height,
        bounds.device_pixel_ratio,
    ]
    .into_iter()
    .all(f64::is_finite)
        || bounds.width <= 0.0
        || bounds.height <= 0.0
        || bounds.device_pixel_ratio <= 0.0
    {
        return Err("Browser view bounds or DPI scale are invalid".to_string());
    }

    let scale = bounds.device_pixel_ratio;
    let left = f64::from(root_webview_offset.0) + bounds.x * scale;
    let top = f64::from(root_webview_offset.1) + bounds.y * scale;
    let right = f64::from(root_webview_offset.0) + (bounds.x + bounds.width) * scale;
    let bottom = f64::from(root_webview_offset.1) + (bounds.y + bounds.height) * scale;
    let x = physical_edge_floor(left)?;
    let y = physical_edge_floor(top)?;
    let right = physical_edge_ceil(right)?;
    let bottom = physical_edge_ceil(bottom)?;
    let width = i64::from(right) - i64::from(x);
    let height = i64::from(bottom) - i64::from(y);
    if width <= 0 || height <= 0 || width > i64::from(u32::MAX) || height > i64::from(u32::MAX) {
        return Err("Browser view size is outside the supported native bounds".to_string());
    }
    Ok(BrowserPhysicalBounds {
        x,
        y,
        width: width as u32,
        height: height as u32,
    })
}

#[cfg(windows)]
fn browser_native_bounds(
    webview: &Webview,
    bounds: &BrowserBounds,
) -> Result<BrowserPhysicalBounds, String> {
    let webview_position = webview.position().map_err(|error| error.to_string())?;
    let window_position = webview
        .window()
        .inner_position()
        .map_err(|error| error.to_string())?;
    let offset = (
        webview_position
            .x
            .checked_sub(window_position.x)
            .ok_or_else(|| "Browser WebView horizontal origin overflowed".to_string())?,
        webview_position
            .y
            .checked_sub(window_position.y)
            .ok_or_else(|| "Browser WebView vertical origin overflowed".to_string())?,
    );
    map_browser_bounds_to_physical(bounds, offset)
}

#[cfg(windows)]
fn read_browser_native_bounds(webview: &Webview) -> Result<BrowserPhysicalBounds, String> {
    let position = webview.position().map_err(|error| error.to_string())?;
    let size = webview.size().map_err(|error| error.to_string())?;
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

        let native_bounds = browser_native_bounds(&webview, &bounds)?;

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
        use tauri::{PhysicalPosition, PhysicalSize};
        let view = get_browser_webview(&app, &pane_id)?;
        let native_bounds = browser_native_bounds(&webview, &bounds)?;
        view.set_position(PhysicalPosition::new(native_bounds.x, native_bounds.y))
            .map_err(|error| error.to_string())?;
        view.set_size(PhysicalSize::new(native_bounds.width, native_bounds.height))
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
    use super::{browser_view_label, map_browser_bounds_to_physical, parse_web_url, BrowserBounds};

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
    fn browser_dom_bounds_map_to_physical_pixels_with_origin_and_dpi() {
        let at_100_percent = BrowserBounds {
            x: 10.25,
            y: 20.5,
            width: 100.2,
            height: 40.1,
            device_pixel_ratio: 1.0,
        };
        assert_eq!(
            map_browser_bounds_to_physical(&at_100_percent, (0, 0)).unwrap(),
            super::BrowserPhysicalBounds {
                x: 10,
                y: 20,
                width: 101,
                height: 41,
            }
        );

        let at_125_percent = BrowserBounds {
            device_pixel_ratio: 1.25,
            ..at_100_percent
        };
        assert_eq!(
            map_browser_bounds_to_physical(&at_125_percent, (8, 30)).unwrap(),
            super::BrowserPhysicalBounds {
                x: 20,
                y: 55,
                width: 127,
                height: 51,
            }
        );

        let at_150_percent = BrowserBounds {
            x: 10.0,
            y: 20.0,
            width: 100.0,
            height: 40.0,
            device_pixel_ratio: 1.5,
        };
        assert_eq!(
            map_browser_bounds_to_physical(&at_150_percent, (-4, 12)).unwrap(),
            super::BrowserPhysicalBounds {
                x: 11,
                y: 42,
                width: 150,
                height: 60,
            }
        );
    }

    #[test]
    fn browser_dom_bounds_reject_invalid_geometry_and_dpi() {
        for bounds in [
            BrowserBounds {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 1.0,
                device_pixel_ratio: 1.0,
            },
            BrowserBounds {
                device_pixel_ratio: 0.0,
                x: 0.0,
                y: 0.0,
                width: 1.0,
                height: 1.0,
            },
        ] {
            assert!(map_browser_bounds_to_physical(&bounds, (0, 0)).is_err());
        }
    }
}
