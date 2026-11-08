---
name: verify
description: Drive the built vaft userscript (vaft/vaft.user.js) inside a real headless Google Chrome on live twitch.tv and capture proof — console logs from page and Twitch's video worker, per-second player samples, screenshots. Use to prove a change under src/ works on real Twitch (ad-break blocking, backup swap, end-of-break reload, settings, overlay hiding), not just in tests/harness.js.
---

# verify: drive vaft on live Twitch

The product is a userscript. A user's surface is a twitch.tv channel page with the script injected at
`document-start`; what they see is the video playing (or not), the `Blocking ads (...)` banner on the player,
and the `[AD DEBUG]` lines in the console. `scripts/vaftctl.mjs` reproduces exactly that: it launches an
isolated Google Chrome, injects the **built** `vaft/vaft.user.js` the way an MV3 userscript manager does for
`@run-at document-start` + `@grant none` (a throwaway unpacked extension with a MAIN-world `document_start`
content script on `*://*.twitch.tv/*`, all frames, loaded per drive via CDP `Extensions.loadUnpacked`), opens a
live channel, and records everything over CDP. No npm deps; Node ≥ 22.

Do not swap the injector for `Page.addScriptToEvaluateOnNewDocument`: it runs before `<html>` exists, which
no userscript manager does, and it silently breaks `hideAdOverlay` (the style has nowhere to go). `summary.docStart`
records what existed at injection; under the extension it is `{documentElement: true, head: false}`.

`node tests/test.js` (mock page + mock worker, scripted playlists) is the unit/e2e proof. This skill is the
real-app proof: real Twitch player, real worker, real usher/GQL, real ads.

All commands run from the repo root. `V=.claude/skills/verify/scripts/vaftctl.mjs`.

## Launch

```sh
node scripts/build.js                 # the driver injects vaft/vaft.user.js, so build src/ first
$V launch                             # add --headful to watch it on your display
```

Ready when it prints `READY pid=<pid> port=<port> browser=Chrome/<ver> dir=<repo>/.verify`. That line is
printed only after the browser answered `Browser.getVersion` over CDP. Launch always starts from an empty
profile (`.verify/chrome-profile/` is wiped first), logged out, no extensions. It refuses to start a second
Chrome while `.verify/state.json` names a live one.

Isolation: one Chrome per state dir, port chosen by Chrome (`--remote-debugging-port=0`). A second
checkout, or a parallel agent, sets `VAFT_VERIFY_DIR=/some/other/dir` and gets its own Chrome, profile and
evidence. Do not run two `drive`s at once against the same instance: each drive rewrites the profile's
`twitchAdSolutions_*` localStorage, so concurrent drives clobber each other's settings.

## Doctor

```sh
$V doctor        # exit 0 + "DOCTOR OK" = worth driving
```

