# vaft verification map

The maintained source for verifying what a vaft user sees on twitch.tv. Read this index, then use the matching
feature file as the recipe. Every recipe drives `scripts/vaftctl.mjs` (see `../SKILL.md`).

## Baseline preconditions

- `node scripts/build.js` has run and `$V doctor` prints `DOCTOR OK` (`V=.claude/skills/verify/scripts/vaftctl.mjs`).
- The Chrome was started by `$V launch` in this state dir: fresh profile, logged out, no extensions besides the
  per-drive injector.
- A live channel. `$V channels --n 10` lists them; top channels are live by definition. Channels named below
  (`kaicenat`, `rainbow6`, `theburntpeanut`) were live when the map was written; substitute any live login.
- One drive at a time per state dir.

## Driving conventions

- Each `drive` starts from defaults plus exactly the `--ls` settings it names; it clears every other
  `twitchAdSolutions_*` key first.
- Trigger behaviour through what a user can do: open a channel, set a `twitchAdSolutions_*` key, type a
  console helper the script installs (`simulateAds(n)`, `reloadTwitchPlayer()`, `allSegmentsAreAdSegments()`)
  via `--at "<sec>:<js>"`.
- Read results from `summary.json` first, then `console.log` lines, then `samples.jsonl`, then screenshots.
- `[worker]` lines come from Twitch's video worker (the injected `runWorker` bundle); `[page]` from the page.

## Proof and skip reporting

- A proof names the evidence dir, the channel, whether the ad was real or simulated, and quotes the milestones.
- After any reload, prove the player recovered: samples after that second show `currentTime` advancing,
  `readyState` 4, and `playerErrorSecs` empty; attach the post-break screenshot.
- A run with no ad proves nothing about ad handling. Report it as "no ad observed", not as a pass.
- An entry point not driven is reported as skipped with the reason, never as verified through another path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior, then exactly
four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with vaftctl`,
`Gotchas`.

## Features

- [Script load and worker hook](./script-load.md): the script starts, hooks Twitch's video worker, and the stream plays.
- [Ad break blocking](./ad-break.md): detection, backup swap, banner, break end, end-of-break reload, recovery.
- [localStorage settings](./settings.md): each `twitchAdSolutions_*` key changes the behaviour it names.
- [Overlays and display ads](./overlays.md): the `Blocking ads` banner, `hideAdOverlay`, SDA wrapper hiding.
- [Console helpers](./console-helpers.md): `reloadTwitchPlayer()`, `simulateAds(n)`, `allSegmentsAreAdSegments()`.
