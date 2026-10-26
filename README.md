# Verminvaders — AI Harness challenge for Le Chonk

This repostory was made for the October Community Challenge by https://mistral.ai/. It builds up on the game Space Invaders by Taito, originally developed and released in 1978 Japan. It also uses original design from the Mistral Vibe CLI (I love the dot design of the cat and [adapted it from this file](https://github.com/mistralai/mistral-vibe/blob/63d0e8f17e2c1f0d9e1d6f4399ab2dc10fbdf477/vibe/cli-rust/src/ui/banner/petit_chat.rs))

The goal is to defend earth (= a piece of lasagna) from invaders (= hungry mice and rodents) by shooting (= spitting furballs at) them.

> Note: No cats or rodents were hurt during this game's development

Since I had no prior experience developing games nor developing AI harnesses, Mistral Vibe did the major development part. My contribution was mainly the idea, name, some details about the figures and design. I did learn a lot about harness and game development though, and had a lot of fun making decisions how the cat and rodents move and behave.

If you're curious about the game yourself, you can find it under **https://tq-bit.github.io/verminvaders/**

## The technical part

The harness uses Playwright on a Chromium Server. It talks to the game's Harness Bridge (`window.verminvaders`) to read the game's current state and feed it to the model, which then strategizes what to do next. Each strategy is fed back into the harness and the next round (= game epoch) starts. This loop goes on until all rodents are eliminiated or the cat is overwhelmed.

> By default the game keeps running while the model strategizes — the harness plays on with its current parameters and applies the model's new plan the moment it returns. If you prefer to play the game with a cat-nap between strategies, pass `--strategy-mode paused` and the game freezes during every consultation.

The harness has a simple memory function built-in to strategize and learn from previous mistakes. Turns out it is able to play the game much better than I used to be.

The model's own words also appear in the game page, in two glass panels right of the canvas: "Le Chonk's thoughts" streams its raw reasoning chain live while it strategizes, and "Current Strategy" settles to its plan for the next epoch or game plus the executor levers it will play with. The `--headed` window (and every recording) is sized to fit both.

### How a session flows

```
serve game -> launch Chromium -> connect to window.verminvaders (10 s timeout)
  -> start() on title
  -> executor ticks every 80 ms (aim, dodge, shoot, reposition)
  -> every epoch: snapshot state + report + memory -> Mistral reasons
       in the background (streamed live into the game's strategy panel)
       (report includes crumb firing statistics: crumbs fired,
        per-column spawn histogram, near misses)
       -> params + memory arrive -> apply params at the next tick,
          persist memory, start the next epoch
  -> game over: next game starts immediately (up to --games), the
       post-mortem runs in the background and its params apply when they land
  -> session summary (games, best score, shots, hits, duration)
```

The game never stops for the model: while Mistral reasons the executor keeps
playing with its current parameters, and the tuned params are applied at the
next tick boundary after the answer lands. A fresh session also warm-starts:
the first game opens on the last params the model played with (persisted in
memory), and the opening consultation retunes them in the background.
(With `--strategy-mode paused` the game instead freezes around every
consultation; a `finally` watchdog guarantees it resumes even if the model
call, the parser, or the process shutdown path fails.) Ctrl+C stops the
harness, resumes the game, and closes the browser cleanly.

## Run the harness

### Requirements

- **Node.js 24+** (TypeScript runs natively via type stripping), npm, and a Chromium download.
- Also, copy the .env.example file and add a MISTRAL_API_KEY

To get started, run
```bash
cd src
# install dependencies (incl. Playwright)
npm install
# download the headless Chromium used to run the game page
npx playwright install chromium
# copy the env-file. Remember to fill it with the API key
cp .env.example .env
```

Two optional environment-variables tune how much history the model works with:

| Variable | Default | Meaning |
| --- | --- | --- |
| `VERMINVADERS_CONTEXT_GAMES` | `5` | How many previous games (their strategy summaries and stats) are included in every prompt. `0` = start each game with no game history. |
| `VERMINVADERS_MEMORY_MAX_GAMES` | `10` | Maximum number of game records persisted in `memory/mistral-strategy.json`. Older records are dropped when the cap is exceeded. |

## Run

From `src/`:

```bash
node main.ts                # 3 games, mistral-large-4, 10 s epochs, headless
node main.ts --headed       # watch it play in a Chromium window
```

### Tests

```bash
npm test                    # run the unit tests
npm run typecheck           # tsc --noEmit
```

### Flags

You can tweak how the AI plays the game. `--headed` allows you to watch the model play and `--style` controls the default behavior when playing the game. See 'Adjusting the AI's behavior' for more details on this.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--headed` | headless | Open a visible Chromium window and watch the game. |
| `--games <n>` | `3` | Auto-restart up to n games per session. |
| `--model <name>` | `mistral-large-4` | Which Mistral model is the strategic brain. |
| `--epoch-ms <n>` | (none) | Strategy epoch length: the model is consulted mid-play every n ms. Omit it for per-wave strategy — no mid-wave stops, the model retunes once per cleared wave (plus opening/post-mortem). |
| `--strategy-mode async\|paused` | `async` | `async` (default): the game keeps playing while Mistral strategizes in the background; new params apply the moment the model returns. `paused`: the classic fair-play catnap — the game freezes around every consultation. |
| `--style '<directive>'` | (none) | Operator directive injected into the model's prompt — see below. |
| `--memory <path>` | `memory/mistral-strategy.json` | Where the model's persistent memory lives. |
| `--persona <path>` | `src/persona/lines.json` | Custom fat-cat lines file. |
| `--game <path>` | `app/game/index.html` | Path to the game page. |
| `--mode realtime\|considered` | `realtime` | `considered` also pauses the game around every executor tick (slow; mostly for debugging). |
| `--poll <ms>` | `80` | Executor tick interval. |
| `--log-level silent\|normal\|verbose` | `normal` | `verbose` logs every shot; `silent` also silences the cat. |
| `--no-llm` | off | Skip all API calls; the executor plays with its default parameters. |
| `--no-thinking` | off | Hide the model's reasoning text; show a `Strategizing` pixel indicator instead. |
| `--no-prompt` | off | Skip the interactive setup wizard (it only runs on a TTY). |

Examples:

```bash
# fast epochs for lively terminal output
node main.ts --epoch-ms 5000

# the classic catnap: the game freezes while Mistral thinks
node main.ts --epoch-ms 5000 --strategy-mode paused

# three games, survival first
node main.ts --games 3 --style "careful: survival over score, wide margins"

# let it learn across sessions, then reset the brain
node main.ts
rm memory/mistral-strategy.json
```

### Adjusting the AI's behavior

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
   | `verminSeed` | -1–2147483647 | Seed for the rodents' firing RNG: `-1` = unseeded, any other value replays the same crumb schedule and shooter picks every game. Unlike the other params it steers the enemy, not the cat. The system prompt does not document this lever — the model is free to discover what it does (operator default via `VERMINVADERS_VERMIN_SEED`). |

   Defaults live in `src/policy/heuristic.ts` (`DEFAULT_EXECUTOR_PARAMS`).


