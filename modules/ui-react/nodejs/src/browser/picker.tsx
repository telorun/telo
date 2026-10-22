import { useEffect, useRef, useState } from "react";
import { useControls } from "./effective-controls.js";
import { useHostStore } from "./host.js";
import { linkAddress } from "./link-address.js";
import { optionKey, useChosenOptions, useOptionPages, type ChoiceOption, type OptionSourceSpec } from "./option-source.js";
import { Surface, type SurfaceSpec } from "./surface.js";
import { useSay } from "./texts.js";
import { TYPING_PAUSE } from "./typing-pause.js";

interface PickerProps {
  id: string;
  label: string;
  source: OptionSourceSpec;
  surface: SurfaceSpec;
  /** Whether several values are chosen: the property is a list. */
  many: boolean;
  roots: Readonly<Record<string, unknown>>;
  chosen: unknown[];
  invalid: boolean;
  onChange: (chosen: unknown[]) => void;
}

/** A chosen option shown as its label, linked where the source gives a link. */
function ChosenLabel({ option }: { option: ChoiceOption }) {
  const store = useHostStore();
  const href = option.href === undefined ? undefined : linkAddress(store, option.href);
  return href ? (
    <a data-telo-part="picker-chosen" href={href}>
      {option.label}
    </a>
  ) : (
    <span data-telo-part="picker-chosen">{option.label}</span>
  );
}

/**
 * Options searched for and chosen in a surface of their own: what is typed is
 * sent after the typing pause, or at once on Enter, an answer to an older
 * search discarded; the list reads one more page per scroll to its end. The
 * chosen values are shown as their labels outside it.
 */
export function Picker({ id, label, source, surface, many, roots, chosen, invalid, onChange }: PickerProps) {
  const say = useSay();
  const control = useControls();
  const [open, setOpen] = useState(false);
  const TextInput = open && source.search ? control("TextInput") : undefined;
  const Listbox = open ? control("Listbox") : undefined;
  const [typed, setTyped] = useState("");
  const [search, setSearch] = useState("");
  const pause = useRef<ReturnType<typeof setTimeout>>(undefined);
  const anchor = useRef<HTMLButtonElement | null>(null);
  useEffect(() => () => clearTimeout(pause.current), []);
  const pages = useOptionPages(source, roots, search, open);
  const shown = useChosenOptions(source, roots, chosen, pages.options, onChange);
  // The list reports keys; each is an option it offers or a value already chosen.
  const valueOf = (key: string) => {
    const offered = pages.options.find((option) => optionKey(option.value) === key);
    return offered ? [offered.value] : chosen.filter((value) => optionKey(value) === key).slice(0, 1);
  };
  const choose = (keys: string[]) => {
    const next = keys.flatMap(valueOf);
    if (!many) {
      onChange(next.slice(0, 1));
      setOpen(false);
      return;
    }
    onChange(next);
  };
  const searchFor = (text: string) => {
    clearTimeout(pause.current);
    setSearch(text);
  };

  return (
    <div data-telo-part="picker" data-invalid={invalid ? "true" : undefined}>
      {shown.length > 0 && (
        <span data-telo-part="picker-value">
          {shown.map((option) => (
            <ChosenLabel key={optionKey(option.value)} option={option} />
          ))}
        </span>
      )}
      <button
        data-telo-part="picker-trigger"
        id={id}
        type="button"
        ref={anchor}
        aria-invalid={invalid ? true : undefined}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        {say("choose")}
      </button>
      {open && (
        <Surface spec={surface} title={label} anchor={anchor} onClose={() => setOpen(false)}>
          {TextInput && (
            <TextInput
              id={`${id}-search`}
              label={say("search", { label })}
              invalid={false}
              required={false}
              disabled={false}
              part="picker-search"
              type="search"
              value={typed}
              onChange={(text) => {
                setTyped(text);
                clearTimeout(pause.current);
                pause.current = setTimeout(() => setSearch(text), TYPING_PAUSE);
              }}
              onCommit={() => searchFor(typed)}
            />
          )}
          {Listbox && (
            <Listbox
              label={label}
              multiple={many}
              options={pages.options.map((option) => ({ key: optionKey(option.value), label: option.label, ...(option.hint !== undefined ? { hint: option.hint } : {}) }))}
              value={chosen.map(optionKey)}
              loading={pages.loading}
              hasMore={pages.more}
              onChange={choose}
              onEndReached={pages.next}
            />
          )}
          {!pages.loading && pages.options.length === 0 && <p data-telo-part="picker-empty">{say("nothingFound")}</p>}
        </Surface>
      )}
    </div>
  );
}