Read-only. Checks: state file exists, the recorded pid is alive, CDP answers on the recorded port, that pid's
command line carries our `--user-data-dir` (so the port is ours, not the user's browser), `vaft/vaft.user.js`
matches `src/` (`node scripts/build.js --check`), the built `@version` / `ourTwitchAdSolutionsVersion`, and
twitch.tv answers. A stale build is a FAIL: you would be proving old code. Run doctor first whenever a result
looks off.

## Drive

```sh
$V channels --n 10                                   # live channels by viewer count (public GQL)
$V drive --channel <login> --seconds 30 --name <label> [options]
```

Options (all repeatable ones may be given many times):

| Flag | Meaning |
|---|---|
| `--channel <login>` / `--url <url>` | What to open. Omitting both picks the top live channel. |
| `--seconds N` | Observation length (default 30). One sample per second. |
| `--ls key=value` | Seed `twitchAdSolutions_<key>` before the first page script runs. Every other `twitchAdSolutions_*` key is cleared, so each drive starts from defaults plus exactly these. |
| `--at "<sec>:<js>"` | Evaluate page-world JS at that second; result goes into the log as `[action]`. The script's own console hooks are the user's tools: `simulateAds(1)`, `simulateAds(0)`, `allSegmentsAreAdSegments()`, `reloadTwitchPlayer()`. |
| `--shots 5,15,29` | Screenshot seconds (default: 5, middle, last). |
| `--no-inject` | Baseline: same page, settings seeded, vaft not injected. |
| `--network` | Also log usher, playlist and GQL requests per session as `[net] REQ/RES/FAIL` lines in `console.log`. |

`drive` prints `summary.json` to stdout. Key fields:

- `vaftLoading`, `workerIntercepted`, `workerStreamSession`: the script loaded, hooked Twitch's worker, and
  the worker saw the stream. All three must be present on any injected run.
- `milestones`: ad-break log lines in order (`Ad detected` → `Blocking ads (<type>)` → `Finished blocking ads`
  → `End-of-break reload` → `Reloading Twitch player (soft|hard)`), plus hook failures and player errors.
- `bannerVisibleSecs` / `bannerTexts`: seconds the `.tas-adblock-overlay` banner was visible (computed
  style) and what it said.
- `video`: progress of the player's `<video>` (`.video-player video`). `advancedSec` ≈ elapsed seconds means
  it played. `resolutions` lists every size seen (640x360 = autoplay backup / 360p).
- `stalledSecs`: seconds where the video was unpaused but `currentTime` didn't move.
- `playerErrorSecs`: seconds the player showed `Error #NNNN`.

For the player's own reasoning (quality picks, renditions, `stream not supported`), enable IVS debug logs from
the page with an `--at` action that finds the player instance through the React fiber under `#root` (the node
whose `stateNode.props.mediaPlayerInstance` is set; use its `.playerInstance` if present) and calls
`setLogLevel('debug')`. Its output arrives as `[worker]` lines.

Feature recipes (exact commands and pass conditions): [features/README.md](features/README.md).

## Evidence

Each drive writes `.verify/evidence/<ISO-stamp>-<name>/`:

- `run.json`: argv, URL, seeded settings, scheduled actions, whether vaft was injected.
- `console.log`: every console call and uncaught exception from the page (`[page]`), Twitch's video worker
  (`[worker]`), iframes (`[iframe:...]`) and scheduled actions (`[action]`), stamped in seconds from navigate.
  Workers are paused at start until logging is attached, so the first worker lines are not lost.
- `samples.jsonl`: one JSON line per second: video state, banner, SDA wrapper styles, `twitchAdSolutionsVersion`,
  player error, content gate.
- `shot-NNNs.png`: screenshots.
- `summary.json`: as above.

Proof standards:

- Prove on the built script that matches `src/` (doctor). Never inject a hand-edited copy.
- Exercise the user path: a real channel page, the script loaded the way a userscript manager loads it, and
  the console helpers a user can type. `simulateAds` is shipped in the script and drives the real worker,
  real backup token fetches and the real player reload; it is the deterministic stand-in for a Twitch ad.
  Say which you used: a real ad (`signifiers:` lists tags) or a simulated one (`signifiers:` empty, preceded
  by `SimulatedAdsDepth: N`).
- Capture the action and the result: the milestone sequence **and** the player state after it (samples
  after the `Reloading Twitch player` second must show `advancedSec` growing, `readyState` 4, no
  `playerErrorSecs`) **and** a screenshot after the break.
- Compare with `--no-inject` when claiming vaft changed what the user sees.
- Real ads are not controllable. A run that saw no ad proves nothing about ad handling; say so and use
  `simulateAds`, or repeat on other channels.

## Cleanup

```sh
$V teardown
```

Kills the process group of the Chrome `launch` started (pid from `.verify/state.json`, launched detached so
the group is exactly that Chrome), deletes `.verify/chrome-profile/`, `chrome.log`, `state.json` and any `ext-*` injector dir a crashed drive left.
`.verify/evidence/` is kept. Never `pkill chrome`: the user's own browser may be Chrome. Run teardown after
every session, including failed ones. `.verify/` is gitignored.

## Helpers

- `scripts/vaftctl.mjs` (executable): `launch`, `doctor`, `channels`, `drive`, `teardown`, `help`. Unknown or
  malformed flags exit 1 with the reason (a quoted `"--ls key=value"` is one argument and is rejected; an
  `--at` whose time isn't a number is rejected).
- In zsh, write `--at "${t}:js"`, not `"$t:js"`: zsh reads `$t:r` and similar as history modifiers.
- `VAFT_VERIFY_DIR` overrides the state/evidence dir; `VAFT_CHROME` overrides the Chrome binary (default
  `google-chrome`).
