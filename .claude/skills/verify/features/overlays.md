# Overlays and display ads

During a break vaft shows a small `Blocking ads (<type>)` banner in the player's top-left corner unless the
user hid it, and on every buffer-monitor tick it hides Twitch's stream display ads (`[data-test-selector="sda-wrapper"]`)
and standalone Amazon `<video>` ads beside the player.

## Sub-features

- `overlay-banner` `.tas-adblock-overlay` is visible during a break, with the backup type in its text, and hidden after.
- `overlay-hide-banner` with `hideAdOverlay=true` the banner never becomes visible.
- `overlay-sda` SDA wrappers get inline `display: none !important`; first hide logs `Hidden Twitch stream display ad`.
- `overlay-amazon-video` a `<video>` playing from `*.media-amazon.com` is hidden, muted and paused (`Hidden separate Twitch video ad`).

## How to get to it (user POV)

- Watch a channel through an ad break (real or `simulateAds(1)`).
- `localStorage.setItem('twitchAdSolutions_hideAdOverlay', 'true')` and reload.

## Driving it with vaftctl

Preconditions:

- Baseline preconditions from the README.

- **Banner shows and clears.** Use the simulated-break run from ad-break.md. `summary.bannerVisibleSecs` covers
  the break and stops at the reload second; `bannerTexts` names the backup type; `shot-020s.png` shows
  `Blocking ads (site)` top-left on the player.
- **Banner hidden.** Run `$V drive --channel <login> --seconds 40 --name hide-overlay --ls hideAdOverlay=true --at "4:[...document.querySelectorAll('style')].some(s=>s.textContent.includes('.tas-adblock-overlay'))" --at "8:simulateAds(1)" --at "22:simulateAds(0)" --shots 15,38`.
  The `[action]` at 4 s is `true`; `bannerVisibleSecs` is empty while `milestones` shows a break.
- **SDA hidden.** In any injected run, `milestones` has `Hidden Twitch stream display ad` and every
  `samples.jsonl` line's `sdaHidden` array holds only `"none"`.

## Gotchas

- The banner's inline `display` is `block` during a break even when hidden by the setting; the setting works through
  a stylesheet. vaftctl's `visible` field reads computed style for this reason.
- The hide stylesheet is appended to `document.head || document.documentElement` at document-start. An injector
  that runs before `<html>` exists drops it silently (seen with `Page.addScriptToEvaluateOnNewDocument`); check
  `summary.docStart.documentElement` is `true`.
- Amazon `<video>` ads (#249) were not observed in any run while writing this map; `overlay-amazon-video` is
  unproven here. Report it as skipped unless a run's log shows the hide line.
