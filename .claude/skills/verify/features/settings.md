# localStorage settings

Users tune vaft by setting `twitchAdSolutions_<key>` in twitch.tv's localStorage and reloading the page.
The script reads them at startup (`loadLocalStorageConfig()`); the worker gets its share through `SharedConfig`.
The keys and defaults are listed in `CLAUDE.md` under "localStorage Config".

## Sub-features

- `settings-config-line` the startup `Config:` line reflects `reloadPlayerAfterAd`, `playerType`, `pinBackupPlayerType`.
- `settings-override-log` each opt-in/opt-out key set to its non-default value logs its `[AD DEBUG]` override message at startup.
- `settings-soft-reload` `softReloadNoStrip=false` turns the no-strip end-of-break reload from soft into hard.
- `settings-hide-overlay` `hideAdOverlay=true` keeps the `Blocking ads` banner hidden (see overlays.md).
- `settings-backup-swap` `backupSwapFirst=false` reverts to the strip-first sticky CSAI path.

## How to get to it (user POV)

- In the browser console on twitch.tv: `localStorage.setItem('twitchAdSolutions_<key>', '<value>')`, then reload.

## Driving it with vaftctl

Preconditions:

- Baseline preconditions from the README.

- **Config line.** Run `$V drive --channel <login> --seconds 10 --name cfg --ls playerType=embed --ls reloadPlayerAfterAd=false`.
  `console.log` has `Config: ReloadPlayerAfterAd = false, ForceAccessTokenPlayerType = embed`.
- **Soft vs hard end-of-break reload.** Run the simulated break from ad-break.md twice: once plain, once with
  `--ls softReloadNoStrip=false`. Plain ends with `End-of-break reload: site — soft, nothing was stripped
  (SoftReloadNoStrip)` + `Reloading Twitch player (soft)`; the override ends with `End-of-break reload: site —
  flushing MediaSource to prevent A/V desync accumulation` + `Reloading Twitch player (hard)`. Both recover
  (see ad-break.md).
- **Stored value.** Add `--at "3:localStorage.getItem('twitchAdSolutions_<key>')"`; the `[action]` line shows the
  seeded value as the page sees it.

## Gotchas

- Pass each setting as its own pair of arguments: `--ls key=value`. A quoted `"--ls key=value"` is one argument
  and vaftctl rejects it.
- The `twitchAdSolutions_` prefix is optional in `--ls`; vaftctl adds it.
- Boolean keys compare against the strings `'true'` / `'false'`; `1`, `yes` and so on fall back to the default.
- Keys not named by `--ls` are removed before the page loads, so a setting never leaks from a previous drive.
