import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MapField } from "./map-field";
import type { JsonSchemaProperty } from "./types";

afterEach(() => {
  cleanup();
});

const stringValueSchema: JsonSchemaProperty = {
  type: "object",
  additionalProperties: { type: "string" },
};

interface HarnessOverrides {
  initial?: Record<string, unknown> | undefined;
  prop?: JsonSchemaProperty;
  fieldPath?: string;
  required?: boolean;
  onValueChange?: (next: unknown) => void;
  onErrorChange?: (path: string, hasError: boolean) => void;
  onFieldBlur?: (name: string) => void;
}

/**
 * Wraps MapField in a small stateful host so userEvent interactions actually
 * round-trip through `value`. Tests can also pass spies for the callbacks.
 */
function Harness({
  initial,
  prop = stringValueSchema,
  fieldPath = "headers",
  required = false,
  onValueChange,
  onErrorChange,
  onFieldBlur,
}: HarnessOverrides) {
  const [value, setValue] = useState<unknown>(initial);
  return (
    <MapField
      rootFieldName="headers"
      fieldPath={fieldPath}
      prop={prop}
      value={value}
      onValueChange={(next) => {
        setValue(next);
        onValueChange?.(next);
      }}
      onFieldBlur={onFieldBlur}
      onErrorChange={onErrorChange}
      resolvedResources={[]}
      label="Headers"
      required={required}
    />
  );
}

async function expandTrigger() {
  // The collapsible auto-opens when empty. When entries exist, the trigger is
  // collapsed and we have to open it to interact with rows. Find it by the
  // Radix data-state attribute so the test works regardless of label/title.
  const closed = document.querySelector('button[data-state="closed"][aria-expanded="false"]');
  if (closed) {
    await userEvent.click(closed as HTMLElement);
  }
}

function getRows(): HTMLElement[] {
  // Each row contains a key input with placeholder="key". Walk up to its row
  // container (the closest ancestor with a `border` class — the row wrapper).
  return screen
    .queryAllByPlaceholderText("key")
    .map((input) => input.closest("div.flex.items-start") as HTMLElement)
    .filter(Boolean);
}

function getKeyInput(row: HTMLElement): HTMLInputElement {
  return within(row).getByPlaceholderText("key") as HTMLInputElement;
}

function getValueInput(row: HTMLElement): HTMLInputElement {
  // Within a row, the only other text input is the FieldControl-rendered scalar.
  const inputs = within(row).getAllByRole("textbox");
  // First is key (has placeholder="key"), second is value.
  return inputs.find((el) => (el as HTMLInputElement).placeholder !== "key") as HTMLInputElement;
}

describe("MapField rendering", () => {
  it("shows only the Add entry button when value is undefined", () => {
    render(<Harness initial={undefined} />);
    expect(screen.getByRole("button", { name: /Add entry/i })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("key")).not.toBeInTheDocument();
  });

  it("shows only the Add entry button when value is an empty object", () => {
    render(<Harness initial={{}} />);
    expect(screen.queryByPlaceholderText("key")).not.toBeInTheDocument();
  });

  it("renders a row per entry, in insertion order", async () => {
    render(<Harness initial={{ Authorization: "Bearer abc", "X-Trace": "42" }} />);
    await expandTrigger();
    const keys = screen.getAllByPlaceholderText("key").map((i) => (i as HTMLInputElement).value);
    expect(keys).toEqual(["Authorization", "X-Trace"]);
  });

  it("uses prop.title as the trigger label, falling back to label, then 'map'", () => {
    const { unmount } = render(
      <Harness prop={{ type: "object", additionalProperties: { type: "string" }, title: "My Headers" }} />,
    );
    expect(screen.getByRole("button", { name: /My Headers/i })).toBeInTheDocument();
    unmount();
    render(
      <MapField
        rootFieldName="headers"
        fieldPath="headers"
        prop={{ type: "object", additionalProperties: { type: "string" } }}
        value={undefined}
        onValueChange={() => {}}
        resolvedResources={[]}
      />,
    );
    // Fallback title "map" appears in its own span; match it by accessible
    // name prefix since the trigger also surfaces the entry count.
    expect(screen.getByRole("button", { name: /^map\b/i })).toBeInTheDocument();
  });
});

