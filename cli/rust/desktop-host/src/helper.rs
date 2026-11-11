//! The helper's state machine: which windows and tray icons exist, and what each
//! request and each user action does to them. Everything a native toolkit does is
//! behind [`Backend`], so the rules are tested without one.
//!
//! No Node twin: this crate has none (see `lib.rs`).

use crate::messages::{codes, Failure, Init, Notification, OnClose, Request, ResponseBody, TrayOpen, WindowOpen};
use crate::origin::Destination;
use std::collections::{HashMap, HashSet};

/// What the native toolkit does. Errors carry the reason a request failed.
pub trait Backend {
    /// Called once, by `Helper.Init`, before any window: data store, dock policy, window icon.
    fn configure(&mut self, init: &Init) -> Result<(), String>;
    fn open_window(&mut self, spec: &WindowOpen) -> Result<(), String>;
    /// Shows the window and focuses it.
    fn show_window(&mut self, window: &str) -> Result<(), String>;
    fn hide_window(&mut self, window: &str) -> Result<(), String>;
    /// Focuses a window without changing whether it is shown.
    fn focus_window(&mut self, window: &str) -> Result<(), String>;
    fn navigate(&mut self, window: &str, url: &str) -> Result<(), String>;
    fn close_window(&mut self, window: &str);
    fn open_tray(&mut self, spec: &TrayOpen) -> Result<(), String>;
    fn close_tray(&mut self, tray: &str);
}

/// Where helper-originated notifications go: the link, in production.
pub trait Notifier {
    fn notify(&self, notification: Notification);
}

struct WindowState {
    on_close: OnClose,
}

pub struct Helper {
    tray_available: bool,
    init: Option<Init>,
    windows: HashMap<String, WindowState>,
    trays: HashSet<String>,
    quit: bool,
}

impl Helper {
    pub fn new(tray_available: bool) -> Self {
        Helper { tray_available, init: None, windows: HashMap::new(), trays: HashSet::new(), quit: false }
    }

    /// Whether `Helper.Quit` has been served: the loop ends after its response is written.
    pub fn quit_served(&self) -> bool {
        self.quit
    }

    pub fn handle(&mut self, backend: &mut dyn Backend, request: Request) -> Result<ResponseBody, Failure> {
        match request {
            Request::Init(init) => {
                if self.init.is_some() {
                    return Err(Failure::new(codes::ALREADY_INITIALIZED, "Helper.Init was already served"));
                }
                backend.configure(&init).map_err(failed)?;
                self.init = Some(init);
                Ok(ResponseBody::Empty)
            }
            Request::WindowOpen(spec) => {
                self.require_init()?;
                self.require_internal(&spec.window, &spec.url)?;
                if self.windows.contains_key(&spec.window) {
                    return Err(Failure::new(codes::REQUEST_FAILED, format!("window '{}' is already open", spec.window)));
                }
                backend.open_window(&spec).map_err(failed)?;
                self.windows.insert(spec.window, WindowState { on_close: spec.on_close });
                Ok(ResponseBody::Empty)
            }
            Request::WindowShow { window } => {
                self.held(&window)?;
                backend.show_window(&window).map_err(failed)?;
                Ok(ResponseBody::Empty)
            }
            Request::WindowHide { window } => {
                self.held(&window)?;
                backend.hide_window(&window).map_err(failed)?;
                Ok(ResponseBody::Empty)
            }
            Request::WindowFocus { window } => {
                self.held(&window)?;
                backend.focus_window(&window).map_err(failed)?;
                Ok(ResponseBody::Empty)
            }
            Request::WindowNavigate { window, url } => {
                self.held(&window)?;
                self.require_internal(&window, &url)?;
                backend.navigate(&window, &url).map_err(failed)?;
                Ok(ResponseBody::Empty)
            }
            Request::WindowClose { window } => {
                // Closing one already closed is `ok`; no `Window.Closed` follows a close asked for.
                if self.windows.remove(&window).is_some() {
                    backend.close_window(&window);
                }
                Ok(ResponseBody::Empty)
            }
            Request::TrayOpen(spec) => {
                self.require_init()?;
                if !self.tray_available {
                    return Ok(ResponseBody::Available(false));
                }
                if self.trays.contains(&spec.tray) {
                    return Err(Failure::new(codes::REQUEST_FAILED, format!("tray '{}' is already open", spec.tray)));
                }
                backend.open_tray(&spec).map_err(failed)?;
                self.trays.insert(spec.tray);
                Ok(ResponseBody::Available(true))
            }
            Request::TrayClose { tray } => {
                if self.trays.remove(&tray) {
                    backend.close_tray(&tray);
                }
                Ok(ResponseBody::Empty)
            }
            Request::HelperQuit => {
                for window in self.windows.drain().map(|(name, _)| name).collect::<Vec<_>>() {
                    backend.close_window(&window);
                }
                for tray in self.trays.drain().collect::<Vec<_>>() {
                    backend.close_tray(&tray);
                }
                self.quit = true;
                Ok(ResponseBody::Empty)
            }
        }
    }

