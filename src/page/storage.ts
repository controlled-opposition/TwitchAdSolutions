import { installHook } from '../shared/hook.ts';
import { maskAsNative } from './mask.ts';
import { playerBufferState, runtime, state } from './state.ts';
import { getPlayerVideoElement } from './twitch.ts';

/**
 * Twitch's player settings in localStorage that survive a player reload: cached by the
 * localStorage hooks below, and written back after doTwitchPlayerTask's reload. A saved empty
 * string is written back only when `restoreEmpty` is set.
 */
export const PRESERVED_PLAYER_SETTINGS: readonly { key: string; restoreEmpty: boolean }[] = [
    { key: 'video-quality', restoreEmpty: false },
    { key: 'video-muted', restoreEmpty: false },
    { key: 'volume', restoreEmpty: false },
    { key: 'lowLatencyModeEnabled', restoreEmpty: true }, // Low Latency
    { key: 'persistenceEnabled', restoreEmpty: true }, // Mini Player
];
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
        // The player's own element, not a separate Twitch ad <video> (#249).
        const video = getPlayerVideoElement();
        if (!video) return;
        if (document.hidden) {
            wasVideoPlaying = !video.paused && !video.ended;
            return;
        }
        if (!playerBufferState.hasStreamStarted) {
            playerBufferState.hasStreamStarted = true;
        }
        if (wasVideoPlaying && !video.ended && video.paused) {
            video.play()?.catch?.(() => {});
        }
    };
    document.addEventListener('visibilitychange', visibilityChange);
    // Hooks for preserving volume / resolution
    try {
        const cachedValues = new Map();
        for (const { key } of PRESERVED_PLAYER_SETTINGS) {
            cachedValues.set(key, localStorage.getItem(key));
        }
        const realSetItem = localStorage.setItem;
        const setItemHook = maskAsNative(function (this: Storage, key: string, value: string) {
            if (cachedValues.has(key)) {
                cachedValues.set(key, value);
            }
            // biome-ignore lint/suspicious/noExplicitAny: forwards the caller's arguments untouched (the real setItem/getItem has overloads)
            realSetItem.apply(this, arguments as any);
        }, 'setItem');
        const realGetItem = localStorage.getItem;
        const getItemHook = maskAsNative(function (this: Storage, key: string) {
            if (cachedValues.has(key)) {
                return cachedValues.get(key);
            }
            // biome-ignore lint/suspicious/noExplicitAny: forwards the caller's arguments untouched (the real setItem/getItem has overloads)
            return realGetItem.apply(this, arguments as any);
        }, 'getItem');
        // These hooks preserve player state across player reloads. Firefox doesn't allow hooking
        // localStorage functions (the assignment stores an item instead); Chrome does. getItem is
        // only hooked once setItem is: a getItem hook alone would serve cached values that never
        // see Twitch's writes. When either is missing, reloads write the keys directly.
        const hooked =
            installHook(localStorage, 'setItem', setItemHook, 'localStorage.setItem') &&
            installHook(localStorage, 'getItem', getItemHook, 'localStorage.getItem');
        if (!hooked) {
            runtime.localStorageHookFailed = true;
        }
    } catch (err) {
        console.log('localStorageHooks failed ' + err);
        runtime.localStorageHookFailed = true;
    }
}
type PageState = typeof state;
type BooleanSetting = { [K in keyof PageState]: PageState[K] extends boolean ? K : never }[keyof PageState];
// twitchAdSolutions_<key> settings that only take effect when set to `when`, which also gives the
// new value ('true' → true, 'false' → false). Each logs when it applies.
const flagOverrides: { key: string; when: 'true' | 'false'; field: BooleanSetting; message: string }[] = [
    {
        key: 'preferLowQualityBackup',
        when: 'false',
        field: 'PreferLowQualityBackup',
        message:
            'PreferLowQualityBackup disabled via localStorage — sticky CSAI path only, no autoplay fallback or escape hatch',
    },
    {
        key: 'fastAutoplayFirstTry',
        when: 'false',
        field: 'FastAutoplayFirstTry',
        message:
            'FastAutoplayFirstTry disabled via localStorage — full Source-tier probe on every break (no autoplay fast-path)',
    },
    {
        key: 'backupSwapFirst',
        when: 'false',
        field: 'BackupSwapFirst',
        message: 'BackupSwapFirst disabled via localStorage — using sticky CSAI path (strip on native stream)',
    },
    {
        key: 'disableAdSpoofing',
        when: 'false',
        field: 'DisableAdSpoofing',
        message: 'AdSpoofing enabled via localStorage opt-in — firing GQL ad-tracking beacons on ad detect',
    },
    {
        key: 'recoverFromSilentMute',
        when: 'false',
        field: 'RecoverFromSilentMute',
        message:
            'RecoverFromSilentMute disabled via localStorage — hard-reload backstop respects already-muted state, mid-session manual mutes preserved across reloads',
    },
    {
        key: 'softReloadNoStrip',
        when: 'false',
        field: 'SoftReloadNoStrip',
        message:
            'SoftReloadNoStrip disabled via localStorage — post-ad reload always hard, even on no-strip CSAI breaks (issue #129)',
    },
    {
        key: 'disablePostBreakWedge',
        when: 'true',
        field: 'DisablePostBreakWedge',
        message:
            'Post-break video-wedge recovery DISABLED via localStorage — audio-alive/video-frozen after a break will not be auto-recovered',
    },
];
function readSetting(key: string): string | null {
    return localStorage.getItem('twitchAdSolutions_' + key);
}
/** 'true'/'false' setting: null when unset, otherwise whether it is exactly 'true'. */
function readBoolSetting(key: string): boolean | null {
    const value = readSetting(key);
    return value === null ? null : value === 'true';
}
/** Numeric setting: null unless it parses to a number >= 0. */
function readNonNegativeSetting(key: string, parse: (value: string) => number): number | null {
    const value = parse(readSetting(key) ?? '');
    return !Number.isNaN(value) && value >= 0 ? value : null;
}
// Apply the twitchAdSolutions_* localStorage overrides (documented in README.md / CLAUDE.md).
export function loadLocalStorageConfig() {
    try {
        state.ReloadPlayerAfterAd = readBoolSetting('reloadPlayerAfterAd') ?? state.ReloadPlayerAfterAd;
        state.DisableReloadCap = readBoolSetting('disableReloadCap') ?? state.DisableReloadCap;
        state.DriftCorrectionRate =
            readNonNegativeSetting('driftCorrectionRate', parseFloat) ?? state.DriftCorrectionRate;
        state.EarlyReloadPollThreshold =
            readNonNegativeSetting('earlyReloadPollThreshold', (v) => parseInt(v, 10)) ??
            state.EarlyReloadPollThreshold;
        state.ForceAccessTokenPlayerType = readSetting('playerType') ?? state.ForceAccessTokenPlayerType;
        state.PinBackupPlayerType = readBoolSetting('pinBackupPlayerType') ?? state.PinBackupPlayerType;
        for (const { key, when, field, message } of flagOverrides) {
            if (readSetting(key) === when) {
                state[field] = when === 'true';
                console.log('[AD DEBUG] ' + message);
            }
        }
        if (readSetting('hideAdOverlay') === 'true') {
            const style = document.createElement('style');
            style.textContent = '.tas-adblock-overlay { display: none !important; }';
            (document.head || document.documentElement).appendChild(style);
        }
    } catch {}
}
