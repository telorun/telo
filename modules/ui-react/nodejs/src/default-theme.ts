/** The built-in theme: a value for every token, and what the base styles read
 *  them for. Its own stylesheet, so an application can decline it. */
export const DEFAULT_THEME_CSS = `@layer telo.theme {
  :root {
    color-scheme: light dark;
    --telo-color-background: oklch(1 0 0);
    --telo-color-surface: oklch(1 0 0);
    --telo-color-text: oklch(0.145 0 0);
    --telo-color-muted: oklch(0.556 0 0);
    --telo-color-border: oklch(0.922 0 0);
    --telo-color-accent: oklch(0.205 0 0);
    --telo-color-accent-text: oklch(0.985 0 0);
    --telo-color-danger: oklch(0.577 0.245 27.325);
    --telo-color-warning: oklch(0.666 0.179 58.318);
    --telo-color-success: oklch(0.596 0.145 163.225);
    --telo-radius-sm: 0.5rem;
    --telo-radius-md: 0.625rem;
    --telo-radius-lg: 0.875rem;
    --telo-space-xs: 0.25rem;
    --telo-space-sm: 0.5rem;
    --telo-space-md: 0.75rem;
    --telo-space-lg: 1rem;
    --telo-space-xl: 1.5rem;
    --telo-shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 5%);
    --telo-shadow-md: 0 4px 6px -1px rgb(0 0 0 / 10%), 0 2px 4px -2px rgb(0 0 0 / 10%);
    --telo-font-body: "Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    --telo-font-heading: "Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    --telo-font-mono: "Geist Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
    --telo-font-size-sm: 0.75rem;
    --telo-font-size-md: 0.875rem;
    --telo-font-size-lg: 1rem;
    --telo-font-size-xl: 1.25rem;
    --telo-line-height-body: 1.43;
    --telo-line-height-heading: 1.25;

    /* Derived from the tokens, so a theme that sets a token moves these too. */
    --telo-derived-fill: color-mix(in oklab, var(--telo-color-text) 3.5%, var(--telo-color-surface));
    --telo-derived-ring: color-mix(in oklab, var(--telo-color-text) 34%, var(--telo-color-surface));
    --telo-derived-hairline: color-mix(in oklab, var(--telo-color-text) 10%, transparent);
    --telo-derived-control: transparent;
    --telo-derived-control-hover: var(--telo-derived-fill);
    --telo-derived-danger-fill: color-mix(in oklab, var(--telo-color-danger) 10%, transparent);
    --telo-derived-danger-fill-hover: color-mix(in oklab, var(--telo-color-danger) 20%, transparent);
    --telo-derived-danger-ring: color-mix(in oklab, var(--telo-color-danger) 20%, transparent);
    --telo-derived-focus: 0 0 0 3px color-mix(in oklab, var(--telo-derived-ring) 50%, transparent);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --telo-color-background: oklch(0.145 0 0);
      --telo-color-surface: oklch(0.145 0 0);
      --telo-color-text: oklch(0.985 0 0);
      --telo-color-muted: oklch(0.708 0 0);
      --telo-color-border: oklch(0.269 0 0);
      --telo-color-accent: oklch(0.985 0 0);
      --telo-color-accent-text: oklch(0.205 0 0);
      --telo-color-warning: oklch(0.828 0.189 84.429);
      --telo-color-success: oklch(0.765 0.177 163.223);
      --telo-shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 30%);
      --telo-shadow-md: 0 4px 6px -1px rgb(0 0 0 / 40%), 0 2px 4px -2px rgb(0 0 0 / 40%);
      --telo-derived-fill: color-mix(in oklab, var(--telo-color-text) 15%, var(--telo-color-surface));
      --telo-derived-ring: color-mix(in oklab, var(--telo-color-text) 49%, var(--telo-color-surface));
      --telo-derived-control: color-mix(in oklab, var(--telo-color-border) 30%, transparent);
      --telo-derived-control-hover: color-mix(in oklab, var(--telo-color-border) 50%, transparent);
      --telo-derived-danger-fill: color-mix(in oklab, var(--telo-color-danger) 20%, transparent);
      --telo-derived-danger-fill-hover: color-mix(in oklab, var(--telo-color-danger) 30%, transparent);
      --telo-derived-danger-ring: color-mix(in oklab, var(--telo-color-danger) 40%, transparent);
    }
  }

  body { margin: 0; background: var(--telo-color-background); color: var(--telo-color-text); font-family: var(--telo-font-body); font-size: var(--telo-font-size-md); line-height: var(--telo-line-height-body); -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
  [data-telo-part="icon"] { width: 1rem; height: 1rem; }

  /* Shell */
  [data-telo-part="header"] { background: var(--telo-color-surface); border-bottom: 1px solid var(--telo-color-border); padding: 0 max(var(--telo-space-xl), calc((100% - 64rem) / 2)); min-height: 2.5rem; gap: var(--telo-space-md); position: sticky; top: 0; z-index: 10; }
  [data-telo-part="app-title"] { font-family: var(--telo-font-heading); font-weight: 600; }
  [data-telo-part="nav"] { gap: var(--telo-space-xs); }
  [data-telo-part="nav-link"] { display: inline-flex; align-items: center; height: 1.75rem; padding: 0 0.625rem; border: 1px solid transparent; border-radius: var(--telo-radius-md); color: var(--telo-color-muted); font-size: 0.8rem; font-weight: 500; text-decoration: none; outline: none; transition: background-color 150ms, color 150ms, border-color 150ms, box-shadow 150ms; }
  [data-telo-part="nav-link"]:hover { background: var(--telo-derived-fill); color: var(--telo-color-text); }
  [data-telo-part="nav-link"][data-current="page"] { background: var(--telo-derived-fill); color: var(--telo-color-text); }
  [data-telo-part="main"] { padding: var(--telo-space-xl); }
  [data-telo-part="page"] { gap: var(--telo-space-lg); width: 100%; max-width: 64rem; margin-inline: auto; box-sizing: border-box; }
  [data-telo-part="page-title"] { font-family: var(--telo-font-heading); font-size: var(--telo-font-size-xl); font-weight: 600; letter-spacing: -0.025em; line-height: var(--telo-line-height-heading); margin: 0; }

  /* Structure */
  [data-telo-part="stack"] { gap: var(--telo-space-md); }
  [data-telo-part="columns"] { gap: var(--telo-space-lg); }
  [data-telo-part="text"] { margin: 0; }
  h2[data-telo-part="text"], h3[data-telo-part="text"] { font-family: var(--telo-font-heading); line-height: var(--telo-line-height-heading); }
  h2[data-telo-part="text"] { font-size: var(--telo-font-size-lg); font-weight: 600; letter-spacing: -0.01em; }
  h3[data-telo-part="text"] { font-size: var(--telo-font-size-md); font-weight: 500; }
  [data-telo-part="link"] { color: var(--telo-color-accent); font-weight: 500; text-decoration: none; text-underline-offset: 4px; border-radius: 2px; outline: none; }
  [data-telo-part="link"]:hover { text-decoration: underline; }
  [data-telo-part="badge"] { height: 1.25rem; box-sizing: border-box; padding: 0 var(--telo-space-sm); border: 1px solid transparent; border-radius: 999px; background: var(--telo-derived-fill); color: var(--telo-color-text); font-size: var(--telo-font-size-sm); font-weight: 500; }
  [data-telo-part="image"], [data-telo-part="svg"] { border-radius: var(--telo-radius-sm); }

  /* Buttons */
  :where(button)[data-telo-part] { gap: 0.375rem; height: 2rem; box-sizing: border-box; padding: 0 0.625rem; margin: 0; border: 1px solid transparent; border-radius: var(--telo-radius-md); background: transparent; background-clip: padding-box; color: var(--telo-color-text); font: inherit; font-weight: 500; line-height: 1; outline: none; user-select: none; transition: background-color 150ms, border-color 150ms, color 150ms, box-shadow 150ms, opacity 150ms; }
  :where(button)[data-telo-part]:focus-visible, [data-telo-part="nav-link"]:focus-visible { border-color: var(--telo-derived-ring); box-shadow: var(--telo-derived-focus); }
  [data-telo-part="link"]:focus-visible { box-shadow: var(--telo-derived-focus); }
  :where(button)[data-telo-part]:disabled { pointer-events: none; opacity: 0.5; }
  [data-telo-part="submit"]:active, [data-telo-part="cancel"]:active, [data-telo-part="table-create"]:active, [data-telo-part="filters-reset"]:active, [data-telo-part="filters-apply"]:active, [data-telo-part="filters-toggle"]:active, [data-telo-part="row-edit"]:active, [data-telo-part="row-delete"]:active, [data-telo-part="pager-prev"]:active, [data-telo-part="pager-next"]:active, [data-telo-part="surface-close"]:active { transform: translateY(1px); }
  [data-telo-part="submit"], [data-telo-part="table-create"] { background: var(--telo-color-accent); color: var(--telo-color-accent-text); }
  [data-telo-part="submit"]:hover, [data-telo-part="table-create"]:hover { background: color-mix(in oklab, var(--telo-color-accent) 80%, transparent); }
  [data-telo-part="submit"][data-style~="danger"] { background: var(--telo-derived-danger-fill); color: var(--telo-color-danger); }
  [data-telo-part="submit"][data-style~="danger"]:hover { background: var(--telo-derived-danger-fill-hover); }
  [data-telo-part="submit"][data-style~="danger"]:focus-visible { border-color: color-mix(in oklab, var(--telo-color-danger) 40%, transparent); box-shadow: 0 0 0 3px var(--telo-derived-danger-ring); }
  [data-telo-part="cancel"], [data-telo-part="pager-prev"], [data-telo-part="pager-next"] { border-color: var(--telo-color-border); background: var(--telo-derived-control); }
  [data-telo-part="cancel"]:hover, [data-telo-part="pager-prev"]:hover, [data-telo-part="pager-next"]:hover { background: var(--telo-derived-control-hover); }
  [data-telo-part="filters-reset"]:hover, [data-telo-part="row-edit"]:hover, [data-telo-part="surface-close"]:hover, [data-telo-part="table-sort"]:hover { background: var(--telo-derived-fill); }
  [data-telo-part="row-edit"], [data-telo-part="row-delete"], [data-telo-part="pager-prev"], [data-telo-part="pager-next"], [data-telo-part="surface-close"] { width: 1.75rem; height: 1.75rem; padding: 0; }
  [data-telo-part="row-edit"], [data-telo-part="row-delete"] { color: var(--telo-color-muted); }
  [data-telo-part="row-edit"]:hover { color: var(--telo-color-text); }
  [data-telo-part="row-delete"]:hover { background: var(--telo-derived-danger-fill); color: var(--telo-color-danger); }

  /* Fields */
  [data-telo-part="form"] { gap: var(--telo-space-lg); }
  [data-telo-part="field"] { gap: var(--telo-space-sm); }
  [data-telo-part="filter"] { gap: 0.375rem; }
  [data-telo-part="label"] { font-size: var(--telo-font-size-md); font-weight: 500; line-height: 1; user-select: none; }
  [data-telo-part="filter-label"] { font-size: var(--telo-font-size-sm); font-weight: 500; line-height: 1; color: var(--telo-color-muted); user-select: none; }
  [data-telo-part="input"], [data-telo-part="textarea"], [data-telo-part="filter-input"] { height: 2rem; padding: 0.25rem 0.625rem; border: 1px solid var(--telo-color-border); border-radius: var(--telo-radius-md); background: var(--telo-derived-control); color: inherit; font: inherit; outline: none; transition: border-color 150ms, box-shadow 150ms, background-color 150ms; }
  [data-telo-part="textarea"] { height: auto; min-height: 4.5rem; padding: 0.375rem 0.625rem; resize: vertical; }
  [data-telo-part="input"]::placeholder, [data-telo-part="textarea"]::placeholder, [data-telo-part="filter-input"]::placeholder { color: var(--telo-color-muted); }
  button[data-telo-part="select"], button[data-telo-part="filter-select"] { padding: 0 0.5rem 0 0.625rem; border-color: var(--telo-color-border); background: var(--telo-derived-control); font-weight: 400; }
  button[data-telo-part="select"]:hover, button[data-telo-part="filter-select"]:hover { background: var(--telo-derived-control-hover); }
  [data-telo-part="select"][data-placeholder], [data-telo-part="filter-select"][data-placeholder] { color: var(--telo-color-muted); }
  [data-telo-part="select"] > [data-telo-part="icon"], [data-telo-part="filter-select"] > [data-telo-part="icon"] { color: var(--telo-color-muted); }
  [data-telo-part="input"]:focus-visible, [data-telo-part="textarea"]:focus-visible, [data-telo-part="filter-input"]:focus-visible { border-color: var(--telo-derived-ring); box-shadow: var(--telo-derived-focus); }
  button[data-telo-part="checkbox"] { width: 1rem; height: 1rem; padding: 0; border-color: var(--telo-color-border); border-radius: 4px; background: var(--telo-derived-control); color: var(--telo-color-accent-text); }
  button[data-telo-part="checkbox"][data-state="checked"] { border-color: var(--telo-color-accent); background: var(--telo-color-accent); }
  [data-telo-part="checkbox"] > [data-telo-part="icon"] { width: 0.875rem; height: 0.875rem; }
  [data-telo-part][data-invalid="true"]:not([data-telo-part="field"]) { border-color: var(--telo-color-danger); box-shadow: 0 0 0 3px var(--telo-derived-danger-ring); }
  [data-telo-part="field-error"], [data-telo-part="form-error"] { color: var(--telo-color-danger); font-size: 0.8rem; font-weight: 500; }
  [data-telo-part="form-actions"] { gap: var(--telo-space-sm); }

  /* Filters */
  [data-telo-part="filters"] { gap: var(--telo-space-md) var(--telo-space-sm); }
  [data-telo-part="filter-input"] { width: 12rem; }
  [data-telo-part="filter-group"] { gap: var(--telo-space-sm); }
  [data-telo-part="filter-bound"] { gap: var(--telo-space-xs); }
  [data-telo-part="filter-caption"] { font-size: var(--telo-font-size-sm); color: var(--telo-color-muted); user-select: none; }
  [data-telo-part="filter-bound"] > [data-telo-part="filter-input"] { width: 9rem; }
  button[data-telo-part="filter-select"] { min-width: 8rem; max-width: 16rem; }
  [data-telo-part="filters-reset"] { color: var(--telo-color-muted); }
  [data-telo-part="filters-reset"]:hover { color: var(--telo-color-text); }
  [data-telo-part="filters-bar"] { gap: var(--telo-space-md) var(--telo-space-sm); }
  [data-telo-part="surface"] [data-telo-part="filters-bar"] { margin-bottom: var(--telo-space-lg); }
  [data-telo-part="filters"][data-placement="aside"] { gap: 0 var(--telo-space-lg); }
  [data-placement="aside"] > [data-telo-part="filters-presets"], [data-placement="aside"] > [data-telo-part="filters-summary"] { margin-bottom: var(--telo-space-md); }
  [data-telo-part="filters"][data-pending="true"] > [data-telo-part="filters-content"] { opacity: 0.6; transition: opacity 150ms; }
  [data-telo-part="filters-toggle"], [data-telo-part="filters-add"], [data-telo-part="filter-chip"] { border-color: var(--telo-color-border); background: var(--telo-derived-control); }
  [data-telo-part="filters-toggle"]:hover, [data-telo-part="filters-add"]:hover, [data-telo-part="filter-chip"]:hover { background: var(--telo-derived-control-hover); }
  [data-telo-part="filters-add"] { border-style: dashed; color: var(--telo-color-muted); font-weight: 400; }
  [data-telo-part="filter-chip"] { border-radius: 999px; font-weight: 400; }
  [data-telo-part="filter-chip"][data-active="true"] { border-color: var(--telo-derived-ring); background: var(--telo-derived-fill); font-weight: 500; }
  [data-telo-part="filter"][data-active="true"] > [data-telo-part="filter-label"] { color: var(--telo-color-text); }
  [data-telo-part="filters-count"] { justify-content: center; min-width: 1.25rem; height: 1.25rem; box-sizing: border-box; padding: 0 0.375rem; border-radius: 999px; background: var(--telo-color-accent); color: var(--telo-color-accent-text); font-size: var(--telo-font-size-sm); font-variant-numeric: tabular-nums; }
  [data-telo-part="filters-apply"] { background: var(--telo-color-accent); color: var(--telo-color-accent-text); }
  [data-telo-part="filters-apply"]:hover { background: color-mix(in oklab, var(--telo-color-accent) 80%, transparent); }
  [data-telo-part="filters-presets"], [data-telo-part="filter-options"] { gap: 0.125rem; padding: 0.125rem; border-radius: var(--telo-radius-md); background: var(--telo-derived-fill); }
  button[data-telo-part="filters-preset"], button[data-telo-part="filter-option"] { height: 1.75rem; border-radius: var(--telo-radius-sm); color: var(--telo-color-muted); font-weight: 400; }
  [data-telo-part="filters-preset"]:hover, [data-telo-part="filter-option"]:hover { color: var(--telo-color-text); }
  [data-telo-part="filters-preset"][data-state="on"], [data-telo-part="filter-option"][data-state="on"] { background: var(--telo-color-surface); color: var(--telo-color-text); font-weight: 500; box-shadow: var(--telo-shadow-sm), 0 0 0 1px var(--telo-derived-hairline); }
  [data-telo-part="filters-summary"], [data-telo-part="filter-tags"] { gap: var(--telo-space-xs); }
  [data-telo-part="summary-chip"], [data-telo-part="filter-tag"] { gap: 0.125rem; height: 1.5rem; box-sizing: border-box; padding: 0 0.125rem 0 var(--telo-space-sm); border-radius: 999px; background: var(--telo-derived-fill); font-size: var(--telo-font-size-sm); font-weight: 500; }
  button[data-telo-part="summary-chip-remove"], button[data-telo-part="filter-tag-remove"] { width: 1.25rem; height: 1.25rem; padding: 0; border-radius: 999px; color: var(--telo-color-muted); }
  button[data-telo-part="filter-remove"] { width: 1.75rem; height: 1.75rem; padding: 0; margin-left: var(--telo-space-xs); color: var(--telo-color-muted); }
  [data-telo-part="summary-chip-remove"]:hover, [data-telo-part="filter-tag-remove"]:hover, [data-telo-part="filter-remove"]:hover { background: var(--telo-derived-fill); color: var(--telo-color-text); }
  [data-telo-part="summary-chip-remove"] > [data-telo-part="icon"], [data-telo-part="filter-tag-remove"] > [data-telo-part="icon"] { width: 0.75rem; height: 0.75rem; }
  [data-telo-part="filter-tags"] { min-height: 2rem; box-sizing: border-box; width: 16rem; max-width: 100%; padding: 0.1875rem 0.25rem; border: 1px solid var(--telo-color-border); border-radius: var(--telo-radius-md); background: var(--telo-derived-control); }
  [data-telo-part="filter-tags"]:focus-within { border-color: var(--telo-derived-ring); box-shadow: var(--telo-derived-focus); }
  [data-telo-part="filter-tags"] > [data-telo-part="filter-input"] { width: auto; height: 1.5rem; padding: 0 0.375rem; border: 0; background: transparent; box-shadow: none; }
  button[data-telo-part="filter-toggle"] { width: 2rem; height: 1.125rem; margin-block: 0.4375rem; padding: 0; border-radius: 999px; background: var(--telo-color-border); }
  button[data-telo-part="filter-toggle"][data-state="checked"] { background: var(--telo-color-accent); }
  [data-telo-part="filter-toggle"]::before { top: 1px; left: 1px; width: 0.875rem; height: 0.875rem; border-radius: 999px; background: var(--telo-color-surface); box-shadow: var(--telo-shadow-sm); transition: translate 150ms; }
  [data-telo-part="filter-toggle"][data-state="checked"]::before { translate: 0.875rem 0; }
  [data-telo-part="filter-slider"] { width: 12rem; max-width: 100%; height: 2rem; }
  [data-telo-part="filter-slider"] > :first-child { height: 0.25rem; border-radius: 999px; background: var(--telo-color-border); }
  [data-telo-part="filter-slider"] > :first-child > * { border-radius: 999px; background: var(--telo-color-accent); }
  [data-telo-part="filter-slider"] [role="slider"] { width: 1rem; height: 1rem; border: 1px solid var(--telo-derived-ring); border-radius: 999px; background: var(--telo-color-surface); box-shadow: var(--telo-shadow-sm); outline: none; transition: box-shadow 150ms; }
  [data-telo-part="filter-slider"] [role="slider"]:focus-visible { box-shadow: var(--telo-derived-focus); }

  /* Choice lists */
  [data-telo-part="select-content"] { padding: 0.25rem; border-radius: var(--telo-radius-md); background: var(--telo-color-surface); color: var(--telo-color-text); font-size: var(--telo-font-size-md); box-shadow: var(--telo-shadow-md), 0 0 0 1px var(--telo-derived-hairline); animation: telo-pop-in 100ms ease-out; transform-origin: var(--radix-select-content-transform-origin, var(--radix-dropdown-menu-content-transform-origin)); }
  [data-telo-part="select-item"] { gap: 0.375rem; padding: 0.25rem 2rem 0.25rem 0.375rem; border-radius: var(--telo-radius-sm); outline: none; }
  [data-telo-part="select-item"][data-highlighted], [data-telo-part="menu-item"][data-highlighted] { background: var(--telo-derived-fill); }
  [data-telo-part="select-item"][data-disabled] { pointer-events: none; opacity: 0.5; }
  [data-telo-part="menu"] { padding: 0.25rem; border-radius: var(--telo-radius-md); background: var(--telo-color-surface); color: var(--telo-color-text); font-size: var(--telo-font-size-md); box-shadow: var(--telo-shadow-md), 0 0 0 1px var(--telo-derived-hairline); animation: telo-pop-in 100ms ease-out; transform-origin: var(--radix-dropdown-menu-content-transform-origin); }
  [data-telo-part="menu-item"] { padding: 0.25rem 0.5rem 0.25rem 0.375rem; border-radius: var(--telo-radius-sm); outline: none; }
  [data-telo-part="select-item"] [data-telo-part="icon"] { right: 0.5rem; }
  [data-telo-part="tooltip"] { padding: 0.375rem 0.75rem; border-radius: var(--telo-radius-sm); background: var(--telo-color-text); color: var(--telo-color-background); font-size: var(--telo-font-size-sm); animation: telo-pop-in 100ms ease-out; transform-origin: var(--radix-tooltip-content-transform-origin); }

  /* Table */
  [data-telo-part="table"] { gap: var(--telo-space-md); }
  [data-telo-part="table-toolbar"], [data-telo-part="pager"] { gap: var(--telo-space-sm); }
  [data-telo-part="table-frame"] { border: 1px solid var(--telo-color-border); border-radius: var(--telo-radius-md); }
  [data-telo-part="table-header-cell"], [data-telo-part="table-cell"], [data-telo-part="row-actions"] { padding: var(--telo-space-sm); text-align: left; vertical-align: middle; }
  [data-telo-part="table-header-cell"]:first-child, [data-telo-part="table-cell"]:first-child { padding-left: var(--telo-space-md); }
  [data-telo-part="table-header-cell"] { height: 2.5rem; padding-block: 0; border-bottom: 1px solid var(--telo-color-border); font-weight: 500; white-space: nowrap; }
  button[data-telo-part="table-sort"] { height: 1.75rem; padding: 0 0.5rem; margin-left: -0.5rem; }
  [data-telo-part="table-sort"] > [data-telo-part="icon"] { width: 0.875rem; height: 0.875rem; color: var(--telo-color-muted); }
  [data-telo-part="table-header-cell"][data-sorted] [data-telo-part="icon"] { color: var(--telo-color-text); }
  [data-telo-part="table-row"] { border-bottom: 1px solid var(--telo-color-border); transition: background-color 150ms; }
  [data-telo-part="table-row"]:last-child { border-bottom: 0; }
  [data-telo-part="table-row"]:hover { background: color-mix(in oklab, var(--telo-derived-fill) 50%, transparent); }
  [data-telo-part="row-actions"] { padding-block: var(--telo-space-xs); text-align: right; }
  [data-telo-part="row-actions"] > * + * { margin-left: 0.125rem; }
  [data-telo-part="table-empty"], [data-telo-part="table-loading"] { height: 6rem; padding: var(--telo-space-sm); color: var(--telo-color-muted); }
  [data-telo-part="pager-status"] { color: var(--telo-color-muted); font-variant-numeric: tabular-nums; }

  /* Surfaces */
  [data-telo-part="surface-overlay"] { background: rgb(0 0 0 / 25%); animation: telo-fade-in 200ms ease-out; }
  [data-telo-part="surface-overlay"][data-state="closed"] { animation: telo-fade-out 150ms ease-in forwards; }
  [data-telo-part="surface"] { gap: var(--telo-space-lg); padding: var(--telo-space-lg); border-radius: var(--telo-radius-lg); background: var(--telo-color-surface); color: var(--telo-color-text); font-size: var(--telo-font-size-md); outline: none; }
  [data-surface="dialog"], [data-surface="confirmation"], [data-surface="popover"] { box-shadow: 0 0 0 1px var(--telo-derived-hairline), var(--telo-shadow-md); animation: telo-surface-in 150ms ease-out; }
  :is([data-surface="dialog"], [data-surface="confirmation"], [data-surface="popover"])[data-state="closed"] { animation: telo-surface-out 100ms ease-in forwards; }
  /* A drawer slides in from the edge it sits at, and out to it. */
  [data-surface="drawer"] { border-radius: 0; box-shadow: 0 0 0 1px var(--telo-derived-hairline), var(--telo-shadow-md); animation: telo-slide-in 200ms cubic-bezier(0.32, 0.72, 0, 1); }
  [data-surface="drawer"][data-state="closed"] { animation: telo-slide-out 150ms ease-in forwards; }
  [data-surface="drawer"][data-side="start"] { --telo-slide-x: -100%; }
  [data-surface="drawer"][data-side="end"] { --telo-slide-x: 100%; }
  :dir(rtl) [data-surface="drawer"][data-side="start"] { --telo-slide-x: 100%; }
  :dir(rtl) [data-surface="drawer"][data-side="end"] { --telo-slide-x: -100%; }
  [data-surface="drawer"][data-side="top"] { --telo-slide-y: -100%; }
  [data-surface="drawer"][data-side="bottom"] { --telo-slide-y: 100%; }
  [data-surface="inline"], [data-surface="panel"] { border: 1px solid var(--telo-color-border); border-radius: var(--telo-radius-md); }
  [data-surface="page"] { padding: 0; border-radius: 0; background: transparent; }
  [data-telo-part="table"]:has(> [data-surface="panel"]) { column-gap: var(--telo-space-lg); }
  [data-telo-part="table-detail"] { padding: var(--telo-space-sm); border-bottom: 1px solid var(--telo-color-border); }
  [data-telo-part="surface-header"] { gap: var(--telo-space-sm); padding-right: 1.75rem; }
  [data-telo-part="surface-title"] { margin: 0; font-family: var(--telo-font-heading); font-size: var(--telo-font-size-lg); font-weight: 500; line-height: 1; }
  [data-telo-part="surface-description"] { margin: 0; color: var(--telo-color-muted); }
  [data-telo-part="surface-close"] { top: var(--telo-space-sm); right: var(--telo-space-sm); }
  [data-telo-part="surface"] [data-telo-part="form-actions"] { bottom: calc(-1 * var(--telo-space-lg)); margin: auto calc(-1 * var(--telo-space-lg)) calc(-1 * var(--telo-space-lg)); padding: var(--telo-space-lg); border-top: 1px solid var(--telo-color-border); background: color-mix(in oklab, var(--telo-derived-fill) 50%, var(--telo-color-surface)); }
  [data-telo-part="surface-body"] { margin: 0 calc(-1 * var(--telo-space-lg)) calc(-1 * var(--telo-space-lg)); padding: 0 var(--telo-space-lg) var(--telo-space-lg); }
  [data-surface="page"] > [data-telo-part="surface-body"] { margin: 0; padding: 0; }
  [data-surface="page"] [data-telo-part="form-actions"] { bottom: 0; margin: 0; padding: var(--telo-space-lg) 0 0; background: var(--telo-color-background); }

  /* Status */
  [data-telo-part="error"] { gap: 0.125rem var(--telo-space-sm); padding: var(--telo-space-sm) 0.625rem; border: 1px solid var(--telo-color-border); border-radius: var(--telo-radius-md); background: var(--telo-color-surface); color: var(--telo-color-danger); text-align: left; }
  [data-telo-part="error"] > [data-telo-part="icon"] { margin-top: 0.125rem; }
  [data-telo-part="error-code"] { font-family: var(--telo-font-mono); font-size: var(--telo-font-size-sm); font-weight: 500; line-height: 1.25rem; }
  [data-telo-part="error-message"] { color: color-mix(in oklab, var(--telo-color-danger) 90%, transparent); }
  [data-telo-part="loading"] { gap: var(--telo-space-sm); color: var(--telo-color-muted); }
  [data-telo-part="loading"] > [data-telo-part="icon"] { animation: telo-spin 1s linear infinite; }

  /* Styles */
  [data-style~="muted"] { color: var(--telo-color-muted); }
  [data-style~="strong"] { font-weight: 600; }
  [data-style~="accent"] { color: var(--telo-color-accent); }
  [data-style~="danger"]:not(button) { color: var(--telo-color-danger); }
  [data-style~="warning"] { color: var(--telo-color-warning); }
  [data-style~="success"] { color: var(--telo-color-success); }
  [data-telo-part="badge"][data-style~="accent"] { background: var(--telo-color-accent); color: var(--telo-color-accent-text); }
  [data-telo-part="badge"][data-style~="danger"] { background: var(--telo-derived-danger-fill); }
  [data-telo-part="badge"][data-style~="warning"] { background: color-mix(in oklab, var(--telo-color-warning) 12%, transparent); }
  [data-telo-part="badge"][data-style~="success"] { background: color-mix(in oklab, var(--telo-color-success) 12%, transparent); }

  @keyframes telo-spin { to { transform: rotate(360deg); } }
  @keyframes telo-fade-in { from { opacity: 0; } }
  @keyframes telo-pop-in { from { opacity: 0; scale: 0.95; } }
  @keyframes telo-surface-in { from { opacity: 0; scale: 0.95; } }
  @keyframes telo-surface-out { to { opacity: 0; scale: 0.95; } }
  @keyframes telo-fade-out { to { opacity: 0; } }
  @keyframes telo-slide-in { from { translate: var(--telo-slide-x, 0) var(--telo-slide-y, 0); } }
  @keyframes telo-slide-out { to { translate: var(--telo-slide-x, 0) var(--telo-slide-y, 0); } }
  @media (prefers-reduced-motion: reduce) {
    [data-telo-part="surface-overlay"], [data-telo-part="surface"], [data-telo-part="select-content"], [data-telo-part="menu"], [data-telo-part="tooltip"] { animation: none; }
  }
}
`;
