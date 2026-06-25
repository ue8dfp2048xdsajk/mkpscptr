---
name: Arc warp formula — circular not parabolic
description: Why the arc uses a true circular formula and how pattern mode differs from design mode.
---

## The rule
`createWarpedImage` uses a **true circular arc**, not a parabola.

- `arcAmount` (−100…+100) maps to half-angle `α = arcAmount/100 * π/2`.
- At ±100: `α = ±π/2` → perfect semicircle (180° total sweep), regardless of image width.
- Radius: `R = (img.width/2) / sin(|α|)` — scales with image width so the chord always matches.
- Displacement: `arcCurve = sign(arcAmount) * R * (cos(nx * |α|) − cos(|α|))`.
- Sagitta (centre displacement) = `(img.width/2) * tan(|α|/2)`.

**Why:** The old parabola `arcAmount * 4 * (1−nx²)` had a fixed-pixel sagitta independent of image width. For narrow designs the sagitta could greatly exceed `img.width/2`, making the arc look more like a pointed Gothic arch than a smooth semicircle.

## Pattern mode
`_renderPattern` passes `data.arcAmount` (NOT `data.arcAmount * dpr`) to `createWarpedImage`. The formula computes R from `img.width` which is already in physical pixels, so DPR is handled automatically through the canvas size — multiplying arcAmount by dpr would double the angle at DPR=2.

`extraPad` in `_renderPattern` uses `(W/2) * tan(|α|/2)` (CSS pixels) instead of `arcAmount * 4`.

## Variables computed outside the slice loop
```js
const absAlpha    = Math.abs(arcAmount) / 100 * (Math.PI / 2);
const sinAlpha    = absAlpha < 1e-6 ? absAlpha : Math.sin(absAlpha);
const arcR        = sinAlpha < 1e-6 ? 0 : (img.width / 2) / sinAlpha;
const arcCosAlpha = Math.cos(absAlpha);
const arcSagitta  = sinAlpha < 1e-6 ? 0 : arcR * (1 - arcCosAlpha);
const arcSign     = Math.sign(arcAmount);
```
