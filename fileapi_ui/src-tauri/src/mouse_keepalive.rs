//! Keeps the Windows display from becoming idle while an SSH Entry Terminal
//! is open. The worker is shared by all terminal windows and is only active
//! while at least one terminal lease exists.

#[cfg(any(windows, test))]
use std::collections::{HashMap, HashSet};
#[cfg(any(windows, test))]
use std::time::{Duration, Instant};

#[cfg(any(windows, test))]
const IDLE_TIMEOUT_MS: u32 = 30_000;
#[cfg(any(windows, test))]
const MAX_LEASE_ID_BYTES: usize = 128;
#[cfg(any(windows, test))]
const DESTROYED_WINDOW_TOMBSTONE_TTL: Duration = Duration::from_secs(60);

#[cfg(any(windows, test))]
#[derive(Clone, Debug, Hash, PartialEq, Eq)]
struct TerminalLease {
    window_label: String,
    lease_id: String,
}

#[cfg(any(windows, test))]
impl TerminalLease {
    fn new(window_label: impl Into<String>, lease_id: impl Into<String>) -> Self {
        Self {
            window_label: window_label.into(),
            lease_id: lease_id.into(),
        }
    }
}

#[cfg(any(windows, test))]
fn validate_lease_id(lease_id: &str) -> Result<(), String> {
    if lease_id.is_empty()
        || lease_id.len() > MAX_LEASE_ID_BYTES
        || !lease_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("Invalid SSH mouse keep-alive lease id".to_string());
    }
    Ok(())
}

#[cfg(any(windows, test))]
#[derive(Default)]
struct LeaseRegistry {
    leases: HashSet<TerminalLease>,
    destroyed_windows: HashMap<String, Instant>,
    worker_running: bool,
}

#[cfg(any(windows, test))]
impl LeaseRegistry {
    fn register(&mut self, lease: TerminalLease) -> Result<bool, String> {
        validate_lease_id(&lease.lease_id)?;
        self.prune_destroyed_windows();
        if self.destroyed_windows.contains_key(&lease.window_label) {
            return Err("SSH terminal window has already been destroyed".to_string());
        }
        Ok(self.leases.insert(lease))
    }

    fn unregister(&mut self, lease: &TerminalLease) -> bool {
        self.leases.remove(lease)
    }

    fn remove_window_leases(&mut self, window_label: &str) -> bool {
        let before = self.leases.len();
        self.leases
            .retain(|lease| lease.window_label != window_label);
        self.leases.len() != before
    }

    fn destroy_window(&mut self, window_label: &str) -> bool {
        self.prune_destroyed_windows();
        let removed_leases = self.remove_window_leases(window_label);
        let new_tombstone = !self.destroyed_windows.contains_key(window_label);
        self.destroyed_windows
            .entry(window_label.to_string())
            .or_insert_with(Instant::now);
        new_tombstone || removed_leases
    }

    fn clear_window_for_startup(&mut self, window_label: &str) -> bool {
        self.prune_destroyed_windows();
        let removed_leases = self.remove_window_leases(window_label);
        let cleared_tombstone = self.destroyed_windows.remove(window_label);
        removed_leases || cleared_tombstone.is_some()
    }

    fn prune_destroyed_windows(&mut self) {
        self.destroyed_windows
            .retain(|_, destroyed_at| destroyed_at.elapsed() < DESTROYED_WINDOW_TOMBSTONE_TTL);
    }

    fn has_active_leases(&self) -> bool {
        !self.leases.is_empty()
    }

    fn start_worker(&mut self) -> bool {
        if self.worker_running {
            return false;
        }
        self.worker_running = true;
        true
    }

    fn stop_worker(&mut self) {
        self.worker_running = false;
    }
}

#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ScreenPoint {
    x: i32,
    y: i32,
}

/// Tracks one interaction clock for the whole interactive desktop session.
/// `GetLastInputInfo` supplies keyboard and mouse activity; a detected lock
/// or an unavailable input clock suspends movement and starts a fresh 30-second
/// period when monitoring resumes.
#[cfg(any(windows, test))]
#[derive(Debug)]
struct IdleClock {
    last_input_tick: Option<u32>,
    last_activity_tick: u32,
    suspended: bool,
}

