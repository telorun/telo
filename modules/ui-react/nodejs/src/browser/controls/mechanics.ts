import type { ControlName } from "../../contract/ui-react-controls.js";

/**
 * Each built-in control's mechanics: the layout its own elements need to work,
 * one stylesheet per control in the `telo.control` layer. The application
 * serves each separately and names it per control, so the mechanics of a
 * control a theme replaces are not served. Colour, spacing and type are the
 * theme's.
 */
const layer = (rules: string[]) => `@layer telo.control {\n${rules.map((rule) => `  ${rule}\n`).join("")}}\n`;

const entry = (parts: string[]) => {
  const any = `:is(${parts.map((part) => `[data-telo-part="${part}"]`).join(", ")})`;
  return [
    `${any} { box-sizing: border-box; min-width: 0; }`,
    ...(parts.includes("input") ? ['[data-telo-part="input"] { width: 100%; }'] : []),
    ...(parts.includes("filter-input")
      ? ['/* In an overlay, and in a bar beside its content, a filter is as wide as its column. */',
         ':is([data-telo-part="surface"], [data-placement="aside"]) [data-telo-part="filter"] [data-telo-part="filter-input"] { width: 100%; max-width: none; }']
      : []),
  ];
};

const choiceList = [
  ':is([data-telo-part="select"], [data-telo-part="filter-select"], [data-telo-part="select-item"]) [data-telo-part="icon"] { flex: none; pointer-events: none; }',
  '[data-telo-part="select"] { width: 100%; }',
  ':is(button[data-telo-part="select"], button[data-telo-part="filter-select"]) { justify-content: space-between; box-sizing: border-box; min-width: 0; }',
  ':is([data-telo-part="select"], [data-telo-part="filter-select"]) > span { overflow: hidden; text-overflow: ellipsis; }',
  ':is([data-telo-part="surface"], [data-placement="aside"]) [data-telo-part="filter"] [data-telo-part="filter-select"] { width: 100%; max-width: none; }',
  "/* Placed against its trigger: the placement sets the anchor's width, the height left and the corner it grows from. */",
  '[data-telo-part="select-content"] { box-sizing: border-box; z-index: 50; overflow-x: hidden; overflow-y: auto; min-width: max(9rem, var(--ui-react-control-anchor-width, 0px)); max-height: var(--ui-react-control-available-height, 100vh); transform-origin: var(--ui-react-control-origin); }',
  '[data-telo-part="select-item"] { position: relative; display: flex; align-items: center; cursor: default; user-select: none; }',
  '[data-telo-part="select-item"] [data-telo-part="icon"] { position: absolute; }',
];

const overlay = '[data-telo-part="surface-overlay"] { position: fixed; inset: 0; z-index: 50; }';

const centred = (surface: string) =>
  `[data-surface="${surface}"] { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 50; width: min(28rem, calc(100vw - 2rem)); max-height: calc(100vh - 2rem); }`;

