# Plans and feature gating

Mockup Scripter has three plan tiers: **free**, **starter**, and **pro**. The canonical source of truth is Clerk `public_metadata.plan` on each user, set by the Stripe webhook → `/api/set-plan` flow after payment.

The frontend reads plan on sign-in (`js/clerk-auth.js` → `window._userPlan`). The backend re-verifies on sensitive API routes.

---

## Plan summary

| Feature | Free / anon | Starter | Pro |
|---------|-------------|---------|-----|
| Editor access | ✓ | ✓ | ✓ |
| Add text | ✓ | ✓ | ✓ |
| Basic effects (opacity, blur, noise; layer mode = Normal) | ✓ | ✓ | ✓ |
| PRO effects in editor | ✓ (try) | ✓ (try) | ✓ |
| Canvas watermark | On windows **with a design** | On PRO-effect windows only | None |
| Per-window ⭐ badge | Yellow when PRO used | Yellow when PRO used | Green when PRO used |
| Export images (PNG/JPEG/ZIP/folder) | ✗ | Non-PRO windows only | All windows |
| Export text | ✗ | ✓ | ✓ |
| Export Pattern PNG (pattern sheet) | ✗ | ✗ | ✓ |
| Local JSON save/load | ✓ | ✓ | ✓ |
| Cloud save | ✗ | 1 project (upsert) | Up to 50 + Save as New |
| Oversized cloud project | Save JSON locally → upload | Same | Same |

Pricing and marketing copy live on `index.html`. This document describes **enforced behavior** in code.

---

## Left sidebar layout (editor)

PRO sections show a **⭐ PRO** label on the **section title** only (turns green on Pro plan). Individual controls inside **Effects** do not repeat the badge — the section title is sufficient.

### Layers
- Add Layer, Copy Layer, Duplicate Layer, Delete Layer

### Appearance (basic — no section PRO badge)
- Opacity, blur, noise
- Flip H / Flip V

### Mockup
- Add mockup, lock/unlock, change bg/design, duplicate/delete/reset windows

### Effects (section title ⭐ PRO)

Controls in order:

1. Cylinder Warp  
2. Vertical Arc  
3. Fisheye  
4. Horizontal Perspective  
5. Vertical Perspective  
6. Layer Mode (Normal = basic; any other blend = PRO)  
7. Warp Mesh (W) + Apply / Cancel  
8. Invert Colors  
9. Copy Effects / Paste Effects  

### Other PRO sections (section title ⭐ PRO each)
- Clipping, Painting, Pattern, Framing, Background Adjustments

---

## Effect categories

### Basic (never PRO-mark a window)
- Opacity, blur, noise
- Layer mode = **Normal**
- Flip H / Flip V

### PRO effects (mark window when active; Starter → watermark + export block)

| Effect | Notes |
|--------|--------|
| Cylinder warp, arc, fisheye, perspective sliders | Non-zero values |
| Mesh warp | PRO only **after Apply** (not on enter/cancel) |
| Layer mode ≠ Normal | Main or any extra layer |
| Invert colors | Main or any extra layer |
| Pattern, clipping, color layer, design eraser | |
| Background adjust / crop | |
| Copy / Paste Effects | See paste rules below |

### Copy / Paste Effects

Copies **effects only** from the selected layer on the source window — never position, scale, rotation, skew, or flip.

**Included:** opacity, blur, noise, cylinder warp, vertical arc, fisheye, horizontal/vertical perspective, layer mode, pattern mode + settings (unflattened), invert status for the copied layer.

**Excluded:** placement geometry, flip H/V, mesh warp (baked mesh is not portable across windows).

- **Copy** alone does not mark a window.
- **Paste** marking:

| Plan | On Paste Layer / Paste Effects |
|------|-------------------------------|
| Free / Starter | PRO badge only if pasted payload contains PRO values (or live state after apply is PRO) |
| Pro | PRO badge only if pasted payload contains PRO values (`_transformsContainProEffect` / `_copiedLayerPayloadIsPro`) |

---

## Client-side gating

### Watermarks (`js/app.js`)

Drawn on `after:render` for:

- **Free:** all windows that have a design loaded (not background-only)
- **Starter:** windows that are PRO-gated (`_windowIsProGated` — live PRO effects only)
- **Pro:** none

### Export (`js/app.js` + `POST /api/export`)

1. User must be signed in
2. **Free:** plans modal; export blocked (server `403 upgrade_required`)
3. **Starter:** PRO windows → upgrade prompt; mixed selection → “Skip PRO windows & export the rest”
4. **Pro:** all selected windows export without watermark

Export formats: individual files, folder (File System Access API), or ZIP (JSZip).

**Export Pattern PNG** (`exportPatternBtn` in Pattern section): client-side download of the tiled pattern sheet. Requires sign-in and **Pro** plan (`_userPlan === 'pro'`). Free and Starter users see the plans modal. Only works while Pattern mode is active on the selected window (no fallback export of `designOriginal`).