describe("MapField add / remove / rename", () => {
  it("adding a row does not emit onValueChange until the key is non-empty", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<Harness onValueChange={onValueChange} />);
    await user.click(screen.getByRole("button", { name: /Add entry/i }));
    expect(getRows()).toHaveLength(1);
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("typing a valid key emits the serialized object", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<Harness onValueChange={onValueChange} />);
    await user.click(screen.getByRole("button", { name: /Add entry/i }));
    const input = screen.getByPlaceholderText("key");
    await user.type(input, "Auth");
    // userEvent.type fires a change per character. Last call is the committed object.
    expect(onValueChange).toHaveBeenLastCalledWith({ Auth: "" });
  });

  it("renaming a key keeps row position (no end-of-object jump)", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<Harness initial={{ A: "1", B: "2", C: "3" }} onValueChange={onValueChange} />);
    await expandTrigger();
    const rows = getRows();
    const middle = getKeyInput(rows[1]);
    await user.clear(middle);
    await user.type(middle, "BB");
    const last = onValueChange.mock.calls.at(-1)?.[0] as Record<string, string>;
    expect(Object.keys(last)).toEqual(["A", "BB", "C"]);
  });

  it("removing a row emits the object without that key", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<Harness initial={{ A: "1", B: "2" }} onValueChange={onValueChange} />);
    await expandTrigger();
    const removeButtons = screen.getAllByRole("button", { name: /Remove entry/i });
    await user.click(removeButtons[0]);
    expect(onValueChange).toHaveBeenLastCalledWith({ B: "2" });
  });

  it("Clear button is hidden when required is true", async () => {
    render(<Harness initial={{ A: "1" }} required />);
    await expandTrigger();
    expect(screen.queryByRole("button", { name: /^Clear/i })).not.toBeInTheDocument();
  });

  it("Clear button emits undefined when not required and the map has entries", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<Harness initial={{ A: "1" }} onValueChange={onValueChange} />);
    await expandTrigger();
    await user.click(screen.getByRole("button", { name: /^Clear/i }));
    expect(onValueChange).toHaveBeenLastCalledWith(undefined);
  });
});

describe("MapField key validation", () => {
  it("flags empty keys with role=alert and aria-invalid", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: /Add entry/i }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Key cannot be empty");
    const keyInput = screen.getByPlaceholderText("key");
    expect(keyInput).toHaveAttribute("aria-invalid", "true");
    expect(keyInput).toHaveAttribute("aria-describedby", alert.id);
  });

  it("flags duplicate keys on the second occurrence and excludes it from serialization", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<Harness initial={{ Auth: "1" }} onValueChange={onValueChange} />);
    await expandTrigger();
    await user.click(screen.getByRole("button", { name: /Add entry/i }));
    const inputs = screen.getAllByPlaceholderText("key");
    await user.type(inputs[1], "Auth");
    expect(await screen.findByRole("alert")).toHaveTextContent("Duplicate key");
    // First (committed) row keeps its value; duplicate row is dropped from the
    // serialized object.
    const last = onValueChange.mock.calls.at(-1)?.[0];
    expect(last).toEqual({ Auth: "1" });
  });

  it("flags pattern mismatches against propertyNames.pattern", async () => {
    const user = userEvent.setup();
    const propWithPattern: JsonSchemaProperty = {
      type: "object",
      additionalProperties: { type: "string" },
      propertyNames: { pattern: "^[A-Z]" },
    };
    render(<Harness prop={propWithPattern} />);
    await user.click(screen.getByRole("button", { name: /Add entry/i }));
    const input = screen.getByPlaceholderText("key");
    await user.type(input, "lower");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Key must match pattern ^[A-Z]");
  });

  it("error precedence is empty > duplicate > pattern", async () => {
    const user = userEvent.setup();
    const propWithPattern: JsonSchemaProperty = {
      type: "object",
      additionalProperties: { type: "string" },
      propertyNames: { pattern: "^[A-Z]" },
    };
    // Two empty-key rows: both should report "empty", not "duplicate" — empty
    // beats duplicate per the documented precedence.
    render(<Harness prop={propWithPattern} initial={{}} />);
    await user.click(screen.getByRole("button", { name: /Add entry/i }));
    await user.click(screen.getByRole("button", { name: /Add entry/i }));
    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(2);
    for (const a of alerts) expect(a).toHaveTextContent("Key cannot be empty");
  });
});

