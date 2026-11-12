# notes-web

A web app that signs users in through an OIDC-style identity provider (authorization code flow):

- `GET /` is a declared UI page (`UiReact.App`) that reads `GET /api/session` and shows who is signed in, or a sign-in button.
- `GET /api/session` answers `{ user }` for the session cookie, `""` when nobody is signed in.
- `GET /auth/login` sets a `notes-state` cookie and redirects to `<provider>/authorize` with `client_id`, `redirect_uri` (`http://127.0.0.1:<port>/auth/callback`), `state` and `response_mode`.
- `GET|POST /auth/callback` checks the returned `state` against the cookie, trades the `code` at `<provider>/token` and starts a session (`notes-session` cookie). A mismatched state, an unknown or already used code is answered 400.

```
telo run ./examples/notes-web
```

It starts `identity-provider/` itself, a stand-in provider that signs `alice` in at once (`STAND_IN_USER` changes the name, `PROVIDER_PORT` the port, default 8081), so the sign-in works with nothing registered. To use a real provider set `PROVIDER_URL` and `CLIENT_ID`, and register `http://127.0.0.1:<PORT>/auth/callback` with it.

Variables: `PROVIDER_URL` (empty means the stand-in), `CLIENT_ID`, `STAND_IN_USER` and `RESPONSE_MODE` (`query` or `form_post`). The cookies are not `Secure` so the app works on `http://127.0.0.1`; a `form_post` return that arrives cross-site needs `SameSite=None` over https, which `notes-desktop` avoids because its host re-submits the form from the app's own origin.

The tests sign in through the stand-in. `examples/notes-desktop` wraps this app in a desktop window.
