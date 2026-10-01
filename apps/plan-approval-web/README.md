# Plan approval — review UI

The reviewer's single-page app for the [plan-approval server](../plan-approval/README.md):
the inbox, plan pages, revision diffs, comments and decisions, product and
repository settings, and runners. A private workspace package, never published;
the server serves its build from `UI_DIR`. Running both is described in the
server's README, under "Running with the UI".

It calls only the review surface (`/api/review/`) on its own origin. Every
write carries the author name entered at the top of the page, remembered in the
browser and never verified.

## Pages

| Path | Page |
| --- | --- |
| `/` | Inbox across products and repositories, filtered by product, repository, status and waiting time (`?product=&repo=&status=&age=`), with `overdue` as the server reports it. |
| `/plans/{id}` | The latest revision rendered as Markdown with raw HTML shown as text; a comment control on every heading or list item whose ID the server stored for that revision; the diff; the timeline; decisions; links; the session and its runner; the history export. |
| `/settings` | Products (deadline, webhook URL, the latest delivery attempts and their errors, history export) and repositories, with registration. |
| `/runners`, `/runners/{name}` | Runners with their last report and repositories; a runner's active sessions (each stoppable), its inactive sessions and its command history with outcomes — both newest first, 50 at a time, with "Load older" — and starting a session. |

## Revision diff

Any two revisions compare as a line diff of their bodies and an item summary,
computed in the browser. The base defaults to the last revision a reviewer
commented on or decided. An item's text runs from its own line to the line
before the next item or heading; an ID in both revisions whose text differs is
**changed**.
A line inside a fenced code block declares no item, as on the server: it
gets no comment control and belongs to the text of the item above it.

The decisions offered are only those the plan's state allows; a refusal from the
server is shown with its code and message.

## Runner page refresh

A runner's commands and sessions are never deleted, so the page never reads
them whole. It reads the newest page of each list (`order=desc`), "Load older"
reads the next one down (`before=<cursor>`), and every 5 seconds it re-reads
only what is on screen: the runner, its active sessions (`state=active`), and
each window from its oldest shown entry up (`order=desc&after=<oldest − 1>`,
paging by `before` until a short page). A window that already holds its whole
list is re-read from the start, so a session that turns inactive shows wherever
it falls; a tick that arrives while a window is still being re-read is skipped.

## Development

```sh
pnpm --filter @telorun/plan-approval-web build      # type-check and build to dist/
pnpm --filter @telorun/plan-approval-web test       # unit tests
pnpm --filter @telorun/plan-approval-web dev        # Vite, proxying /api to PLAN_APPROVAL_SERVER (default http://localhost:8080)
```

Demo data for a fresh database comes from the server's seed application, once
per `DB_FILE` (a second run fails with `ERR_PRODUCT_EXISTS`):

```sh
PLAN_APPROVAL_URL=http://127.0.0.1:8080 pnpm run telo ./apps/plan-approval/demo/telo.yaml
```
