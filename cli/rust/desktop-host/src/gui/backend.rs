//! The toolkit behind [`Backend`]: tao windows carrying wry webviews, tray-icon
//! icons with muda menus. Type-checked but never run (see `gui.rs`).
//!
//! No Node twin: this crate has none (see `lib.rs`).

use crate::helper::Backend;
use crate::icon;
use crate::link::LinkWriter;
use crate::menu::{item_id, MenuEntry};
use crate::messages::{Init, TrayOpen, WindowOpen};
use crate::navigation;
use std::collections::HashMap;
use std::sync::Arc;
use tao::dpi::LogicalSize;
use tao::event_loop::EventLoopWindowTarget;
use tao::window::{Icon as WindowIcon, Window, WindowBuilder, WindowId};
use tray_icon::menu::{Menu, MenuId, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon as TrayImage, TrayIcon, TrayIconBuilder};
use wry::{NewWindowResponse, WebView, WebViewBuilder};

use super::UserEvent;

/// A window and the webview in it. The webview is dropped first.
struct GuiWindow {
    _webview: WebView,
    window: Window,
}

/// Everything the toolkit holds, between requests.
pub struct GuiState {
    notifier: Arc<LinkWriter>,
    init: Option<Init>,
    window_icon: Option<WindowIcon>,
    #[cfg(not(target_os = "macos"))]
    web_context: Option<wry::WebContext>,
    #[cfg(target_os = "macos")]
    _app_menu: Option<Menu>,
    windows: HashMap<String, GuiWindow>,
    names: HashMap<WindowId, String>,
    trays: HashMap<String, TrayIcon>,
}

impl GuiState {
    pub fn new(notifier: Arc<LinkWriter>) -> Self {
        GuiState {
            notifier,
            init: None,
            window_icon: None,
            #[cfg(not(target_os = "macos"))]
            web_context: None,
            #[cfg(target_os = "macos")]
            _app_menu: None,
            windows: HashMap::new(),
            names: HashMap::new(),
            trays: HashMap::new(),
        }
    }

    pub fn window_name(&self, id: WindowId) -> Option<String> {
        self.names.get(&id).cloned()
    }
}

/// [`GuiState`] with the event loop's window target, which only exists inside a
/// handler call and is what creates windows.
pub struct GuiBackend<'a> {
    state: &'a mut GuiState,
    target: &'a EventLoopWindowTarget<UserEvent>,
}

impl<'a> GuiBackend<'a> {
    pub fn new(state: &'a mut GuiState, target: &'a EventLoopWindowTarget<UserEvent>) -> Self {
        GuiBackend { state, target }
    }

    fn window(&self, window: &str) -> Result<&GuiWindow, String> {
        self.state.windows.get(window).ok_or_else(|| format!("no window '{window}'"))
    }
}

