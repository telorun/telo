# Tray icons

`Desktop.TrayIcon` is a `Telo.Service` for an icon in the Windows notification area, the macOS menu bar or a Linux AppIndicator.

```yaml
kind: Desktop.TrayIcon
metadata: { name: tray }
host: !ref desktopHost
icon: !module-path tray.png
monochrome: true
tooltip: Hello
menu:
  - { type: item, label: Open Hello, action: { invoke: { kind: Desktop.ShowWindow, window: !ref mainWindow } } }
  - { type: item, label: Hello 1.0, enabled: false }
  - { type: separator }
  - { type: item, label: Quit, action: { invoke: { kind: Desktop.Quit, host: !ref desktopHost } } }
```

- `icon` is a PNG file of the module written `!module-path`, scaled by the host; a file of another type is `HOST_PATH_CONTENT_MISMATCH` at check and at creation. `monochrome: true` draws it as a macOS template image.
- `tooltip` and each item's `label` are literal `Text`s, shown in the application's fallback language. `enabled` is a literal boolean, default `true`. The menu is fixed: it does not follow application state.
- An item with no `action` does nothing when chosen. On the wire an item is identified by its index in the list, separators counted.
- `action` on the icon itself is what a primary click does on Windows; elsewhere a click opens the menu.
- Where the session has no tray the host answers `available: false`: the module logs a `DESKTOP_TRAY_UNAVAILABLE` warning, shows nothing and does not hold the application for the icon.
