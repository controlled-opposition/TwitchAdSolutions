import type { SharedConfig } from './types.ts';

/**
 * Defaults for the settings both sides use. The page overrides some from localStorage at
 * startup and passes the result to each worker it injects (WorkerInit.config).
 */
export function defaultSharedConfig(): SharedConfig {
    return {
        ReloadPlayerAfterAd: true, // After the ad finishes do a player reload instead of pause/play
        EarlyReloadPollThreshold: 3, // Number of consecutive all-stripped polls before triggering early reload (each poll ~2s, so 3 = ~6s, 5 = ~10s, 10 = ~20s; 0 = disable). Lowered from 5 to 3 to match the testing variant — field reports indicate faster early-reload recovers heavier SSAI breaks more cleanly. Override via localStorage twitchAdSolutions_earlyReloadPollThreshold.
        PinBackupPlayerType: true, // Remember which backup player type worked and try it first on next ad break
        PreferLowQualityBackup: true, // Hybrid safety net for SSAI-heavy breaks: sticky escape hatch (fires after ~8s stuck in all-stripped state) + autoplay (360p) as last-resort backup when all Source types are ad-laden. Default on; set twitchAdSolutions_preferLowQualityBackup=false to disable.
        FastAutoplayFirstTry: true, // When the prior break committed autoplay-via-escape-hatch, prepend autoplay (360p) to position 0 of playerTypesToTry on the next break — autoplay wins on first probe (~340ms) instead of cycling through 4 Source types (~1.5-2s). Auto-resets when a Source-tier type wins (channel recovered), so quality returns to full automatically if Twitch ever brings back non-ad-laden Source backups. Default on as of v67.1.0 — field data (project_all_channels_csai_only_marked) confirms every observed channel exhausts Source-tier on every break. Opt-out via localStorage twitchAdSolutions_fastAutoplayFirstTry=false.
        BackupSwapFirst: true, // On ad detect, immediately swap to a backup player-type m3u8 (TTV-AB-style). Avoids MediaSource mixing from strip activity — fewer loading circles in field. Cost: extra fetches on every ad break. Default on; set twitchAdSolutions_backupSwapFirst=false to disable.
        DisableAdSpoofing: true, // Default OFF (was ON through v68.2.0). The always-100%-watched + audible + visible spoof beacon pattern may itself fingerprint as anomalous and trigger detection escalation (CSAI reaching the committed backup) — observed correlation in field + TTV-AB maintainer hypothesis. Spoof-accepted (no GQL rejection) does NOT prove not-fingerprinted; Twitch can 200-OK while using the beacon pattern as silent detection input. Opt in by setting twitchAdSolutions_disableAdSpoofing=false to re-enable the GQL ad-tracking beacons (video_ad_impression, video_ad_quartile_complete x 4, video_ad_pod_complete).
        SoftReloadNoStrip: true, // Issue #129 (mode D): post-ad reload uses SOFT reload when the break stripped no segments (BackupSwapFirst CSAI swap). Hard reload's MediaSource flush is only needed after strip injection (BLANK_MP4/recovery) — on a no-strip break it just pays the desktop black-screen + play-icon teardown for nothing. Default on; set twitchAdSolutions_softReloadNoStrip=false to force the old always-hard behavior.
        ForceAccessTokenPlayerType: 'popout',
        GQLDeviceID: null,
        AuthorizationHeader: undefined,
        ClientIntegrityHeader: null,
        ClientVersion: null,
        ClientSession: null,
    };
}

/** The SharedConfig fields of a page/worker state object, as a plain copy. */
export function pickSharedConfig(source: SharedConfig): SharedConfig {
    const config = defaultSharedConfig();
    for (const key of Object.keys(config) as (keyof SharedConfig)[]) {
        (config as Record<keyof SharedConfig, unknown>)[key] = source[key];
    }
    return config;
}
