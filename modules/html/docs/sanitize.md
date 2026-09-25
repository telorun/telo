---
description: "Html.SafeTree: sanitizing untrusted HTML against an allowlist — the policy, the URL rule, and the presets"
sidebar_label: Sanitizing
---

# Sanitizing

`Html.SafeTree` reduces untrusted markup to what a policy allows. The policy is an
allowlist: nothing is kept unless it is listed, and nothing is merged in from any
default. The output is an `Html.Parsed` carrying the input's `baseUrl`; render it
with `Html.Markup`.

```yaml
- name: clean
  invoke: !ref Html.basicFormatting
  inputs: { document: !cel "steps.parse.result" }
```

## The policy

| Key | Meaning |
| --- | --- |
| `elements` | HTML elements kept, by local name. An element whose content is raw text, and `svg`, `math` or `image`, cannot be listed (below). |
| `attributes` | Per element name, or `"*"` for every kept element: attribute name → constraint. |
| `setAttributes` | Per element name: attribute name → a value forced onto the element. |
| `dropContent` | Elements removed with everything inside them. Default `[script, style]`. |
| `comments` | Keep comments. Default `false`. |
| `idPrefix` | Prefixed onto every kept `id` and `name` value. |

Every level of the policy is closed, and the policy is literal — it cannot be
computed by an expression.

### Elements: keep, unwrap, drop

Each element of the input is handled by the first rule that applies:

1. **Dropped** — its local name is in `dropContent`, in **any** namespace (an SVG
   `<script>` is dropped like an HTML one). It is removed with everything inside
   it.
2. **Kept** — it is an HTML-namespace element whose name is in `elements`. It
   stays, with only the attributes the policy allows, and its children go through
   the policy.
3. **Unwrapped** — anything else. The element goes and its children stay, passed
   through the policy in its place. This includes **every foreign element**: an
   SVG or MathML element is never kept, whatever `elements` says, because their
   vocabularies carry scriptable behaviour of their own (`<svg:a xlink:href>`,
   `<svg:animate>`). A `<template>` unwraps to its contents.

Text is kept. A comment is kept only with `comments: true`, and never one that,
written on its own, would not read back as itself — a comment whose text would
end it early (`-->`, `--!>`, a leading `>` or `->`) is removed even then. A
doctype is removed. Text nodes left side by side by unwrapping are merged.

### Elements that cannot be kept

An element whose content is raw text — `script`, `style`, `xmp`, `iframe`,
`noembed`, `noframes`, `plaintext`, `noscript` (the parser runs with scripting
enabled) — holds no elements to filter, only text the browser runs or renders as
it is, so an allowlist cannot vet it. `elements` cannot list one: remove it with
`dropContent`, or leave it out.

`svg`, `math` and `image` cannot be listed either: markup never writes them as
HTML elements — `<svg>` and `<math>` start SVG and MathML content, and `<image>`
reads back as `<img>`.

