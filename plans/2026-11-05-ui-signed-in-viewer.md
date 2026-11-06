---
status: draft
priority: medium
depends-on: [2026-11-05-inbound-authentication.md]
packages: [modules/ui, modules/ui-react, examples/ui-showcase, apps/hub, apps/authoring-agent, docs]
---

# Screens that know who is signed in

## Problem

A screen cannot tailor itself to the signed-in person. A node's `when`, a navigation entry's `when` and a token set's `when` run per request, but their `request` holds only `headers`, `ip` and `lang`. An admin-only menu entry, a page only managers may open, or a "My tasks" view today means a `Ui.Data` reader over a session route plus a browser-side condition — which hides content without withholding it: the node is still delivered, and the page is reachable by its path. The showcase's sign-in gate is exactly this.

Home Assistant gates a card with a `user` condition. In Telo inbound authentication delivers `authentication:` on `Http.Server.mounts[]` and a typed `request.principal` (`Auth.Principal`) in route contexts; screens do not yet read it.

## Solution

**`request.principal` in every per-request screen context.** The `request` that `UiReact.App`'s per-request expressions read gains `principal`, typed `Auth.Principal` and nullable: the principal the serving mount's verifiers produced, null exactly when none accepted the request — including an unauthenticated request through a mount with `anonymous: allow` and every request through a mount with no `authentication:`. It is readable wherever `request` is today — a page's own nodes' `when` and leaf values, `UiReact.App.header`, navigation entries' `when`, `tokens` entries' `when` — and nowhere a composite is resolved once at creation (`CEL_UNKNOWN_FIELD` there). Reading a member without a null guard is `CEL_NULLABLE_ACCESS`, so "signed in" is written `request.principal != null` and a role test `request.principal != null && 'admin' in request.principal.roles`. An App reached through several mounts reads, per request, the principal of the mount that served it.

**Pages can be withheld.** `Ui.Page` gains `when`, evaluated per request with the same `request`. A page whose `when` is false is answered exactly as a path the application does not serve — the same not-found document, status and body — and for that request it is absent from the application document's page list and every navigation entry naming it is left out, with no condition repeated on the entry. The page's title, path and nodes reach no document of that request. Assets are content-addressed and reached only through documents a request is delivered; they are not secrets beyond that, and nothing secret belongs in one.

**Caching follows.** A document whose expressions read `request.principal` is built per request — never served from the per-language copy the App keeps of documents that do not — with `Cache-Control: private, no-cache`, `Vary` naming the headers the mount's credential sources read (`Cookie`, `Authorization`) beside the headers it already lists, and an ETag over its own body, so no cache, the App's own included, serves one person's document to another. The cost is one document build per such request, bounded by the expressions the page holds; nothing per person is retained in the process.

**Before / after.** Before, an admin menu entry is a navigation `when` over a header the author parses, and the admin page answers anyone who types its path. After, `when: !cel "request.principal != null && 'admin' in request.principal.roles"` on the page withholds it and its menu entry from everyone else.

## Decisions

- **Server-side `when` only; no browser root for the principal.** Content a condition hides in the browser has already been delivered, so it is not access control; a `when` decides delivery. A browser root would invite exactly the mistake this plan exists to remove.
- **Nullable everywhere, no "unauthenticated mount" rule.** Whether a request has a principal is a fact of the request; the null guard the type forces is the check. Rejected: a rule refusing a principal read on an App no authenticating mount reaches, which would need the analyzer to know whether each expression reads `request.principal` across the mount graph — and an App legitimately mounted both publicly and privately would be refused.
- **A withheld page is not-found, not forbidden.** A 403 confirms the page exists; not-found is what a page the application does not serve already answers. The API routes the page calls are protected by the routes' own `authorization:`, never by the page's `when`.
- **The principal is the identity plan's, unchanged.** `ui-react` reads the `request.principal` the mount produced and imports `auth` (MIT, like `ui-react`) for its type only; the screens define no user, session or role vocabulary of their own.
- **Withholding a page drops its navigation entries automatically.** One condition per page; repeating it on every entry is how menus and pages drift apart.
- **No `request.principal` inside composites.** A composite is resolved once at creation and shared by every request; a per-person composite is a page node with `when`, or a `Ui.Data` over a route that answers per person.

Bookkeeping: docs (`ui` `page.md`, `nodes.md`, `conditions.md` — `request.principal` beside `headers` / `ip` / `lang`; `ui-react` `app.md` § Authentication and the caching rule); the showcase's session gate rebuilt on `request.principal` once the identity modules exist, with tests under its `tests/`; the hub `build-ui` guide (within its 32768-byte bound), the primer, `modules/CLAUDE.md`; a ledger entry under Standard library, "Screens and menus per signed-in person"; `Added` fragments for `ui` and `ui-react`. `ui` and `ui-react` add vocabulary to their own kinds' schemas only, so they need no floor of their own; an application writing a page `when` declares its floor, per the grammar rule, verified by execution.

## Verify

- An App under a mount authenticating with a session verifier: a page with an admin `when` answers its document to an admin, and to another user and to an anonymous request the same not-found document, status and body as an unknown path; the app document's page list and navigation omit it for the latter two.
- On a mount with `anonymous: allow`, an unauthenticated request reads null and an authenticated one reads its principal.
- A `when` reading `request.principal.roles` without a null guard is `CEL_NULLABLE_ACCESS`; `request.principal` inside a composite's `when` is `CEL_UNKNOWN_FIELD`.
- Two users in the same language reading the same page get different bodies and ETags, with `Vary` naming `Cookie`; a document that reads no principal is still served from the per-language copy.

## Example after the change

```yaml
kind: Ui.Page
metadata: { name: adminPage }
path: /admin
title: Administration
when: !cel "request.principal != null && 'admin' in request.principal.roles"
children:
  - { type: composite, ref: !ref adminPanel }
---
kind: UiReact.App
metadata: { name: app }
title: Tasks
theme: !ref UiReact.defaultTheme
pages: [!ref home, !ref adminPage]
header:
  end:
    - type: text
      text: !cel "request.principal != null ? request.principal.subject : 'Guest'"
```
