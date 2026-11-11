//! The message set of the link, internal to one release (README: "Messages").
//!
//! Requests flow host to helper and are answered `{ ok }` / `{ error }`;
//! notifications flow helper to host and are never answered. A payload is a closed
//! object: a missing member, a member of the wrong type and a member the table does
//! not list are each a protocol violation, which ends the link.
//!
//! No Node twin: this crate has none (see `lib.rs`).

use crate::envelope::{violation, ProtocolError};
use crate::menu::{read_menu, MenuEntry};
use crate::origin::{Origin, Origins};
use crate::payload::Fields;
use serde_json::{json, Value};
use std::path::PathBuf;

/// Error codes of an `{ error }` response. The first two are `desktop_host-1`'s.
pub mod codes {
    pub const UNKNOWN_ENTRY: &str = "ERR_DESKTOP_HOST_UNKNOWN_ENTRY";
    pub const REQUEST_FAILED: &str = "ERR_DESKTOP_HOST_REQUEST_FAILED";
    pub const NOT_INITIALIZED: &str = "ERR_DESKTOP_HELPER_NOT_INITIALIZED";
    pub const ALREADY_INITIALIZED: &str = "ERR_DESKTOP_HELPER_ALREADY_INITIALIZED";
}

#[derive(Debug, Clone, PartialEq)]
pub struct Failure {
    pub code: &'static str,
    pub message: String,
}

