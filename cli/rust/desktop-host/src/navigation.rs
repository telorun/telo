//! What the helper does when a webview wants to navigate or open a window: keep the
//! page on the application's origin or the host's, and hand everything else to the
//! host.
//!
//! A navigation, link, form post or `window.open` that leaves both origins never
//! loads in the window: it is cancelled and reported as `Navigation.External`. A
//! `window.open` / `target=_blank` on the application's origin is cancelled too and
//! reported as `Window.OpenRequested`, so the host decides whether another window
//! opens. One on the host's origin opens nothing: the host's pages are reached only
//! through URLs the host gave the window, so it is only logged, without its URL.
//!
//! No Node twin: this crate has none (see `lib.rs`).

use crate::helper::Notifier;
use crate::messages::Notification;
use crate::origin::{Destination, Origins};

/// Whether the window's webview may load `url`. Returns `false` for a cancelled one.
pub fn on_navigation(origins: &Origins, notifier: &dyn Notifier, window: &str, url: &str) -> bool {
    match origins.classify(url) {
        Destination::App | Destination::Host | Destination::Blank => true,
        Destination::External => {
            notifier.notify(Notification::NavigationExternal { window: window.to_owned(), url: url.to_owned() });
            false
        }
    }
}

/// A webview asked for a new window. Always cancelled; the host is told where it was going.
/// A new `about:blank` window (a script's bare `window.open()`) has nowhere to go and is
/// cancelled silently, which is why popups that rely on `window.opener` are unsupported.
pub fn on_new_window(origins: &Origins, notifier: &dyn Notifier, window: &str, url: &str) {
    match origins.classify(url) {
        Destination::Blank => {}
        Destination::App => notifier.notify(Notification::WindowOpenRequested { from_window: window.to_owned(), url: url.to_owned() }),
        Destination::Host => eprintln!("telo-desktop-host: window '{window}' asked to open a page of the host's own in a new window; nothing opens"),
        Destination::External => notifier.notify(Notification::NavigationExternal { window: window.to_owned(), url: url.to_owned() }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::origin::Origin;
    use std::cell::RefCell;

    #[derive(Default)]
    struct Recorder(RefCell<Vec<Notification>>);

    impl Notifier for Recorder {
        fn notify(&self, notification: Notification) {
            self.0.borrow_mut().push(notification);
        }
    }

    fn origins() -> Origins {
        Origins::new(Origin::parse("http://127.0.0.1:5000").unwrap(), Origin::parse("http://127.0.0.1:5001").unwrap()).unwrap()
    }

    #[test]
    fn both_origins_and_the_blank_document_load_and_report_nothing() {
        let notes = Recorder::default();
        assert!(on_navigation(&origins(), &notes, "w", "http://127.0.0.1:5000/a?b#c"));
        assert!(on_navigation(&origins(), &notes, "w", "http://127.0.0.1:5001/admit?code=c"));
        assert!(on_navigation(&origins(), &notes, "w", "about:blank"));
        assert!(notes.0.borrow().is_empty());
    }

    #[test]
    fn another_origin_is_cancelled_and_reported_once() {
        let notes = Recorder::default();
        assert!(!on_navigation(&origins(), &notes, "w", "https://id.example.com/authorize?x=1"));
        assert!(!on_navigation(&origins(), &notes, "w", "http://127.0.0.1:5000@evil.com/"));
        assert!(!on_navigation(&origins(), &notes, "w", "http://127.0.0.1:5002/"));
        assert_eq!(
            *notes.0.borrow(),
            [
                Notification::NavigationExternal { window: "w".into(), url: "https://id.example.com/authorize?x=1".into() },
                Notification::NavigationExternal { window: "w".into(), url: "http://127.0.0.1:5000@evil.com/".into() },
                Notification::NavigationExternal { window: "w".into(), url: "http://127.0.0.1:5002/".into() },
            ]
        );
    }

    #[test]
    fn a_new_window_is_reported_by_where_it_was_going_and_one_on_the_host_origin_opens_nothing() {
        let notes = Recorder::default();
        on_new_window(&origins(), &notes, "w", "http://127.0.0.1:5000/settings");
        on_new_window(&origins(), &notes, "w", "https://example.com/");
        on_new_window(&origins(), &notes, "w", "about:blank");
        on_new_window(&origins(), &notes, "w", "http://127.0.0.1:5001/return?code=r");
        assert_eq!(
            *notes.0.borrow(),
            [
                Notification::WindowOpenRequested { from_window: "w".into(), url: "http://127.0.0.1:5000/settings".into() },
                Notification::NavigationExternal { window: "w".into(), url: "https://example.com/".into() },
            ]
        );
    }
}