    /// The user closed a window: one declared `onClose: hide` is hidden, stays
    /// held and the host is told (`Window.Hidden`), one declared `close` is
    /// destroyed and the host told (`Window.Closed`).
    pub fn window_close_requested(&mut self, backend: &mut dyn Backend, notifier: &dyn Notifier, window: &str) {
        let Some(state) = self.windows.get(window) else { return };
        match state.on_close {
            OnClose::Hide => {
                match backend.hide_window(window) {
                    Ok(()) => notifier.notify(Notification::WindowHidden { window: window.to_owned() }),
                    Err(reason) => eprintln!("telo-desktop-host: hiding window '{window}' failed: {reason}"),
                }
            }
            OnClose::Close => {
                self.windows.remove(window);
                backend.close_window(window);
                notifier.notify(Notification::WindowClosed { window: window.to_owned() });
            }
        }
    }

    /// A tray menu item was chosen. Nothing is reported for a tray the host does not hold.
    pub fn tray_item_chosen(&self, notifier: &dyn Notifier, tray: &str, item: u32) {
        if self.trays.contains(tray) {
            notifier.notify(Notification::TrayItemChosen { tray: tray.to_owned(), item });
        }
    }

    pub fn tray_clicked(&self, notifier: &dyn Notifier, tray: &str) {
        if self.trays.contains(tray) {
            notifier.notify(Notification::TrayClicked { tray: tray.to_owned() });
        }
    }

    fn require_init(&self) -> Result<&Init, Failure> {
        self.init.as_ref().ok_or_else(|| Failure::new(codes::NOT_INITIALIZED, "Helper.Init has not been served"))
    }

    fn held(&self, window: &str) -> Result<(), Failure> {
        self.require_init()?;
        if self.windows.contains_key(window) {
            Ok(())
        } else {
            Err(Failure::new(codes::UNKNOWN_ENTRY, format!("no window '{window}' is held")))
        }
    }

    /// A window loads only the application's origin and the host's; the URL is not
    /// repeated in the refusal, since it can carry a single-use code.
    fn require_internal(&self, window: &str, url: &str) -> Result<(), Failure> {
        let init = self.require_init()?;
        match init.origins.classify(url) {
            Destination::App | Destination::Host => Ok(()),
            _ => Err(Failure::new(
                codes::REQUEST_FAILED,
                format!("window '{window}' was given a URL on neither {} nor {}", init.origins.app.text(), init.origins.host.text()),
            )),
        }
    }
}

fn failed(reason: String) -> Failure {
    Failure::new(codes::REQUEST_FAILED, reason)
}

#[cfg(test)]
pub(crate) mod testing {
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    pub struct Fake {
        pub calls: Vec<String>,
        pub fail_open_window: bool,
    }