impl Failure {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Failure { code, message: message.into() }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Init {
    pub identifier: String,
    pub product_name: String,
    /// `origin` (the application's) and `hostOrigin` (the host's own pages).
    pub origins: Origins,
    pub webview_directory: PathBuf,
    pub show_in_dock: bool,
    pub icon: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Size {
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnClose {
    Close,
    Hide,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WindowOpen {
    pub window: String,
    pub url: String,
    pub title: Option<String>,
    pub size: Option<Size>,
    pub min_size: Option<Size>,
    pub resizable: bool,
    pub visible: bool,
    pub on_close: OnClose,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TrayOpen {
    pub tray: String,
    pub icon: PathBuf,
    pub monochrome: bool,
    pub tooltip: Option<String>,
    pub menu: Vec<MenuEntry>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Request {
    Init(Init),
    WindowOpen(WindowOpen),
    WindowShow { window: String },
    WindowHide { window: String },
    WindowClose { window: String },
    WindowNavigate { window: String, url: String },
    WindowFocus { window: String },
    TrayOpen(TrayOpen),
    TrayClose { tray: String },
    HelperQuit,
}

impl Request {
    pub fn parse(kind: &str, payload: &Value) -> Result<Request, ProtocolError> {
        let mut f = Fields::new(payload, "")?;
        let request = match kind {
            "Helper.Init" => Request::Init(Init {
                identifier: f.non_empty_string("identifier")?,
                product_name: f.non_empty_string("productName")?,
                origins: Origins::new(
                    Origin::parse(&f.string("origin")?).map_err(|e| violation(format!("'origin': {e}")))?,
                    Origin::parse(&f.string("hostOrigin")?).map_err(|e| violation(format!("'hostOrigin': {e}")))?,
                )
                .map_err(|e| violation(format!("'hostOrigin': {e}")))?,
                webview_directory: absolute_path(&f.string("webviewDirectory")?, "webviewDirectory")?,
                show_in_dock: f.boolean("showInDock")?,
                icon: f.opt_string("icon")?.map(|p| absolute_path(&p, "icon")).transpose()?,
            }),
            "Window.Open" => Request::WindowOpen(WindowOpen {
                window: f.non_empty_string("window")?,
                url: f.non_empty_string("url")?,
                title: f.opt_string("title")?,
                size: f.opt_object("size", read_size)?,
                min_size: f.opt_object("minSize", read_size)?,
                resizable: f.boolean("resizable")?,
                visible: f.boolean("visible")?,
                on_close: match f.string("onClose")?.as_str() {
                    "close" => OnClose::Close,
                    "hide" => OnClose::Hide,
                    other => return Err(violation(format!("'onClose' is '{other}', not 'close' or 'hide'"))),
                },
            }),
            "Window.Show" => Request::WindowShow { window: f.non_empty_string("window")? },
            "Window.Hide" => Request::WindowHide { window: f.non_empty_string("window")? },
            "Window.Close" => Request::WindowClose { window: f.non_empty_string("window")? },
            "Window.Navigate" => Request::WindowNavigate { window: f.non_empty_string("window")?, url: f.non_empty_string("url")? },
            "Window.Focus" => Request::WindowFocus { window: f.non_empty_string("window")? },
            "Tray.Open" => Request::TrayOpen(TrayOpen {
                tray: f.non_empty_string("tray")?,
                icon: absolute_path(&f.string("icon")?, "icon")?,
                monochrome: f.boolean("monochrome")?,
                tooltip: f.opt_string("tooltip")?,
                menu: read_menu(&mut f)?,
            }),
            "Tray.Close" => Request::TrayClose { tray: f.non_empty_string("tray")? },
            "Helper.Quit" => Request::HelperQuit,
            other => return Err(violation(format!("unknown request type '{other}'"))),
        };
        f.finish()?;
        Ok(request)
    }
}

fn read_size(f: &mut Fields<'_>) -> Result<Size, ProtocolError> {
    Ok(Size { width: f.extent("width")?, height: f.extent("height")? })
}

fn absolute_path(text: &str, member: &str) -> Result<PathBuf, ProtocolError> {
    let path = PathBuf::from(text);
    if !path.is_absolute() {
        return Err(violation(format!("'{member}' is not an absolute path")));
    }
    Ok(path)
}

/// The body of an `{ ok }` response.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResponseBody {
    Empty,
    Available(bool),
}

impl ResponseBody {
    pub fn to_value(self) -> Value {
        match self {
            ResponseBody::Empty => json!({}),
            ResponseBody::Available(available) => json!({ "available": available }),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Notification {
    Ready { version: String, tray: bool },
    Unavailable { reason: String },
    QuitRequested,
    Reopened,
    WindowClosed { window: String },
    WindowHidden { window: String },
    WindowOpenRequested { from_window: String, url: String },
    NavigationExternal { window: String, url: String },
    TrayItemChosen { tray: String, item: u32 },
    TrayClicked { tray: String },
}

impl Notification {
    pub fn to_wire(&self) -> (&'static str, Value) {
        match self {
            Notification::Ready { version, tray } => ("Helper.Ready", json!({ "version": version, "tray": tray })),
            Notification::Unavailable { reason } => ("Helper.Unavailable", json!({ "reason": reason })),
            Notification::QuitRequested => ("Helper.QuitRequested", json!({})),
            Notification::Reopened => ("Helper.Reopened", json!({})),
            Notification::WindowClosed { window } => ("Window.Closed", json!({ "window": window })),
            Notification::WindowHidden { window } => ("Window.Hidden", json!({ "window": window })),
            Notification::WindowOpenRequested { from_window, url } => ("Window.OpenRequested", json!({ "fromWindow": from_window, "url": url })),
            Notification::NavigationExternal { window, url } => ("Navigation.External", json!({ "window": window, "url": url })),
            Notification::TrayItemChosen { tray, item } => ("Tray.ItemChosen", json!({ "tray": tray, "item": item })),
            Notification::TrayClicked { tray } => ("Tray.Clicked", json!({ "tray": tray })),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn abs(path: &str) -> String {
        if cfg!(windows) { format!("C:{path}") } else { path.to_owned() }
    }

    fn init_payload() -> Value {
        json!({
            "identifier": "run.telo.examples.hello",
            "productName": "Hello",
            "origin": "http://127.0.0.1:53817",
            "hostOrigin": "http://127.0.0.1:53900",
            "webviewDirectory": abs("/data/webview"),
            "showInDock": false,
        })
    }

    #[test]
    fn reads_init_with_and_without_an_icon() {
        let Request::Init(init) = Request::parse("Helper.Init", &init_payload()).unwrap() else { panic!() };
        assert_eq!((init.origins.app.text(), init.origins.host.text()), ("http://127.0.0.1:53817".into(), "http://127.0.0.1:53900".into()));
        assert_eq!(init.icon, None);
        let mut with_icon = init_payload();
        with_icon["icon"] = json!(abs("/app/icon.png"));
        let Request::Init(init) = Request::parse("Helper.Init", &with_icon).unwrap() else { panic!() };
        assert_eq!(init.icon, Some(PathBuf::from(abs("/app/icon.png"))));
    }

    #[test]
    fn init_refuses_a_bad_origin_a_relative_path_and_an_unlisted_member() {
        for (key, value) in [("origin", json!("http://127.0.0.1:1/x")), ("hostOrigin", json!("http://127.0.0.1:1/x")), ("hostOrigin", json!("http://127.0.0.1:53817")), ("webviewDirectory", json!("relative")), ("extra", json!(1)), ("showInDock", json!("no")), ("icon", json!("icon.png"))] {
            let mut payload = init_payload();
            payload[key] = value;
            assert!(Request::parse("Helper.Init", &payload).is_err(), "{key}");
        }
        for member in ["identifier", "hostOrigin"] {
            let mut missing = init_payload();
            missing.as_object_mut().unwrap().remove(member);
            assert!(Request::parse("Helper.Init", &missing).is_err(), "{member}");
        }
    }

    #[test]
    fn reads_window_open_with_optional_members() {
        let minimal = json!({ "window": "main", "url": "http://127.0.0.1:2/admit?code=c", "resizable": true, "visible": false, "onClose": "hide" });
        let Request::WindowOpen(open) = Request::parse("Window.Open", &minimal).unwrap() else { panic!() };
        assert_eq!((open.size, open.min_size, open.title, open.on_close, open.visible), (None, None, None, OnClose::Hide, false));
        let full = json!({
            "window": "main", "url": "http://127.0.0.1:1/", "title": "T", "size": { "width": 480, "height": 320.5 },
            "minSize": { "width": 320, "height": 240 }, "resizable": false, "visible": true, "onClose": "close"
        });
        let Request::WindowOpen(open) = Request::parse("Window.Open", &full).unwrap() else { panic!() };
        assert_eq!(open.size, Some(Size { width: 480.0, height: 320.5 }));
        assert_eq!(open.on_close, OnClose::Close);
    }

    #[test]
    fn window_open_refuses_a_bad_size_and_a_bad_on_close() {
        let base = |extra: Value| {
            let mut payload = json!({ "window": "w", "url": "u", "resizable": true, "visible": true, "onClose": "close" });
            for (k, v) in extra.as_object().unwrap() {
                payload[k] = v.clone();
            }
            payload
        };
        for extra in [
            json!({ "size": { "width": 0, "height": 5 } }),
            json!({ "size": { "width": -1, "height": 5 } }),
            json!({ "size": { "width": 5 } }),
            json!({ "size": { "width": 5, "height": 5, "depth": 1 } }),
            json!({ "size": "big" }),
            json!({ "onClose": "minimize" }),
        ] {
            assert!(Request::parse("Window.Open", &base(extra.clone())).is_err(), "{extra}");
        }
    }

    #[test]
    fn reads_the_small_requests() {
        assert_eq!(Request::parse("Window.Show", &json!({ "window": "a" })).unwrap(), Request::WindowShow { window: "a".into() });
        assert_eq!(Request::parse("Window.Navigate", &json!({ "window": "a", "url": "u" })).unwrap(), Request::WindowNavigate { window: "a".into(), url: "u".into() });
        assert_eq!(Request::parse("Helper.Quit", &json!({})).unwrap(), Request::HelperQuit);
        assert!(Request::parse("Helper.Quit", &json!({ "now": true })).is_err());
        assert!(Request::parse("Window.Show", &json!({ "window": "" })).is_err());
        assert!(Request::parse("Window.Explode", &json!({})).is_err());
    }

    #[test]
    fn reads_tray_open_with_its_menu() {
        let payload = json!({
            "tray": "t", "icon": abs("/app/tray.png"), "monochrome": true, "tooltip": "Hello",
            "menu": [{ "type": "item", "item": 0, "label": "Open", "enabled": true }, { "type": "separator" }]
        });
        let Request::TrayOpen(open) = Request::parse("Tray.Open", &payload).unwrap() else { panic!() };
        assert_eq!(open.menu.len(), 2);
        assert!(open.monochrome);
        let mut relative = payload.clone();
        relative["icon"] = json!("tray.png");
        assert!(Request::parse("Tray.Open", &relative).is_err());
    }

    #[test]
    fn notifications_have_the_documented_wire_form() {
        let cases = [
            (Notification::Ready { version: "0.133.0".into(), tray: false }, "Helper.Ready", json!({ "version": "0.133.0", "tray": false })),
            (Notification::Unavailable { reason: "no display".into() }, "Helper.Unavailable", json!({ "reason": "no display" })),
            (Notification::QuitRequested, "Helper.QuitRequested", json!({})),
            (Notification::Reopened, "Helper.Reopened", json!({})),
            (Notification::WindowClosed { window: "w".into() }, "Window.Closed", json!({ "window": "w" })),
            (Notification::WindowHidden { window: "w".into() }, "Window.Hidden", json!({ "window": "w" })),
            (Notification::WindowOpenRequested { from_window: "w".into(), url: "u".into() }, "Window.OpenRequested", json!({ "fromWindow": "w", "url": "u" })),
            (Notification::NavigationExternal { window: "w".into(), url: "u".into() }, "Navigation.External", json!({ "window": "w", "url": "u" })),
            (Notification::TrayItemChosen { tray: "t".into(), item: 2 }, "Tray.ItemChosen", json!({ "tray": "t", "item": 2 })),
            (Notification::TrayClicked { tray: "t".into() }, "Tray.Clicked", json!({ "tray": "t" })),
        ];
        for (notification, kind, payload) in cases {
            assert_eq!(notification.to_wire(), (kind, payload));
        }
    }

    #[test]
    fn response_bodies() {
        assert_eq!(ResponseBody::Empty.to_value(), json!({}));
        assert_eq!(ResponseBody::Available(true).to_value(), json!({ "available": true }));
    }
}
