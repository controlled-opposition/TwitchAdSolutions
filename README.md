# TwitchAdSolutions (vaft)

A hard fork of [ryanbr/TwitchAdSolutions](https://github.com/ryanbr/TwitchAdSolutions) (itself forked from the archived [pixeltris/TwitchAdSolutions](https://github.com/pixeltris/TwitchAdSolutions)), taken at vaft 68.5.7 and trimmed down to just one thing: the **vaft** userscript.

The other upstream variants (uBlock Origin scriptlets, testing builds, video-swap-new, strip, brave-fix) are deliberately left out, and this repo is maintained independently. It does not track upstream.

## Install

1. Install a userscript manager:
   - [Violentmonkey](https://violentmonkey.github.io/)
   - [Tampermonkey](https://www.tampermonkey.net/)
   - [Userscripts](https://apps.apple.com/us/app/userscripts/id1463298887) (Safari)

   *Greasemonkey doesn't work with this script.*
2. Open **[vaft.user.js](https://github.com/controlled-opposition/TwitchAdSolutions/raw/master/vaft/vaft.user.js)** and accept the install prompt.

**Don't combine it with other Twitch-specific ad blockers**, including the upstream copy of this script.

## What it does

- Tries to switch to a clean (ad-free) stream as fast as it can
- If it can't find one, it removes the ad segments, so playback pauses until an ad-free stream is found

## Configuration

The script supports runtime configuration via `localStorage`. Set values in the browser console and refresh the page.

**`twitchAdSolutions_reloadPlayerAfterAd`** (default: `true`)
- `true` - full player reload after ads (slower, more reliable)
- `false` - pause/play after ads (faster, less reliable)
- Not set - uses default (`true`)

**`twitchAdSolutions_playerType`** (default: `popout`)
- Changes the player type used for access token requests
- `popout` - popout player context, tends to receive fewer ads (default)
- `embed` - embedded player context, used for third-party sites
- `site` - normal site player, standard Twitch experience (most ads)
- `autoplay` - autoplay context, lower quality (360p)
- Not set - uses default (`popout`)

**`twitchAdSolutions_hideAdOverlay`** (default: not set)
- `true` - hide the "Blocking ads" banner overlay on the video player
- Not set - banner is visible during ad blocking (default)

**`twitchAdSolutions_pinBackupPlayerType`** (default: `true`)
- `true` - remember which backup player type worked and try it first on next ad break (saves backup search time) (default)
- `false` - always iterate through backup types fresh

**`twitchAdSolutions_reloadCooldownSeconds`** (default: `30`)
- Minimum seconds between player reloads after ad breaks
- Prevents CSAI (client-side ad insertion) cascades where a reload triggers Twitch to serve another ad
- Set to `0` to disable cooldown

**`twitchAdSolutions_disableReloadCap`** (default: not set)
- `true` - buffer monitor reloads unlimited times (pre-v47 behavior, risk of reload loops)
- Not set - buffer monitor reloads at most once per recovery window (default)
- Only enable if you're seeing genuinely stuck playback that a single reload doesn't fix

**`twitchAdSolutions_preferLowQualityBackup`** (default: `true`)
- Hybrid safety net for SSAI-heavy ad breaks. Adds `autoplay` (360p) as a last-resort backup when all Source types (site/popout/mobile_web/embed) are ad-laden. Also enables the sticky escape hatch (~8s stuck → fall through to backup search) when `twitchAdSolutions_backupSwapFirst=false`.
- Set to `false` to disable the autoplay fallback and escape hatch
- ⚠ **Quality caveat**: autoplay only commits when every Source backup is also ad-laden — rare, but the 360p hit is the tradeoff for avoiding long freezes on SSAI-heavy channels

**`twitchAdSolutions_backupSwapFirst`** (default: `true`)
- **Default ad-blocking path** (as of v63.0.0). On ad detect, immediately swap to a backup player-type m3u8 (site → popout → mobile_web → embed, first clean wins). Avoids the MediaSource mixing that the legacy strip+BLANK_MP4+recovery path produces — fewer loading circles and no A/V desync accumulation.
- Set to `false` to revert to the legacy sticky CSAI strip-first path. Use this if you're on a channel/network where backup fetches are unreliable and stripping native is preferable.
- ⚠ **Bandwidth tradeoff**: extra token fetch on every ad break (~400ms first time per session, much less after `BackupEncodingsM3U8Cache` warms up).

```js
// Faster post-ad transition
localStorage.setItem('twitchAdSolutions_reloadPlayerAfterAd', 'false');

// Change player type
localStorage.setItem('twitchAdSolutions_playerType', 'embed');

// Hide ad blocking banner
localStorage.setItem('twitchAdSolutions_hideAdOverlay', 'true');

// Restore defaults
localStorage.removeItem('twitchAdSolutions_reloadPlayerAfterAd');
localStorage.removeItem('twitchAdSolutions_playerType');
localStorage.removeItem('twitchAdSolutions_hideAdOverlay');
localStorage.removeItem('twitchAdSolutions_pinBackupPlayerType');
localStorage.removeItem('twitchAdSolutions_reloadCooldownSeconds');
localStorage.removeItem('twitchAdSolutions_disableReloadCap');
localStorage.removeItem('twitchAdSolutions_preferLowQualityBackup');
localStorage.removeItem('twitchAdSolutions_backupSwapFirst');
```

## Known Extension Conflicts

- **7TV** — may cause black screen / infinite buffering ([#17](https://github.com/ryanbr/TwitchAdSolutions/issues/17))
- **TwitchNoSub** — handled automatically via workerStringReinsert, but older versions may conflict
- **TTV-AB** — running both simultaneously may cause duplicate ad blocking and errors. Use one or the other.
- **Purple AdBlock** — may conflict if both are active. Disable one.
- **AdGuard Extra** — operates at a different layer, can be used alongside without conflict

## Troubleshooting

See [DEBUG.md](DEBUG.md) for how to read the `[AD DEBUG]` console output.

## License

MIT. See [LICENSE](LICENSE). vaft credits: https://github.com/cleanlock/VideoAdBlockForTwitch#credits