#[cfg(any(windows, test))]
impl IdleClock {
    fn new(now: u32, last_input_tick: Option<u32>, suspended: bool) -> Self {
        Self {
            last_input_tick,
            last_activity_tick: last_input_tick.unwrap_or(now),
            suspended: suspended || last_input_tick.is_none(),
        }
    }

    fn should_nudge(
        &mut self,
        now: u32,
        last_input_tick: Option<u32>,
        screen_locked: bool,
    ) -> bool {
        let Some(last_input_tick) = last_input_tick else {
            self.suspended = true;
            return false;
        };

        if screen_locked {
            self.suspended = true;
            self.last_input_tick = Some(last_input_tick);
            return false;
        }

        if self.suspended {
            self.suspended = false;
            self.last_input_tick = Some(last_input_tick);
            self.last_activity_tick = now;
            return false;
        }

        if self.last_input_tick != Some(last_input_tick) {
            self.last_input_tick = Some(last_input_tick);
            let elapsed = now.wrapping_sub(last_input_tick);
            self.last_activity_tick = if elapsed <= i32::MAX as u32 {
                last_input_tick
            } else {
                // GetLastInputInfo and GetTickCount have finite resolution;
                // an input observed a few ticks in the future must not turn
                // wrapping_sub into a huge elapsed duration and nudge early.
                now
            };
            return false;
        }

        if now.wrapping_sub(self.last_activity_tick) < IDLE_TIMEOUT_MS {
            return false;
        }

        true
    }

    fn note_nudge_attempt(&mut self, now: u32) {
        // Reset even if Windows rejects the synthetic input, so a failure
        // cannot turn the 250ms monitor into an input storm.
        self.last_activity_tick = now;
    }
}

/// Finds an actual neighboring display pixel. Testing each candidate against
/// the native monitor layout handles outer edges, corners, and gaps between
/// monitors without relying on the virtual desktop's rectangular bounding box.
#[cfg(any(windows, test))]
fn adjacent_monitor_point(
    current: ScreenPoint,
    mut is_on_monitor: impl FnMut(ScreenPoint) -> bool,
) -> Option<ScreenPoint> {
    let candidates = [
        current
            .x
            .checked_add(1)
            .map(|x| ScreenPoint { x, y: current.y }),
        current
            .x
            .checked_sub(1)
            .map(|x| ScreenPoint { x, y: current.y }),
        current
            .y
            .checked_add(1)
            .map(|y| ScreenPoint { x: current.x, y }),
        current
            .y
            .checked_sub(1)
            .map(|y| ScreenPoint { x: current.x, y }),
    ];

    candidates
        .into_iter()
        .flatten()
        .find(|candidate| is_on_monitor(*candidate))
}

