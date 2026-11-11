# notes-web

A web app that signs users in through an OIDC-style identity provider (authorization code flow):

- `GET /` shows who is signed in, or a sign-in link.
- `GET /auth/login` sets a `notes-state` cookie and redirects to `<provider>/authorize` with `client_id`, `redirect_uri` (`http://127.0.0.1:<port>/auth/callback`), `state` and `response_mode`.
- `GET|POST /auth/callback` checks the returned `state` against the cookie, trades the `code` at `<provider>/token` and starts a session (`notes-session` cookie). A mismatched state, an unknown or already used code is answered 400.

Variables: `PROVIDER_URL`, `CLIENT_ID` and `RESPONSE_MODE` (`query` or `form_post`). The cookies are not `Secure` so the app works on `http://127.0.0.1`; a `form_post` return that arrives cross-site needs `SameSite=None` over https, which `notes-desktop` avoids because its host re-submits the form from the app's own origin.

`tests/__fixtures__/identity-provider` is the provider the test signs in through. `examples/notes-desktop` wraps this app in a desktop window.
