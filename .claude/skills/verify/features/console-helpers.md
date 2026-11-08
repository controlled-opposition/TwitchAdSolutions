# Console helpers

The script installs a few globals a user (or a bug reporter following DEBUG.md) can call from the twitch.tv console.

## Sub-features

- `helper-reload` `reloadTwitchPlayer()` reloads the player (`Reloading Twitch player (soft)`) and playback resumes.
- `helper-simulate` `simulateAds(n)` posts `SimulateAds` to the worker (`SimulatedAdsDepth: n`); `simulateAds()` with no argument prints usage.
- `helper-all-segments` `allSegmentsAreAdSegments()` toggles stripping every segment (`AllSegmentsAreAdSegments: true|false`).

## How to get to it (user POV)

- Type the call in the browser console on a twitch.tv channel page.

## Driving it with vaftctl

Preconditions:

- Baseline preconditions from the README.

- **Manual reload.** Run `$V drive --channel <login> --seconds 30 --name manual-reload --at "12:reloadTwitchPlayer()" --shots 10,28`.
  `console.log` has `[page] [AD DEBUG] Reloading Twitch player (soft)` at ~12 s; samples after it show
  `video.t` restart near 0 then advance with `readyState` 4; `playerErrorSecs` empty.
- **Simulate usage message.** Add `--at "5:simulateAds()"`; `console.log` has
  `Ad depth parameter required (0 = no simulated ad, 1+ = use backup player for given depth)`.
- **Simulate a break.** See ad-break.md.
- **Strip everything.** Run `$V drive --channel <login> --seconds 40 --name strip-all --at "8:simulateAds(1)" --at "10:allSegmentsAreAdSegments()" --at "24:allSegmentsAreAdSegments()" --at "26:simulateAds(0)"`.
  The worker logs `AllSegmentsAreAdSegments: true` then `false`; `stalledSecs` covers the stripped window.

## Gotchas

- Calls run in the page's main world, the same world the userscript uses (`@grant none`); they don't exist with
  `--no-inject`, and the `[action]` line then reads `THREW ReferenceError`.
- `reloadTwitchPlayer()` returns `undefined`; judge it by the log line and the samples, not the return value.
- The strip-all recipe has not been run while writing this map. Expect the player to freeze while stripping; the
  stall ladder may reload it. Record what happens before treating it as a pass.
