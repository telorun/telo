import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from "react";
import { useControl } from "./effective-controls.js";
import {
  DOUBLE_CLICK_SCALE,
  FITTED,
  ZOOM_STEP,
  isFitted,
  panBy,
  wheelFactor,
  zoomAbout,
  type Point,
  type Size,
  type View,
} from "./media-viewer-zoom.js";
import { useSay } from "./texts.js";

/** One picture the viewer steps through. */
export interface MediaItem {
  /** Where the picture is read from, and the link to its original. */
  src: string;
  /** The file's name, which names the picture. */
  name: string;
}

/** Horizontal travel, in pixels, that a drag on a fitted picture counts as a swipe. */
const SWIPE = 48;
/** What a wheel turn in lines is worth in pixels. */
const LINE_PIXELS = 16;

/** How a stage's centre, its size and the picture's fitted size stand, read when a gesture needs them. */
interface Measure {
  centre: Point;
  stage: Size;
  picture: Size;
}

/**
 * A full-screen viewer over the pictures of `items`, shown at `index`: it steps
 * through them (previous and next buttons, the arrow keys, a swipe), zooms
 * (buttons, `+` / `-` / `0`, the wheel and a pinch about the pointer, a double
 * click) and pans a zoomed picture within its bounds. The zoom starts fitted
 * again on every picture. Escape and the surface's close button ask `onClose`;
 * the focus stays inside and returns to where it was.
 */
