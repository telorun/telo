# External sign-in

A navigation to another origin never loads in a window: an `http` or `https` one opens in the system browser, as an embedded sign-in page is what identity providers refuse. The sign-in returns through the application's own origin, so the web application's redirect address works unchanged.

- Declare the return paths on the need: `callbackPaths: [/auth/callback]`. Nothing is armed without them.
- Register `http://127.0.0.1:<port>/auth/callback` with the provider. A provider that accepts any loopback port needs nothing more. One that matches the redirect address exactly needs the root's port to declare a `default:`, since the origin is then the same on every launch.
- The return is a `GET`, or a `POST` of `application/x-www-form-urlencoded` (`response_mode=form_post`; the web application needs a urlencoded body parser). The browser shows "Return to <productName> to finish signing in." and the host replays the request inside the window that left, so the session ends up in the window.
- A `POST` is replayed through a page on the host origin — a second loopback port of the host's own, assigned at every launch — which submits the form to the application with the host origin as `Origin`. A web application that allowlists the `Origin` of its callback `POST` must accept that origin, as a `form_post` callback already must accept the provider's.
- One return per external navigation, on exactly the declared path; anything else is `403`.
- A popup flow that relies on `window.opener` is not supported: the system browser has no opener.
- The host cannot tell a genuine return from a forged one; the web application's own `state` / PKCE check is the protection.
