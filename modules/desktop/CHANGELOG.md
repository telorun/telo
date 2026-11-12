# Changelog

## 0.2.0 - 2026-11-12
### Added
* Documentation: `telo run` as the desktop host (single instance, remembered loopback origin, admission through a second loopback origin of the host's own that serves every page the host shows, startup view), external sign-in through the need's `callbackPaths` (a `form_post` return arrives with the host origin as `Origin`), windows shown where the session has no tray, and what `onClose: hide` means for stopping.

## 0.1.0 - 2026-11-09
### Added
* New module: native windows (Desktop.Window), a tray icon with a menu of actions (Desktop.TrayIcon), Desktop.ShowWindow and Desktop.Quit, speaking the desktop_host-1 protocol to any desktop host supplied through the Telo.DesktopHost need.
