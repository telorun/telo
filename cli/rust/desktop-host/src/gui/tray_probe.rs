//! Whether this session can show a tray icon.
//!
//! No Node twin: this crate has none (see `lib.rs`).

/// macOS and Windows always can. On Linux a tray icon needs a StatusNotifierWatcher
/// on the session bus; stock GNOME has none. A bus that cannot be asked counts as
/// none, and the reason is logged.
pub fn tray_available() -> bool {
    #[cfg(target_os = "linux")]
    {
        match watcher_has_owner() {
            Ok(owned) => owned,
            Err(error) => {
                eprintln!("telo-desktop-host: cannot ask the session bus for a StatusNotifierWatcher: {error}");
                false
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}

#[cfg(target_os = "linux")]
fn watcher_has_owner() -> zbus::Result<bool> {
    let connection = zbus::blocking::Connection::session()?;
    let bus = zbus::blocking::fdo::DBusProxy::new(&connection)?;
    let watcher = zbus::names::BusName::try_from("org.kde.StatusNotifierWatcher")?;
    Ok(bus.name_has_owner(watcher)?)
}
