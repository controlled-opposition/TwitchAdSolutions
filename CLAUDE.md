# TwitchAdSolutions (vaft)

Hard fork of ryanbr/TwitchAdSolutions (forked at vaft 68.5.7), trimmed to the single vaft userscript. Not synced with upstream; all code here is owned and maintained in this repo. Remote `origin` = controlled-opposition/TwitchAdSolutions.

## Scope

- The only shipped artifact is `vaft/vaft.user.js`. Don't add uBlock Origin scriptlets, testing builds, other script variants, or extensions.
- `vaft/vaft.user.js` is **generated** from `src/` by `node scripts/build.js` (esbuild) and committed, because the install/update URL serves it straight from the repo. Never edit it by hand; change `src/` and rebuild. `nix flake check` (and CI) fails if it is stale.

## Layout

- `src/meta.js`: the userscript header (`@version` etc.), prepended by the build.
- `src/page/`: runs on the page. `index.ts` is the entry (frame/clip-page guards, duplicate-copy check, startup). `state.ts` holds the page's settings (`state`), the shared mutable flags (`runtime`) and `playerBufferState`.
- `src/worker/`: runs inside Twitch's video worker. `index.ts` is the entry. `state.ts` holds the worker's settings and stream state (`state`: `StreamInfos`, `AdSegmentCache`, `V2API`, ...).
- `src/shared/`: used by both bundles: types (`StreamInfo`, the page⇄worker messages, `SharedConfig`), `defaultSharedConfig()`, `getWasmWorkerJs()`. It must not use DOM-only or worker-only APIs: it is type-checked against both libs.
- `scripts/build.js`: the build. `tests/`: unit tests, the end-to-end harness and the benchmark.

## Worker Injection

The worker is a separate esbuild bundle. The build splices it into the userscript as the body of `runWorker()` (`src/page/worker-bundle.ts`), and `hookWindowWorker()` starts each Twitch worker from `(${runWorker.toString()})(${JSON.stringify(init)})`. `init` is a `WorkerInit`: Twitch's worker blob URL plus `SharedConfig`, the page settings the worker needs (localStorage options and captured GQL headers). Later header changes travel as `Update*` messages.

- Worker code can import anything under `src/worker/` and `src/shared/`; the bundle is self-contained, so there is no outer-scope rule any more. It cannot import from `src/page/`, and `src/worker/tsconfig.json` (webworker lib) rejects `window`/`document`.
- To pass a new page setting to the worker, add it to `SharedConfig` (`src/shared/types.ts`) and `defaultSharedConfig()`. Both `state` objects spread the defaults, so the page reads it from localStorage and the worker receives it in `init.config`.
- The worker entry runs Twitch's own worker script with an indirect eval (`(0, eval)(...)`) so it lands in the worker's global scope, as it would as its own worker script.
- The output is strict mode (since v69.1.0). The build puts `"use strict"` as the first statement of each IIFE, page and worker, so it survives a userscript manager wrapping the script and the worker being shipped as `runWorker`'s source text. Twitch's worker code stays sloppy: indirect eval doesn't inherit strictness.
- Under strict mode, assigning to a property another extension (or the browser) made read-only throws. Install every hook and every `window.*` global through `installHook(target, key, fn, label)` (`src/shared/hook.ts`), never by plain assignment. It falls back to redefining a configurable own property, logs when the property can't be replaced, and returns whether the hook is in place, so the caller can carry on unhooked: the worker still runs Twitch's code without its fetch hook (stream plays, with ads), the page skips the header capture or CSAI counts, and localStorage falls back to `localStorageHookFailed`. `maskAsNative` defines `toString` rather than assigning it, for the same reason.
- `alreadyHooked` detection relies on the blob text containing `hookWorkerFetch`; a test checks the built blob still does.

## Versions