#[cfg(windows)]
mod windows_impl {
    use super::{adjacent_monitor_point, IdleClock, LeaseRegistry, ScreenPoint, TerminalLease};
    use std::mem::{size_of, size_of_val};
    use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
    use std::sync::{Condvar, Mutex, OnceLock};
    use std::thread;
    use std::time::Duration;
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::Graphics::Gdi::{MonitorFromPoint, MONITOR_DEFAULTTONULL};
    use windows_sys::Win32::System::StationsAndDesktops::{
        CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_READOBJECTS, UOI_NAME,
    };
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, GetLastInputInfo, SendInput, INPUT, INPUT_0, INPUT_MOUSE, LASTINPUTINFO,
        MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_MOVE, MOUSEEVENTF_MOVE_NOCOALESCE,
        MOUSEEVENTF_VIRTUALDESK, MOUSEINPUT,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetCursorPos, GetSystemMetrics, SetCursorPos, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN,
        SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
    };

    const POLL_INTERVAL: Duration = Duration::from_millis(250);
    const MAX_PANIC_RESTARTS: u8 = 3;

    struct Service {
        leases: Mutex<LeaseRegistry>,
        changed: Condvar,
    }

    static SERVICE: OnceLock<Service> = OnceLock::new();
    static PANIC_RESTARTS: AtomicU8 = AtomicU8::new(0);
    static INPUT_DESKTOP_WARNING_REPORTED: AtomicBool = AtomicBool::new(false);
    static NUDGE_WARNING_REPORTED: AtomicBool = AtomicBool::new(false);

    fn service() -> &'static Service {
        SERVICE.get_or_init(|| Service {
            leases: Mutex::new(LeaseRegistry::default()),
            changed: Condvar::new(),
        })
    }

    fn lock_registry() -> std::sync::MutexGuard<'static, LeaseRegistry> {
        service()
            .leases
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn log_warning(status: &str, detail: &str) {
        crate::oplog::log(
            "WARN",
            "mouse_keepalive",
            status,
            "SSH Entry Terminal",
            "",
            detail,
        );
    }

    pub(super) fn register_lease(lease: TerminalLease) -> Result<(), String> {
        let service = service();
        let mut leases = service
            .leases
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let inserted = leases.register(lease.clone())?;
        if !leases.start_worker() {
            return Ok(());
        }

        // Keep the registry lock while spawning: the worker cannot exit on an
        // empty set between this state change and its first active check.
        PANIC_RESTARTS.store(0, Ordering::Relaxed);
        if let Err(error) = thread::Builder::new()
            .name("nfterm-ssh-mouse-keepalive".to_string())
            .spawn(monitor)
        {
            leases.stop_worker();
            if inserted {
                leases.unregister(&lease);
            }
            return Err(format!("Unable to start SSH mouse keep-alive: {error}"));
        }
        drop(leases);
        service.changed.notify_all();
        Ok(())
    }

    pub(super) fn unregister_lease(lease: &TerminalLease) {
        if lock_registry().unregister(lease) {
            service().changed.notify_all();
        }
    }

    pub(super) fn destroy_window(window_label: &str) {
        if lock_registry().destroy_window(window_label) {
            service().changed.notify_all();
        }
    }

    pub(super) fn clear_window_for_startup(window_label: &str) {
        if lock_registry().clear_window_for_startup(window_label) {
            service().changed.notify_all();
        }
    }

    fn wait_for_active_terminal() -> bool {
        let service = service();
        let leases = service
            .leases
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !leases.has_active_leases() {
            let mut leases = leases;
            leases.stop_worker();
            return false;
        }

        let (mut leases, _) = service
            .changed
            .wait_timeout(leases, POLL_INTERVAL)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !leases.has_active_leases() {
            // Set this under the same lock used by registration. A racing new
            // terminal will then start a fresh worker instead of being lost.
            leases.stop_worker();
            false
        } else {
            true
        }
    }

    fn monitor() {
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(monitor_loop)).is_ok() {
            PANIC_RESTARTS.store(0, Ordering::Relaxed);
            return;
        }

        let restart_count = PANIC_RESTARTS.fetch_add(1, Ordering::Relaxed) + 1;
        log_warning(
            "worker_panicked",
            &format!("SSH mouse keep-alive worker panicked (restart {restart_count})"),
        );
        let mut leases = lock_registry();
        if !leases.has_active_leases() {
            leases.stop_worker();
            PANIC_RESTARTS.store(0, Ordering::Relaxed);
            return;
        }
        if restart_count > MAX_PANIC_RESTARTS {
            leases.stop_worker();
            log_warning(
                "worker_stopped",
                "SSH mouse keep-alive stopped after repeated worker failures",
            );
            return;
        }

        drop(leases);
        thread::sleep(Duration::from_millis(500));
        let mut leases = lock_registry();
        if !leases.has_active_leases() {
            leases.stop_worker();
            PANIC_RESTARTS.store(0, Ordering::Relaxed);
            return;
        }
        if let Err(error) = thread::Builder::new()
            .name("nfterm-ssh-mouse-keepalive-retry".to_string())
            .spawn(monitor)
        {
            leases.stop_worker();
            log_warning(
                "worker_restart_failed",
                &format!("Unable to restart SSH mouse keep-alive: {error}"),
            );
        }
    }

    fn monitor_loop() {
        let now = unsafe { GetTickCount() };
        let initial_last_input_tick = last_input_tick();
        let mut clock = IdleClock::new(now, initial_last_input_tick, input_desktop_is_locked());

        while wait_for_active_terminal() {
            let now = unsafe { GetTickCount() };
            let observed_last_input_tick = last_input_tick();
            let screen_locked = input_desktop_is_locked();
            if clock.should_nudge(now, observed_last_input_tick, screen_locked) {
                // Confirm the idle/lock state again immediately before
                // injecting input. This narrows the race where a user starts
                // moving the mouse just as an idle nudge becomes due.
                let confirmed_at = unsafe { GetTickCount() };
                let confirmed_input = last_input_tick();
                let confirmed_locked = input_desktop_is_locked();
                if clock.should_nudge(confirmed_at, confirmed_input, confirmed_locked) {
                    if any_input_is_held() {
                        // Keep the interval due. A real key/button release is
                        // global input and resets the clock on the next poll.
                        continue;
                    }
                    let _ = move_cursor_one_pixel_and_back();
                    clock.note_nudge_attempt(unsafe { GetTickCount() });
                }
            }
        }
    }

    fn any_input_is_held() -> bool {
        (0u16..=u8::MAX as u16)
            .any(|virtual_key| unsafe { GetAsyncKeyState(i32::from(virtual_key)) & i16::MIN != 0 })
    }

    fn last_input_tick() -> Option<u32> {
        let mut input = LASTINPUTINFO {
            cbSize: size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        (unsafe { GetLastInputInfo(&mut input) } != 0).then_some(input.dwTime)
    }

    /// OpenInputDesktop identifies the currently active desktop. Only
    /// `Default` is the unlocked interactive desktop; lock, UAC, and other
    /// secure desktops all fail closed and suspend cursor movement.
    fn input_desktop_is_locked() -> bool {
        let desktop = unsafe { OpenInputDesktop(0, 0, DESKTOP_READOBJECTS) };
        if desktop.is_null() {
            report_input_desktop_unavailable();
            return true;
        }

        let mut name = [0u16; 128];
        let mut required = 0u32;
        let read_name = unsafe {
            GetUserObjectInformationW(
                desktop,
                UOI_NAME,
                name.as_mut_ptr().cast(),
                size_of_val(&name) as u32,
                &mut required,
            )
        } != 0;
        unsafe { CloseDesktop(desktop) };

        if !read_name {
            report_input_desktop_unavailable();
            return true;
        }
        INPUT_DESKTOP_WARNING_REPORTED.store(false, Ordering::Relaxed);
        let length = name
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(name.len());
        !String::from_utf16_lossy(&name[..length]).eq_ignore_ascii_case("Default")
    }

    fn report_input_desktop_unavailable() {
        if !INPUT_DESKTOP_WARNING_REPORTED.swap(true, Ordering::Relaxed) {
            crate::oplog::log(
                "WARN",
                "mouse_keepalive",
                "input_desktop_unavailable",
                "SSH Entry Terminal",
                "",
                "Windows input desktop could not be inspected; cursor movement is paused for safety.",
            );
        }
    }

    fn report_nudge_failure(detail: &str) {
        if !NUDGE_WARNING_REPORTED.swap(true, Ordering::Relaxed) {
            log_warning("cursor_nudge_failed", detail);
        }
    }

    fn move_cursor_one_pixel_and_back() -> bool {
        let mut current = POINT { x: 0, y: 0 };
        if unsafe { GetCursorPos(&mut current) } == 0 {
            report_nudge_failure("GetCursorPos failed before a cursor nudge");
            return false;
        }

        let virtual_screen = VirtualScreen {
            left: unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) },
            top: unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) },
            width: unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) },
            height: unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) },
        };
        if virtual_screen.width < 2 || virtual_screen.height < 2 {
            report_nudge_failure("Windows reported a virtual screen smaller than two pixels");
            return false;
        }

        let current_point = ScreenPoint {
            x: current.x,
            y: current.y,
        };
        let target = adjacent_monitor_point(current_point, |candidate| {
            let point = POINT {
                x: candidate.x,
                y: candidate.y,
            };
            !unsafe { MonitorFromPoint(point, MONITOR_DEFAULTTONULL) }.is_null()
                && virtual_screen.absolute(candidate) != virtual_screen.absolute(current_point)
        });
        let Some(target) = target else {
            report_nudge_failure("No adjacent pixel was available on a connected display");
            return false;
        };

        let inputs = [
            mouse_move_input(target, virtual_screen),
            mouse_move_input(current_point, virtual_screen),
        ];
        let input_size = size_of::<INPUT>() as i32;
        let sent = unsafe { SendInput(inputs.len() as u32, inputs.as_ptr(), input_size) };
        // Let the ordered input batch reach the cursor before checking its
        // final position; SendInput can return before queued movement is visible.
        thread::sleep(Duration::from_millis(5));
        // Absolute mouse coordinates are normalized to 16-bit values for the
        // virtual desktop and can round on large or mixed-monitor layouts.
        // Restore the exact physical screen coordinate only if the user has
        // not moved away from the two positions owned by this nudge.
        let mut restoration_succeeded = true;
        let mut after_input = POINT { x: 0, y: 0 };
        let cursor_position_read = unsafe { GetCursorPos(&mut after_input) } != 0;
        if cursor_position_read {
            let still_at_nudge_position = (after_input.x.abs_diff(current.x) <= 1
                && after_input.y.abs_diff(current.y) <= 1)
                || (after_input.x.abs_diff(target.x) <= 1 && after_input.y.abs_diff(target.y) <= 1);
            if still_at_nudge_position && unsafe { SetCursorPos(current.x, current.y) } == 0 {
                report_nudge_failure(
                    "SetCursorPos failed while restoring the cursor after a nudge",
                );
                restoration_succeeded = false;
            }
        } else {
            report_nudge_failure("GetCursorPos failed while restoring the cursor after a nudge");
            restoration_succeeded = false;
        }
        if sent != inputs.len() as u32 {
            report_nudge_failure(&format!(
                "SendInput accepted {sent}/{} mouse keep-alive events",
                inputs.len()
            ));
            return false;
        }
        if !restoration_succeeded {
            return false;
        }
        NUDGE_WARNING_REPORTED.store(false, Ordering::Relaxed);
        true
    }

    #[derive(Clone, Copy)]
    struct VirtualScreen {
        left: i32,
        top: i32,
        width: i32,
        height: i32,
    }

    impl VirtualScreen {
        // Tauri's tao Windows runtime sets Per-Monitor V2 awareness before
        // creating windows, so cursor, monitor, and virtual-screen APIs use
        // consistent physical-pixel coordinates across mixed-DPI displays.
        fn absolute(self, point: ScreenPoint) -> (i32, i32) {
            (
                normalize_absolute(point.x, self.left, self.width),
                normalize_absolute(point.y, self.top, self.height),
            )
        }
    }

    fn normalize_absolute(coordinate: i32, origin: i32, extent: i32) -> i32 {
        if extent <= 1 {
            return 0;
        }
        (((coordinate as i64 - origin as i64) * 65_535) / (extent as i64 - 1)) as i32
    }

    fn mouse_move_input(point: ScreenPoint, screen: VirtualScreen) -> INPUT {
        let (dx, dy) = screen.absolute(point);
        INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx,
                    dy,
                    mouseData: 0,
                    dwFlags: MOUSEEVENTF_MOVE
                        | MOUSEEVENTF_ABSOLUTE
                        | MOUSEEVENTF_VIRTUALDESK
                        | MOUSEEVENTF_MOVE_NOCOALESCE,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }
}