Both are refusals of the policy, listed with their rule codes under
[A policy that is refused](#a-policy-that-is-refused).

### The output always serializes

A tree the parser did not build can put content where markup cannot express it,
so a kept element's children are placed where they can be written:

- a kept **void element** (`img`, `br`, `input`, `hr`, …) keeps no children — they
  follow it as its next siblings, through the policy as usual;
- a kept **`textarea`** or **`title`** holds only the text of what was inside it,
  after the policy ran over it (a dropped element contributes nothing).

Unwrapping can still leave a tree whose markup reads back differently — an `<a>`
left inside another `<a>`, a `tr` directly inside a `table`. After the walk the
output goes through the same readback `Html.Markup` makes (see
[Markup](./rendering.md#faithful-or-refused)); while it does not read back as
itself it is replaced by what it reads back as, at most three times. So elements
the parser implies may appear without being listed — `<table><tr>` comes out as
`<table><tbody><tr>` — and nested anchors come apart. A tree still unstable after
three replacements is refused with `ERR_HTML_NOT_SERIALIZABLE`, the kind's one
declared error, naming the first differing node's path.

So `Html.Markup` never refuses `SafeTree` output.

### Attributes

An attribute is kept only when the element is kept and the attribute is listed for
its name or under `"*"`; when both list it, the element's own entry applies.
Attribute names match `^[a-z][a-z0-9:_.-]*$`, and a name starting with `on` —
every event handler — cannot be listed at all (`HTML_SANITIZE_EVENT_HANDLER`,
below).

A constraint says which values pass:

| Constraint | A value passes when |
| --- | --- |
| `{}` | always |
| `values: [...]` | it equals one of them |
| `prefixes: [...]` | it starts with one of them |
| `values` and `prefixes` | it passes either |
| `protocols: [...]` | the URL rule below, for a URL-bearing attribute |

### The URL rule

These attributes hold URLs: `href`, `src`, `srcset`, `action`, `formaction`,
`cite`, `poster`, `background`, `longdesc`, `xlink:href`. One of them keeps its
value only when the URL is **relative** or its **scheme** is in the constraint's
`protocols`. A URL-bearing attribute cannot be allowed without `protocols`, and
`javascript` and `vbscript` cannot be listed (both refused below).

The scheme is read as a browser reads it: tab, line feed and carriage return are
removed from anywhere in the value, leading and trailing control characters and
spaces are trimmed, and the scheme is what precedes the first `:` when that prefix
is a valid scheme (`^[a-zA-Z][a-zA-Z0-9+.-]*$`), compared case-insensitively. So
` JaVa\tScRiPt:x` has the scheme `javascript`. A value with no scheme — a path,
`#fragment`, `?query`, or a scheme-relative `//host/path` — is relative.

`srcset` is split into its comma-separated candidates and the URL of each (the
text before its first space) is checked; one disallowed candidate removes the
whole attribute.

### `setAttributes`

`setAttributes` is applied to a kept element after its attributes are filtered,
and wins over any value the element carried — `input: { type: checkbox,
disabled: "" }` makes every kept `<input>` a disabled checkbox whatever it was. A
forced value is written as given: `idPrefix` never touches it. An event handler
cannot be forced (`HTML_SANITIZE_EVENT_HANDLER_FORCED`, below).

### `idPrefix`

User content kept on a page shares the page's id namespace, so a kept
`id="login"` could collide with, or be mistaken for, the page's own. `idPrefix`
moves the content's ids — and everything pointing at them — out of the way:

- every kept `id` and `name` value is prefixed (`id="install"` →
  `id="user-content-install"`);
- every token of a kept **id-reference attribute** is prefixed:
  `for`, `headers`, `list`, `form`, `itemref`, `popovertarget`, `commandfor`,
  `aria-activedescendant`, `aria-controls`, `aria-describedby`, `aria-details`,
  `aria-errormessage`, `aria-flowto`, `aria-labelledby`, `aria-owns`
  (`aria-describedby="hint lbl"` → `"user-content-hint user-content-lbl"`);
- a **fragment-only URL** (`href="#install"`) is rewritten to `#<prefix>install`
  only when it points at an element kept in the same sanitized tree — found as
  HTML finds a fragment's target: the fragment percent-decoded, matched against a
  kept element's `id`, then a kept `<a>`'s `name`. A fragment with no such target
  (`#top` on a page that declares none) and an empty `#` are left alone, so they
  keep meaning what they meant on the page.

A policy with `idPrefix` must allow `id` or `name` somewhere, or there is nothing
to prefix.

### A policy that is refused

A policy that contradicts itself, or keeps what no allowlist can make safe, is
reported by `telo check` as `RESOURCE_RULE_VIOLATED` — the rule code in
`data.rule`, anchored at the offending entry where the rule names one — and
refused by the controller when the resource is created
(`ERR_HTML_SANITIZE_POLICY_INVALID`, its message naming the same code):

| Rule | Anchored at | Refused |
| --- | --- | --- |
| `HTML_SANITIZE_RAW_TEXT_ELEMENT` | the `elements` entry | An element whose content is raw text, listed in `elements`. |
| `HTML_SANITIZE_NOT_AN_HTML_ELEMENT` | the `elements` entry | `svg`, `math` or `image` listed in `elements`. |
| `HTML_SANITIZE_SCRIPT_PROTOCOL` | the element's `attributes` entry | `javascript` or `vbscript` in any `protocols`. |
| `HTML_SANITIZE_URL_WITHOUT_PROTOCOLS` | the element's `attributes` entry | A URL-bearing attribute allowed without `protocols`. |
| `HTML_SANITIZE_EVENT_HANDLER` | the element's `attributes` entry | An event handler (a name starting with `on`) allowed, which would let script from the untrusted input through. |
| `HTML_SANITIZE_EVENT_HANDLER_FORCED` | the element's `setAttributes` entry | An event handler forced, which would put the policy author's own script onto every kept element. |
| `HTML_SANITIZE_UNKNOWN_ELEMENT` | the element's `attributes` entry | An `attributes` key (other than `"*"`) that `elements` does not list. |
| `HTML_SANITIZE_UNKNOWN_ELEMENT_FORCED` | the element's `setAttributes` entry | A `setAttributes` key that `elements` does not list. |
| `HTML_SANITIZE_DROP_ALLOWED` | the resource | An element in both `elements` and `dropContent` (the default one included). |
| `HTML_SANITIZE_ID_PREFIX_UNUSED` | the resource | `idPrefix` set while no element (nor `"*"`) allows `id` or `name`. |

## Presets

Invoke one with `invoke: !ref Html.<preset>`. Changing a preset is a changelog
entry.

- **`stripAll`** — `elements: []`: only the text remains.
- **`basicFormatting`** — `p, br, a, em, strong, code, ul, ol, li, blockquote`,
  with `a href` allowed for `http`, `https` and `mailto`.
- **`richContent`** — `basicFormatting` plus `h1`–`h6`, `table, thead, tbody, tr,
  th, td`, `pre`, `img` (`src` for `http` and `https`, `alt`, `title`, `width`,
  `height`), `hr`, `del`, `details`, `summary`, and a task-list checkbox: `input`
  with no attributes of its own and `type=checkbox`, `disabled` forced by
  `setAttributes`. `code` keeps a `class` starting with `language-`, every kept
  element keeps its `id` and `name`, and `idPrefix` is `user-content-` — so a
  heading's anchor and the `#` links to it survive, prefixed.