    impl Backend for Fake {
        fn configure(&mut self, init: &Init) -> Result<(), String> {
            self.calls.push(format!("configure {}", init.identifier));
            Ok(())
        }
        fn open_window(&mut self, spec: &WindowOpen) -> Result<(), String> {
            if self.fail_open_window {
                return Err("no webview".into());
            }
            self.calls.push(format!("open {} visible={}", spec.window, spec.visible));
            Ok(())
        }
        fn show_window(&mut self, window: &str) -> Result<(), String> {
            self.calls.push(format!("show {window}"));
            Ok(())
        }
        fn hide_window(&mut self, window: &str) -> Result<(), String> {
            self.calls.push(format!("hide {window}"));
            Ok(())
        }
        fn focus_window(&mut self, window: &str) -> Result<(), String> {
            self.calls.push(format!("focus {window}"));
            Ok(())
        }
        fn navigate(&mut self, window: &str, url: &str) -> Result<(), String> {
            self.calls.push(format!("navigate {window} {url}"));
            Ok(())
        }
        fn close_window(&mut self, window: &str) {
            self.calls.push(format!("close {window}"));
        }
        fn open_tray(&mut self, spec: &TrayOpen) -> Result<(), String> {
            self.calls.push(format!("open-tray {}", spec.tray));
            Ok(())
        }
        fn close_tray(&mut self, tray: &str) {
            self.calls.push(format!("close-tray {tray}"));
        }
    }

    #[derive(Default)]
    pub struct Recorder(pub RefCell<Vec<Notification>>);

    impl Notifier for Recorder {
        fn notify(&self, notification: Notification) {
            self.0.borrow_mut().push(notification);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::menu::MenuEntry;
    use crate::origin::{Origin, Origins};
    use crate::messages::Size;
    use super::testing::{Fake, Recorder};
    use std::path::PathBuf;

    fn init() -> Init {
        Init {
            identifier: "run.telo.test".into(),
            product_name: "Test".into(),
            origins: Origins::new(Origin::parse("http://127.0.0.1:5000").unwrap(), Origin::parse("http://127.0.0.1:5001").unwrap()).unwrap(),
            webview_directory: PathBuf::from("/w"),
            show_in_dock: true,
            icon: None,
        }
    }

    fn open(window: &str, on_close: OnClose, visible: bool) -> Request {
        Request::WindowOpen(WindowOpen {
            window: window.into(),
            url: format!("http://127.0.0.1:5001/admit?code=c-{window}"),
            title: None,
            size: Some(Size { width: 1.0, height: 1.0 }),
            min_size: None,
            resizable: true,
            visible,
            on_close,
        })
    }

    fn tray(name: &str) -> Request {
        Request::TrayOpen(TrayOpen { tray: name.into(), icon: PathBuf::from("/t.png"), monochrome: false, tooltip: None, menu: vec![MenuEntry::Separator] })
    }

    fn ready(tray_available: bool) -> (Helper, Fake) {
        let mut helper = Helper::new(tray_available);
        let mut fake = Fake::default();
        helper.handle(&mut fake, Request::Init(init())).unwrap();
        fake.calls.clear();
        (helper, fake)
    }

    fn code(result: Result<ResponseBody, Failure>) -> &'static str {
        result.unwrap_err().code
    }

    #[test]
    fn nothing_is_served_before_init_and_init_is_served_once() {
        let mut helper = Helper::new(true);
        let mut fake = Fake::default();
        assert_eq!(code(helper.handle(&mut fake, open("w", OnClose::Close, true))), codes::NOT_INITIALIZED);
        assert_eq!(code(helper.handle(&mut fake, tray("t"))), codes::NOT_INITIALIZED);
        assert_eq!(code(helper.handle(&mut fake, Request::WindowShow { window: "w".into() })), codes::NOT_INITIALIZED);
        helper.handle(&mut fake, Request::Init(init())).unwrap();
        assert_eq!(code(helper.handle(&mut fake, Request::Init(init()))), codes::ALREADY_INITIALIZED);
        assert_eq!(fake.calls, ["configure run.telo.test"]);
    }