#[tauri::command]
pub fn ssh_terminal_keepalive_register(
    window: tauri::WebviewWindow,
    lease_id: String,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        windows_impl::register_lease(TerminalLease::new(window.label(), lease_id))
    }
    #[cfg(not(windows))]
    {
        let _ = (window, lease_id);
        Ok(())
    }
}

#[tauri::command]
pub fn ssh_terminal_keepalive_unregister(
    window: tauri::WebviewWindow,
    lease_id: String,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        windows_impl::unregister_lease(&TerminalLease::new(window.label(), lease_id));
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (window, lease_id);
        Ok(())
    }
}

#[tauri::command]
pub fn ssh_terminal_keepalive_clear_window(window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(windows)]
    windows_impl::clear_window_for_startup(window.label());
    #[cfg(not(windows))]
    let _ = window;
    Ok(())
}

pub fn release_window(window_label: &str) {
    #[cfg(windows)]
    windows_impl::destroy_window(window_label);
    #[cfg(not(windows))]
    let _ = window_label;
}

#[cfg(test)]
mod tests {
    use super::{
        adjacent_monitor_point, validate_lease_id, IdleClock, LeaseRegistry, ScreenPoint,
        TerminalLease, MAX_LEASE_ID_BYTES,
    };

    #[test]
    fn idle_clock_waits_for_thirty_seconds_and_repeats_at_the_interval() {
        let mut clock = IdleClock::new(0, Some(0), false);
        assert!(!clock.should_nudge(29_999, Some(0), false));
        assert!(clock.should_nudge(30_000, Some(0), false));
        clock.note_nudge_attempt(30_000);
        assert!(!clock.should_nudge(59_999, Some(0), false));
        assert!(clock.should_nudge(60_000, Some(0), false));
    }

