# hello-desktop

`hello-web` in a desktop shell: a window on `/`, a hidden settings window on `/settings` and a tray icon whose menu opens either, writes a status line to the log (`Console.writeLine`) and quits. The web app is unchanged — this wrapper starts it with `App.Instance`, takes the port the desktop host supplies, and opens windows on it. Closing the window hides it; the app keeps running until Quit.

```
telo run ./examples/hello-desktop
telo package ./examples/hello-desktop --out dist/Hello
```

A second `telo run` shows the running instance's windows and exits 0. `icon.png` (1024 × 1024) and `tray.png` ship with the app with no `files:` entry.

The test runs the wrapper against a fixture desktop host and checks what it asks for; no window opens.
