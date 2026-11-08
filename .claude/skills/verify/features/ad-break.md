# Ad break blocking

When Twitch inserts an ad break, vaft detects it in the playlist, swaps the player onto an ad-free backup
stream (BackupSwapFirst, the default), shows `Blocking ads (<type>)` on the player, and when the break ends,
reloads the player back onto the normal stream. The user sees the stream continue instead of an ad.

## Sub-features

- `break-detect` logs `Ad detected — type: preroll|midroll, channel: <login>, pod: N ad(s)`.
- `break-backup` commits the first clean backup type: `Blocking ads (<type>) — backup found in <ms>`.
- `break-contaminated` skips ad-laden backups (`Backup stream (<type>) also has ads`) and reorders (`Contamination-aware reorder`).
- `break-autoplay` falls back to the 360p autoplay backup when every Source type has ads (`Autoplay backup committed`).
- `break-end` ends the break: `Finished blocking ads — stripped N ad segments, duration: Xs`.
- `break-reload` the end-of-break action: `End-of-break reload: <type> — soft|flushing ...` then `Reloading Twitch player (soft|hard)`.
- `break-recover` after the reload the video plays again at Source quality with no player error.

## How to get to it (user POV)

- Open a channel while logged out; Twitch serves prerolls and midrolls to logged-out viewers often.
- Type `simulateAds(1)` in the console, wait, then `simulateAds(0)` (the script's own test helper; drives the
  real worker, backup fetches, and reload).

## Driving it with vaftctl

Preconditions:

- Baseline preconditions from the README.

- **Simulated break, end to end.** Run
  `$V drive --channel <login> --seconds 60 --name sim-break --at "10:simulateAds(1)" --at "30:simulateAds(0)" --shots 5,20,55`.
  `summary.milestones` reads, in order: `SimulatedAdsDepth: 1`, `Ad detected ... signifiers:` (empty),
  `Blocking ads (site) — backup found`, `SimulatedAdsDepth: 0`, `Finished blocking ads — stripped 0`,
  `End-of-break reload: site — soft, nothing was stripped (SoftReloadNoStrip)`, `Reloading Twitch player (soft)`.
  `bannerVisibleSecs` spans roughly 11 to the reload second and `bannerTexts` contains `Blocking ads (site)`.
- **Recovery after the reload.** In the same run, samples after the reload second show `video.t` restarting
  near 0 and then advancing, `readyState` 4, size back to 1280x720 or higher; `playerErrorSecs` is empty;
  `shot-055s.png` shows the stream, not a black player.
- **Real break.** Run `$V drive --channel <login> --seconds 120 --name real-break --shots 5,30,60,115` on a
  few top channels until `milestones` contains an `Ad detected` with non-empty `signifiers:`. Prove the same
  sequence; a pod of N ads lasts about 30·N s, so give it `seconds` ≥ 30·N + 30 to see `Finished blocking ads`.
- **Baseline.** Run the same channel with `--no-inject`; a real ad shows Twitch's ad UI in the screenshots.

## Gotchas

- Real ads cannot be scheduled. Logged out, the first page load of a big channel usually carries a preroll,
  and a channel that just served one often serves none for minutes after.
- `simulateAds(N)` treats backup types at index < N-1 as ad-laden: `1` takes the first type (`site`), `2`
  skips `site`, and so on. The break lasts until `simulateAds(0)`; it then ends after 3 ad-free polls (~4-5 s).
- A real preroll in progress when `simulateAds(1)` fires merges into one break; check that no `Ad detected`
  precedes the `SimulatedAdsDepth: 1` line, or rerun.
- Up to v69.4.1 the end-of-break soft reload broke fMP4 channels (theburntpeanut: 18 of 22): an
  `IVS WASM worker crashed` line followed by a rescuing hard reload, or worker `Player stopping playback - error
  Player:2 (ErrorNotSupported code 0 - No playable format)` and `Error #4000` on screen. A crash that the hard
  reload rescues still counts as a failed soft reload. Prove `break-reload` on an fMP4 channel (media playlist
  has `#EXT-X-MAP`) as well as a TS one, and grep for `WASM worker crashed` as well as `playerErrorSecs`.
- Video `currentTime` resets to ~0 on every player reload; `advancedSec` in the summary is last-minus-first and
  understates playback across a reload. Read the samples.