describe("MapField onErrorChange lifecycle", () => {
  it("emits (path, true) when an error appears and (path, false) when it clears", async () => {
    const user = userEvent.setup();
    const onErrorChange = vi.fn();
    render(<Harness onErrorChange={onErrorChange} />);
    await user.click(screen.getByRole("button", { name: /Add entry/i }));
    // Empty-key error → true
    await vi.waitFor(() => {
      expect(onErrorChange).toHaveBeenCalledWith("headers", true);
    });
    onErrorChange.mockClear();
    await user.type(screen.getByPlaceholderText("key"), "Auth");
    await vi.waitFor(() => {
      expect(onErrorChange).toHaveBeenCalledWith("headers", false);
    });
  });

  it("emits (path, false) on unmount when an error was previously reported", async () => {
    const user = userEvent.setup();
    const onErrorChange = vi.fn();
    const { unmount } = render(<Harness onErrorChange={onErrorChange} fieldPath="headers" />);
    await user.click(screen.getByRole("button", { name: /Add entry/i }));
    await vi.waitFor(() => {
      expect(onErrorChange).toHaveBeenCalledWith("headers", true);
    });
    onErrorChange.mockClear();
    unmount();
    expect(onErrorChange).toHaveBeenCalledWith("headers", false);
  });

  it("emits (oldPath, false) when fieldPath changes", async () => {
    const user = userEvent.setup();
    const onErrorChange = vi.fn();
    function PathSwitcher() {
      const [path, setPath] = useState("headers");
      return (
        <>
          <button onClick={() => setPath("renamed")}>switch</button>
          <Harness onErrorChange={onErrorChange} fieldPath={path} />
        </>
      );
    }
    render(<PathSwitcher />);
    await user.click(screen.getByRole("button", { name: /Add entry/i }));
    await vi.waitFor(() => {
      expect(onErrorChange).toHaveBeenCalledWith("headers", true);
    });
    onErrorChange.mockClear();
    await user.click(screen.getByRole("button", { name: /switch/i }));
    // Old path must be cleared; new path may then re-fire true.
    expect(onErrorChange).toHaveBeenCalledWith("headers", false);
  });
});

describe("MapField external value resync", () => {
  it("rebuilds rows when the parent passes a different object", async () => {
    function ExternalSwap() {
      const [value, setValue] = useState<Record<string, unknown>>({ A: "1" });
      return (
        <>
          <button onClick={() => setValue({ B: "2", C: "3" })}>swap</button>
          <MapField
            rootFieldName="headers"
            fieldPath="headers"
            prop={stringValueSchema}
            value={value}
            onValueChange={(next) => setValue(next as Record<string, unknown>)}
            resolvedResources={[]}
          />
        </>
      );
    }
    const user = userEvent.setup();
    render(<ExternalSwap />);
    await expandTrigger();
    expect(screen.getAllByPlaceholderText("key").map((i) => (i as HTMLInputElement).value)).toEqual([
      "A",
    ]);
    await user.click(screen.getByRole("button", { name: /swap/i }));
    await expandTrigger();
    expect(screen.getAllByPlaceholderText("key").map((i) => (i as HTMLInputElement).value)).toEqual([
      "B",
      "C",
    ]);
  });

  it("resyncs row order when the parent reorders the same keys", async () => {
    function ExternalReorder() {
      const [value, setValue] = useState<Record<string, unknown>>({ A: "1", B: "2" });
      return (
        <>
          <button onClick={() => setValue({ B: "2", A: "1" })}>reorder</button>
          <MapField
            rootFieldName="headers"
            fieldPath="headers"
            prop={stringValueSchema}
            value={value}
            onValueChange={(next) => setValue(next as Record<string, unknown>)}
            resolvedResources={[]}
          />
        </>
      );
    }
    const user = userEvent.setup();
    render(<ExternalReorder />);
    await expandTrigger();
    expect(screen.getAllByPlaceholderText("key").map((i) => (i as HTMLInputElement).value)).toEqual([
      "A",
      "B",
    ]);
    await user.click(screen.getByRole("button", { name: /reorder/i }));
    await expandTrigger();
    // Order-sensitive shallowEqualObject must detect the swap and resync.
    expect(screen.getAllByPlaceholderText("key").map((i) => (i as HTMLInputElement).value)).toEqual([
      "B",
      "A",
    ]);
  });
});

describe("MapField value editing", () => {
  it("editing a value emits the serialized object with the new value", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<Harness initial={{ Auth: "old" }} onValueChange={onValueChange} />);
    await expandTrigger();
    const row = getRows()[0];
    const valueInput = getValueInput(row);
    await user.clear(valueInput);
    await user.type(valueInput, "new");
    const last = onValueChange.mock.calls.at(-1)?.[0];
    expect(last).toEqual({ Auth: "new" });
  });
});