    #[test]
    fn opens_a_window_once_and_only_on_one_of_the_two_origins() {
        let (mut helper, mut fake) = ready(true);
        helper.handle(&mut fake, open("main", OnClose::Hide, false)).unwrap();
        assert_eq!(fake.calls, ["open main visible=false"]);
        assert_eq!(code(helper.handle(&mut fake, open("main", OnClose::Hide, true))), codes::REQUEST_FAILED);
        let at = |url: &str| Request::WindowOpen(WindowOpen { url: url.into(), ..match open("x", OnClose::Close, true) { Request::WindowOpen(w) => w, _ => unreachable!() } });
        let failure = helper.handle(&mut fake, at("http://evil.com/?code=secret")).unwrap_err();
        assert_eq!(failure.code, codes::REQUEST_FAILED);
        assert!(!failure.message.contains("secret"), "{}", failure.message);
        helper.handle(&mut fake, at("http://127.0.0.1:5000/settings")).unwrap();
        assert_eq!(fake.calls, ["open main visible=false", "open x visible=true"]);
    }

    #[test]
    fn a_backend_that_cannot_open_a_window_fails_the_request_and_holds_nothing() {
        let (mut helper, mut fake) = ready(true);
        fake.fail_open_window = true;
        let failure = helper.handle(&mut fake, open("main", OnClose::Close, true)).unwrap_err();
        assert_eq!((failure.code, failure.message.as_str()), (codes::REQUEST_FAILED, "no webview"));
        fake.fail_open_window = false;
        helper.handle(&mut fake, open("main", OnClose::Close, true)).unwrap();
    }

    #[test]
    fn show_hide_focus_navigate_need_a_held_window() {
        let (mut helper, mut fake) = ready(true);
        for request in [
            Request::WindowShow { window: "no".into() },
            Request::WindowHide { window: "no".into() },
            Request::WindowFocus { window: "no".into() },
            Request::WindowNavigate { window: "no".into(), url: "http://127.0.0.1:5000/".into() },
        ] {
            assert_eq!(code(helper.handle(&mut fake, request)), codes::UNKNOWN_ENTRY);
        }
        helper.handle(&mut fake, open("w", OnClose::Close, true)).unwrap();
        fake.calls.clear();
        helper.handle(&mut fake, Request::WindowHide { window: "w".into() }).unwrap();
        helper.handle(&mut fake, Request::WindowShow { window: "w".into() }).unwrap();
        helper.handle(&mut fake, Request::WindowFocus { window: "w".into() }).unwrap();
        helper.handle(&mut fake, Request::WindowNavigate { window: "w".into(), url: "http://127.0.0.1:5000/cb?x=1".into() }).unwrap();
        helper.handle(&mut fake, Request::WindowNavigate { window: "w".into(), url: "http://127.0.0.1:5001/return?code=r".into() }).unwrap();
        assert_eq!(fake.calls, ["hide w", "show w", "focus w", "navigate w http://127.0.0.1:5000/cb?x=1", "navigate w http://127.0.0.1:5001/return?code=r"]);
        let away = Request::WindowNavigate { window: "w".into(), url: "https://id.example.com/".into() };
        assert_eq!(code(helper.handle(&mut fake, away)), codes::REQUEST_FAILED);
    }

    #[test]
    fn closing_is_idempotent_and_reports_nothing() {
        let (mut helper, mut fake) = ready(true);
        helper.handle(&mut fake, open("w", OnClose::Close, true)).unwrap();
        fake.calls.clear();
        helper.handle(&mut fake, Request::WindowClose { window: "w".into() }).unwrap();
        helper.handle(&mut fake, Request::WindowClose { window: "w".into() }).unwrap();
        helper.handle(&mut fake, Request::WindowClose { window: "never".into() }).unwrap();
        assert_eq!(fake.calls, ["close w"]);
        assert_eq!(code(helper.handle(&mut fake, Request::WindowShow { window: "w".into() })), codes::UNKNOWN_ENTRY);
    }

