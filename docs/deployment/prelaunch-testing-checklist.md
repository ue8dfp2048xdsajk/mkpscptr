# Pre-Launch Manual Testing Checklist

Manual, human-driven QA checklist to run through before opening MockupScripter to real customers. This is complementary to [pre-deploy-checklist.md](pre-deploy-checklist.md) (infra/env verification) — this document is about end-to-end product behavior.

Notes inline (marked with `>`) call out places where the checklist item was verified against the actual code and either doesn't work the way it might be assumed to, or is worth double-checking for that reason. See the "Known gaps" section at the bottom for a summary.

---

## Part 1 — Anonymous user flow

### Landing & editor

- [ ] Open app without signing in
- [ ] Upload a background
- [ ] Upload a design
- [ ] Move/scale/rotate design
- [ ] Refresh browser → full canvas restores
- [ ] Close browser → reopen → full canvas restores
- [ ] Backgrounds restore
- [ ] Designs restore
- [ ] All effects restore
- [ ] Pattern mode restores
- [ ] Clip masks restore
- [ ] Color layer restores
- [ ] Extra design layers restore (including their own warp/blur/noise — see the fix in `js/app.js` `createCanvasPreviewsFromSnapshot`)
- [ ] Warp/perspective/blur/noise restore correctly
- [ ] Edit the canvas in two browser tabs at once (same profile) → confirm autosave doesn't silently lose one tab's work
  > Local autosave is a single global IndexedDB key (`session`), not per-tab — the last tab to autosave wins. Not necessarily a bug, but confirm it's acceptable rather than assumed safe.

### Anonymous gating

- [ ] Export → plans modal opens
- [ ] Save Progress → plans modal opens
- [ ] Upgrade buttons open checkout flow
- [ ] Watermark appears where expected

---

## Part 2 — Sign in & session continuity

- [ ] Sign in
- [ ] Return to app automatically
- [ ] Canvas restored exactly
- [ ] Backgrounds intact
- [ ] Effects intact
- [ ] **Sidebar layout:** Appearance = opacity / blur / noise / flip only; **Effects** section title has ⭐ PRO (controls inside have no duplicate badges); order = cylinder warp → vertical arc → fisheye → horizontal perspective → vertical perspective → layer mode → mesh warp → invert colors → copy/paste effects
- [ ] Local autosave restored successfully (via IndexedDB — see note below)

> **Anonymous → signed-in continuity is client-side only.** Before the Clerk redirect, the session is flushed to IndexedDB (`_autosaveDB.set('session', ...)`) and read back on page load after returning — the same mechanism as a plain refresh. There is no server-side claim endpoint. If you need work to survive clearing browser storage, that would require a future server-side feature.

- [ ] Click **Save Progress** while signed out → sign in → confirm whether the save auto-completes on return, or whether the user must click Save again
  > `ms_redirect_after_auth` is set to `'save'` before the redirect, but `_handleAuthRedirect` in `js/clerk-auth.js` only auto-resumes the `'export'` case. `'save'` and `'home'` are stored but never acted on. Confirm this UX gap is acceptable for launch (canvas itself still restores fine — only the "save to cloud" *intent* is lost).
- [ ] PostHog identify event fires on sign-in (confirm it's driven by Clerk's client-side `session` object)

### Settings & navigation

- [ ] App avatar menu → **Settings** opens `/settings.html`
- [ ] Settings **← Back to app** goes to `/app.html` (not the marketing landing page), session intact
- [ ] Billing portal **← Return to Mockup Scripter** (from app or settings) returns to `/app.html`, session intact — not the marketing landing page
- [ ] Settings **Edit Profile** opens Clerk profile in an on-page modal (user stays on settings; no stranded trip to `accounts.mockupscripter.com` unless modal API unavailable)
- [ ] Signed in → visit `/` → nav and hero show **Open app** → `/app.html` still signed in

### Free plan

- [ ] Save blocked
- [ ] Export blocked
- [ ] Export Pattern PNG blocked (sign-in redirect or plans modal after sign-in)
- [ ] Upgrade banner visible

