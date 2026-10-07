# Ui.View

One node tree, declared once and placed wherever it is needed.

| Field | | |
| --- | --- | --- |
| `content` | required | one [node](nodes.md) |

```yaml
kind: Ui.View
metadata: { name: summary }
content:
  type: stack
  children:
    - { type: text, text: This week, style: heading }
    - { type: composite, ref: !ref weeklyTable }
```

Expressions in a view are evaluated once, when the application starts. A view
whose `content` is switched off by its own `when` provides no node, so the
node that placed it is left out.

A view is what a kind with no controller provides through — see
[Ui.Composite](composite.md).
