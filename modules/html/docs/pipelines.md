---
description: "Composing the html kinds: fetch, parse, isolate the article and convert to Markdown; one parse feeding several readers"
sidebar_label: Pipelines
---

# Pipelines

Parse once with `Html.JsonTree`, then hand the page to every kind that reads it:
each takes `document: !cel "steps.<parse>.result"` and returns a value.

## Fetch → parse → main content → Markdown

```yaml
kind: Telo.Application
metadata: { name: ArticleToMarkdown }
imports:
  Html: oci://ghcr.io/telorun/html@0.1.0
  Http: oci://ghcr.io/telorun/http-client@0.22.2
  Run: oci://ghcr.io/telorun/run@0.27.1
variables:
  url: { env: ARTICLE_URL, type: string }
targets:
  - !ref convert
---
kind: Run.Sequence
metadata: { name: convert }
steps:
  - name: fetch
    invoke: { kind: Http.Request }
    inputs:
      url: !cel "variables.url"
      responseType: bytes
  - name: parse
    invoke: { kind: Html.JsonTree }
    inputs:
      html:
        bytes: !cel "steps.fetch.result.body"
      baseUrl: !cel "variables.url"
  - name: main
    invoke: { kind: Html.MainContent }
    inputs: { document: !cel "steps.parse.result" }
  - name: markdown
    invoke: { kind: Html.Markdown }
    inputs: { document: !cel "steps.main.result.content" }
outputs:
  title: !cel "has(steps.main.result.title) ? steps.main.result.title : ''"
  markdown: !cel "steps.markdown.result.markdown"
```

Passing the undecoded bytes lets the page's own `<meta charset>` decide the
encoding; add `charset:` when the response declared one. Passing the fetched URL
as `baseUrl` is what makes the article's links absolute.

## One parse, several readers

```yaml
steps:
  - name: parse
    invoke: { kind: Html.JsonTree }
    inputs: { html: !cel "inputs.html", baseUrl: !cel "inputs.url" }
  - name: meta
    invoke: { kind: Html.Metadata }
    inputs: { document: !cel "steps.parse.result" }
  - name: main
    invoke: { kind: Html.MainContent }
    inputs: { document: !cel "steps.parse.result" }
  - name: clean
    invoke: !ref Html.richContent
    inputs: { document: !cel "steps.main.result.content" }
  - name: html
    invoke: { kind: Html.Markup }
    inputs: { document: !cel "steps.clean.result" }
```

A page is a value, so no step changes what another reads: `Metadata` and
`MainContent` both see the page as parsed.
