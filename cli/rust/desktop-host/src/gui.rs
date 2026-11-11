//! The native half: a `tao` event loop owning the windows (`wry` webviews) and tray
//! icons (`tray-icon`), fed by a reader thread over the link.
//!
//! Compiled only with the `gui` feature. **Type-checked, never linked or run**: it was
//! written against the vendored sources of wry 0.55.1, tao 0.35.3 and tray-icon 0.24.2
//! on a machine with no WebKitGTK and no display. `cargo check --features gui` passed
//! on Linux (a stub `pkg-config`), `x86_64-pc-windows-msvc` and `aarch64-apple-darwin`
//! (`DOCS_RS=1` skipping an Objective-C build script); no window, webview or tray icon
//! has ever been created by this code. Everything it decides lives in the plain modules;
//! what is left here is wiring.
//!
//! Threads: the main thread runs the event loop and touches every toolkit object. A
//! reader thread turns frames from stdin into user events. Writes to stdout come
//! from the main thread only (handlers run there), through one locked writer.
//!
//! No Node twin: this crate has none (see `lib.rs`).

mod backend;
mod tray_probe;

use crate::frame::FrameReader;
use crate::helper::{Helper, Notifier};
use crate::link::{dispatch, read_inbound, Inbound, LinkWriter};
use crate::menu::parse_item_id;
use crate::messages::{Notification, Request};
use backend::GuiBackend;
use std::sync::{Arc, Mutex};
use tao::event::{Event, StartCause, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tray_icon::menu::MenuEvent;
use tray_icon::TrayIconEvent;

/// Exit codes: 0 after `Helper.Quit`; 1 unavailable; 2 the host broke the protocol;
/// 3 the link closed without a `Helper.Quit`.
pub const EXIT_UNAVAILABLE: i32 = 1;
pub const EXIT_PROTOCOL: i32 = 2;
pub const EXIT_LINK_CLOSED: i32 = 3;

pub enum UserEvent {
    Request { id: u64, kind: String, request: Request },
    LinkClosed,
    Violation(String),
    Menu(MenuEvent),
    Tray(TrayIconEvent),
}

pub fn run() -> i32 {
    let writer = Arc::new(LinkWriter::new(std::io::stdout()));
    if let Some(reason) = preflight() {
        return unavailable(&writer, reason);
    }
    // The event loop panics where the toolkit cannot start (no display server answering).
    let built = std::panic::catch_unwind(|| EventLoopBuilder::<UserEvent>::with_user_event().build());
    let mut event_loop = match built {
        Ok(event_loop) => event_loop,
        Err(_) => return unavailable(&writer, "the native toolkit could not start (see the log above)".to_owned()),
    };
    if let Err(error) = wry::webview_version() {
        return unavailable(&writer, format!("no usable webview runtime: {error}"));
    }
    #[cfg(target_os = "macos")]
    {
        use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};
        // No dock icon until `Helper.Init` says the app wants one.
        event_loop.set_activation_policy(ActivationPolicy::Accessory);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = &mut event_loop;

    let proxy = Arc::new(Mutex::new(event_loop.create_proxy()));
    let send = {
        let proxy = Arc::clone(&proxy);
        move |event: UserEvent| -> bool { proxy.lock().unwrap_or_else(|p| p.into_inner()).send_event(event).is_ok() }
    };
    {
        let for_menu = send.clone();
        MenuEvent::set_event_handler(Some(move |event| {
            for_menu(UserEvent::Menu(event));
        }));
        let for_tray = send.clone();
        TrayIconEvent::set_event_handler(Some(move |event| {
            for_tray(UserEvent::Tray(event));
        }));
    }
    std::thread::spawn(move || {
        let mut reader = FrameReader::new(std::io::stdin().lock());
        loop {
            match read_inbound(&mut reader) {
                Inbound::Request { id, kind, request } => {
                    if !send(UserEvent::Request { id, kind, request }) {
                        return;
                    }
                }
                Inbound::Closed => {
                    send(UserEvent::LinkClosed);
                    return;
                }
                Inbound::Violation(message) => {
                    send(UserEvent::Violation(message));
                    return;
                }
            }
        }
    });

    let tray = tray_probe::tray_available();
    writer.notify(Notification::Ready { version: crate::VERSION.to_owned(), tray });

    let mut helper = Helper::new(tray);
    let mut state = backend::GuiState::new(Arc::clone(&writer));
    // Set when this process chose to end, so the loop's end is not reported as the OS quitting.
    let mut ending = false;
    event_loop.run(move |event, target, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(UserEvent::Request { id, kind, request }) => {
                let mut gui = GuiBackend::new(&mut state, target);
                if let Err(error) = dispatch(&mut helper, &mut gui, &writer, id, &kind, request) {
                    eprintln!("telo-desktop-host: writing the response to {kind} failed: {error}");
                    ending = true;
                    *control_flow = ControlFlow::ExitWithCode(EXIT_LINK_CLOSED);
                } else if helper.quit_served() {
                    ending = true;
                    *control_flow = ControlFlow::ExitWithCode(0);
                }
            }
            Event::UserEvent(UserEvent::LinkClosed) => {
                eprintln!("telo-desktop-host: the host closed the link; exiting");
                ending = true;
                *control_flow = ControlFlow::ExitWithCode(EXIT_LINK_CLOSED);
            }
            Event::UserEvent(UserEvent::Violation(message)) => {
                eprintln!("telo-desktop-host: protocol violation: {message}");
                ending = true;
                *control_flow = ControlFlow::ExitWithCode(EXIT_PROTOCOL);
            }
            Event::UserEvent(UserEvent::Menu(menu_event)) => {
                if let Some((tray, item)) = parse_item_id(menu_event.id.as_ref()) {
                    helper.tray_item_chosen(&*writer, tray, item);
                }
            }
            Event::UserEvent(UserEvent::Tray(tray_event)) => {
                // Only Windows separates a primary click from opening the menu.
                if cfg!(windows) {
                    if let TrayIconEvent::Click { id, button: tray_icon::MouseButton::Left, button_state: tray_icon::MouseButtonState::Up, .. } = tray_event {
                        helper.tray_clicked(&*writer, id.as_ref());
                    }
                }
            }
            Event::WindowEvent { window_id, event: WindowEvent::CloseRequested, .. } => {
                if let Some(name) = state.window_name(window_id) {
                    let mut gui = GuiBackend::new(&mut state, target);
                    helper.window_close_requested(&mut gui, &*writer, &name);
                }
            }
            Event::Reopen { .. } => writer.notify(Notification::Reopened),
            Event::NewEvents(StartCause::Init) => {}
            Event::LoopDestroyed => {
                // The loop ended without this process asking: the OS is quitting the app.
                if !ending {
                    writer.notify(Notification::QuitRequested);
                }
            }
            _ => {}
        }
    })
}

fn unavailable(writer: &LinkWriter, reason: String) -> i32 {
    eprintln!("telo-desktop-host: unavailable: {reason}");
    writer.notify(Notification::Unavailable { reason });
    EXIT_UNAVAILABLE
}

/// Refusals decidable before the toolkit starts.
fn preflight() -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        let set = |name: &str| std::env::var_os(name).is_some_and(|value| !value.is_empty());
        if !set("WAYLAND_DISPLAY") && !set("DISPLAY") {
            return Some("no display (neither WAYLAND_DISPLAY nor DISPLAY is set)".to_owned());
        }
    }
    None
}