    #[test]
    fn injected_cursor_input_starts_the_next_full_idle_interval() {
        let mut clock = IdleClock::new(0, Some(0), false);
        assert!(clock.should_nudge(30_000, Some(0), false));
        clock.note_nudge_attempt(30_000);
        // SendInput updates GetLastInputInfo; the monitor observes that
        // synthetic input and starts the next interval from its observed tick.
        assert!(!clock.should_nudge(30_250, Some(30_000), false));
        assert!(!clock.should_nudge(59_999, Some(30_000), false));
        assert!(clock.should_nudge(60_000, Some(30_000), false));
    }

    #[test]
    fn keyboard_or_mouse_activity_restarts_the_idle_interval() {
        let mut clock = IdleClock::new(0, Some(0), false);
        assert!(!clock.should_nudge(29_000, Some(29_000), false));
        assert!(!clock.should_nudge(58_999, Some(29_000), false));
        assert!(clock.should_nudge(59_000, Some(29_000), false));
    }

    #[test]
    fn activity_uses_the_system_input_timestamp_not_the_poll_timestamp() {
        let mut clock = IdleClock::new(0, Some(0), false);
        assert!(!clock.should_nudge(29_000, Some(28_900), false));
        assert!(clock.should_nudge(58_900, Some(28_900), false));
    }

