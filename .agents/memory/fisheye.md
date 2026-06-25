---
name: Fisheye replaces arc tilt
description: The arcTilt slider drives a vertical barrel/pincushion fisheye — same mechanism as the original tiltK but stronger.
---

## What it does
The `arcTilt` slider (label "Fisheye") creates a **vertical barrel/pincushion** distortion:

- **Left (negative)** → centre rows squashed (pinched in the middle)
- **Right (positive)** → centre rows stretched tall (ballooned out in the middle, edges normal)

This is the same shape as the original `tiltK` formula, just with a larger coefficient (0.45 vs 0.18) for a more dramatic effect.

## Formula (in createWarpedImage slice loop)
```js
const tiltK = (-arcTiltAmount / 100) * effectH * 0.45 * (1 - nx * nx);
const dy = centerY - drawH / 2 + arcCurve + tiltK;
const drawH_tilt = Math.max(1, drawH - 2 * tiltK);
```

At extremes (±100): `tiltK_centre = ∓ 0.45 * effectH`
- Right (+100): centre slices drawn 1.9× taller (ballooned)
- Left (−100): centre slices ~0.1× normal height (tightly pinched)

## Padding
`effectH` and `referenceH` are still needed so tiltK amplitude matches the design's original height, not the padded canvas size.

```js
const effectH = referenceH || img.height;
const pad = Math.ceil(arcSagitta) + Math.ceil(Math.abs(arcTiltAmount) / 100 * effectH * 0.45);
```

`_renderPattern` uses the same coefficient for `tiltMax`.

## What NOT to do
Do NOT replace tiltK with a horizontal mapping (nx_dest remap). The user expects vertical stretch/squash, not horizontal barrel/pincushion.