export function MediaViewer({ items, index, onIndex, onClose }: { items: readonly MediaItem[]; index: number; onIndex: (index: number) => void; onClose: () => void }) {
  const say = useSay();
  const Dialog = useControl("Dialog");
  const Icon = useControl("Icon");
  const titleId = useId();
  const stage = useRef<HTMLDivElement>(null);
  const picture = useRef<HTMLImageElement>(null);
  const total = items.length;
  const item = items[index];

  /** The view belongs to the picture it was made on: another picture starts fitted. */
  const [held, setHeld] = useState<{ index: number; view: View }>({ index, view: FITTED });
  const view = held.index === index ? held.view : FITTED;
  const viewRef = useRef(view);
  viewRef.current = view;
  const update = (next: View) => {
    viewRef.current = next;
    setHeld({ index, view: next });
  };

  const measure = (): Measure => {
    const frame = (stage.current as HTMLElement).getBoundingClientRect();
    return {
      centre: { x: frame.left + frame.width / 2, y: frame.top + frame.height / 2 },
      stage: { width: stage.current?.clientWidth ?? 0, height: stage.current?.clientHeight ?? 0 },
      picture: { width: picture.current?.offsetWidth ?? 0, height: picture.current?.offsetHeight ?? 0 },
    };
  };
  const about = (at: Point, centre: Point): Point => ({ x: at.x - centre.x, y: at.y - centre.y });

  const zoomTo = (scale: number, at?: Point) => {
    const { centre, stage: frame, picture: fitted } = measure();
    update(zoomAbout(viewRef.current, scale, at ? about(at, centre) : { x: 0, y: 0 }, fitted, frame));
  };
  const step = (by: number) => onIndex((index + by + total) % total);

  // Keys act wherever the focus is inside the viewer, which the dialog keeps it.
  const latest = useRef({ step, zoomTo, update });
  latest.current = { step, zoomTo, update };
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      const { step: move, zoomTo: zoom, update: reset } = latest.current;
      const scale = viewRef.current.scale;
      switch (event.key) {
        case "ArrowLeft":
          if (total > 1) move(-1);
          break;
        case "ArrowRight":
          if (total > 1) move(1);
          break;
        case "+":
        case "=":
          zoom(scale * ZOOM_STEP);
          break;
        case "-":
          zoom(scale / ZOOM_STEP);
          break;
        case "0":
          reset(FITTED);
          break;
        default:
          return;
      }
      event.preventDefault();
    };
    document.addEventListener("keydown", keys);
    return () => document.removeEventListener("keydown", keys);
  }, [total]);

  // The wheel zooms about the pointer; a listener of its own, since React's is passive.
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const pixels = event.deltaMode === 1 ? event.deltaY * LINE_PIXELS : event.deltaY;
      latest.current.zoomTo(viewRef.current.scale * wheelFactor(pixels), { x: event.clientX, y: event.clientY });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);

  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{ start: Point; pinch?: { distance: number; scale: number } }>({ start: { x: 0, y: 0 } });
  const distance = () => {
    const [a, b] = [...pointers.current.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  const down = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    gesture.current = { start: { x: event.clientX, y: event.clientY }, pinch: pointers.current.size === 2 ? { distance: distance(), scale: viewRef.current.scale } : undefined };
  };

  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const before = pointers.current.get(event.pointerId);
    if (!before) return;
    const at = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, at);
    const { centre, stage: frame, picture: fitted } = measure();
    const { pinch } = gesture.current;
    if (pointers.current.size === 2 && pinch && pinch.distance > 0) {
      const [a, b] = [...pointers.current.values()];
      const middle = about({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, centre);
      update(zoomAbout(viewRef.current, pinch.scale * (distance() / pinch.distance), middle, fitted, frame));
    } else if (pointers.current.size === 1 && viewRef.current.scale > 1) {
      update(panBy(viewRef.current, { x: at.x - before.x, y: at.y - before.y }, fitted, frame));
    }
  };

  const up = (event: ReactPointerEvent<HTMLDivElement>) => {
    const was = pointers.current.size;
    if (!pointers.current.delete(event.pointerId)) return;
    if (event.type !== "pointerup" || was !== 1 || total < 2 || viewRef.current.scale > 1) return;
    const dx = event.clientX - gesture.current.start.x;
    const dy = event.clientY - gesture.current.start.y;
    if (Math.abs(dx) >= SWIPE && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
  };

  const doubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!isFitted(viewRef.current)) return update(FITTED);
    zoomTo(DOUBLE_CLICK_SCALE, { x: event.clientX, y: event.clientY });
  };

  if (!item) return null;
  return (
    <Dialog
      open
      modal
      labelledBy={titleId}
      attributes={{ "data-surface": "dialog", "data-size": "full", "data-modal": "true" }}
      onOpenChange={(open) => open || onClose()}
    >
      <div data-telo-part="surface-header">
        <h2 data-telo-part="surface-title" id={titleId}>
          {say("mediaViewer")}
        </h2>
      </div>
      <div data-telo-part="media-viewer">
        <div
          data-telo-part="media-viewer-stage"
          ref={stage}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          onDoubleClick={doubleClick}
        >
          <img
            key={item.src}
            data-telo-part="media-viewer-image"
            ref={picture}
            src={item.src}
            alt={item.name}
            draggable={false}
            decoding="async"
            referrerPolicy="no-referrer"
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
          />
        </div>
        <div data-telo-part="media-viewer-toolbar">
          {total > 1 && (
            <>
              <button data-telo-part="media-viewer-previous" type="button" aria-label={say("mediaPrevious")} onClick={() => step(-1)}>
                <Icon name="previous" />
              </button>
              <span data-telo-part="media-viewer-position" role="status">
                {say("mediaPosition", { position: index + 1, total })}
              </span>
              <button data-telo-part="media-viewer-next" type="button" aria-label={say("mediaNext")} onClick={() => step(1)}>
                <Icon name="next" />
              </button>
            </>
          )}
          <button data-telo-part="media-viewer-zoom-out" type="button" aria-label={say("mediaZoomOut")} onClick={() => zoomTo(view.scale / ZOOM_STEP)}>
            −
          </button>
          <button data-telo-part="media-viewer-zoom-reset" type="button" aria-label={say("mediaZoomReset")} onClick={() => update(FITTED)}>
            1:1
          </button>
          <button data-telo-part="media-viewer-zoom-in" type="button" aria-label={say("mediaZoomIn")} onClick={() => zoomTo(view.scale * ZOOM_STEP)}>
            +
          </button>
          <a data-telo-part="media-viewer-download" href={item.src} download={item.name} target="_blank" rel="noopener noreferrer">
            <Icon name="export" />
            {say("mediaDownload", { name: item.name })}
          </a>
        </div>
      </div>
      <button data-telo-part="surface-close" type="button" aria-label={say("close")} onClick={onClose}>
        <Icon name="close" />
      </button>
    </Dialog>
  );
}