    #[test]
    fn a_future_input_tick_never_looks_like_more_than_thirty_seconds_of_idle() {
        let mut clock = IdleClock::new(40_000, Some(40_000), false);
        assert!(!clock.should_nudge(40_000, Some(40_005), false));
        assert!(!clock.should_nudge(69_999, Some(40_005), false));
        assert!(clock.should_nudge(70_000, Some(40_005), false));
    }

    #[test]
    fn idle_time_before_the_first_entry_open_is_measured_from_global_input() {
        let mut clock = IdleClock::new(40_000, Some(0), false);
        assert!(clock.should_nudge(40_000, Some(0), false));
    }

    #[test]
    fn lock_pauses_movement_and_unlock_starts_a_fresh_idle_interval() {
        let mut clock = IdleClock::new(0, Some(0), false);
        assert!(!clock.should_nudge(29_000, Some(0), true));
        assert!(!clock.should_nudge(80_000, Some(0), true));
        assert!(!clock.should_nudge(80_001, Some(0), false));
        assert!(!clock.should_nudge(110_000, Some(0), false));
        assert!(clock.should_nudge(110_001, Some(0), false));
    }

    #[test]
    fn held_input_release_restarts_the_idle_interval() {
        let mut clock = IdleClock::new(0, Some(0), false);
        assert!(clock.should_nudge(30_000, Some(0), false));
        // While the key/button is held, the monitor leaves the idle clock due.
        assert!(clock.should_nudge(30_250, Some(0), false));
        // Releasing it updates the system input timestamp and starts a fresh
        // interval from that activity.
        assert!(!clock.should_nudge(30_500, Some(30_500), false));
        assert!(!clock.should_nudge(60_499, Some(30_500), false));
        assert!(clock.should_nudge(60_500, Some(30_500), false));
    }

