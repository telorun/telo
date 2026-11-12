# notes-web

A notes app where every user keeps their own notes, signed in through an OIDC-style identity provider (authorization code flow):

- `GET /` is a declared UI page (`UiReact.App`) that reads `GET /api/session` and shows the signed-in user's notes — a list with create, edit and delete — or a sign-in button.
- `GET /api/session` answers `{ user }` for the session cookie, `""` when nobody is signed in.
- `/api/notes` serves the signed-in user's notes in the collection contract the page's listing reads: `GET /` (a page of notes, filtered by `text.contains`, sorted by `updatedAt`), `GET /{id}`, `POST /`, `PUT /{id}` and `DELETE /{id}`. Each note is stored with its owner's subject, and every statement is held to the caller's own rows, so another user's note answers 404 exactly as one that does not exist. A request with no session is answered 401.
- `GET /auth/login` sets a `notes-state` cookie and redirects to `<provider>/authorize` with `client_id`, `redirect_uri` (`/auth/callback` on the host the browser used, so the state cookie returns with it whether the page is opened as `localhost` or `127.0.0.1`), `state` and `response_mode`.
- `GET|POST /auth/callback` checks the returned `state` against the cookie, trades the `code` at `<provider>/token` and starts a session (`notes-session` cookie). A mismatched state, an unknown or already used code is answered 400.

```
telo run ./examples/notes-web
```

It starts `identity-provider/` itself, a stand-in provider that signs `alice` in at once (`STAND_IN_USER` changes the name, `PROVIDER_PORT` the port, default 8081), so the sign-in works with nothing registered. To use a real provider set `PROVIDER_URL` and `CLIENT_ID`, and register `/auth/callback` at the address you open the app at (`http://localhost:<PORT>/auth/callback`, say) with it.

Variables: `PROVIDER_URL` (empty means the stand-in), `CLIENT_ID`, `STAND_IN_USER`, `RESPONSE_MODE` (`query` or `form_post`) and `DB_FILE`, the SQLite file the notes are kept in (`notes-web.db` in the working directory by default), which also keeps the sessions, so a restart signs nobody out. A browser holding a session the server no longer has is shown a sign-in again. The cookies are not `Secure` so the app works over plain `http` on this machine; a `form_post` return that arrives cross-site needs `SameSite=None` over https, which `notes-desktop` avoids because its host re-submits the form from the app's own origin. A write to `/api/notes` must come from the page's own origin: the session cookie is refused on a cross-origin write.

The tests sign in through the stand-in: `signs-in.yaml` the sign-in itself, `keeps-notes-apart.yaml` two users over one database. `examples/notes-desktop` wraps this app in a desktop window.
