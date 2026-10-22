/**
 * The built-in controls: the reference implementation of `ui_react_controls-1`,
 * drawn wherever no theme replaces a control. This directory is the only part
 * of the renderer that reaches the interactive primitives, the icon set and the
 * browser's own entry elements.
 */
import type { Controls } from "../../contract/ui-react-controls.js";
import { Checkbox, OptionGroup, Slider, Switch } from "./choice.js";
import { DateRangeInput } from "./date-range-input.js";
import { DateInput, DateTimeInput, NumberInput, TextArea, TextInput, TimeInput } from "./entry.js";
import { Icon } from "./icon.js";
import { Listbox } from "./listbox.js";
import { Menu } from "./menu.js";
import { Confirmation, Dialog, Drawer, Popover } from "./overlays.js";
import { MultiSelect, Select } from "./select.js";
import { TagsInput } from "./tags-input.js";
import { Tooltip } from "./tooltip.js";

export const BUILT_IN_CONTROLS: Controls = {
  TextInput,
  NumberInput,
  TextArea,
  DateInput,
  DateTimeInput,
  TimeInput,
  TagsInput,
  DateRangeInput,
  Checkbox,
  Switch,
  Slider,
  OptionGroup,
  Select,
  MultiSelect,
  Listbox,
  Dialog,
  Drawer,
  Popover,
  Confirmation,
  Menu,
  Tooltip,
  Icon,
};
