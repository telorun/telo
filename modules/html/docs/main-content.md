---
description: "Html.MainContent: isolating a page's main article from navigation, sidebars and ads"
sidebar_label: Main content
---

# Main content

`Html.MainContent` finds the main article in a page and drops everything around
it — navigation, sidebars, ads, comment sections, footers.

```yaml
- name: main
  invoke: { kind: Html.MainContent }
  inputs: { document: !cel "steps.parse.result" }
```

It returns `content`, an `Html.Parsed` holding the article, and — when the page
declares them — `title`, `byline`, `excerpt`, `siteName`, `lang`, `dir` and
`publishedTime`. Relative links and media in `content` are resolved against the
page's base URL, which `content.baseUrl` carries. When no part of the page scores
as an article, the call fails with `ERR_HTML_NO_MAIN_CONTENT`.

The detector works on a document built from the page tree on every call; the page
it was given is never changed, and no HTML text is parsed again.

| Config | Meaning | Default |
| --- | --- | --- |
| `charThreshold` | The fewest characters an article must have. | `500` |
| `nbTopCandidates` | How many top-scoring candidates are compared. | `5` |
| `keepClasses` | Keep `class` attributes. | `false` |
| `classesToPreserve` | Classes kept even when `keepClasses` is off. | — |
| `linkDensityModifier` | Added to the link-density limits; raise it to keep link-heavy content. | `0` |
| `videoHosts` | Hosts whose embedded videos are kept, each with its subdomains (`youtube.com` keeps `www.youtube.com`). | the detector's own list |
| `jsonLd` | Read title, author and dates from the page's JSON-LD. | `true` |

Short pages need a lower `charThreshold`: an article shorter than it is not
accepted.
