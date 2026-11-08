# Script load and worker hook

When a user opens a twitch.tv channel with vaft installed, the script announces itself, applies its settings,
hooks `fetch`, replaces Twitch's video worker with the injected one, and the stream plays as it would without
vaft.

## Sub-features

- `load-banner` logs `[AD DEBUG] TwitchAdSolutions vaft v<ourTwitchAdSolutionsVersion> loading` and the `Config:` line.
- `load-hooks` installs the window fetch hook (`Window fetch hook installed`) with no `Could not hook` lines.
- `load-worker` intercepts Twitch's worker (`Worker intercepted — injecting ad-block hooks`, worker logs `hookWorkerFetch (vaft)`).
- `load-stream` the worker opens a session (`New stream session — channel: <login>, API: v2`).
- `load-plays` the video advances about one second per second with vaft as without it.
- `load-frames` nested non-embed twitch.tv frames skip with `vaft skipped — nested frame`.
- `load-version-global` `window.twitchAdSolutionsVersion` equals `ourTwitchAdSolutionsVersion`.

## How to get to it (user POV)

- Open `https://www.twitch.tv/<channel>` with the script installed.
- Open a channel in a page that embeds Twitch (`player.twitch.tv/?channel=<login>&parent=...`). Not driven yet.

## Driving it with vaftctl

Preconditions:

- Baseline preconditions from the README.

- **Load on a channel.** Run `$V drive --channel <login> --seconds 30 --name load`. `summary.vaftLoading`,
  `summary.workerIntercepted` (true) and `summary.workerStreamSession` (names `<login>`) are all set;
  `summary.milestones` has no `Could not hook`, `CONFLICT` or `falling back to unmodified worker`.
- **Version global.** In `samples.jsonl`, `vaftVersion` equals `ourTwitchAdSolutionsVersion` from `src/page/index.ts`
  (doctor prints it).
- **Plays like baseline.** Run `$V drive --channel <login> --seconds 30 --name load-baseline --no-inject`.
  Both runs show `video.advancedSec` within a few seconds of `seconds - firstProgressAtSec` and empty
  `stalledSecs` / `playerErrorSecs`. Compare `shot-*.png` side by side.
- **Frame guard.** `grep 'vaft skipped' console.log` in the injected run. No such line comes from `[page]`.
  The channel page's iframes (`[cdp] attached iframe`) were not on twitch.tv hosts in any run so far, so the
  nested-frame branch usually doesn't fire: report `load-frames` as skipped unless an `[iframe:...]` session
  logs `vaft skipped — nested frame`.

## Gotchas

- Twitch starts two video workers on a channel page; two `Worker intercepted` and two `hookWorkerFetch (vaft)`
  lines are normal.
- `GQL headers captured` needs an `Authorization` header and so never appears logged out. Its absence is not a
  failure in this harness.
- Logged-out channel loads often begin with a real preroll; `Ad detected — type: preroll` within the first
  seconds is expected, not a load failure.
- `[iframe:] EXCEPTION SecurityError: getLayoutMap()`, `MaxListenersExceededWarning`, and `[GraphQL] ... unauthenticated`
  are Twitch's own noise and appear with `--no-inject` too.
- The cookie banner covers the top of every screenshot. It does not block playback; it is not clicked.