Bump `@version` (`src/meta.js`) and `ourTwitchAdSolutionsVersion` (`src/page/index.ts`) together for functional changes, then rebuild. `ourTwitchAdSolutionsVersion` also drives duplicate-script detection (a running copy with an equal or higher value makes this one skip), so it must only ever increase.

## localStorage Config

All read at init (`loadLocalStorageConfig()` in `src/page/storage.ts`); the ones the worker uses reach it through `SharedConfig`:
- `twitchAdSolutions_reloadPlayerAfterAd` — `true`/`false`, default `true`
- `twitchAdSolutions_playerType` — string, default `popout`
- `twitchAdSolutions_pinBackupPlayerType` — `true`/`false`, default `true`
- `twitchAdSolutions_hideAdOverlay` — `true` to hide the internal `.tas-adblock-overlay` banner (SDA wrapper hide always runs), default not set
- `twitchAdSolutions_disableReloadCap` — `true` to revert to unlimited reloads
- `twitchAdSolutions_driftCorrectionRate` — number, default `1.1` (0 to disable)
- `twitchAdSolutions_earlyReloadPollThreshold` — number, default `3` (0 to disable; thin cache overrides to 1)
- `twitchAdSolutions_preferLowQualityBackup` — hybrid mode (sticky escape hatch + autoplay last-resort backup), default `true`; set to `false` to disable
- `twitchAdSolutions_backupSwapFirst` — on ad detect, immediately swap to backup player-type m3u8 (TTV-AB-style) instead of sticky CSAI strip. Default `true` as of v63.0.0; set to `false` for legacy strip-first path
- `twitchAdSolutions_fastAutoplayFirstTry` — opt-out (default `true` as of v67.1.0). Prepend autoplay (360p) to position 0 of the iteration when the prior break committed autoplay via PreferLowQualityBackup escape hatch. Saves ~1.5-2s of probe-loop buffering. Auto-resets when a Source-tier type wins (channel recovered) so quality returns to full automatically. Set to `'false'` to force full Source-tier probe on every break
- `twitchAdSolutions_recoverFromSilentMute` — opt-out (default `true`). On hard reload, if the element is already muted but vaft has successfully unmuted at any point earlier this session, recover via the 5500ms backstop (Twitch's silent re-mute pattern — issue #200). Disable via `'false'` if you deliberately mute mid-session and want that preserved across reloads. Users muted from session start are always respected (vaftEverUnmuted=false short-circuits the recovery check).
- `twitchAdSolutions_disableAdSpoofing` — opt-in via `'false'` (default `'true'` — spoofing is OFF). When enabled, on ad detect vaft fires the GQL ad-tracking beacons (`video_ad_impression`, `video_ad_quartile_complete` × 4, `video_ad_pod_complete`) that Twitch's player would have sent if the ad had played normally. Originally intended to mimic the ad-completion signal Twitch expects and may reduce detection escalation — but the always-100%-watched + audible + visible beacon pattern may itself fingerprint as anomalous (silently, without GQL rejection) and trigger detection escalation in the other direction (observed correlation with CSAI ads reaching committed backups + TTV-AB maintainer hypothesis). Default flipped from on→off after v68.2.0. Set to `'false'` to re-enable (for A/B testing whether spoofing affects ad break duration / CSAI escalation on your channels). Failures swallowed (never blocks ad-block flow).
- `twitchAdSolutions_softReloadNoStrip` — opt-out via `'false'` (default on). After a break that stripped nothing but committed a non-autoplay backup (the BackupSwapFirst swap, issue #129 mode D), reload soft instead of hard: no MediaSource flush, no desktop black-screen + play-icon teardown. `'false'` restores the hard flush (use it if audio/video drift apart after backup-swap breaks).
- `twitchAdSolutions_disablePostBreakWedge` — opt-out via `'true'` (default off = feature on). Disables the post-break video-wedge recovery (v667/v68.5.0, TTV-AB _checkPostBreakWedge mirror) for A/B isolation.

## CSAI vs SSAI

- **SSAI** (Server-Side Ad Insertion) — ads embedded in m3u8 segments. Blockable by stripping.
- **CSAI** (Client-Side Ad Insertion) — ads delivered via `edge.ads.twitch.tv`, outside m3u8. Not blockable at m3u8 level. Detected via fetch/XHR hooks for logging only.
- When `hadStrippedSegments === false` (CSAI-only), skip reload entirely to prevent cascade.

## Key Architecture (vaft)

- **Buffer monitor** (`monitorPlayerBuffering`) — polls player state every 1-3s (visibility-aware). Detects stalls, fires pause/play or reload.
- **No end-of-break reload cooldown** — the post-ad reload is rate-limited by the break cycle itself (#162). The former `reloadCooldownSeconds` setting only fed a log line and was removed in v69.2.0.
- **Reload cap** — buffer monitor reloads at most once per recovery window (`StallLadder.reloadUsed`, `src/page/stall.ts`).
- **Grace periods** — 15s after reload, 10s after backup switch. Buffer monitor skips fixes during these.
- **Drift correction** — `startDriftCorrection(videoElement)` shared function. 1.1× playback rate, 30s safety timeout. Restarts fresh on re-entry (clears stale timers). Used by post-reload drift and buffer gap seek.
- **Reload routing** — worker → main `ReloadPlayer` messages carry a `kind` field, and a `requestId` when the worker wants to know what happened (`requestReload()` in `src/worker/reload.ts`): the page answers with `ReloadResult` (`reloaded` / `skipped-healthy` / `not-done`), so only the request that was skipped is affected. `kind: 'codec-swap'` (HEVC/AV1 → AVC master) is a soft reload that is never skipped as "player healthy". `doTwitchPlayerTask('reload', reloadKind)` picks `setSrc` params: `kind === 'early'` → hard reload (`isNewMediaPlayerInstance: true, refreshAccessToken: true`, new session); otherwise soft reload. The two flags are **not** coupled: on Apple touch devices `iosSoftReload` downgrades `isNewMediaPlayerInstance` to false while `refreshAccessToken` stays true (v68.5.5 — not yet validated on a device). Early reload sites (both sticky + normal paths) send `kind: 'early'`; the end-of-break reload after a break that stripped segments sends `'early'`; after a no-strip break that committed a backup (BackupSwapFirst swap, issue #129 mode D) it sends `'post-ad'` when `SoftReloadNoStrip` is on, except for an autoplay backup, which stays `'early'` because only a token refresh leaves the 360p ladder. (`SoftReloadNoStrip` was dead code from v68.5.0 until v69.2.0: it sat in the stripped-segments branch.) HEVC force reload stays soft (codec change, no strip involved). Hard reload flushes the MediaSource buffer — required after strip activity (BLANK_MP4 injection, recovery replay) to avoid audio/video desync from accumulated timestamp drift.
- **Early reload** — fires during prolonged all-stripped freeze. Threshold: 3 polls (~6s), or 1 poll when recovery cache <3 segments (thin-cache fast path). Budget: `max(1, PodLength)` or `max(2, PodLength)` when thin. State machine `AdBreak.EarlyReload` (`src/worker/early-reload.ts`): `armed → requested → reloaded → armed`; any result re-arms (budget-bounded); a reload the page skipped as healthy is refunded; an unanswered request re-arms after 10s. Not fired on the poll that starts a codec-swap reload. Override via `twitchAdSolutions_earlyReloadPollThreshold`.
- **Sticky CSAI fast path** — `AdBreak.Path`: `probing → sticky-csai` once a break's polls are all live (only when `BackupSwapFirst` is off), then stays for the whole break unless the PreferLowQualityBackup escape hatch moves it to `escaped` (never back). Both paths step the same early-reload machine.
- **Latency-aware reload health check** — measures `seekable.end - currentTime` before skipping post-ad reload. If >7s behind live or seekable unavailable/garbage, proceeds with reload. Guards against 2^30 sentinel values via `Number.isFinite` + 3600s cap.
- **User pause intent** — tracks video pause/play events to distinguish user vs script pauses. `scriptPausedAt` only resets when player wasn't paused (guards against clearing intent during stall recovery).
- **Player ref** — `runtime.playerForMonitoringBuffering` is re-acquired at the start of every buffer-monitor tick (not cleared on reload); `overlay.ts` reads the last tick's value between ticks.
- **StreamInfo factory** — `createStreamInfo()` (`src/worker/stream-info.ts`) declares all fields up-front. Per-break state lives in `AdBreak` (`createAdBreak()`, `src/worker/ad-break.ts`), created on the first ad-marked poll and dropped at break end, so there is no per-break reset list to maintain.

## State Machines

Each one is a single typed state value with its transitions in one place; keep it that way (no new loose flags that together encode a state).

Worker (per `StreamInfo`):
- **Ad break** — `StreamInfo.Break: AdBreak | null` (`src/worker/ad-break.ts`). `onAdPoll` / `onAdFreePoll` drive the end candidate (`AdBreak.End`): 3 ad-free polls in a row, an ad-free poll with no live segments, or 12s since the first ad-free poll end the break (bounces back to ad-marked keep a <12s candidate). `decideBreakEndAction()` picks the end-of-break player action. `StrippedSegments` is the break's total (not reset on a poll that strips nothing).
- **Break path** — `AdBreak.Path` (`probing` / `sticky-csai` / `escaped`).
- **Early reload** — `AdBreak.EarlyReload` (see above).
- **Codec swap** — `StreamInfo.CodecSwap`: `native → switching → swapped → native`. The AVC-only master is served unless `native`. Tried once per break; reverts to `native` if the page didn't reload. Every break end with a swap reloads back, stripped or not.
- **Autoplay first** — `SourceTierExhausted` + `FastAutoplayWins` across breaks; `AdBreak.AutoplayFirst` is decided once per break on its first backup search (every 5th such break re-probes the Source tier).
- **Recovery segments** — `AdBreak.RecoverySegments`, so a break never replays a previous break's segments.
- **Page reload seen** — `StreamInfo.ReloadPending`: set on every stream by `TriggeredPlayerReload`; each stream's own next poll stamps `LastPlayerReload` (minimal-requests window, post-ad re-entry guards).
- **Codec match** — backup variants are picked in the player's codec family when one exists (`getStreamVariantForResolution`); if the committed backup's family still can't be decoded by the player (`isCodecMismatch`, either direction), the poll strips every segment.

Page:
- **Stall ladder** — `playerBufferState.stall` (`src/page/stall.ts`, pure `stallTick`).
- **Post-break wedge watch** — `playerBufferState.wedge` (`src/page/wedge.ts`, pure `wedgeSample`), armed on the ad→no-ad edge.
- **Loading-circle detector** — `playerBufferState.adStall` (`idle` / `stalling`); `hasHadData` resets on channel change.
- **Ad-break mirror** — `inAdBreak` + `runtime.isActivelyStrippingAds`, applied only in `onAdBreakUpdate()` (`src/page/worker-hook.ts`).
- **Drift correction** — one tracked catch-up (`src/page/drift.ts`); finishing resets the element whose rate was raised.
- **Hard-reload mute restore** — one `MuteRestore` at a time (`src/page/player.ts`); a hard reload during a pending restore takes over its pre-mute instead of reading it as a user mute.

## Debug Logging

All logs use `[AD DEBUG]` prefix. Some logs are deduped (once per ad break or once per page load) to prevent console spam.

## Validation

In the Nix dev shell (`nix develop` / direnv):
- `node scripts/build.js`: rebuild `vaft/vaft.user.js` after any change under `src/` (`--check` only verifies).
- `node tests/test.js`: unit tests plus end-to-end tests against the built script.
- `tsc -p . && tsc -p src/worker`: type check the page and worker bundles (0 errors).
- `biome check --write .`: lint + format `src/`, `scripts/`, `tests/` and JSON.
- `nix fmt`: format everything (nixfmt, Biome, yamlfmt). Markdown is not auto-formatted.
- `nix flake check`: all of the above as checks (formatting, lint, typecheck, build up to date, tests). This is what CI runs.
- `node tests/benchmark.js`: optional perf comparison against the pixeltris baseline.

Use the dev shell's esbuild: the up-to-date check compares bytes, so a different esbuild version can produce a spurious diff.

## Tests

- `tests/load.js`: `loadModules(['src/worker/ads.ts', ...], { globals })` bundles the listed modules and evaluates them in a fresh vm context, so each call gets its own module state. Exports come back as properties (`vaft.stripAdSegments`, `vaft.state.V2API = true`); `vaft.context` is the global (`self`/`window`).
- `tests/harness.js`: loads a built userscript into a mock page, captures the worker blob it injects, and runs it in a mock worker with a scripted network and GQL. A `setup(global)` option prepares either global first (e.g. locks `fetch` the way another extension might).
- `tests/scenarios.js`: scripted ad-break scenarios (fake clock) that produce a transcript of returned playlists and worker messages. Running the same scenarios against two builds compares their behaviour; that is how this TypeScript conversion was checked against v68.5.8.

## Lint / Format (Biome)

`biome.json`: 4-space indent, 120 columns, single quotes, semicolons, trailing commas; recommended lint preset minus `useTemplate`, `useArrowFunction`, `useOptionalChain`, `useLiteralKeys` (style-only churn; optional chaining also changes the result for falsy non-null values) and `noArguments` (deliberate forwarding in the native-masked hooks). Suppress a finding only with a `biome-ignore` comment that says why. Formatting-only commits go in `.git-blame-ignore-revs`. The generated `vaft/vaft.user.js` is excluded.

## Types

TypeScript 7 (`tsconfig.base.json`, extended by `tsconfig.json` for the page + shared code with the DOM lib, and `src/worker/tsconfig.json` for the worker with the webworker lib). `strict` is on; tsc only checks, esbuild builds.
- Imports use explicit `.ts` extensions and `import type` for types (`verbatimModuleSyntax`, `erasableSyntaxOnly`).
- `StreamInfo` is built by `createStreamInfo()` and `AdBreak` by `createAdBreak()`, each with every field up front; a field missing from one or from its interface is a type error.
- Twitch internals reached through React (`TwitchMediaPlayer`, `TwitchPlayerState`, `ReactFiber` in `src/page/twitch.ts`) are typed with only the members vaft uses, all optional where Twitch may drop them; component instances are deliberately `any` (`ReactInstance`).
- Behaviour-neutral casts where the checker can't follow the code: `(err as Error).message` in catch blocks, `arguments as any` when forwarding to the real `fetch`/`setItem`/`open`. Don't "fix" these by changing runtime behaviour.

## Backup Player Types

`embed`, `site`, `popout`, `mobile_web` (autoplay removed — gets stuck in loading circle on transition back; still used as a last-resort via `PreferLowQualityBackup`).

## Ad Overlay Hiding

`hideTwitchAdOverlays()` hides one overlay type during ad blocking:
- **Stream display ads (SDA)** — via exact `[data-test-selector="sda-wrapper"]` selector, no parent walking

Called on every buffer monitor tick. Guards via `dataset.tasHidden` to skip already-hidden elements.

**Previously removed:**
- Turbo promo / "allow ads" overlay hide (PR #143) — used `.player-overlay-background` which is Twitch's generic modal scrim (also used for content gates, error dialogs, subscription warnings). Too broad to use safely.
- Ad-break-card text match (PR #141) — scanned `span/p/h1/h2/h3` text for "taking an ad break" phrases then walked up via fuzzy `[class*="overlay"]` + `parentElement` fallback. Could hide player controls on false matches. TTV-AB doesn't attempt this either.

Only keep overlay hides that use exact attribute selectors with no parent walking.
