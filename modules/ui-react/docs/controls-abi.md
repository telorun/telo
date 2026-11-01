# The controls contract — `ui_react_controls-2`

What a theme's controls are written against. The renderer draws every
interactive leaf of a page — every text box, choice, list, overlay, menu,
navigation, tab list, tooltip and glyph — through one control set: a theme's control where the
theme implements it, this module's built-in everywhere else. The built-ins are
the reference implementation; they meet this contract the way any other
implementation must.

A control is a **named export** of a browser entry: a React function
component, exported under the control's name. A module ships its controls as a
[`UiReact.Controls`](theme.md#control-sets) set — the entry and the controls
it implements — and a theme lists the sets it draws with. Composition stays the
renderer's — tables, pagers, filter bars, forms, pickers, in-flow surfaces,
buttons, links and labels are drawn by the renderer and styled with CSS only.

## The control set

The set is closed. A control's **root part** is the part its outermost element
carries; where it has several, the renderer passes the one it draws
(`part`, or `parts.root` with the names of the other parts it gives). A
control's **sub-parts** are the only other parts it may draw.

| Control | Group | Root part | Sub-parts |
| --- | --- | --- | --- |
| `TextInput` | Entry | `input`, `filter-input`, `picker-search` | — |
| `NumberInput` | Entry | `input`, `filter-input` | — |
| `TextArea` | Entry | `textarea` | — |
| `DateInput` | Entry | `input`, `filter-input` | — |
| `DateTimeInput` | Entry | `input` | — |
| `TimeInput` | Entry | `input` | — |
| `TagsInput` | Entry | `tags`, `filter-tags` | `tag`, `filter-tag`, `tag-remove`, `filter-tag-remove`, `input`, `filter-input`, `icon` |
| `DateRangeInput` | Entry | `date-range` | `date-range-presets`, `date-range-preset`, `date-range-from`, `date-range-to`, `label` |
| `Checkbox` | Choice | `checkbox` | `icon` |
| `Switch` | Choice | `switch`, `filter-toggle` | — |
| `Slider` | Choice | `slider`, `filter-slider` | `slider-value`, `filter-slider-value` |
| `OptionGroup` | Choice | `options`, `filter-options`, `filters-presets` | `option`, `filter-option`, `filters-preset` |
| `Select` | Choice | `select`, `filter-select` | `select-content`, `select-item`, `icon` |
| `MultiSelect` | Choice | `select`, `filter-select` | `select-content`, `select-item`, `icon` |
| `Listbox` | Choice | `picker-list` | `picker-option`, `option-hint` |
| `Dialog` | Overlay | `surface` | `surface-overlay` |
| `Drawer` | Overlay | `surface` | `surface-overlay` |
| `Popover` | Overlay | `surface` | — |
| `Confirmation` | Overlay | `surface` | `surface-overlay` |
| `Menu` | Overlay | `menu` | `menu-item` |
| `Tooltip` | Overlay | `tooltip` | — |
| `Navigation` | Navigation | `navigation` | `nav-item`, `nav-toggle`, `nav-group`, `nav-panel`, `icon` |
| `Tabs` | Navigation | `tabs` | `tab-list`, `tab`, `tab-panel` |
| `Icon` | Glyph | `icon` | — |

The glyph names an `Icon` is drawn with are closed too: `add`, `alert`,
`close`, `collapse`, `delete`, `edit`, `expand`, `filter`, `loading`, `menu`,
`more`, `next`, `previous`, `remove`, `reset`, `sort-ascending`,
`sort-descending`, `sortable`. A glyph inside a
control — a select's chevron, a checkbox's mark, a tag's × — is that control's
`icon` sub-part, not an `Icon`.

A `Slider` may draw its position as text — `valueText` where it is given, else
`value` — in the optional sub-part `slider-value` under `slider` and
`filter-slider-value` under `filter-slider`, marked `aria-hidden`, since the
thumb already announces it. A slider that does not draw it is still complete.

## What a control receives and what it owns

| | The renderer | The control |
| --- | --- | --- |
| State | every value and every open state | reports intents only, and draws what its props say |
| Data | validation (it passes `invalid`); reading options, paging, searching, labelling chosen values | never fetches; receives `options`, `loading`, `hasMore` |
| Dismissal | the policy: what may close a surface, the unsaved-input question, nothing closing while a form is sent | reports why it would close |
| Text | every formatting: it passes finished strings, `lang` and `weekStart` | never sees a text record |
| Semantics | `id`, the label, the description and error relations, `required`, `disabled` | forwards them to the element a person focuses |
| Interaction | the composition around the control | its role's pattern: keyboard, roving focus or an active descendant, the focus trap and the focus's return for a modal overlay, drawing a layer at the end of `<body>` with its root marked (see [Layers](#layers)), placement and collision |
| Parts | the part its root draws | its sub-parts and states; anything else it draws carries no `data-telo-part` |

Placement and collision — where an overlay or a list lands, and how it avoids
the viewport's edge — are a control's to provide and are not terms of the
contract: no check can observe them without a layout engine.

## Values

Values cross in the renderer's wire forms: text as a string, a number as its
typed text, a day as `YYYY-MM-DD`, a day and a time as `YYYY-MM-DDTHH:mm`, a
time as `HH:mm`, a date range as `{ from, to }` of two days, and an option by
the string key the renderer issued for it.

## Intents

A control is fully controlled: it reports what a person did, and the renderer
decides what changes.

- `onChange(value)` — a new value, in its wire form.
- `onOpenChange(open, reason)` — the control would open, or close: `reason` is
  `escape`, `outside` (a press or the focus outside it) or `close` (anything of
  its own, a chosen entry included), and is given only when closing. Until the
  renderer passes `open: false`, the control stays open.
- `onEndReached()` — a list was scrolled to its end: the renderer reads more
  where there is more.
- `onCommit()` — the entry is meant: Enter or leaving a text box, letting go of
  a slider. Reported after the `onChange` it means. A text box given
  `onCommit` does nothing else with Enter.

| Control | Intents, and the prop each sets |
| --- | --- |
| `TextInput` | `onChange` → `value`, `onCommit` |
| `NumberInput` | `onChange` → `value`, `onCommit` |
| `TextArea` | `onChange` → `value` |
| `DateInput` | `onChange` → `value`, `onCommit` |
| `DateTimeInput` | `onChange` → `value` |
| `TimeInput` | `onChange` → `value` |
| `TagsInput` | `onChange` → `values` |
| `DateRangeInput` | `onChange` → `value` |
| `Checkbox` | `onChange` → `checked` |
| `Switch` | `onChange` → `checked` |
| `Slider` | `onChange` → `value`, `onCommit` |
| `OptionGroup` | `onChange` → `value` |
| `Select` | `onChange` → `value`, `onOpenChange` → `open`, `onEndReached` |
| `MultiSelect` | `onChange` → `value`, `onOpenChange` → `open`, `onEndReached` |
| `Listbox` | `onChange` → `value`, `onEndReached` |
| `Dialog` | `onOpenChange` → `open` |
| `Drawer` | `onOpenChange` → `open` |
| `Popover` | `onOpenChange` → `open` |
| `Confirmation` | `onOpenChange` → `open` |
| `Menu` | `onOpenChange` → `open`, `onChange` |
| `Tooltip` | `onOpenChange` → `open` |
| `Navigation` | `onOpenChange` → `open`, `onChange` |
| `Tabs` | `onChange` → `value` |

## Overlays and anchored controls

An overlay — `Dialog`, `Drawer`, `Popover`, `Confirmation` — is given the
renderer's content as its children: the surface's header and title, its body
and its form's actions. It sets `attributes` on its root as given (the
`data-surface`, `data-side`, `data-size`, `data-align` and `data-modal` the
styling contract documents on `surface`), names itself by `labelledBy` and
`describedBy`, and draws its root, and a modal one's `surface-overlay`, at the
end of `<body>` — outside the `app` part — each a layer root carrying
`data-telo-layer`. A modal overlay holds the focus
inside it while it is open and gives it back to what had it when it closes; a
confirmation is answered only by Escape or by one of the renderer's buttons.

`Menu` and `Tooltip` are given the renderer's own element as their only child
— the filter bar's add button, an icon button — and draw it as their trigger,
carrying no state of theirs on it. `Menu` is a list of things to do
(`role="menu"`), never a list of places to go: links are `Navigation`'s.
`Popover` is placed against `anchor`, an element the renderer drew.

## Navigation

`Navigation` draws a tree of links in the WAI-ARIA disclosure navigation
pattern: every entry with an `href` is a real link (`a`, the `nav-item` part)
and every entry with `items` is a button (`nav-toggle`) disclosing them, with
`aria-expanded` and, while open, `aria-controls` naming the element its
entries are drawn in.

- **The tree.** `layout` draws the top-level entries in a row
  (`horizontal`), in a column (`vertical`), or in a column of each top-level
  entry's glyph — its first letter when it has none — (`rail`), the entry
  still named by its whole label. The root carries the layout as
  `data-layout`, and `attributes` as given.
- **Icons.** An entry's `icon` is an element the renderer drew — a `glyph`
  hidden from assistive technology — and the control places it as given,
  never copying or restyling it: before the label of the entry's link or
  button, and in a rail as the whole text of a top-level entry.
- **A landmark only when named.** Given `label`, the root is a `nav` named by
  it; without one it is no landmark — a menu node's one group is not the
  page's navigation.
- **Groups in a column open in place.** In `vertical`, an open group's
  entries are drawn in a `nav-group` right after its button, inside the
  navigation, at every depth. A `nav-group` is no layer and carries no
  `data-telo-layer`; Tab reaches its entries in the order they are drawn.
- **Groups in a row or a rail float.** In `horizontal` and `rail`, an open
  group's entries are drawn in a `nav-panel` at the end of `<body>`, a layer
  root carrying `data-telo-layer`, placed against its button: below it for a
  top-level group of a row, beside it otherwise — a rail's top-level group
  beside the rail, and a nested group beside its button in the panel holding
  it. A panel stays inside the viewport. Tab moves from an open group's button
  into its panel, and from the panel's last entry on to the entry after the
  group; Shift+Tab moves back the same way.
- **Entries opening a dialog.** An entry given `opens: "dialog"` has
  neither `href` nor `items`: it is a button (`nav-toggle`) carrying
  `aria-haspopup="dialog"`, and `aria-expanded` and `data-state` by whether
  its key is listed in `open`. It draws nothing of its own when open and has
  no `aria-controls`: a press asks for its key as a group's button would, and
  the renderer draws the dialog.
- **What does not fit.** Given `more`, a row of several top-level entries
  moves those that do not fit its width, from the end, into one more group
  drawn last, keyed and labelled by `more`; without it, every entry stays in
  the row. Like placement, this needs a layout engine to observe and is the
  control's to provide, not a term the vectors check.
- **Open groups.** `open` is the set of the open groups' keys, in any order. A
  group is drawn open when its key is listed and every group holding it is
  open, so a listed group inside a closed one stays closed until that one
  opens. `onOpenChange` reports the set a person asks for, which depends on
  the layout:
  - in `vertical`, a press on a group's button asks for the set with that one
    key added or taken out, so several groups may be open at once. Nothing
    else closes a group in place: Escape, a press or the focus outside and
    following a link ask for no change;
  - in `horizontal` and `rail`, opening a group asks for its chain — its key
    and those of the groups holding it — so every group beside it and beneath
    them closes, and a press on an open group's button asks for the groups
    holding it. Escape asks to close the innermost open group, and a press or
    the focus outside every panel and outside the navigation asks to close
    what it lies outside of in one report; closing a panel with the focus in
    it gives the focus to its button.
- **Following a link.** A plain press on a link — no modifier key, the main
  button — is reported as `onChange` with the link's key; the control keeps
  the browser from following it, and the renderer moves to it. In
  `horizontal` and `rail` it is followed, while a panel is open, by
  `onOpenChange([], "close")`; in `vertical` by nothing — closing whatever
  holds the navigation is the renderer's. Any other press on a link is the
  browser's.
- **Current.** An entry given `current` carries it as `data-current`, and a
  link as `aria-current` too: `page` for the page being shown, `true` for the
  current choice of a set, such as the language in use. The More group
  carries `data-current="true"` while an entry it holds is current.

## Tabs

`Tabs` draws content under tabs in the WAI-ARIA tabs pattern with manual
activation: a `tab-list` (`role="tablist"`, named by `label`) of `tab`
buttons (`role="tab"`, `aria-selected` on the chosen one), then one
`tab-panel` (`role="tabpanel"`, reached by Tab) holding `children`, the chosen
tab's content. The arrow keys, Home and End move the focus among the tabs and
the chosen one is the one Tab reaches; Enter, Space or a press on a tab other
than the chosen one is reported as `onChange` with its key. The renderer
draws a [`tabs` node](../../ui/docs/nodes.md#tabs) with it, keying each tab by
the key the page document gives it and holding which one is chosen; its parts are in the
[styling contract](styling.md#tabs)'s list.

## Layers

`Select`, `MultiSelect`, `Dialog`, `Drawer`, `Popover`, `Confirmation`, `Menu`,
`Tooltip` and `Navigation` are the **layer controls**: each draws a layer at
the end of `<body>` — an overlay's `surface` and a modal one's
`surface-overlay`, a choice list's `select-content`, a `menu`, a `tooltip`, a
row's or a rail's `nav-panel`. The contract data marks each of them
`layer: true`.

- **The marker.** The root of every layer a control draws at the end of
  `<body>` carries `data-telo-layer`. A closing copy is a child of `<body>`
  that is `inert`, carries no `data-telo-layer`, and is neither the
  application's element nor a supplied one: nothing in it is an element of
  the page. A live layer root keeps `data-telo-layer` while a later modal
  layer makes it `inert`, and stays an element of the page.
- **One unit.** A set implementing any layer control implements all nine
  (`UI_CONTROLS_LAYERS_PARTIAL`), so every layer on a page comes from one
  implementation. A primitive library keeps one stack of the layers it draws,
  and two stacks cannot be made to cooperate — one cancels the Escape or traps
  the focus another needs — so the contract guarantees instead that a page
  holds one stack. The other fifteen controls draw no layer and may be
  replaced in any subset.
- **Composition within the stack.** How one implementation's layers compose
  — a list opened in a dialog, a drawer or a popover, the confirmation over a
  dialog or a drawer, the menu in a filter overlay, a tooltip over a surface
  or over a navigation panel —
  is its own, and the scenes hold it to one rule. Escape closes only the top
  layer. A press outside the top layer is offered to each layer from the top
  down: each layer it lies outside of may close, as its own `dismiss.outside`
  says (a confirmation never closes this way). The press stops at the first
  layer it lies inside of; otherwise it stops after the first **shielding**
  layer, which is still offered it. A modal dialog or drawer, a confirmation,
  and an open `Select`, `MultiSelect` or `Menu` list shield; a popover, a
  non-modal dialog or drawer, a navigation panel and a tooltip do not. So a press on the page
  closes a chip's popover and the non-modal popover holding the chip
  together, while one made with a list open in that popover closes only the
  list.

### The built-in stack and other layers

A layer something else draws — a [component](component-abi.md)'s own —
is above the built-in layers when it opens after them. Toward such a layer,
the built-ins:

- leave the focus inside it: a modal dialog's trap admits it;
- report no `outside` close for a press or the focus inside it, and no
  `escape` for a key inside it;
- cancel and stop none of its events — pointer, key, focus, wheel: they listen
  on the document in the bubble phase and return before acting on an event
  targeted inside it;
- make only what was beneath them at opening unreachable: a modal one sets
  `inert` on that, and never `inert`, `aria-hidden` or `pointer-events: none`
  on a later layer or any of its ancestors, and it locks the page's scroll
  without cancelling `wheel` or `touchmove`.

This is the built-ins' tested behaviour, not a term every implementation
meets. A layer built on Radix's overlays cannot meet it — they cancel Escape in
the capture phase, and a modal one traps the focus and sets `pointer-events:
none` on `<body>` — which is why the nine are one unit.

## States

A control carries only these, and only on its own parts. Attributes a
primitive sets for its own placement (`data-side`, `data-align` on a list) are
no terms of the contract.

| Control | Attribute | Values | On |
| --- | --- | --- | --- |
| `TextInput` | `data-invalid` | `true` | its root |
| `NumberInput` | `data-invalid` | `true` | its root |
| `TextArea` | `data-invalid` | `true` | its root |
| `DateInput` | `data-invalid` | `true` | its root |
| `DateTimeInput` | `data-invalid` | `true` | its root |
| `TimeInput` | `data-invalid` | `true` | its root |
| `TagsInput` | `data-invalid` | `true` | its root |
| `DateRangeInput` | `data-invalid` | `true` | its root |
| `DateRangeInput` | `data-state` | `on`, `off` | `date-range-preset` |
| `Checkbox` | `data-state` | `checked`, `unchecked` | its root |
| `Checkbox` | `data-invalid` | `true` | its root |
| `Switch` | `data-state` | `checked`, `unchecked` | its root |
| `Switch` | `data-invalid` | `true` | its root |
| `Slider` | `data-invalid` | `true` | its root |
| `OptionGroup` | `data-invalid` | `true` | its root |
| `OptionGroup` | `data-state` | `on`, `off` | its `option` part |
| `Select` | `data-state` | `open`, `closed` | its root, `select-content` |
| `Select` | `data-placeholder` | present | its root |
| `Select` | `data-invalid` | `true` | its root |
| `Select` | `data-state` | `checked`, `unchecked` | `select-item` |
| `Select` | `data-highlighted` | present | `select-item` |
| `MultiSelect` | `data-state` | `open`, `closed` | its root, `select-content` |
| `MultiSelect` | `data-placeholder` | present | its root |
| `MultiSelect` | `data-invalid` | `true` | its root |
| `MultiSelect` | `data-state` | `checked`, `unchecked` | `select-item` |
| `MultiSelect` | `data-highlighted` | present | `select-item` |
| `Listbox` | `data-state` | `idle`, `loading` | its root |
| `Listbox` | `data-state` | `on`, `off` | `picker-option` |
| `Dialog` | `data-state` | `open`, `closed` | its root, `surface-overlay` |
| `Drawer` | `data-state` | `open`, `closed` | its root, `surface-overlay` |
| `Popover` | `data-state` | `open`, `closed` | its root |
| `Confirmation` | `data-state` | `open`, `closed` | its root, `surface-overlay` |
| `Menu` | `data-state` | `open`, `closed` | its root |
| `Menu` | `data-highlighted` | present | `menu-item` |
| `Tooltip` | `data-state` | `closed`, `delayed-open`, `instant-open` | its root |
| `Navigation` | `data-layout` | `horizontal`, `vertical`, `rail` | its root |
| `Navigation` | `data-state` | `open`, `closed` | `nav-toggle` |
| `Navigation` | `data-state` | `open`, `closed` | `nav-panel` |
| `Navigation` | `data-current` | `page`, `true` | `nav-item`, `nav-toggle` |
| `Tabs` | `data-state` | `active`, `inactive` | `tab` |
| `Tabs` | `data-state` | `active` | `tab-panel` |

## The declaration

What an implementation can type-check against:

```ts
import type { ComponentType, ReactElement, ReactNode } from "react";

/** Why a list, a menu, a tooltip or an overlay would close. */
export type CloseReason = "escape" | "outside" | "close";

/** One option: a key the renderer issues, and the finished text shown for it. */
export interface Option {
  key: string;
  label: string;
}

/** What the renderer says of the element a person focuses; the control
 *  forwards each to that element. */
export interface Semantics {
  /** Set on the focusable element: what a label's `for` points at. */
  id: string;
  /** The accessible name, where no label element names the control. */
  label?: string;
  /** Ids of the elements describing the control, space-separated: its hint, its error. */
  describedBy?: string;
  invalid: boolean;
  required: boolean;
  disabled: boolean;
}

export interface TextInputProps extends Semantics {
  part: "input" | "filter-input" | "picker-search";
  name?: string;
  type: "text" | "search";
  value: string;
  onChange(value: string): void;
  /** Given, the text is meant on Enter and on leaving the control, and Enter does nothing else. */
  onCommit?(): void;
}

export interface NumberInputProps extends Semantics {
  part: "input" | "filter-input";
  name?: string;
  /** Whether only whole numbers are entered. */
  integer: boolean;
  /** The number as its typed text, or `""`. */
  value: string;
  onChange(value: string): void;
  onCommit?(): void;
}

export interface TextAreaProps extends Semantics {
  name?: string;
  value: string;
  onChange(value: string): void;
}

export interface DateInputProps extends Semantics {
  part: "input" | "filter-input";
  name?: string;
  /** The language the page is in. */
  lang: string;
  /** `YYYY-MM-DD`, or `""`. */
  value: string;
  onChange(value: string): void;
  onCommit?(): void;
}

export interface DateTimeInputProps extends Semantics {
  name?: string;
  lang: string;
  /** `YYYY-MM-DDTHH:mm`, or `""`. */
  value: string;
  onChange(value: string): void;
}

export interface TimeInputProps extends Semantics {
  name?: string;
  lang: string;
  /** `HH:mm`, or `""`. */
  value: string;
  onChange(value: string): void;
}

export interface TagsInputProps extends Semantics {
  /** The parts of the box, of one value, of its remove button and of what is typed into. */
  parts: {
    root: "tags" | "filter-tags";
    tag: "tag" | "filter-tag";
    remove: "tag-remove" | "filter-tag-remove";
    input: "input" | "filter-input";
  };
  /** What one value is typed as. */
  type: "text" | "number" | "date" | "datetime-local" | "time";
  values: string[];
  /** The accessible name of each value's remove button, in the order of `values`. */
  removeLabels: string[];
  onChange(values: string[]): void;
}

/** A range as its two dates hold it: `YYYY-MM-DD`, or `""`. */
export interface DateRange {
  from: string;
  to: string;
}

export interface DateRangeInputProps {
  /** Set on the group; the two dates carry `<id>-from` and `<id>-to`. */
  id: string;
  /** The group's accessible name. */
  label: string;
  describedBy?: string;
  invalid: boolean;
  required: boolean;
  disabled: boolean;
  /** What labels the first date and the second. */
  fromLabel: string;
  toLabel: string;
  /** Each preset with the range it sets, computed by the renderer. */
  presets: { label: string; from: string; to: string }[];
  lang: string;
  weekStart: "monday" | "sunday";
  value: DateRange;
  onChange(value: DateRange): void;
}

export interface CheckboxProps extends Semantics {
  name?: string;
  checked: boolean;
  onChange(checked: boolean): void;
}

export interface SwitchProps extends Semantics {
  part: "switch" | "filter-toggle";
  checked: boolean;
  onChange(checked: boolean): void;
}

export interface SliderProps extends Semantics {
  /** The root's part; the position drawn as text is `slider-value` or `filter-slider-value`. */
  part: "slider" | "filter-slider";
  min: number;
  max: number;
  step: number;
  /** The position as a number's typed text. */
  value: string;
  /** What the position is read out as, where its number alone is not it. */
  valueText?: string;
  onChange(value: string): void;
  /** The position is let go. */
  onCommit(): void;
}

export interface OptionGroupProps extends Semantics {
  parts: {
    root: "options" | "filter-options" | "filters-presets";
    option: "option" | "filter-option" | "filters-preset";
  };
  /** Any number chosen, or at most one. */
  multiple: boolean;
  options: Option[];
  /** The chosen keys. */
  value: string[];
  onChange(value: string[]): void;
}

export interface SelectProps extends Semantics {
  part: "select" | "filter-select";
  options: Option[];
  /** The chosen key, or `""`. */
  value: string;
  /** Shown while nothing is chosen. */
  placeholder: string;
  /** The entry choosing nothing, which reports `""`. */
  noneLabel: string;
  open: boolean;
  /** Whether more options are being read. */
  loading: boolean;
  /** Whether a further page of options exists. */
  hasMore: boolean;
  onOpenChange(open: boolean, reason?: CloseReason): void;
  onChange(value: string): void;
  /** The list is scrolled to its end. */
  onEndReached?(): void;
}

export interface MultiSelectProps extends Semantics {
  part: "select" | "filter-select";
  options: Option[];
  /** The chosen keys, in the options' order. */
  value: string[];
  placeholder: string;
  open: boolean;
  loading: boolean;
  hasMore: boolean;
  onOpenChange(open: boolean, reason?: CloseReason): void;
  onChange(value: string[]): void;
  onEndReached?(): void;
}

export interface ListboxProps {
  /** The list's accessible name. */
  label: string;
  multiple: boolean;
  options: (Option & { hint?: string })[];
  value: string[];
  loading: boolean;
  hasMore: boolean;
  onChange(value: string[]): void;
  onEndReached?(): void;
}

/** What every overlay is given beside its own props. */
export interface OverlayProps {
  open: boolean;
  /** Set on the root as given: what the styling contract documents on `surface`. */
  attributes: Record<string, string>;
  onOpenChange(open: boolean, reason?: CloseReason): void;
  /** What the renderer draws inside: header, body, actions. */
  children: ReactNode;
}

export interface DialogProps extends OverlayProps {
  modal: boolean;
  /** The id of the title the renderer draws. */
  labelledBy: string;
  describedBy?: string;
}

export interface DrawerProps extends DialogProps {
  side: "start" | "end" | "top" | "bottom";
}

export interface PopoverProps extends OverlayProps {
  /** What it is placed against. */
  anchor: HTMLElement | null;
  side: "start" | "end" | "top" | "bottom";
  align?: "start" | "center" | "end";
  labelledBy?: string;
}

export interface ConfirmationProps extends OverlayProps {
  labelledBy: string;
  describedBy: string;
}

export interface MenuProps {
  open: boolean;
  /** The things to do, each a key and its finished text. */
  items: Option[];
  onOpenChange(open: boolean, reason?: CloseReason): void;
  /** An entry is chosen. */
  onChange(key: string): void;
  /** The renderer's button it opens from: rendered as the menu's trigger. */
  children: ReactElement;
}

/** One entry of a navigation: a link, a group of entries, or a button
 *  opening a dialog the renderer draws. */
export interface NavigationEntry {
  /** Issued by the renderer, unique in the navigation. */
  key: string;
  label: string;
  /** The address a link leads to; a group has none. */
  href?: string;
  /** A group's entries, in order; a link has none. */
  items?: NavigationEntry[];
  /** Given, the entry has neither `href` nor `items`: its button opens a
   *  dialog the renderer draws, and is expanded while its key is in `open`. */
  opens?: "dialog";
  /** The entry is current: a link carries it as `aria-current` and
   *  `data-current`, a group's button as `data-current`. */
  current?: "page" | "true";
  /** The renderer's glyph for the entry, hidden from assistive technology:
   *  drawn before the label, and in a rail in place of its first letter. */
  icon?: ReactElement;
}

export interface NavigationProps {
  /** Given, the navigation is a landmark this names; without it, none. */
  label?: string;
  /** In a row, in a column, or in a column of each top-level entry's first
   *  letter. A group opens a panel over the page in a row or a rail, and in
   *  place beneath its button in a column. */
  layout: "horizontal" | "vertical" | "rail";
  items: NavigationEntry[];
  /** Given, the group what does not fit a horizontal row moves into;
   *  without it, every entry stays in the row. */
  more?: { key: string; label: string };
  /** The keys of the open groups, in any order: a group is drawn open when its
   *  key is listed and every group holding it is open. */
  open: string[];
  /** Set on the root as given. */
  attributes?: Record<string, string>;
  onOpenChange(open: string[], reason?: CloseReason): void;
  /** A link is followed: the renderer moves to it. */
  onChange(key: string): void;
}

export interface TabsProps {
  /** The tab list's accessible name. */
  label?: string;
  /** The tabs, in order, each a key and its finished text. */
  tabs: Option[];
  /** The chosen tab's key. */
  value: string;
  onChange(value: string): void;
  /** The chosen tab's content, drawn in its panel. */
  children: ReactNode;
}

export interface TooltipProps {
  open: boolean;
  /** What it says. */
  label: string;
  onOpenChange(open: boolean, reason?: CloseReason): void;
  /** The renderer's element it names: rendered as the tooltip's trigger. */
  children: ReactElement;
}

/** The semantic names of the glyphs the renderer draws. */
export type IconName =
  | "add"
  | "alert"
  | "close"
  | "collapse"
  | "delete"
  | "edit"
  | "expand"
  | "filter"
  | "loading"
  | "menu"
  | "more"
  | "next"
  | "previous"
  | "remove"
  | "reset"
  | "sort-ascending"
  | "sort-descending"
  | "sortable";

export interface IconProps {
  name: IconName;
}

/** The control set of `ui_react_controls-2`: a module implementing any of them
 *  exports each under its name. */
export interface Controls {
  TextInput: ComponentType<TextInputProps>;
  NumberInput: ComponentType<NumberInputProps>;
  TextArea: ComponentType<TextAreaProps>;
  DateInput: ComponentType<DateInputProps>;
  DateTimeInput: ComponentType<DateTimeInputProps>;
  TimeInput: ComponentType<TimeInputProps>;
  TagsInput: ComponentType<TagsInputProps>;
  DateRangeInput: ComponentType<DateRangeInputProps>;
  Checkbox: ComponentType<CheckboxProps>;
  Switch: ComponentType<SwitchProps>;
  Slider: ComponentType<SliderProps>;
  OptionGroup: ComponentType<OptionGroupProps>;
  Select: ComponentType<SelectProps>;
  MultiSelect: ComponentType<MultiSelectProps>;
  Listbox: ComponentType<ListboxProps>;
  Dialog: ComponentType<DialogProps>;
  Drawer: ComponentType<DrawerProps>;
  Popover: ComponentType<PopoverProps>;
  Confirmation: ComponentType<ConfirmationProps>;
  Menu: ComponentType<MenuProps>;
  Tooltip: ComponentType<TooltipProps>;
  Navigation: ComponentType<NavigationProps>;
  Tabs: ComponentType<TabsProps>;
  Icon: ComponentType<IconProps>;
}

export type ControlName = keyof Controls;
```

## What a module may leave to the page

A controls module may list as `external` only these; the page supplies each
through its import map. Anything else is bundled into the module.

| Specifier | Is |
| --- | --- |
| `react` | React |
| `react/jsx-runtime` | the JSX runtime |
| `react-dom` | `createPortal` and the rest of `react-dom` |

`@telorun/ui-react` is not among them: a control cannot fetch, navigate or read
the page's address.

## A control's mechanics

The layout a control's own elements need to work — a select list's stacking
and size, a slider's track, a switch's thumb, where a dialog or a drawer
sits — is its mechanics, in the `telo.control` layer. Each built-in's
mechanics is a stylesheet of its own, which the application document names by
control (`controls.stylesheets`) and leaves out for a control a set replaces;
a set brings its own as the stylesheet its entry builds, which the application
places in the same layer. The base layer holds the renderer's composition only
and names no part only a control draws.

## In the browser

The application document's `controls` names each set of controls in use —
the module's URL and the controls it exports — and the renderer loads each
through its module loader before it draws the page. The first set naming a
control is the one drawn; a control no set names is the built-in. A control
that cannot be drawn is never replaced by the built-in: it is an `error` node
in the place of the node that was drawing it, coded
`ERR_UI_THEME_CONTROL_LOAD_FAILED` (its module did not load, or does not
export it) or `ERR_UI_THEME_CONTROL_FAILED` (it threw).

## Vectors, scenes and the interpreter

The contract ships as data in the code entry `@telorun/ui-react-contract` of
this module, beside the interpreter that runs it:

- `controls` — this set: each control's props, root part, sub-parts, intents
  and states;
- `vectors` — per control, the props every vector starts from and each
  behaviour vector: props, the steps a person takes and what must follow;
- `parts` — the part list, the renderer's states, the reserved properties and
  the design tokens the renderer's own layer reads (`rendererTokens`) (see
  [the styling contract](styling.md));
- `scenes` — applications that between them draw every part: their documents,
  the answers their requests get, and the steps taken on them;
- `runVector` and `runScene` — the interpreter, which drives a DOM window and
  touches nothing else: a host draws the control, or mounts the renderer;
- `tokenProperty` — how a design token is spelled as the custom property the
  page sets (`color.accent` → `--telo-color-accent`), the one projection the
  application's token stylesheet uses;
- `layouts`, `layoutVectors` and `runLayoutVector` — the
  [layout contract](layouts-abi.md), its vectors and their runner.

A step is one of `click`, `press` (a pointer pressed down, `mouse` or
`touch`), `hover` (a mouse pointer moved onto the element), `key` (with
`shift`), `fill`, `focus`, `blur`, `scroll` (the element and everything in it
scrolled to its end), `wait`, `props` (a vector's props changed), `respond` (a
scene's answers changed) and `expect`. An element is named by its `part`,
`text`, `role`, `tag`, `id`, `attributes`, `within` and `index`.
An expectation names the exact intents reported since the last one, where the
focus is, what is drawn and what is not, attributes, text, and what is drawn
outside the application. The interpreter applies each intent to the prop it
sets, as the renderer would, unless the vector holds that prop; after every
step it also holds the control to its documented parts and states, to the
semantics on the element carrying `id`, and to drawing its overlay parts
outside the application, each in a layer whose root at the end of `<body>`
carries `data-telo-layer`. A closing copy is a child of `<body>` that is
`inert`, carries no `data-telo-layer`, and is neither the application's
element nor a supplied one: nothing in it is an element of the page. A live
layer root keeps `data-telo-layer` while a later modal layer makes it
`inert`, and stays an element of the page.

The built-ins meet every vector and every scene in a
[happy-dom](https://github.com/capricorn86/happy-dom) window, at the one
version the workspace pins, and
[`ui-react-conformance`](../../ui-react-conformance/README.md) holds every
other control set to the same vectors and scenes in the same DOM: the DOM
implementation and its version are part of the contract's oracle.

## How the generation grows

For the life of `ui_react_controls-2`:

- the control set only grows;
- a prop is added only where an implementation ignoring it still meets the
  contract;
- the supplied specifiers only grow.

Anything else — a new value form, a state, a required part, an intent — is
`ui_react_controls-3`. A renderer may host several generations at once; this
one hosts `ui_react_controls-2` alone.

`ui_react_controls-2` differs from `ui_react_controls-1` in:

- two controls, `Navigation` — a ninth layer control, so a set implementing
  the eight of generation 1 is refused — and `Tabs`;
- the parts `navigation`, `nav-toggle`, `nav-item`, `nav-group` (a column's
  group opened in place) and `nav-panel` (a row's or a rail's group, a layer);
- four glyph names, `menu`, `more`, `collapse` and `expand`;
- `Menu`'s entries, which carry no `current`, and its `menu-item`, which
  carries no `data-current`: a menu node is drawn by `Navigation`;
- two interpreter terms, the `hover` step and the `tag` of a target.
