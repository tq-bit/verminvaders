# Verminvaders — AI Harness

A terminal-driven AI harness that plays **Verminvaders** (a Space-Invaders-style game in
which a cat defends a lasagna slice from rodents) through the game's in-page bridge API.
The harness never reads pixels and never modifies the game: `window.verminvaders` is the
single source of truth and the only control surface.

What makes it interesting: the game is played by a **local executor** (aim math, march
prediction, Roomba lead, crumb dodging), but the *strategy* is set by **Mistral AI**.
Every epoch (default 10 seconds) the harness pauses the game, sends the state plus an
epoch report plus the model's own persistent memory to `mistral-large-4`, and the model
returns a tuned parameter set and an updated memory object. Because memory survives
epochs, games, and sessions, the model is meant to get better the longer it plays.

While the model thinks, its reasoning is streamed live to the terminal (dim gray), and a
fat cat narrates the session with commentary lines you can edit freely.

## Project layout

```
app/verminvaders-demo.html    the game (single self-contained HTML page)
spec/                         the harness specification (requirements)
src/
  main.ts                     CLI entrypoint: serves the game, launches the browser
  types/                      all shared types, by module, re-exported from index.d.ts
    index.d.ts                import types from here (type-only imports)
    game.d.ts                  bridge snapshot types (GameState, ...)
    policy.d.ts, driver.d.ts, llm.d.ts, strategy.d.ts, persona.d.ts, cli.d.ts
  constants/                  all runtime constants, by module, re-exported from index.ts
    game.ts                   arena/cat/furball/march geometry
    policy.ts, driver.ts, persona.ts, llm.ts   tuning knobs and defaults
  errors/mistral-error.ts     custom errors
  llm/
    mistral-client.ts         streaming chat-completions client (class only)
    sse.ts                    SSE stream consumption (functions)
  policy/
    aim.ts                    pure math: flight time, march prediction, corridors
    dodge.ts                  crumb threat detection, safe-corridor search
    hot-corridors.ts          falling-crumb corridor detection
    heuristic.ts              the parameterized executor (class only)
  driver/
    connection.ts             bridge over CDP (latency-compensated state reads)
    driver.ts                 tick loop, phase handling, pause watchdog (class only)
    strategy-controller.ts    epoch/post-mortem flow, memory persistence (class only)
    strategy-prompt.ts        system prompt + compact state builders
    strategy-params.ts        model answer parsing + parameter normalization
    epoch-tracker.ts          per-epoch stats: shots, crumb fire, near misses (class only)
    stats.ts                  wave and session summaries (class only)
    sleep.ts, constants moved to src/constants/
  persona/
    lines.json                the fat cat's lines — edit these!
    lines.ts                  line loading and validation
    persona.ts                cooldown-aware narrator (class only)
  ui/
    colors.ts                 TTY-aware ANSI colors
    thinking-renderer.ts      live reasoning stream renderer (class only)
  tests/                      48 unit tests (no network needed)
memory/                       the model's persistent strategy memory (gitignored)
```

## Setup

Requirements: **Node.js 24+** (TypeScript runs natively via type stripping), npm, and a
Chromium download (handled by Playwright).

```bash
cd src

# install dependencies (incl. Playwright)
npm install

# download the headless Chromium used to run the game page
npx playwright install chromium
```

### API key and environment variables

The strategy brain calls the Mistral API. Put your key in `src/.env`:

```
MISTRAL_API_KEY=your-key-here
```

Two optional variables tune how much history the model works with:

| Variable | Default | Meaning |
| --- | --- | --- |
| `VERMINVADERS_CONTEXT_GAMES` | `5` | How many previous games (their strategy summaries and stats) are included in every prompt. `0` = start each game with no game history. |
| `VERMINVADERS_MEMORY_MAX_GAMES` | `10` | Maximum number of game records persisted in `memory/mistral-strategy.json`. Older records are dropped when the cap is exceeded. |

`src/.env` is gitignored; the file may also carry other `KEY=VALUE` pairs — they are
loaded without overriding variables already present in your environment. A real
environment variable takes precedence over the `.env` file.

No key? Run the local executor only with `--no-llm` (no API calls, default parameters).

## Run

From `src/`:

```bash
node main.ts                # 3 games, mistral-large-4, 10 s epochs, headless
node main.ts --headed       # watch it play in a Chromium window
```

The terminal shows the fat cat's commentary (magenta face, yellow line), the model's
live reasoning (dim gray) followed by its strategy notes (cyan) and parameter set
(green), wave summaries, and a session summary.

```bash
npm test                    # run the unit tests
npm run typecheck           # tsc --noEmit
```

## Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--headed` | headless | Open a visible Chromium window and watch the game. |
| `--games <n>` | `3` | Auto-restart up to n games per session. |
| `--model <name>` | `mistral-large-4` | Which Mistral model is the strategic brain. |
| `--epoch-ms <n>` | `10000` | Length of one playing epoch before the model is consulted. |
| `--style '<directive>'` | (none) | Operator directive injected into the model's prompt — see below. |
| `--memory <path>` | `memory/mistral-strategy.json` | Where the model's persistent memory lives. |
| `--persona <path>` | `src/persona/lines.json` | Custom fat-cat lines file. |
| `--game <path>` | `app/verminvaders-demo.html` | Path to the game page. |
| `--mode realtime\|considered` | `realtime` | `considered` also pauses the game around every executor tick (slow; mostly for debugging). |
| `--poll <ms>` | `80` | Executor tick interval. |
| `--log-level silent\|normal\|verbose` | `normal` | `verbose` logs every shot; `silent` also silences the cat. |
| `--no-llm` | off | Skip all API calls; the executor plays with its default parameters. |

Examples:

```bash
# fast epochs for lively terminal output
node main.ts --epoch-ms 5000

# three games, survival first
node main.ts --games 3 --style "careful: survival over score, wide margins"

# let it learn across sessions, then reset the brain
node main.ts
rm memory/mistral-strategy.json
```

## Adjusting the AI's behavior

Two layers are adjustable:

1. **Play style (`--style`)** — the model decides its own strategy by default (it is
   inferred from epoch reports and its accumulated memory). Pass a directive to bias it:
   `--style reckless` (points first, accept risks), `--style careful` (survival first),
   or any free text like `--style "prioritize the Roomba whenever it appears"`. The
   directive is marked highest-priority in the prompt, but the model may refuse it in a
   clearly losing position and will say so in its notes.

2. **Executor parameters** — the model tunes these every epoch; they are what it hands
   back each time:

   | Parameter | Range | Effect |
   | --- | --- | --- |
   | `roombaFirst` | bool | Chase the 200-point Roomba before rodents. |
   | `lowestRowWeight` | 0–10 | Urgency of deep rodents (closest to the lasagna line). |
   | `pointsWeight` | 0–10 | How much rodent points matter in target choice. |
   | `shieldPenalty` | 0–5000 | Avoidance of shielded firing corridors (0 = ignore shields). |
   | `chewShields` | bool | Allow one deliberate shot into a shield to open a hole. |
   | `dodgeHorizonS` | 0.3–1.6 s | React to crumbs landing within this window. |
   | `acceptHitBelowS` | 0.05–0.5 s | Stop dodging when impact is nearer than this. |
   | `corridorMarginPx` | 4–20 px | Safety margin kept from crumb columns. |
   | `columnSpreadWeight` | 0–10 | Penalty for killing a column's last rodent — keeps the enemy's random fire diluted across many columns (rods pick a uniformly random live rodent per shot, so fewer live columns means denser crumb streams). |

   Defaults live in `src/policy/heuristic.ts` (`DEFAULT_EXECUTOR_PARAMS`).

## Per-game strategy summaries and memory cleanup

At the end of every game the model writes a **gameSummary** — a concise strategy
summary of that game (what worked, what failed, the most important change) — which is
stored on the game's record in `memory/mistral-strategy.json` alongside its stats and
the executor parameters used. Later games receive the most recent summaries (bounded by
`VERMINVADERS_CONTEXT_GAMES`) so the model builds on them instead of repeating
mistakes.

The post-mortem is also a **memory cleanup pass**: the model is instructed to
consolidate its free-form memory — merge duplicated lessons, combine near-identical
strategies (e.g. repeated parameter-history entries), and remove redundant or
outdated observations — before it is written back. The file itself never grows past
`VERMINVADERS_MEMORY_MAX_GAMES` game records. Deleting
`memory/mistral-strategy.json` resets all learning.

## The fat cat

All quips live in `src/persona/lines.json` — faces and one line per event category
(`boot`, `gameStart`, `waveClear`, `roombaHit`, `lifeLost`, `dodge`, `idle`, `gameOver`,
`sessionEnd`). Edit them freely, or point `--persona` at your own file (same JSON
shape). Lines are picked randomly with per-category cooldowns so the cat does not spam.

## How a session flows

```
serve game -> launch Chromium -> connect to window.verminvaders (10 s timeout)
  -> start() on title
  -> executor ticks every 80 ms (aim, dodge, shoot, reposition)
  -> every epoch: pause -> stream state + report + memory to Mistral
       (report includes crumb firing statistics: crumbs fired,
        per-column spawn histogram, near misses)
       -> model reasons (streamed live) -> returns params + memory
       -> apply params, persist memory, resume
  -> game over: post-mortem into memory -> next game (up to --games)
  -> session summary (games, best score, shots, hits, duration)
```

The game is only ever paused while the model thinks; a `finally` watchdog guarantees it
resumes even if the model call, the parser, or the process shutdown path fails. Ctrl+C
stops the harness, resumes the game, and closes the browser cleanly.

## Notes and limits

- Each epoch costs roughly 30 s of model thinking plus tokens (~1.5k reasoning tokens
  observed with `mistral-large-4`). Use `--model` to pick a faster model or
  `--epoch-ms` to change the thinking cadence.
- The model's memory file may contain its own opinions about the game's geometry;
  deleting `memory/mistral-strategy.json` resets its learning to zero.
- The harness intentionally never edits the game page; the only API used is the
  documented bridge (`spec/verminvaders-harness-specification.md`).
