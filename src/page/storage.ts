import { playerBufferState, runtime, state } from './state.ts';
import { maskAsNative } from './mask.ts';

// Set up visibility overrides and localStorage hooks to preserve player state across reloads
export function onContentLoaded() {
    if (document.getElementById('seventv-extension')) {
        console.log(
            '[AD DEBUG] Warning: 7TV extension detected — may cause black screen or buffering issues. If you experience problems, try disabling 7TV.',
        );
    }
    // Resume the player on tab focus if Twitch paused it during an ad on a hidden tab.
    // Previously also spoofed document.hidden / visibilityState / hasFocus and swallowed
    // the events on the capture phase. That broke other extensions that key off real
    // visibility (e.g. BetterTTV "Mute Invisible Player"). Resume-on-focus alone is
    // enough to keep playback alive across hidden→visible transitions during ads.
    // Sync'd with TTV-AB v6.5.0.
    let wasVideoPlaying = true;
    const visibilityChange = () => {
        const videos = document.getElementsByTagName('video');
        if (videos.length === 0) return;
        if (document.hidden) {
            wasVideoPlaying = !videos[0].paused && !videos[0].ended;
            return;
        }
        if (!playerBufferState.hasStreamStarted) {
            playerBufferState.hasStreamStarted = true;
        }
        if (wasVideoPlaying && !videos[0].ended && videos[0].paused) {
            videos[0].play()?.catch?.(() => {});
        }
    };
    document.addEventListener('visibilitychange', visibilityChange);
    // Hooks for preserving volume / resolution
    try {
        const keysToCache = [
            'video-quality',
            'video-muted',
            'volume',
            'lowLatencyModeEnabled', // Low Latency
            'persistenceEnabled', // Mini Player
        ];
        const cachedValues = new Map();
        for (let i = 0; i < keysToCache.length; i++) {
            cachedValues.set(keysToCache[i], localStorage.getItem(keysToCache[i]));
        }
        const realSetItem = localStorage.setItem;
        localStorage.setItem = maskAsNative(function (this: Storage, key, value) {
            if (cachedValues.has(key)) {
                cachedValues.set(key, value);
            }
            // biome-ignore lint/suspicious/noExplicitAny: forwards the caller's arguments untouched (the real setItem/getItem has overloads)
            realSetItem.apply(this, arguments as any);
        }, 'setItem');
        const realGetItem = localStorage.getItem;
        localStorage.getItem = maskAsNative(function (this: Storage, key) {
            if (cachedValues.has(key)) {
                return cachedValues.get(key);
            }
            // biome-ignore lint/suspicious/noExplicitAny: forwards the caller's arguments untouched (the real setItem/getItem has overloads)
            return realGetItem.apply(this, arguments as any);
        }, 'getItem');
        if (localStorage.getItem === realGetItem) {
            // These hooks are useful to preserve player state on player reload
            // Firefox doesn't allow hooking of localStorage functions but chrome does
            runtime.localStorageHookFailed = true;
        }
    } catch (err) {
        console.log('localStorageHooks failed ' + err);
        runtime.localStorageHookFailed = true;
    }
}
// Apply the twitchAdSolutions_* localStorage overrides (documented in README.md / CLAUDE.md).
export function loadLocalStorageConfig() {
    try {
        const lsReloadAfterAd = localStorage.getItem('twitchAdSolutions_reloadPlayerAfterAd');
        if (lsReloadAfterAd !== null) {
            state.ReloadPlayerAfterAd = lsReloadAfterAd === 'true';
        }
        const lsReloadCooldown = parseInt(localStorage.getItem('twitchAdSolutions_reloadCooldownSeconds') ?? '', 10);
        if (!Number.isNaN(lsReloadCooldown) && lsReloadCooldown >= 0) {
            state.ReloadCooldownSeconds = lsReloadCooldown;
        }
        const lsDisableReloadCap = localStorage.getItem('twitchAdSolutions_disableReloadCap');
        if (lsDisableReloadCap !== null) {
            state.DisableReloadCap = lsDisableReloadCap === 'true';
        }
        const lsDriftRate = parseFloat(localStorage.getItem('twitchAdSolutions_driftCorrectionRate') ?? '');
        if (!Number.isNaN(lsDriftRate) && lsDriftRate >= 0) {
            state.DriftCorrectionRate = lsDriftRate;
        }
        const lsEarlyReload = parseInt(localStorage.getItem('twitchAdSolutions_earlyReloadPollThreshold') ?? '', 10);
        if (!Number.isNaN(lsEarlyReload) && lsEarlyReload >= 0) {
            state.EarlyReloadPollThreshold = lsEarlyReload;
        }
        const lsPlayerType = localStorage.getItem('twitchAdSolutions_playerType');
        if (lsPlayerType !== null) {
            state.ForceAccessTokenPlayerType = lsPlayerType;
        }
        const lsPinBackup = localStorage.getItem('twitchAdSolutions_pinBackupPlayerType');
        if (lsPinBackup !== null) {
            state.PinBackupPlayerType = lsPinBackup === 'true';
        }
        const lsPreferLow = localStorage.getItem('twitchAdSolutions_preferLowQualityBackup');
        if (lsPreferLow === 'false') {
            state.PreferLowQualityBackup = false;
            console.log(
                '[AD DEBUG] PreferLowQualityBackup disabled via localStorage — sticky CSAI path only, no autoplay fallback or escape hatch',
            );
        }
        const lsFastAutoplay = localStorage.getItem('twitchAdSolutions_fastAutoplayFirstTry');
        if (lsFastAutoplay === 'false') {
            state.FastAutoplayFirstTry = false;
            console.log(
                '[AD DEBUG] FastAutoplayFirstTry disabled via localStorage — full Source-tier probe on every break (no autoplay fast-path)',
            );
        }
        const lsBackupSwapFirst = localStorage.getItem('twitchAdSolutions_backupSwapFirst');
        if (lsBackupSwapFirst === 'false') {
            state.BackupSwapFirst = false;
            console.log(
                '[AD DEBUG] BackupSwapFirst disabled via localStorage — using sticky CSAI path (strip on native stream)',
            );
        }
        const lsDisableAdSpoofing = localStorage.getItem('twitchAdSolutions_disableAdSpoofing');
        if (lsDisableAdSpoofing === 'false') {
            state.DisableAdSpoofing = false;
            console.log(
                '[AD DEBUG] AdSpoofing enabled via localStorage opt-in — firing GQL ad-tracking beacons on ad detect',
            );
        }
        const lsRecoverFromSilentMute = localStorage.getItem('twitchAdSolutions_recoverFromSilentMute');
        if (lsRecoverFromSilentMute === 'false') {
            state.RecoverFromSilentMute = false;
            console.log(
                '[AD DEBUG] RecoverFromSilentMute disabled via localStorage — hard-reload backstop respects already-muted state, mid-session manual mutes preserved across reloads',
            );
        }
        const lsSoftReloadNoStrip = localStorage.getItem('twitchAdSolutions_softReloadNoStrip');
        if (lsSoftReloadNoStrip === 'false') {
            state.SoftReloadNoStrip = false;
            console.log(
                '[AD DEBUG] SoftReloadNoStrip disabled via localStorage — post-ad reload always hard, even on no-strip CSAI breaks (issue #129)',
            );
        }
        const lsDisablePostBreakWedge = localStorage.getItem('twitchAdSolutions_disablePostBreakWedge');
        if (lsDisablePostBreakWedge === 'true') {
            state.DisablePostBreakWedge = true;
            console.log(
                '[AD DEBUG] Post-break video-wedge recovery DISABLED via localStorage — audio-alive/video-frozen after a break will not be auto-recovered',
            );
        }
        const lsHideAdOverlay = localStorage.getItem('twitchAdSolutions_hideAdOverlay');
        if (lsHideAdOverlay === 'true') {
            const style = document.createElement('style');
            style.textContent = '.tas-adblock-overlay { display: none !important; }';
            (document.head || document.documentElement).appendChild(style);
        }
    } catch {}
}
