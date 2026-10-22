import { useState } from "react";
import type { MultiSelectProps, SelectProps } from "../contract/ui-react-controls.js";
import { useControl } from "./effective-controls.js";

type Held<P> = Omit<P, "open" | "onOpenChange" | "loading" | "hasMore"> & { loading?: boolean; hasMore?: boolean };

/** A select, its list open while the control asks for it. */
export function SelectList({ loading = false, hasMore = false, ...props }: Held<SelectProps>) {
  const Select = useControl("Select");
  const [open, setOpen] = useState(false);
  return <Select {...props} loading={loading} hasMore={hasMore} open={open} onOpenChange={setOpen} />;
}

/** A multi-select, its list open while the control asks for it. */
export function MultiSelectList({ loading = false, hasMore = false, ...props }: Held<MultiSelectProps>) {
  const MultiSelect = useControl("MultiSelect");
  const [open, setOpen] = useState(false);
  return <MultiSelect {...props} loading={loading} hasMore={hasMore} open={open} onOpenChange={setOpen} />;
}
