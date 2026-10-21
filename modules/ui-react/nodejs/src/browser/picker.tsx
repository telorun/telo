import { useEffect, useRef, useState, type UIEvent } from "react";
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
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [search, setSearch] = useState("");
  const pause = useRef<ReturnType<typeof setTimeout>>(undefined);
  const anchor = useRef<HTMLButtonElement | null>(null);
  useEffect(() => () => clearTimeout(pause.current), []);
  const pages = useOptionPages(source, roots, search, open);
  const shown = useChosenOptions(source, roots, chosen, pages.options, onChange);
  const held = new Set(chosen.map(optionKey));

  const choose = (option: ChoiceOption) => {
    const key = optionKey(option.value);
    if (!many) {
      onChange([option.value]);
      setOpen(false);
      return;
    }
    onChange(held.has(key) ? chosen.filter((value) => optionKey(value) !== key) : [...chosen, option.value]);
  };
  const scrolled = (event: UIEvent<HTMLElement>) => {
    const list = event.currentTarget;
    if (list.scrollTop + list.clientHeight >= list.scrollHeight - 8) pages.next();
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
          {source.search && (
            <input
              data-telo-part="picker-search"
              type="search"
              autoComplete="off"
              aria-label={say("search", { label })}
              value={typed}
              onChange={(event) => {
                const text = event.target.value;
                setTyped(text);
                clearTimeout(pause.current);
                pause.current = setTimeout(() => setSearch(text), TYPING_PAUSE);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                clearTimeout(pause.current);
                setSearch(typed);
              }}
            />
          )}
          <ul data-telo-part="picker-list" role="listbox" aria-multiselectable={many} data-state={pages.loading ? "loading" : "idle"} onScroll={scrolled}>
            {pages.options.map((option) => (
              <li
                key={optionKey(option.value)}
                data-telo-part="picker-option"
                role="option"
                aria-selected={held.has(optionKey(option.value))}
                data-state={held.has(optionKey(option.value)) ? "on" : "off"}
                tabIndex={0}
                onClick={() => choose(option)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    choose(option);
                  }
                }}
              >
                {option.label}
                {option.hint !== undefined && <span data-telo-part="option-hint">{option.hint}</span>}
              </li>
            ))}
          </ul>
          {!pages.loading && pages.options.length === 0 && <p data-telo-part="picker-empty">{say("nothingFound")}</p>}
        </Surface>
      )}
    </div>
  );
}
