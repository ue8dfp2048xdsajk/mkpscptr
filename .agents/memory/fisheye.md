---
name: Fisheye replaces arc tilt
description: The arcTilt slider now drives a barrel/pincushion fisheye effect, not a vertical asymmetry.
---

## What changed
The `arcTilt` slider (label renamed to "Fisheye") was previously a vertical asymmetry (one side of the arc bent more). It now drives a **horizontal barrel/pincushion distortion**:

- **Positive** = barrel: centre expands outward  
- **Negative** = pincushion: centre pinches inward

## Formula
Applied in the slice loop of `createWarpedImage`, after cylinder projection:

```js
const fisheyeK   = (arcTiltAmount / 100) * 0.45;   // C=0.45 keeps nx_dest in [-1,1]
const nx_proj    = cylinderAmount === 0 ? nx : (projectedX / sinMax);
const nx_dest    = nx_proj * (1 + fisheyeK * (1 - nx_proj * nx_proj));
const fisheyeScale = 1 + fisheyeK * (1 - 3 * nx_proj * nx_proj);  // for slice width
const dx         = centerX + nx_dest * (img.width / 2);
const projectedSliceW = Math.max(1, baseSliceW * Math.abs(fisheyeScale));
```

**Why C=0.45 (< 0.5):** For C < 0.5, the derivative d(nx_dest)/d(nx_proj) is always positive on [-1,1], preventing sign-flip and fold-over artifacts. At C=0.45 and fisheye=±100, centre magnification is ±45%.

## What was removed
- `tiltK` vertical shift and `drawH_tilt` height scaling are gone.
- `tiltMax` was removed from `extraPad` in `_renderPattern` (fisheye adds no vertical displacement).
- `effectH` / `referenceH` no longer used in the pad calculation.

## _noArcWarp note
`arcTilt` is NOT part of the `_noArcWarp` condition. Fisheye is purely horizontal — it does not create asymmetric transparent borders, so eraser-position compensation runs correctly when only fisheye is active.
