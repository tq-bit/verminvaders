# Verminvaders — AI Harness Specification

**Version:** 1.0 · **Status:** Ready for implementation · **Target:** autonomous browser agent ("the harness") that plays Verminvaders through the in-page bridge API.

## 1. Purpose

Build a harness that connects to a running instance of the Verminvaders game (single self-contained HTML page, HTML canvas), observes the full game state through the `window.verminvaders` bridge, and plays the game autonomously by issuing movement and shooting commands. The harness must not read pixels and must not modify the game — the bridge is the single source of truth and the only control surface.

## 2. Game overview

The player controls a cat defending a lasagna slice. A formation of rodents marches back and forth, descending on wall contact, firing crumbs downward. The cat spits furballs upward. Furniture shields erode when hit by either side. A Roomba with a rat general occasionally crosses the top as a bonus target.

- Arena: 480 × 600 px, origin top-left.
- Cat baseline: `catY = 536` (constant `state.cat.y`).
- Lives: 3, hit grants 2 s invulnerability. Losing all lives → game over.
- Second game-over condition: any rodent reaching `y ≥ 510` (the lasagna line).
- Waves: clearing all rodents starts a 2.2 s `waveclear` intermission, then a new wave; each wave starts lower and fires faster.
- Scoring: rat (top two rows) 30, third-row mouse 20, other mice 10, Roomba 200.

## 3. Bridge API (`window.verminvaders`)

### 3.1 Reading

`verminvaders.state()` returns a plain snapshot (JSON-safe, safe to serialize across a CDP boundary):

| Field | Type | Meaning |
| --- | --- | --- |
| `phase` | string | `title` \| `playing` \| `waveclear` \| `gameover` |
| `paused` | boolean | simulation frozen (harness or P key) |
| `score`, `hi`, `wave`, `lives` | number | run progress |
| `invuln` | number | seconds of remaining invulnerability (> 0 = untargetable) |
| `time` | number | in-game clock, seconds (frozen while paused) |
| `cat` | object | `{ x, y, minX: 36, maxX: 444, speed: 230 }` |
| `furball` | object \| null | the single shot in flight `{ x, y, vy }`; **null = may shoot** |
| `crumbs` | array | incoming ammo `{ x, y, w: 10, h: 10, vy }`, strictly vertical |
| `rods` | array | live rodents `{ x, y, w, h, row, col, rat, points }`, absolute coords |
| `formation` | object | `{ x, y, dir, cols: 8, rows: 5, stepX: 44, stepY: 36, nextMarchIn }` |
| `roomba` | object \| null | bonus target `{ x, y: 52, vx: ±95, points: 200 }` |
| `shields` | array | `{ x, y, w, h, cellsLeft }`, all at `y = 392` |

`verminvaders.canvas` exposes `{ w: 480, h: 600, catY: 536 }`.

### 3.2 Acting

All controls return `true` on success, `false` on a no-op. Never throw.

| Call | Effect |
| --- | --- |
| `start()` | begin or restart when `phase` is `title`/`gameover` |
| `shoot()` | spit a furball; `false` if one is airborne, phase ≠ `playing`, or paused |
| `moveLeft(bool)` / `moveRight(bool)` | hold-style input, like a key press |
| `moveTo(x)` | glide to x at 322 px/s; auto-clamped to 36–444; returns `false` on non-numeric input |
| `stop()` | release all movement inputs |
| `pause()` / `resume()` / `togglePause()` | freeze / unfreeze the simulation (see §5.2) |

### 3.3 Legacy alias

Removed. The pre-rename `window.purrvaders` alias no longer exists; all code must use `verminvaders`.

## 4. Game constants the policy needs

| Constant | Value |
| --- | --- |
| Cat keyboard speed | 230 px/s; `moveTo` glide speed 322 px/s (1.4 × 230) |
| Furball spawn | `(cat.x + 18, cat.y − 16)`, i.e. muzzle offset **+18 px in x** — aim calculations must compensate |
| Furball velocity | −430 px/s (upward); radius 4; despawn above y < −20; **max one in flight** |
| Crumb velocity | `130 + 14 × wave` px/s, straight down, 10 × 10 px |
| Cat hitbox | x ± 30 around `cat.x`, y from 502 to 536 |
| Roomba | spawns off-screen left/right at y = 52, speed 95 px/s; first appearance 8–14 s into a wave, next 9–17 s after leaving |
| March | formation shifts 12 px per step horizontally, or drops 16 px and reverses at walls; `nextMarchIn` gives seconds until the next step |
| March interval | `max(0.06, 0.5 × alive/total) × max(0.55, 1 − 0.06 × (wave − 1))` seconds |
| Shields | 4 pieces at y = 392, destructible by both furballs and crumbs; a furball that chews a shield is consumed |

## 5. Required harness behavior

### 5.1 Decision loop

Implement a driver with a pluggable policy: `decide(state) → { moveTo?: number, left?: bool, right?: bool, shoot?: bool, stop?: bool }`, applied once per tick.

- **Real-time mode (default):** tick every 60–100 ms; the game never pauses; policy must be fast (< 10 ms per decision).
- **Considered mode (optional):** each tick wraps the decision in `pause()` → `decide()` → `act()` → `resume()`. Think time per decision should stay under 2 s for a reasonable spectator experience; the game tolerates arbitrary pause lengths.
- The driver must always `resume()` in a `finally` block or with a watchdog, so a policy crash never leaves the game frozen.

