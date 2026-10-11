/** A faint dot grid fading out from the centre of its positioned parent. */
export function DotGridBackdrop() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle,rgb(0_0_0/0.13)_1px,transparent_1px)] bg-[size:18px_18px] [mask-image:radial-gradient(ellipse_at_center,black_15%,transparent_70%)] dark:bg-[radial-gradient(circle,rgb(255_255_255/0.11)_1px,transparent_1px)]"
    />
  );
}
