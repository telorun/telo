/** Where a picture stands in its stage: its zoom and its offset from the stage's centre, in pixels. */
export interface View {
  scale: number;
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export const FITTED: View = { scale: 1, x: 0, y: 0 };
export const MAX_SCALE = 8;
/** What a button, a key or a double click multiplies the zoom by. */
export const ZOOM_STEP = 1.5;
/** The zoom a double click on a fitted picture goes to. */
export const DOUBLE_CLICK_SCALE = 2.5;

/** The view with its zoom held between fitted and `MAX_SCALE`, and its offset keeping the picture over the stage: a picture smaller than the stage stays centred. */
export function clampView(view: View, picture: Size, stage: Size): View {
  const scale = Math.min(MAX_SCALE, Math.max(1, view.scale));
  const reach = (shown: number, room: number) => Math.max(0, (shown * scale - room) / 2);
  const limit = { x: reach(picture.width, stage.width), y: reach(picture.height, stage.height) };
  return {
    scale,
    x: Math.min(limit.x, Math.max(-limit.x, view.x)) + 0,
    y: Math.min(limit.y, Math.max(-limit.y, view.y)) + 0,
  };
}

/** The view zoomed to `scale` about `around` (relative to the stage's centre), so the point under it stays under it. */
export function zoomAbout(view: View, scale: number, around: Point, picture: Size, stage: Size): View {
  const next = Math.min(MAX_SCALE, Math.max(1, scale));
  const ratio = next / view.scale;
  return clampView({ scale: next, x: around.x - (around.x - view.x) * ratio, y: around.y - (around.y - view.y) * ratio }, picture, stage);
}

/** The view moved by a drag, held to the picture's bounds. */
export function panBy(view: View, by: Point, picture: Size, stage: Size): View {
  return clampView({ ...view, x: view.x + by.x, y: view.y + by.y }, picture, stage);
}

/** The zoom a wheel turn of `delta` (pixels, up negative) multiplies the view's by. */
export const wheelFactor = (delta: number): number => Math.exp(-delta * 0.002);

export const isFitted = (view: View): boolean => view.scale === 1 && view.x === 0 && view.y === 0;
