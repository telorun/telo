// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { MediaViewer } from "../src/browser/media-viewer.js";
import { FITTED, MAX_SCALE, clampView, panBy, zoomAbout } from "../src/browser/media-viewer-zoom.js";
import { TextsContext } from "../src/browser/texts.js";
import { uiTexts } from "./ui-texts.js";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const PICTURE = { width: 400, height: 300 };
const STAGE = { width: 800, height: 600 };

describe("a view", () => {
  it("is held between fitted and the maximum zoom, and a picture smaller than its stage stays centred", () => {
    expect(clampView({ scale: 0.2, x: 50, y: 50 }, PICTURE, STAGE)).toEqual(FITTED);
    expect(clampView({ scale: 100, x: 0, y: 0 }, PICTURE, STAGE).scale).toBe(MAX_SCALE);
    // Zoomed to 1.5 the picture is 600 wide in an 800 stage: it can not leave the centre.
    expect(clampView({ scale: 1.5, x: 90, y: -90 }, PICTURE, STAGE)).toEqual({ scale: 1.5, x: 0, y: 0 });
  });

  it("pans only as far as the zoomed picture reaches past its stage", () => {
    const zoomed = { scale: 4, x: 0, y: 0 };
    // 1600 wide in 800: 400 each side; 1200 high in 600: 300.
    expect(panBy(zoomed, { x: 9999, y: -9999 }, PICTURE, STAGE)).toEqual({ scale: 4, x: 400, y: -300 });
    expect(panBy(zoomed, { x: 10, y: 20 }, PICTURE, STAGE)).toEqual({ scale: 4, x: 10, y: 20 });
  });

  it("zooms about a point, which stays where it was", () => {
    const view = zoomAbout(FITTED, 4, { x: 100, y: 0 }, PICTURE, STAGE);
    expect(view).toEqual({ scale: 4, x: -300, y: 0 });
    // The point under the pointer is the same picture point before and after.
    expect((100 - FITTED.x) / FITTED.scale).toBe((100 - view.x) / view.scale);
  });
});

describe("the viewer", () => {
  let root: Root | undefined;
  afterEach(() => act(() => root?.unmount()));

  it("starts every picture fitted, and the buttons zoom and reset", async () => {
    const container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
    const items = [
      { src: "/a.png", name: "a.png" },
      { src: "/b.png", name: "b.png" },
    ];
    const Viewer = ({ index }: { index: number }) => (
      <TextsContext.Provider value={uiTexts()}>
        <MediaViewer items={items} index={index} onIndex={() => undefined} onClose={() => undefined} />
      </TextsContext.Provider>
    );
    const part = (name: string) => document.querySelector(`[data-telo-part="${name}"]`) as HTMLElement;
    const transform = () => part("media-viewer-image").style.transform;
    await act(async () => root!.render(<Viewer index={0} />));
    expect(transform()).toBe("translate(0px, 0px) scale(1)");
    await act(async () => part("media-viewer-zoom-in").click());
    await act(async () => part("media-viewer-zoom-in").click());
    expect(transform()).toBe("translate(0px, 0px) scale(2.25)");
    await act(async () => part("media-viewer-zoom-out").click());
    expect(transform()).toBe("translate(0px, 0px) scale(1.5)");
    await act(async () => part("media-viewer-zoom-reset").click());
    expect(transform()).toBe("translate(0px, 0px) scale(1)");
    await act(async () => part("media-viewer-zoom-in").click());
    await act(async () => root!.render(<Viewer index={1} />));
    expect([part("media-viewer-image").getAttribute("alt"), transform()]).toEqual(["b.png", "translate(0px, 0px) scale(1)"]);
  });
});