impl Backend for GuiBackend<'_> {
    fn configure(&mut self, init: &Init) -> Result<(), String> {
        if let Some(path) = &init.icon {
            let image = icon::read_png(path)?;
            self.state.window_icon = Some(WindowIcon::from_rgba(image.pixels, image.width, image.height).map_err(|e| format!("the window icon is unusable: {e}"))?);
        }
        #[cfg(not(target_os = "macos"))]
        {
            std::fs::create_dir_all(&init.webview_directory)
                .map_err(|e| format!("cannot create the webview directory {}: {e}", init.webview_directory.display()))?;
            self.state.web_context = Some(wry::WebContext::new(Some(init.webview_directory.clone())));
        }
        #[cfg(target_os = "macos")]
        {
            use tao::platform::macos::{ActivationPolicy, EventLoopWindowTargetExtMacOS};
            if init.show_in_dock {
                self.target.set_activation_policy_at_runtime(ActivationPolicy::Regular);
            }
            self.state._app_menu = Some(install_app_menu(&init.product_name)?);
        }
        self.state.init = Some(init.clone());
        Ok(())
    }

    fn open_window(&mut self, spec: &WindowOpen) -> Result<(), String> {
        let init = self.state.init.clone().ok_or("Helper.Init has not been served")?;
        let mut builder = WindowBuilder::new()
            .with_title(spec.title.clone().unwrap_or_else(|| init.product_name.clone()))
            .with_resizable(spec.resizable)
            .with_visible(spec.visible);
        if let Some(size) = spec.size {
            builder = builder.with_inner_size(LogicalSize::new(size.width, size.height));
        }
        if let Some(size) = spec.min_size {
            builder = builder.with_min_inner_size(LogicalSize::new(size.width, size.height));
        }
        if let Some(icon) = self.state.window_icon.clone() {
            builder = builder.with_window_icon(Some(icon));
        }
        let window = builder.build(self.target).map_err(|e| format!("cannot create the window: {e}"))?;

        let on_navigate = {
            let (origins, notifier, name) = (init.origins.clone(), Arc::clone(&self.state.notifier), spec.window.clone());
            move |url: String| navigation::on_navigation(&origins, &*notifier, &name, &url)
        };
        let on_new_window = {
            let (origins, notifier, name) = (init.origins.clone(), Arc::clone(&self.state.notifier), spec.window.clone());
            move |url: String, _features: wry::NewWindowFeatures| {
                navigation::on_new_window(&origins, &*notifier, &name, &url);
                NewWindowResponse::Deny
            }
        };

        #[cfg(target_os = "macos")]
        let base = {
            use wry::WebViewBuilderExtDarwin;
            // Never the shared default store: one per application identifier.
            WebViewBuilder::new().with_data_store_identifier(crate::store::data_store_identifier(&init.identifier))
        };
        #[cfg(not(target_os = "macos"))]
        let base = {
            let context = self.state.web_context.as_mut().ok_or("Helper.Init has not been served")?;
            WebViewBuilder::new_with_web_context(context)
        };
        let builder = base.with_url(spec.url.clone()).with_navigation_handler(on_navigate).with_new_window_req_handler(on_new_window);

        #[cfg(target_os = "linux")]
        let webview = {
            use tao::platform::unix::WindowExtUnix;
            use wry::WebViewBuilderExtUnix;
            let vbox = window.default_vbox().ok_or("the window has no GTK container")?;
            builder.build_gtk(vbox)
        };
        #[cfg(not(target_os = "linux"))]
        let webview = builder.build(&window);
        let webview = webview.map_err(|e| format!("cannot create the webview: {e}"))?;

        self.state.names.insert(window.id(), spec.window.clone());
        self.state.windows.insert(spec.window.clone(), GuiWindow { _webview: webview, window });
        Ok(())
    }

    fn show_window(&mut self, window: &str) -> Result<(), String> {
        let held = &self.window(window)?.window;
        held.set_visible(true);
        held.set_minimized(false);
        held.set_focus();
        Ok(())
    }

    fn hide_window(&mut self, window: &str) -> Result<(), String> {
        self.window(window)?.window.set_visible(false);
        Ok(())
    }

    fn focus_window(&mut self, window: &str) -> Result<(), String> {
        let held = &self.window(window)?.window;
        // Focusing must not show a window the host hid.
        if held.is_visible() {
            held.set_focus();
        }
        Ok(())
    }

    fn navigate(&mut self, window: &str, url: &str) -> Result<(), String> {
        // The URL stays out of the reason: it can carry a single-use code.
        self.window(window)?._webview.load_url(url).map_err(|e| format!("window '{window}' cannot load the page: {e}"))
    }

    fn close_window(&mut self, window: &str) {
        if let Some(held) = self.state.windows.remove(window) {
            self.state.names.remove(&held.window.id());
        }
    }

    fn open_tray(&mut self, spec: &TrayOpen) -> Result<(), String> {
        let image = icon::read_png(&spec.icon)?;
        let image = TrayImage::from_rgba(image.pixels, image.width, image.height).map_err(|e| format!("the tray icon is unusable: {e}"))?;
        let menu = Menu::new();
        for entry in &spec.menu {
            let appended = match entry {
                MenuEntry::Separator => menu.append(&PredefinedMenuItem::separator()),
                MenuEntry::Item { item, label, enabled } => menu.append(&MenuItem::with_id(MenuId::new(item_id(&spec.tray, *item)), label, *enabled, None)),
            };
            appended.map_err(|e| format!("cannot build the tray menu: {e}"))?;
        }
        let mut builder = TrayIconBuilder::new()
            .with_id(spec.tray.clone())
            .with_icon(image)
            .with_menu(Box::new(menu))
            // A monochrome icon is a macOS template image; the flag means nothing elsewhere.
            .with_icon_as_template(spec.monochrome)
            // Windows reports the primary click as `Tray.Clicked`, so it must not open the menu.
            .with_menu_on_left_click(!cfg!(windows));
        if let Some(tooltip) = &spec.tooltip {
            builder = builder.with_tooltip(tooltip);
        }
        let tray = builder.build().map_err(|e| format!("cannot create the tray icon: {e}"))?;
        self.state.trays.insert(spec.tray.clone(), tray);
        Ok(())
    }

    fn close_tray(&mut self, tray: &str) {
        self.state.trays.remove(tray);
    }
}

/// macOS routes the clipboard shortcuts and Quit through the menu bar; without one
/// a webview cannot copy or paste and Cmd-Q does nothing.
#[cfg(target_os = "macos")]
fn install_app_menu(product_name: &str) -> Result<Menu, String> {
    use tray_icon::menu::{IsMenuItem, Submenu};
    let failed = |e: tray_icon::menu::Error| format!("cannot build the application menu: {e}");
    let app = Submenu::with_items(
        product_name,
        true,
        &[
            &PredefinedMenuItem::hide(None) as &dyn IsMenuItem,
            &PredefinedMenuItem::hide_others(None),
            &PredefinedMenuItem::separator(),
            &PredefinedMenuItem::quit(None),
        ],
    )
    .map_err(failed)?;
    let edit = Submenu::with_items(
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(None) as &dyn IsMenuItem,
            &PredefinedMenuItem::redo(None),
            &PredefinedMenuItem::separator(),
            &PredefinedMenuItem::cut(None),
            &PredefinedMenuItem::copy(None),
            &PredefinedMenuItem::paste(None),
            &PredefinedMenuItem::select_all(None),
        ],
    )
    .map_err(failed)?;
    let window = Submenu::with_items("Window", true, &[&PredefinedMenuItem::minimize(None) as &dyn IsMenuItem, &PredefinedMenuItem::close_window(None)]).map_err(failed)?;
    let menu = Menu::new();
    menu.append_items(&[&app, &edit, &window]).map_err(failed)?;
    menu.init_for_nsapp();
    Ok(menu)
}
