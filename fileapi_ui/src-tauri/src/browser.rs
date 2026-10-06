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
) -> Result<(), String> {
    require_main_webview(&webview)?;
    let label = browser_view_label(&pane_id)?;
    if let Some(stale_view) = app.get_webview(&label) {
        stale_view.close().map_err(|error| error.to_string())?;
    }
    let url = parse_web_url(&initial_url, true)?;

    #[cfg(windows)]
    {
        use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
        use tauri::{LogicalPosition, LogicalSize};

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
                LogicalPosition::new(bounds.x, bounds.y),
                LogicalSize::new(bounds.width, bounds.height),
            )
            .map_err(|error| error.to_string())?;
        if !visible {
            child.hide().map_err(|error| error.to_string())?;
        }
        Ok(())
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
) -> Result<(), String> {
    require_main_webview(&webview)?;
    #[cfg(windows)]
    {
        use tauri::{LogicalPosition, LogicalSize};
        let view = get_browser_webview(&app, &pane_id)?;
        view.set_position(LogicalPosition::new(bounds.x, bounds.y))
            .map_err(|error| error.to_string())?;
        view.set_size(LogicalSize::new(bounds.width, bounds.height))
            .map_err(|error| error.to_string())
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
    use super::{browser_view_label, parse_web_url};

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
}