---

## Part 3 — Free → Starter checkout

### Checkout

- [ ] Checkout opens
- [ ] Coupon/promo code works
- [ ] Stripe payment succeeds
- [ ] Customer created
- [ ] Subscription created
- [ ] Invoice paid (verify via Stripe dashboard / billing portal — the webhook handler does **not** listen for `invoice.paid`, so don't expect app-side behavior tied to that specific event; only `checkout.session.completed` drives the plan upgrade)

### Backend

- [ ] `checkout.session.completed` = HTTP 200
- [ ] MongoDB customer created
- [ ] Clerk metadata updated
- [ ] PostHog plan updated
- [ ] Upgrade banner disappears
- [ ] Pending checkout state cleared (`ms_pending_checkout_plan` / `ms_pending_checkout_period` / `ms_pending_plan`)

### Billing period upgrades (same tier)

- [ ] Starter **monthly** → Annual tab → Starter card shows **Switch to annual** (not disabled "Current plan")
- [ ] Starter **monthly** → Lifetime tab → Starter card shows **Get lifetime**
- [ ] After annual or lifetime purchase, Clerk `billingPeriod` matches; old subscription canceled (no double billing)
- [ ] After lifetime purchase, a later `subscription.deleted` webhook does **not** downgrade plan to Free

### Starter

- [ ] Save works
- [ ] Save overwrites existing project (Starter is a single-slot upsert — there is no multi-project storage on this tier)
- [ ] Save as New blocked (button is Pro-only, disabled for Starter)
- [ ] Logout/login reloads project
- [ ] Refresh reloads project

### Starter exports

- [ ] Normal export succeeds
- [ ] Export Pattern PNG blocked (plans modal)
- [ ] Pro-effect warning appears
- [ ] Mixed export behaves correctly
- [ ] All-pro export blocked

### Starter watermark matrix

For each effect, confirm the watermark appears **in the exported/downloaded file itself**, not just in the on-screen editor preview.
> The on-screen watermark is drawn via a separate Fabric `after:render` hook (`_drawWatermarkOnCanvas`) from the export path (`toDataURL()`). These are two different render passes — visually correct in the editor does not guarantee it's baked into the exported PNG. Verify by opening the actual downloaded file for each row below.

- [ ] Warp
- [ ] Arc
- [ ] Perspective
- [ ] Fisheye (this is the `arcTilt` slider under the hood — confirm the UI label maps to the effect you expect)
- [ ] Pattern
- [ ] Clip Mask
- [ ] Color Layer
- [ ] Extra Design Layer
- [ ] Plain placement has no watermark
- [ ] Layer mode ≠ Normal (multiply, screen, etc.)
- [ ] Invert colors (main or extra layer)
- [ ] Paste Effects (Starter: always marks window PRO)
- [ ] Starter: Paste Layer / Paste Effects from PRO source → ⭐ appears immediately (no slider nudge); watermark on first canvas render after paste
- [ ] Starter: click between window backgrounds → watermarks stay on all PRO-gated windows (no vanish until pan)
- [ ] Copy/Paste Effects does **not** change position, scale, or rotation on target
- [ ] Paste Layer onto window that already has a design → stacks as new overlay (original design kept); empty window → replaces main design
- [ ] Main + extra → Delete main → bottom extra becomes main; Delete Layer / Backspace on sole main → removes whole window
- [ ] Select overlay → Make Main Design → swap; undo restores stack
- [ ] After Make Main Design, demoted layer moves independently (new main does not follow)
- [ ] Main design → solid blue handles; all stacked extras (paste, duplicate, demoted main) → orange handles
- [ ] Shift+skew/scale extra layer → main does not join selection or transform
- [ ] Transform handle cursors: corner = diagonal resize, side = stretch, Shift+side = skew hint, rotation handle = rotate
- [ ] Copy/Paste Effects copies opacity, warp, blend, pattern settings, invert (not flip H/V)
- [ ] Invert → undo → no ⭐, Starter export allowed, image not inverted
- [ ] Eraser → undo (pristine art) → no ⭐, Starter export allowed
- [ ] Design eraser: one layer selected → erase → release → no jump, erased pixels stay
- [ ] Design eraser on duplicate only → main layer untouched
- [ ] Click mockup background (not design) → that window selects
- [ ] Duplicate 2 windows → click other backgrounds → correct window (not off-by-N); shift+range includes dupes; Starter export selected plain duplicate → no false PRO modal (no refresh)
- [ ] Duplicate window(s) → undo removes dupes → redo restores; add window → undo removes → redo restores; delete → undo → redo
- [ ] Drag-reorder window → undo restores order and content → redo re-applies reorder (no empty cells / badge-only ghosts)
- [ ] Multi-select 2+ windows → drag handle on selected window → all selected move together; undo/redo and export selected unchanged
- [ ] Drag empty viewport/grid gap → box-selects windows; plain click deselects; edit works immediately after (no select tool mode)
- [ ] Exit eraser → layer re-selected → re-enter with E works
- [ ] 0 or 2 layers selected → eraser blocked (alert)
- [ ] Extra-layer warp only → ⭐ + Starter export block; undo warp to 0 → ⭐ clears
- [ ] Mesh warp (after Apply only; cancel does not mark)

### PRO effect badges & load

- [ ] JSON load runs `_recomputeProEffect` — corrupt `hasProEffect: false` with active blend still shows badge
- [ ] Mesh warp undo → badge clears; redo → badge + geometry correct
- [ ] Reset after mesh warp → undo restores warp + badge
- [ ] Invert → undo clears badge when no other PRO effects

### Downgrade reminder

- [ ] Pro user with 2+ cloud projects sees backup hint in profile menu
- [ ] Settings → Plan & Billing shows downgrade notice for Pro
- [ ] Starter with 2+ projects in DB sees read-only hint

---

## Part 4 — Starter → Pro

### Checkout

- [ ] Existing Stripe customer reused
- [ ] Subscription upgraded
- [ ] Webhook succeeds
- [ ] Clerk metadata updated

### Pro features

- [ ] Watermark disappears
- [ ] Export succeeds
- [ ] Export Pattern PNG succeeds (Pattern mode active on selected window)
- [ ] Save as New works
- [ ] Rename works
- [ ] Multiple projects save
- [ ] 51st project blocked (limit is enforced at 50 — save #51 is rejected with `project_limit_reached`, both pre-insert and via a post-insert race-condition rollback)
- [ ] Billing portal opens
- [ ] Invoice PDF works

---

## Part 5 — Downgrade

- [ ] Downgrade via billing portal
- [ ] Stripe updates
- [ ] Webhook succeeds
- [ ] Clerk metadata becomes Starter
- [ ] Watermarks return
- [ ] Save as New blocked
- [ ] Export restrictions return
- [ ] If downgrading from Pro with >1 saved project, confirm existing extra projects are handled gracefully (not silently deleted, and not able to be re-saved past the Starter single-slot limit)

---

## Part 6 — Cancel subscription

- [ ] Cancel subscription
- [ ] `customer.subscription.deleted` fires
- [ ] Clerk becomes Free
- [ ] Customer mapping retained
- [ ] Export blocked
- [ ] Save blocked
- [ ] Upgrade shown

---

## Part 7 — Resubscribe

- [ ] Same Stripe customer reused
- [ ] Same MongoDB customer reused
- [ ] Features unlocked immediately

---

## Part 8 — Lifetime purchase

- [ ] One-time payment (Stripe checkout `mode: payment`, not `subscription`)
- [ ] Correct webhook (`checkout.session.completed` — lifetime does not go through subscription events)
- [ ] Clerk updated
- [ ] Invoice available
- [ ] No cancellation option (no subscription exists to cancel — confirm the billing portal reflects this sensibly rather than erroring)
- [ ] Features unlocked permanently
- [ ] Promo code field is correctly hidden/disabled at checkout (lifetime checkouts do not enable `allow_promotion_codes`)

---

## Part 9 — Account deletion

- [ ] Delete account
- [ ] Clerk user removed
- [ ] MongoDB cleaned (customer mapping + projects)
- [ ] Stripe customer retained/removed per your intended policy — confirm actual behavior (`api/account/delete.js` deletes the Stripe customer object; it does not separately call subscription-cancel first)
- [ ] **Delete an account that has an active paid subscription** → confirm no further Stripe charges occur afterward (deleting the Stripe customer should cascade-cancel the subscription, but this should be verified with a real active subscription, not just a free/already-canceled test account)
- [ ] Redirect to landing
- [ ] Re-register creates fresh account

---

## Part 10 — Projects

- [ ] Save project
- [ ] Reload project
- [ ] UUID works
- [ ] Different browser restores correctly
- [ ] Missing local images handled gracefully (toast: "N image(s) need re-uploading on this device")
- [ ] Large project handled correctly
- [ ] Project with more than 40 unique images → confirm graceful error, not silent truncation or a hung save (`CLOUD_IMAGE_LIMIT = 40`)
- [ ] Project near the 4MB client-side / 15MB server-side size limits → confirm graceful error
- [ ] Duplicate many windows → delete most → cloud save succeeds (no false "too large" when remaining payload is under 4 MB)
- [ ] Delete project works
- [ ] Fetch a project by UUID while signed out / as a different user (`GET /api/projects/:id` has no auth check) → confirm this is acceptable given UUIDs are unguessable, or flag as a security item to fix

---

## Part 11 — Autosave

- [ ] Refresh restores everything
- [ ] Browser restart restores everything
- [ ] Sign in restores everything
- [ ] Checkout restores everything
- [ ] Upgrade restores everything
- [ ] Logout/login restores everything
- [ ] Duplicate design layers restore effects (warp/blur/noise on the duplicate itself, not just the main design — this was the bug fixed in this session)
- [ ] Pattern restores
- [ ] Warp restores
- [ ] Perspective restores
- [ ] Clip masks restore
- [ ] Paint (color layer) restores

---

## Part 12 — Browser compatibility

### Desktop

- [ ] Chrome
- [ ] Safari (pay particular attention to sign-in — this app recently moved from an embedded Clerk modal to hosted redirects specifically because of a Safari/embedded-UI failure; regression-test Safari sign-in explicitly)
- [ ] Firefox

### Mobile

- [ ] Landing page usable
- [ ] Pricing page usable
- [ ] Sign in works
- [ ] Account Portal works

---

## Part 13 — Session handling

- [ ] Leave app idle for several hours
- [ ] Save still works
- [ ] Export still works
- [ ] Upgrade still works
- [ ] Expired session handled gracefully

---

## Part 14 — Failed payments

- [ ] Declined card
- [ ] Cancel checkout
- [ ] Browser Back
- [ ] Close checkout
- [ ] Close browser during payment
- [ ] Canvas preserved
- [ ] Pending plan cleared

---

## Part 15 — Stress tests

- [ ] Double-click Upgrade
- [ ] Double-click Save
- [ ] Double-click Export
- [ ] Multiple rapid checkouts (5 within 60s should succeed; the 6th should return 429 — see Part 18)
- [ ] No duplicate Stripe sessions
- [ ] No duplicate MongoDB records
- [ ] No duplicate projects

---

## Part 16 — Multi-tab

- [ ] Open two tabs
- [ ] Upgrade in one
- [ ] Refresh second
- [ ] Plan syncs
- [ ] No data loss
- [ ] Start a sign-in or upgrade flow by opening the link in a **new tab** rather than redirecting the current one → confirm resume-after-auth still works
  > `ms_redirect_after_auth`, `ms_pending_checkout_plan`, and `ms_pending_checkout_period` live in `sessionStorage`, which is not shared across tabs. The normal flow (same-tab redirect) works fine; a new-tab flow may silently lose the "resume" behavior.

---

## Part 17 — Storage edge cases

- [ ] Clear IndexedDB
- [ ] Clear localStorage
- [ ] Open project
- [ ] Helpful error shown
- [ ] App doesn't crash

---

## Part 18 — API & Security

- [ ] Rate limiting works
- [ ] Sixth checkout returns 429 (confirmed: limit is 5 requests / 60s per user in `api/checkout.js`)
- [ ] JWT validation works
- [ ] Webhooks reject invalid signatures
- [ ] Nonce protection works
- [ ] No exposed secrets
- [ ] CSP still valid
- [ ] Remove the stale `https://clerks.mockupscripter.com` (with an "s") entry from `vercel.json` CSP — this was identified as a typo domain during the Clerk migration and is dead weight, not actually needed
- [ ] No console errors
- [ ] Confirm rate limiting fails **open** if Redis/Upstash is unreachable (`api/_sliding-window.js`) — not a pre-launch blocker, but be aware that a Redis outage silently disables rate limiting rather than blocking requests
- [ ] Confirm plan-activation replay protection (`api/_nonce-store.js`) is MongoDB-backed and independent of Redis/Upstash health — a broken or missing Upstash credential can no longer prevent a paying customer's plan from activating (see the "Consolidate nonce store onto MongoDB" change). The only durable dependency for this is `MONGODB_URI`.
- [ ] Confirm there is no automated alerting (Slack/Sentry/PagerDuty) on webhook failures today — plan to manually watch Vercel function logs during your first real transactions, since failures currently only surface as `console.error` log lines

---

## Part 19 — Analytics

- [ ] PostHog identify on sign in
- [ ] Plan changes tracked
- [ ] Checkout tracked
- [ ] No duplicate events
- [ ] No sensitive data captured

---

## Part 20 — Production verification

### Stripe

- [ ] Every webhook = HTTP 200
- [ ] No webhook retries
- [ ] No duplicate customers

### Clerk

- [ ] Plan always matches Stripe

### MongoDB

- [ ] Customer records correct
- [ ] Projects correct

### Vercel

- [ ] No 500 errors
- [ ] No auth failures
- [ ] No deployment warnings

### Browser

- [ ] No console errors
- [ ] No failed network requests

---

## Part 20b — Keyboard shortcuts

Quick manual pass after loading a project with multiple mockups and layers.

### Selection & windows

- [ ] **Esc** deselects all windows and layers (canvas focused)
- [ ] **Esc** with plans modal open closes modal only — selection unchanged
- [ ] **Esc** while typing in filter input clears filter (does not double-fire deselect)
- [ ] **L** locks selected mockups; **U** unlocks
- [ ] **N** opens Add Mockup file picker (cancel OK)
- [ ] **Ctrl/Cmd+A** select all; **Del** deletes layer if selected else mockup

### Layers & effects

- [ ] **Shift+L** opens Add Layer file picker (cancel OK)
- [ ] **I** inverts selected layer colors
- [ ] **M** promotes selected overlay to main design
- [ ] **D** duplicates layer; **Ctrl/Cmd+D** duplicates mockup window(s)
- [ ] **Ctrl/Cmd+C** copies layer; **Ctrl/Cmd+V** pastes to other selected mockup(s)
- [ ] **Ctrl/Cmd+Shift+C** copies effects; **Ctrl/Cmd+Shift+V** pastes effects
- [ ] **Shift+H** / **Shift+V** flip selected mockup(s)
- [ ] In clip mode: **H** hides layers; **Shift+H** does not flip

### Position nudge

- [ ] **Arrow keys** nudge selected layer(s) 1 px; **Shift+Arrow** nudge 10 px
- [ ] Multi-window: main nudge moves peer mockups; extra nudge syncs same-index peers
- [ ] Cross-window sync (one layer per active mockup): layers stay aligned after nudge
- [ ] No nudge in clip/eraser/warp/color-paint modes, while typing, or with text box selected
- [ ] **Ctrl/Cmd+Z** restores pre-nudge positions

### Alignment guides

- [ ] **G** or control-panel **⊹** toggles guides on/off (off by default)
- [ ] Magenta dashed lines when layer center aligns with mockup center (H/V)
- [ ] Cyan dashed lines when edges align with any layer in grid neighbor mockup
- [ ] Guides visible only while dragging or arrow-nudging; clear on mouseup
- [ ] Toggle state persists after reload (autosave) and JSON save/load
- [ ] Legacy JSON without field → guides off

### Unchanged sanity checks

- [ ] **C** toggles clip (plain C); **Ctrl/Cmd+C** does not open clip
- [ ] **E** toggles eraser; **Ctrl/Cmd+E** exports
- [ ] **Ctrl/Cmd+Z** / **Shift+Z** undo/redo still work

### Canvas text boxes

- [ ] Click grab bar → box stays selected; **Ctrl/Cmd+C** then **Ctrl/Cmd+V** pastes duplicate offset (works after click-only or drag)
- [ ] Click inside text while typing → **Ctrl/Cmd+C** copies selected words only (browser default)
- [ ] **Ctrl/Cmd+C/V** with text box selected does not trigger layer copy/paste
- [ ] **Esc** or click empty canvas clears text-box selection
- [ ] **Ctrl/Cmd+Z** after paste removes duplicated text box
- [ ] Free plan: copy/paste text boxes works; Export Text Boxes still paywalled
- [ ] **Clear text** (viewport panel) removes all boxes; undo restores; disabled when none exist

---

## Part 21 — Final customer journey ⭐

This is the one to treat as most important.

Using:
- Incognito mode
- A brand-new email
- A different browser (if possible)

Complete this journey without any manual intervention:

- [ ] Visit landing page
- [ ] Upload background
- [ ] Upload design
- [ ] Apply effects
- [ ] Refresh (everything restores)
- [ ] Click Export (paywall appears)
- [ ] Sign up
- [ ] Return to app with work intact
  > This restores via the local IndexedDB autosave, not a server-side claim — see Part 2.
- [ ] Upgrade to Starter
- [ ] Export successfully (verify the exported file, not just the on-screen preview)
- [ ] Save project
- [ ] Close browser
- [ ] Return the next day
- [ ] Sign in
- [ ] Resume project exactly where you left off

If that final journey works flawlessly, you're not just testing individual features — you've validated the complete experience your first real customer will have. That's the strongest indicator that you're ready to launch.

---

## Known gaps found during code review (not necessarily blockers — decide deliberately)

1. **No server-side claim flow** — anonymous → signed-in continuity is entirely client-side (IndexedDB), with no MongoDB/Clerk-metadata linkage. (Part 2)
2. **"Save Progress" doesn't auto-resume after sign-in** — only "Export" does, via `ms_redirect_after_auth`. (Part 2)
3. **Watermark-on-export not structurally guaranteed** — the on-screen watermark overlay and the exported file go through different render paths; verify explicitly per effect. (Part 3)
4. **`GET /api/projects/:id` has no auth check** — relies on UUID being unguessable. (Part 10)
5. **Local autosave is a single shared key across tabs** — concurrent-tab editing can silently overwrite. (Part 1, 16)
6. **`sessionStorage`-based auth/checkout resume breaks across tabs** — same-tab redirect flow only. (Part 16)
7. **Stale `clerks.mockupscripter.com` CSP entry** — leftover typo domain from the Clerk migration debugging; harmless but should be cleaned up. (Part 18)
8. **`invoice.paid` is not handled by the Stripe webhook** — only `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`. (Part 3)
9. **No external alerting on webhook/backend failures** — console logs only; plan for manual log-watching at launch. (Part 18)
10. **Rate limiting fails open, nonce store fails closed** — different failure modes for the two protection layers. Rate limiting (`api/_sliding-window.js`, `api/_rate-limiter.js`) still uses optional Redis/Postgres and fails open if unreachable. The nonce store (`api/_nonce-store.js`) is now MongoDB-only and fails closed if `MONGODB_URI` is unreachable — the same store that's already required for the rest of the payment pipeline, so there's no longer a separate Redis/Postgres credential that can silently break plan activation. (Part 18)