### PRO effect detection (`_windowHasProEffect` / `_syncProEffect` in `js/app.js`)

PRO status is **derived from live window state**. `_syncProEffect(data)` sets `hasProEffect` and refreshes the ⭐ badge. Watermark (Starter) and export filtering use `_windowIsProGated(data)` — true when any PRO effect is active **or** `forceProBadge` is set (temporary flag during PRO payload paste apply).

**Real PRO effects** (`_windowHasProEffect`):

- Warp / arc / fisheye / perspective non-zero (window or any layer `_fx`)  
- `meshWarpApplied === true`  
- `blendMode !== 'normal'` on window or any layer `_fx`  
- `invertedMain` or any `invertedExtras[]`  
- Pattern, clip mask, color layer, eraser-modified design (`designOriginal !== initialDesignOriginal`)  
- Background adjust / crop non-default  
- Baked mesh warp or eraser work on any layer (`obj._carriesBakedPro`; propagated via Copy Layer, paste, Make Main, Duplicate Layer)

**Baked PRO lineage:** Mesh warp Apply and eraser strokes set `_carriesBakedPro` on the affected fabric object. Copy/paste and Make Main **move layers freely** and propagate the flag so gating (⭐, watermark, Starter export) follows the work — editor preview of all effects remains available on every plan.

**Paste gating:** Paste Layer and Paste Effects call `_applyPasteProSync` **before** the warp/effect pipeline so the ⭐ badge is immediate when the payload is PRO; `_finishPasteProSync` reconciles from live state after apply.

**Paste Layer:** copying the main design and pasting onto a window that already has a design stacks it as an overlay layer; pasting onto an empty mockup replaces the main design. When only the source mockup is selected, paste duplicates the layer in-place (offset +40/+20, same as Duplicate Layer).

**Layer promotion:** deleting the main design while other layers exist auto-promotes the bottom extra to main; **Make Main Design** swaps a selected overlay with the current main (old main becomes the bottom extra).

**Undo:** snapshots `designOriginal` / extra originals; eraser and standard undo call `_syncProEffect` after restore.

**After JSON or cloud load:** `_syncProEffect` runs per window (live state is authoritative).

Snapshot fields: `meshWarpApplied`, `invertedMain`, `invertedExtras`, `hasProEffect`, `forceProBadge`, `carriesBakedPro` (main + duplicates).

---

## Save / load / cloud

| Action | Free | Starter | Pro |
|--------|------|---------|-----|
| Save Local (JSON) | ✓ | ✓ | ✓ |
| Load Local (JSON) | ✓ | ✓ | ✓ |
| Cloud save | ✗ | 1 slot (upsert) | Up to 50 |
| Save as New | ✗ | ✗ | ✓ |
| Open cloud project | Sign-in | ✓ (all in DB) | ✓ |

Client ~4 MB guard; server **15 MB** per save. Too large → toast, save JSON locally.

---

## Downgrade (Pro → Starter / Free)

- All cloud projects **remain in the database**
- UI warns: open each project → **Save Local (JSON)** before downgrading
- Starter: only **one** editable cloud slot; extra projects listable, effectively read-only for editing
- Export/watermark/badge rules revert immediately to the lower tier

---

## Server-side gating

### `POST /api/export`
Returns `403 { error: "upgrade_required" }` if plan is `free`.

### `POST /api/projects/save`
| Plan | Behavior |
|------|----------|
| `free` | `403 upgrade_required` |
| `starter` | Upsert single project per user |
| `pro` | Insert; max **50** (`403 project_limit_reached`) |

### `POST /api/checkout`
Authenticated; blocks same/higher plan (`409`).

---

## Stripe price → plan mapping

```
STRIPE_PRICE_STARTER_MONTHLY   → starter
STRIPE_PRICE_STARTER_ANNUAL    → starter
STRIPE_PRICE_STARTER_LIFETIME  → starter
STRIPE_PRICE_PRO_MONTHLY       → pro
STRIPE_PRICE_PRO_ANNUAL        → pro
STRIPE_PRICE_PRO_LIFETIME      → pro
```

Defined in `api/webhooks/stripe.js` (`getPriceMap()`).

---

## Changing tiers safely

1. Update client gates in `js/app.js` and `js/clerk-auth.js`
2. Update server gates in `api/export.js`, `api/projects/save.js`, `api/checkout.js`
3. Update `VALID_PLANS` in `api/set-plan.js` and webhook handlers
4. Update `index.html` / this doc / prelaunch checklist if user-facing limits change
5. Run `npm test` (`pro-effect-gating.test.js`, `watermark-plan-upgrade.test.js`, `export.test.js`)

---

## Related docs

- [Prelaunch testing checklist](../deployment/prelaunch-testing-checklist.md)
- [Backend API — export & checkout](../architecture/backend-api.md)
- [Environment variables — Stripe prices](../getting-started/environment-variables.md)
- [Set-plan security QA](../set-plan-security-qa.md)
