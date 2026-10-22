import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  CircleAlert,
  ListFilter,
  LoaderCircle,
  Pencil,
  Plus,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import type { IconName, IconProps } from "../../../../ui-react/nodejs/src/contract/ui-react-controls.js";

const GLYPHS: Record<IconName, LucideIcon> = {
  add: Plus,
  alert: CircleAlert,
  close: X,
  delete: Trash2,
  edit: Pencil,
  filter: ListFilter,
  loading: LoaderCircle,
  next: ChevronRight,
  previous: ChevronLeft,
  remove: X,
  reset: X,
  "sort-ascending": ArrowUp,
  "sort-descending": ArrowDown,
  sortable: ChevronsUpDown,
};

/** A decorative glyph, by what it means. */
export function Icon({ name }: IconProps) {
  const Glyph = GLYPHS[name];
  return <Glyph data-telo-part="icon" aria-hidden="true" focusable="false" />;
}
