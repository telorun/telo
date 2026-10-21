# Report console — a data-driven screen in two languages

A monthly report console declared in one manifest, with no hand-written
frontend, served in English or Polish by the browser's language. Its backend is
a set of stub routes answering fixture data, so it runs with no Google account
and no timesheet service; a real backend replaces `stub-api.yaml` and nothing
else.

| File | Holds |
| --- | --- |
| `telo.yaml` | the application: the shapes the screen and the routes share, the pages, the server |
| `stub-api.yaml` | the routes the screen calls, over fixture functions |
| `polish.yaml` | the translator and its Polish catalog — the console's texts and the renderer's own words |
| `console.css` | the dark-blue table header, over the renderer's part names |

## Run

```sh
pnpm run telo ./examples/report-console/telo.yaml
```

Then open <http://127.0.0.1:8140>, with the browser's language set to Polish
to see it translated. Override the port with the `PORT` env var. **Connect
Google** goes to a consent stand-in that grants at once;
`/api/auth/consent?outcome=denied` and `?outcome=expired` answer as a refused
or lapsed consent would.

The UI and translation modules are not released yet, so this example imports
`ui`, `ui-react` and `i18n` from this workspace by relative path and runs only
from a checkout. Its other imports are pinned.

## What the screen does

```
Http.Server (:8140)
├── /api/auth  → authApi     (sign-in check, connect, consent, sign out)
├── /api       → consoleApi  (guarded: 401 without a session)
└── /          → UiReact.App
                 ├── /          Reports: sign-in gate → account, report form, answer
                 └── /projects  Projects: a table of one sheet's projects
```

- **Sign-in gate.** A `Ui.Data` reader over `/api/auth` draws the banner with
  **Connect Google** or the console, by `data.authorized`. It reads again when
  the window regains focus and whenever a request inside it answers 401, so an
  ended session swaps the form for the banner while the form keeps what was
  entered. A refused consent comes back as `?signin=denied` (a declared query
  parameter) and a lapsed one as `failure: expired` in the check's answer; each
  draws its own notice.
- **The form** is a `Ui.Action` posting to `/api/generate`:
  - the timesheet and the upload folder are pickers over the Drive listing,
    searched as you type, each choice linked to its file and a sheet showing
    its owner as a hint; both are remembered in the browser (`state`) and labelled again from
    the Drive when the page opens;
  - everything but the source section stays hidden until a sheet is chosen;
  - the period is a date range with presets, starting at last month, warning
    past one month; the API refuses one that ends before it starts;
  - the projects are the chosen sheet's — changing the sheet reads them again
    and keeps only the chosen ones it still has; none chosen means all;
  - columns are a fixed-order list with defaults, the hours format a pair of
    options, merging and a chart two switches, each with its hint;
  - the button stays disabled, saying why, until a column is chosen, and a new
    sheet, period, project choice or columns clear the last answer.
- **The answer** is drawn as node trees over `result`: a heading with a plural
  count, a notice of skipped projects, two empty states, three danger boxes
  shown only when they hold something, the merged file and the chart when
  produced, and the files list. Its amount and currency columns appear on a
  billing report only — one whose columns include an amount. Each row offers
  **Draft e-mail**, disabled for a project with no address, whose draft link
  replaces the button, and **Upload**, which sends the folder chosen at the
  press and the period the report was generated for, one press at a time.
  A refusal is drawn as `HTTP <status> · <code>` and its message.
- **The projects page** is a `Ui.Table` over `/api/projects`, filtered by the
  page address's `sheet` (the report links to it), with a confirmed
  **Remind** on every row that has an address.

## Translation

Every text is written in English (`lang: en`). `polish.yaml` holds one
`I18n.Catalog` with the Polish for each of them — page and node texts, the
models' titles, descriptions and option labels, plural headings in Polish's
four forms, and every word the renderer draws on its own (`Ui.words`). The
`I18n.Negotiator` named `language` picks the catalog language the
`Accept-Language` header falls back to, and the application serves its
documents in it; `telo check` warns about a catalog entry that matches no
text.

## Routes

| Method | Path | Answers |
| --- | --- | --- |
| `GET` | `/api/auth` | `{ authorized, failure? }` from the session cookie |
| `POST` | `/api/auth/connect` | `{ url }`, the consent address |
| `GET` | `/api/auth/consent?outcome=` | 302 to `/`, setting the session; `denied` / `expired` redirect to `/?signin=<outcome>` |
| `POST` | `/api/auth/signout` | 200, clearing the session |
| `GET` | `/api/auth/user` | `{ email }` |
| `GET` | `/api/drive/files` | a page of files: `kind`, `name.contains`, `id.in`, `limit`, `cursor` |
| `GET` | `/api/projects` | a page of projects: `spreadsheetId`, `id.in`, `limit`, `cursor` |
| `POST` | `/api/generate` | the report; 404 for an unknown sheet, 409 for a closed one, 400 for a reversed period |
| `POST` | `/api/draft` | 201 `{ url }`, the draft |
| `POST` | `/api/upload` | 201 `{ link, target }`; 404 for an unknown folder |
| `POST` | `/api/projects/remind` | `{ sentTo }` |

Every route under `/api` but the sign-in ones answers
`401 { code: UNAUTHORIZED, message }` without a session.

## Tests

`tests/serves-the-console.yaml` reads the application and page documents in
both languages; `tests/answers-every-route.yaml` calls every route above.

```sh
pnpm run telo ./examples/test-suite.yaml --include 'report-console/tests/*.yaml'
```
