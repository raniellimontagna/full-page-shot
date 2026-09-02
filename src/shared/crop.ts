import type { CssRect } from './messages'

/**
 * A rectangle in device pixels -- the coordinate space of a captured frame's
 * canvas, after `devicePixelRatio` scaling. Everything in this file that
 * takes a `CssRect` (CSS px, viewport-relative) converts it to this space.
 */
export interface DeviceRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Converts a CSS-pixel selection rect into a device-pixel crop rect ready to
 * draw from a captured frame.
 *
 * Units: `rect` is CSS px (viewport-relative, as produced by the selection
 * overlay); the returned `DeviceRect` is device px, i.e. the pixel grid of
 * the frame passed in as `frame`.
 *
 * Each edge is rounded independently -- the right edge is
 * `round((x + width) * dpr)`, not `round(x * dpr) + round(width * dpr)` --
 * and the width/height are then derived from the rounded edges. This matters
 * when two CSS rects share a border (e.g. adjacent selections): rounding
 * each rect's edges independently guarantees the shared edge rounds to the
 * same device-pixel value on both sides, so the resulting device rects tile
 * exactly with no 1px gap or overlap. Rounding a width independently of its
 * edges would not have that property.
 *
 * The result is clamped to `[0, frame.width] x [0, frame.height]`, since a
 * selection can extend past the captured frame (e.g. a drag that ends
 * slightly outside the viewport, or dpr/rounding pushing an edge past the
 * boundary). If clamping collapses the rect to zero (or negative) width or
 * height -- the selection landed entirely outside the frame, or right on the
 * boundary -- this throws rather than returning a crop that would produce an
 * empty or inverted canvas.
 */
export function planCrop(
  rect: CssRect,
  devicePixelRatio: number,
  frame: { width: number; height: number },
): DeviceRect {
  const x1 = clamp(Math.round(rect.x * devicePixelRatio), 0, frame.width)
  const y1 = clamp(Math.round(rect.y * devicePixelRatio), 0, frame.height)
  const x2 = clamp(Math.round((rect.x + rect.width) * devicePixelRatio), 0, frame.width)
  const y2 = clamp(Math.round((rect.y + rect.height) * devicePixelRatio), 0, frame.height)

  const width = x2 - x1
  const height = y2 - y1

  if (width <= 0 || height <= 0) {
    throw new Error(
      `planCrop: crop rect is empty after clamping ${JSON.stringify(rect)} (dpr ${devicePixelRatio}) to the ${frame.width}x${frame.height} frame`,
    )
  }

  return { x: x1, y: y1, width, height }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