### 5.2 Pause semantics

- While paused, `state()` keeps working (use it to plan), inputs queue and apply on resume, and the in-game clock freezes.
- Pause is optional by design: a confident policy may play fully real-time and never call it.

### 5.3 Phase handling

- `title` / `gameover` → call `start()` (make auto-restart configurable; default: restart up to N games per session).
- `waveclear` → issue no movement/shoot commands; expect `phase` back to `playing` after ~2.2 s.
- On every transition, call `stop()` to clear held inputs.

### 5.4 Safety rules

- Never hold `moveLeft` and `moveRight` together.
- Only shoot when `state.furball === null`, phase is `playing`, and not paused (the API enforces this; the policy should not rely on enforcement).
- Treat `invuln > 0` as safe-to-stay but not safe-to-tank-again.

## 6. Suggested policy (heuristic baseline)

The implementation must at minimum encode this baseline; refinements are welcome.

**Target selection.** Prefer, in order: (1) Roomba when it can be intercepted (see below); (2) the lowest rodent in the column whose x-corridor is least shielded; (3) rodents in the lowest row nearest the lasagna line (they end the game first).

**Furball interception.** Flight time to a target depth \(y_t\) is \(t = ((\text{cat.y} - 16) - y_t) / 430\). During flight the target moves in discrete 12 px march steps: expected steps \(n \approx t / \text{marchInterval}\), displacement \(12 \times \text{dir} \times n\) (clamped by wall-reversal prediction). Aim: \(\text{catTarget} = x_{\text{target center}} + \text{displacement} - 18\) (muzzle offset). Verify the cat can arrive in time: \(|\text{catTarget} - \text{cat.x}| / 322 < t\); if not, pick a nearer target.

**Roomba interception.** Lead the target: \(\text{aim} = \text{roomba.x} + \text{roomba.vx} \times t_{\text{flight}}\), with \(t_{\text{flight}} = ((\text{cat.y} - 16) - 52) / 430 \approx 1.08\) s, so the Roomba travels ≈ 102 px during the shot. Same arrival-time check applies; skip if unreachable.

**Shield awareness.** A furball that intersects a shield's rectangle at y = 392 is consumed (chew). Prefer aim corridors through gaps, or accept the trade when the target is high-value. Never repeatedly shoot into the same intact shield.

**Dodging.** A crumb threatens the cat if its x-range overlaps `cat.x ± 30` while `invuln === 0`. With time-to-impact \((502 - c.y) / c.vy\), dodge via `moveTo` to the nearest safe corridor if time > 0.25 s; below that, accept the hit (3 lives, invulnerability follows). Suppress dodging decisions that would walk the cat out of an aimed shot.

## 7. Connection architecture (B chosen — terminal driver)

- **A. In-page agent (preferred):** a standalone JS module injected into the game page (console, bookmarklet, or `<script>` appended to the exported HTML). Runs the decision loop with `setInterval`. No dependencies, no browser automation needed. Structure the module so the policy is importable/unit-testable outside the page.
- **B. External driver:** Node.js + Playwright/Puppeteer. Load the game page (serve via `http://localhost` — some browsers restrict `localStorage` on `file://`, though the game degrades gracefully), then run `decide` in Node against snapshots pulled via `page.evaluate(() => verminvaders.state())`, pushing commands back the same way. Account for ~5–20 ms round-trip latency; considered mode (§5.1) is recommended here.

Required module interface (both modes): `connect() → boolean`, `tick()` (one decide-act cycle), `run(options)` with `{ mode: "realtime" | "considered", pollMs, maxGames, logLevel }`, and a clean `stop()` that halts the loop and resumes the game if paused.

## 8. Robustness

- Missing `window.verminvaders` → poll until present (page may still be loading); fail with a clear message after 10 s.
- Wrap every `state()` call in try/catch; on exception, log, `stop()` inputs, and re-sync on the next tick.
- Never crash the game: the harness runs in the same page (mode A) or over CDP (mode B); uncaught harness exceptions must be caught at the tick boundary.
- Log a one-line summary per wave (score, lives, duration) and a session summary (games played, best score, shots fired, hits).

## 9. Acceptance criteria

- AC1 — Bridge detection and game start from `title` within 2 s.
- AC2 — Clears wave 1 (all 40 rodents) without losing more than one life.
- AC3 — Wave-1 clear time under 90 s.
- AC4 — Intercepts the Roomba at least once per session when it appears during a clear shooting window.
- AC5 — Loses no life to a crumb that was visible for ≥ 0.5 s while the cat had an escape corridor.
- AC6 — Considered mode: a full pause → decide → act → resume round trip with no stuck-pause state (kill the harness mid-decision; game must still be resumable).
- AC7 — Plays 3 consecutive games (auto-restart) and 10 minutes total without an uncaught exception.

## 10. Out of scope

- Modifying the game or its bridge API.
- Screen capture or pixel analysis (the state API is authoritative and complete).
- Human-input emulation beyond the bridge, multiplayer, or leaderboard tampering.