    #[test]
    fn unavailable_input_clock_pauses_until_it_is_available_again() {
        let mut clock = IdleClock::new(0, Some(0), false);
        assert!(!clock.should_nudge(40_000, None, false));
        assert!(!clock.should_nudge(60_000, Some(0), false));
        assert!(clock.should_nudge(90_000, Some(0), false));
    }

    #[test]
    fn activity_clock_handles_tick_count_wraparound() {
        let start = u32::MAX - 10_000;
        let mut clock = IdleClock::new(start, Some(start), false);
        assert!(!clock.should_nudge(start.wrapping_add(29_999), Some(start), false));
        assert!(clock.should_nudge(start.wrapping_add(30_000), Some(start), false));
    }

    #[test]
    fn cursor_nudge_selects_an_inward_pixel_at_monitor_edges_and_corners() {
        let current = ScreenPoint { x: 0, y: 0 };
        let target = adjacent_monitor_point(current, |point| {
            (0..=100).contains(&point.x) && (0..=80).contains(&point.y)
        });
        assert_eq!(target, Some(ScreenPoint { x: 1, y: 0 }));

        let right_edge = ScreenPoint { x: 100, y: 40 };
        let target = adjacent_monitor_point(right_edge, |point| {
            (0..=100).contains(&point.x) && (0..=80).contains(&point.y)
        });
        assert_eq!(target, Some(ScreenPoint { x: 99, y: 40 }));
    }

    #[test]
    fn cursor_nudge_avoids_gaps_between_monitors() {
        let current = ScreenPoint { x: 10, y: 40 };
        let target = adjacent_monitor_point(current, |point| {
            (0..=10).contains(&point.x) || (20..=30).contains(&point.x)
        });
        assert_eq!(target, Some(ScreenPoint { x: 9, y: 40 }));
    }

    #[test]
    fn terminal_lease_registry_is_idempotent_and_clears_a_closed_window() {
        let lease = TerminalLease::new("ssh-popup-1", "lease-1");
        let mut registry = LeaseRegistry::default();
        assert!(registry.register(lease.clone()).unwrap());
        assert!(!registry.register(lease.clone()).unwrap());
        assert!(!registry.leases.is_empty());
        assert!(registry.destroy_window("ssh-popup-1"));
        assert!(registry.leases.is_empty());
        assert!(!registry.unregister(&lease));
        assert!(registry.register(lease.clone()).is_err());
        assert!(registry.clear_window_for_startup("ssh-popup-1"));
        assert!(registry.register(lease).unwrap());
    }

    #[test]
    fn lease_ids_are_bounded_and_use_the_frontend_generated_alphabet() {
        assert!(validate_lease_id("ssh-uuid-keepalive-uuid").is_ok());
        assert!(validate_lease_id("").is_err());
        assert!(validate_lease_id(&"a".repeat(MAX_LEASE_ID_BYTES + 1)).is_err());
        assert!(validate_lease_id("ssh/terminal").is_err());
    }

    #[test]
    fn multiple_open_entries_share_one_worker_until_the_last_lease_closes() {
        let first = TerminalLease::new("main", "entry-1");
        let second = TerminalLease::new("ssh-popup-2", "entry-2");
        let mut registry = LeaseRegistry::default();

        assert!(registry.register(first.clone()).unwrap());
        assert!(registry.start_worker());
        assert!(registry.register(second.clone()).unwrap());
        assert!(
            !registry.start_worker(),
            "another Entry does not start another worker"
        );

        assert!(registry.unregister(&first));
        assert!(
            registry.has_active_leases(),
            "the remaining Entry keeps the worker active"
        );
        assert!(!registry.start_worker());

        assert!(registry.unregister(&second));
        assert!(!registry.has_active_leases());
        registry.stop_worker();
        assert!(
            registry.start_worker(),
            "a future Entry starts the worker again"
        );
    }
}
