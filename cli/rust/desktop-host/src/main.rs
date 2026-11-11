//! The `telo-desktop-host` binary. Without the `gui` feature there is no native
//! toolkit in it: it announces `Helper.Unavailable` on the link and exits 1, so a
//! host that obtained such a build refuses cleanly instead of waiting for a window.
//!
//! No Node twin: this crate has none (see `lib.rs`).

// No console window for the helper a packaged app starts; its link is pipes, which a GUI-subsystem
// process still inherits.
#![cfg_attr(all(windows, feature = "gui"), windows_subsystem = "windows")]

#[cfg(feature = "gui")]
fn main() {
    if print_version() {
        return;
    }
    std::process::exit(telo_desktop_host::gui::run());
}

#[cfg(not(feature = "gui"))]
fn main() {
    use telo_desktop_host::helper::Notifier;
    use telo_desktop_host::link::LinkWriter;
    use telo_desktop_host::messages::Notification;

    if print_version() {
        return;
    }
    let reason = "this telo-desktop-host was built without its native toolkit (cargo feature `gui`)".to_owned();
    eprintln!("telo-desktop-host: {reason}");
    LinkWriter::new(std::io::stdout()).notify(Notification::Unavailable { reason });
    std::process::exit(1);
}

fn print_version() -> bool {
    if std::env::args().nth(1).as_deref() == Some("--version") {
        println!("telo-desktop-host {}", telo_desktop_host::VERSION);
        return true;
    }
    false
}
