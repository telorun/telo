# notes-desktop

`notes-web` in a desktop window. Sign-in goes through an OIDC-style provider: the window's navigation to the provider opens in the system browser, and when the provider sends the browser back to `/auth/callback` (a path named in `callbackPaths`) the desktop host shows the return page there and replays the request in the window, which ends signed in. A provider answering with `form_post` is handled the same way.

```
PROVIDER_URL=https://id.example.com CLIENT_ID=notes telo run ./examples/notes-desktop
```

Things to know:

- **The redirect address is `http://127.0.0.1:53817/auth/callback`.** A provider that matches the redirect address exactly needs a fixed port, which is why the root port declares `default: 53817`; an app that does not need that leaves the default out and lets the host remember a port.
- A sign-in that opens a popup window is not supported; use the redirect flow shown here.
- The host re-enters the window only for a declared callback path, once per sign-in started from it.

How the host returns a sign-in is covered by the CLI's desktop sign-in tests; this example's test checks the wrapper.