export const CONTROL_MECHANICS: Readonly<Partial<Record<ControlName, string>>> = {
  TextInput: layer(entry(["input", "filter-input", "picker-search"]).concat('[data-telo-part="picker-search"] { width: 100%; }')),
  NumberInput: layer(entry(["input", "filter-input"])),
  TextArea: layer(['[data-telo-part="textarea"] { box-sizing: border-box; min-width: 0; width: 100%; }']),
  DateInput: layer(entry(["input", "filter-input"])),
  DateTimeInput: layer(entry(["input"])),
  TimeInput: layer(entry(["input"])),
  DateRangeInput: layer([
    "/* The presets on a line of their own, then each date under its label's column. */",
    '[data-telo-part="date-range"] { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; min-width: 0; }',
    '[data-telo-part="date-range-presets"] { grid-column: 1 / -1; justify-self: start; display: inline-flex; flex-wrap: wrap; align-items: center; }',
    ':is([data-telo-part="date-range-from"], [data-telo-part="date-range-to"]) { box-sizing: border-box; min-width: 0; width: 100%; }',
  ]),
  TagsInput: layer([
    ':is([data-telo-part="tags"], [data-telo-part="filter-tags"]) { display: flex; flex-wrap: wrap; align-items: center; box-sizing: border-box; }',
    ':is([data-telo-part="tag"], [data-telo-part="filter-tag"]) { display: inline-flex; align-items: center; white-space: nowrap; }',
    ':is([data-telo-part="tags"] > [data-telo-part="input"], [data-telo-part="filter-tags"] > [data-telo-part="filter-input"]) { flex: 1 1 4rem; width: auto; box-sizing: border-box; min-width: 0; }',
    ':is([data-telo-part="tag-remove"], [data-telo-part="filter-tag-remove"]) > [data-telo-part="icon"] { flex: none; pointer-events: none; }',
  ]),
  Checkbox: layer([
    "/* A boolean field is one line: the box, then its label. */",
    '[data-telo-part="field"]:has(> [data-telo-part="checkbox"]) { flex-direction: row; flex-wrap: wrap; align-items: center; }',
    '[data-telo-part="field"]:has(> [data-telo-part="checkbox"]) > [data-telo-part="field-error"] { flex-basis: 100%; }',
    '[data-telo-part="checkbox"] > [data-telo-part="icon"] { flex: none; pointer-events: none; }',
  ]),
  Switch: layer([
    "/* A switch field is one line: the switch, then its label. The thumb is the switch's `::before`. */",
    '[data-telo-part="field"]:has(> [data-telo-part="switch"]) { flex-direction: row; flex-wrap: wrap; align-items: center; }',
    '[data-telo-part="field"]:has(> [data-telo-part="switch"]) > [data-telo-part="field-error"] { flex-basis: 100%; }',
    ':is([data-telo-part="switch"], [data-telo-part="filter-toggle"]) { position: relative; }',
    ':is([data-telo-part="switch"], [data-telo-part="filter-toggle"])::before { content: ""; position: absolute; }',
  ]),
  Slider: layer([
    "/* The track is the first child, the range inside it; the thumb is the element with the slider role. */",
    ':is([data-telo-part="slider"], [data-telo-part="filter-slider"]) { position: relative; display: flex; align-items: center; touch-action: none; user-select: none; }',
    ':is([data-telo-part="slider"], [data-telo-part="filter-slider"]) > :first-child { position: relative; flex: 1; }',
    ':is([data-telo-part="slider"], [data-telo-part="filter-slider"]) > :first-child > * { position: absolute; height: 100%; }',
    ':is([data-telo-part="slider"], [data-telo-part="filter-slider"]) [role="slider"] { display: block; }',
    "/* The value sits past the track's end, so its width never moves the track; the theme leaves it room. */",
    ':is([data-telo-part="slider-value"], [data-telo-part="filter-slider-value"]) { position: absolute; inset-block: 0; inset-inline-start: 100%; display: flex; align-items: center; white-space: nowrap; pointer-events: none; }',
  ]),
  OptionGroup: layer([
    ':is([data-telo-part="options"], [data-telo-part="filter-options"], [data-telo-part="filters-presets"]) { display: inline-flex; flex-wrap: wrap; align-items: center; }',
    ':is([data-telo-part="options"], [data-telo-part="filters-presets"]) { align-self: flex-start; }',
  ]),
  Listbox: layer([
    "/* The list scrolls on its own, which is what reads the next page at its end. */",
    '[data-telo-part="picker-list"] { list-style: none; margin: 0; padding: 0; max-height: min(20rem, 60vh); overflow-y: auto; }',
    '[data-telo-part="picker-option"] { display: flex; align-items: baseline; cursor: default; user-select: none; }',
  ]),
  Select: layer(choiceList),
  MultiSelect: layer(choiceList),
  Dialog: layer([
    overlay,
    centred("dialog"),
    '[data-surface="dialog"][data-size="small"] { width: min(22rem, calc(100vw - 2rem)); }',
    '[data-surface="dialog"][data-size="large"] { width: min(44rem, calc(100vw - 2rem)); }',
    '[data-surface="dialog"][data-size="full"] { width: calc(100vw - 2rem); height: calc(100vh - 2rem); }',
  ]),
  Drawer: layer([
    overlay,
    '[data-surface="drawer"] { position: fixed; z-index: 50; max-width: 100vw; max-height: 100vh; }',
    '[data-surface="drawer"]:is([data-side="start"], [data-side="end"]) { top: 0; bottom: 0; width: 26rem; }',
    '[data-surface="drawer"][data-side="start"] { inset-inline-start: 0; }',
    '[data-surface="drawer"][data-side="end"] { inset-inline-end: 0; }',
    '[data-surface="drawer"]:is([data-side="top"], [data-side="bottom"]) { left: 0; right: 0; height: 50vh; }',
    '[data-surface="drawer"][data-side="top"] { top: 0; }',
    '[data-surface="drawer"][data-side="bottom"] { bottom: 0; }',
    '[data-surface="drawer"][data-size="small"]:is([data-side="start"], [data-side="end"]) { width: 20rem; }',
    '[data-surface="drawer"][data-size="large"]:is([data-side="start"], [data-side="end"]) { width: 40rem; }',
    '[data-surface="drawer"][data-size="full"]:is([data-side="start"], [data-side="end"]) { width: 100vw; }',
    '[data-surface="drawer"][data-size="small"]:is([data-side="top"], [data-side="bottom"]) { height: 30vh; }',
    '[data-surface="drawer"][data-size="large"]:is([data-side="top"], [data-side="bottom"]) { height: 75vh; }',
    '[data-surface="drawer"][data-size="full"]:is([data-side="top"], [data-side="bottom"]) { height: 100vh; }',
  ]),
  Popover: layer([
    '[data-surface="popover"] { z-index: 50; width: min(22rem, calc(100vw - 1rem)); max-height: var(--ui-react-control-available-height, calc(100vh - 1rem)); transform-origin: var(--ui-react-control-origin); }',
  ]),
  Confirmation: layer([overlay, centred("confirmation")]),
  Menu: layer([
    '[data-telo-part="menu"] { box-sizing: border-box; z-index: 50; overflow-x: hidden; overflow-y: auto; min-width: max(9rem, var(--ui-react-control-anchor-width, 0px)); max-height: var(--ui-react-control-available-height, 100vh); transform-origin: var(--ui-react-control-origin); }',
    '[data-telo-part="menu-item"] { position: relative; display: flex; align-items: center; cursor: default; user-select: none; }',
  ]),
  Tooltip: layer(['[data-telo-part="tooltip"] { z-index: 50; width: fit-content; transform-origin: var(--ui-react-control-origin); }']),
  Icon: layer(['[data-telo-part="icon"] { flex: none; pointer-events: none; }']),
};

/** The file a control's mechanics are served as: `select.css`, `date-time-input.css`. */
export const mechanicsFileName = (control: string) => `${control.replace(/[A-Z]/g, (letter, at) => (at === 0 ? "" : "-") + letter.toLowerCase())}.css`;
