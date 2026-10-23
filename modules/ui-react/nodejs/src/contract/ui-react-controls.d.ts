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
