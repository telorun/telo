---
"@telorun/debug-ui": minor
---

Make the debug UI usable on a phone-width viewport.

The layout previously assumed a desktop width — a single non-wrapping header row and the Graph view's fixed 220px trace-list + 340px detail rails left almost no room for the canvas under ~640px. A `@media (max-width: 640px)` block now:

- wraps the header tabs/controls and the events filter bar, with larger tap targets;
- stacks the Graph view vertically — the invocation list becomes a horizontal scroll strip above the canvas, and the node-detail panel becomes a bottom sheet overlaying the canvas instead of a 340px side column;
- lets the drill-down panels go near-full-width with a tight cascade.

The drill-down cascade offset moved from an inline `left` to a `--tdbg-depth` CSS variable so the media query can retune it; desktop layout is unchanged.

Also fixes pan/zoom on touch: xyflow ships no `touch-action`, so the browser claimed one-finger drags and the graph never panned on a touch device. The flow container is now `touch-action: none`, handing pan/pinch to xyflow.