    #[test]
    fn the_user_closing_a_window_hides_or_destroys_by_its_declaration() {
        let (mut helper, mut fake) = ready(true);
        let notes = Recorder::default();
        helper.handle(&mut fake, open("hidden", OnClose::Hide, true)).unwrap();
        helper.handle(&mut fake, open("gone", OnClose::Close, true)).unwrap();
        fake.calls.clear();
        helper.window_close_requested(&mut fake, &notes, "hidden");
        assert_eq!(fake.calls, ["hide hidden"]);
        assert_eq!(*notes.0.borrow(), [Notification::WindowHidden { window: "hidden".into() }]);
        helper.window_close_requested(&mut fake, &notes, "gone");
        assert_eq!(fake.calls, ["hide hidden", "close gone"]);
        assert_eq!(
            *notes.0.borrow(),
            [Notification::WindowHidden { window: "hidden".into() }, Notification::WindowClosed { window: "gone".into() }]
        );
        // The hidden one is still held, the other is not.
        helper.handle(&mut fake, Request::WindowShow { window: "hidden".into() }).unwrap();
        assert_eq!(code(helper.handle(&mut fake, Request::WindowShow { window: "gone".into() })), codes::UNKNOWN_ENTRY);
        // A close for a window nothing holds is ignored.
        helper.window_close_requested(&mut fake, &notes, "gone");
        assert_eq!(notes.0.borrow().len(), 2);
    }

    #[test]
    fn a_tray_opens_where_the_session_has_one() {
        let (mut helper, mut fake) = ready(true);
        let notes = Recorder::default();
        assert_eq!(helper.handle(&mut fake, tray("t")).unwrap(), ResponseBody::Available(true));
        assert_eq!(code(helper.handle(&mut fake, tray("t"))), codes::REQUEST_FAILED);
        helper.tray_item_chosen(&notes, "t", 1);
        helper.tray_clicked(&notes, "t");
        helper.tray_item_chosen(&notes, "other", 1);
        assert_eq!(*notes.0.borrow(), [Notification::TrayItemChosen { tray: "t".into(), item: 1 }, Notification::TrayClicked { tray: "t".into() }]);
        helper.handle(&mut fake, Request::TrayClose { tray: "t".into() }).unwrap();
        helper.handle(&mut fake, Request::TrayClose { tray: "t".into() }).unwrap();
        helper.tray_clicked(&notes, "t");
        assert_eq!(notes.0.borrow().len(), 2);
        assert_eq!(fake.calls, ["open-tray t", "close-tray t"]);
    }

    #[test]
    fn without_a_tray_every_open_answers_unavailable_and_holds_nothing() {
        let (mut helper, mut fake) = ready(false);
        let notes = Recorder::default();
        assert_eq!(helper.handle(&mut fake, tray("t")).unwrap(), ResponseBody::Available(false));
        assert_eq!(helper.handle(&mut fake, tray("t")).unwrap(), ResponseBody::Available(false));
        helper.tray_clicked(&notes, "t");
        helper.handle(&mut fake, Request::TrayClose { tray: "t".into() }).unwrap();
        assert!(fake.calls.is_empty());
        assert!(notes.0.borrow().is_empty());
    }

    #[test]
    fn quit_closes_everything_and_ends_the_loop() {
        let (mut helper, mut fake) = ready(true);
        helper.handle(&mut fake, open("w", OnClose::Hide, true)).unwrap();
        helper.handle(&mut fake, tray("t")).unwrap();
        fake.calls.clear();
        assert!(!helper.quit_served());
        helper.handle(&mut fake, Request::HelperQuit).unwrap();
        assert!(helper.quit_served());
        fake.calls.sort();
        assert_eq!(fake.calls, ["close w", "close-tray t"]);
    }
}
