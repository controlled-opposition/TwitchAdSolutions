import type { StreamInfo } from '../shared/types.ts';
import { state } from './state.ts';

export function pruneStreamInfos() {
    const now = Date.now();
    for (const channelName in state.StreamInfos) {
        const streamInfo = state.StreamInfos[channelName];
        if (!streamInfo || !streamInfo.LastSeenAt || now - streamInfo.LastSeenAt > state.StreamInfoMaxAgeMs) {
            if (streamInfo && streamInfo.Urls) {
                for (const url in streamInfo.Urls) {
                    delete state.StreamInfosByUrl[url];
                }
            }
            delete state.StreamInfos[channelName];
        }
    }
}
// Creates a new StreamInfo with the full field shape declared up-front.
// When adding a new streamInfo field, declare it here with an appropriate
// zero value so the complete shape is visible in one place.
export function createStreamInfo(channelName: string, encodingsM3u8: string, usherParams: string): StreamInfo {
    return {
        // Identity / lifecycle
        ChannelName: channelName,
        LastSeenAt: Date.now(),
        EncodingsM3U8: encodingsM3u8,
        UsherParams: usherParams,
        // Resolutions / URL map
        Urls: Object.create(null), // xxx.m3u8 -> { Resolution: "284x160", FrameRate: 30.0 }
        ResolutionList: [],
        RequestedAds: new Set(),
        SpoofedAdIds: new Set(), // notifyAdComplete: stitched-ad IDs already spoofed this break (multi-poll dedup). Cleared at break end.
        // Modified m3u8 state
        ModifiedM3U8: null,
        IsUsingModifiedM3U8: false,
        // Ad-break state
        IsShowingAd: false,
        IsMidroll: false,
        AdBreakStartedAt: 0,
        PodLength: 1,
        HasConfirmedAdAttrs: false,
        CleanPlaylistCount: 0,
        PendingAdEndAt: 0, // Timestamp of first clean poll seen this break — drives the bounce-tolerant max-wait escalation gate (TTV-AB v6.6.7 #1/#4)
        AdEndBounceCount: 0, // Count of ad-marker bounces while PendingAdEndAt is alive — telemetry only
        ConsecutiveZeroStripBreaks: 0,
        CsaiOnlyThisBreak: false,
        // Strip state
        IsStrippingAdSegments: false,
        NumStrippedAdSegments: 0,
        RecoverySegments: [],
        RecoveryStartSeq: undefined, // LOAD-BEARING: explicitly checked with `!== undefined`
        FreezeStartedAt: 0,
        ConsecutiveAllStrippedPolls: 0,
        TotalAllStrippedPolls: 0,
        LastAdCachePruneAt: 0, // stripAdSegments: last AdSegmentCache prune (throttled to once per 60s)
        // Clean playlist snapshot for all-stripped recovery (mirrors TTV-AB)
        LastCleanNativeM3U8: null,
        LastCleanNativePlaylistAt: 0,
        // Backup player type cycling
        BackupEncodingsM3U8Cache: Object.create(null), // player type -> encodings m3u8 (null once used)
        ActiveBackupPlayerType: null,
        PinnedBackupPlayerType: null,
        LastCommittedBackupPlayerType: null,
        FailedBackupPlayerTypes: new Map(), // Map<playerType, timestamp> — failures expire after 15s for retry
        LoggedBackupAdsByType: null, // lazy-init to Set on first "backup has ads" log
        CycleRescuedThisBreak: false,
        // Early reload
        EarlyReloadCount: 0,
        EarlyReloadAtPoll: 0,
        EarlyReloadTriggered: false,
        EarlyReloadAwaitingResult: false,
        // Hybrid-mode state (PreferLowQualityBackup)
        EscapeHatchFired: false,
        LastBreakUsedEscapeHatch: false, // FastAutoplayFirstTry: set when a break commits autoplay via PreferLowQualityBackup escape hatch (= all 4 Source types contaminated this break). Read at next break's backup-search entry to prepend autoplay first. Reset when a Source-tier type wins (channel recovered).
        FastAutoplayConsecutive: 0, // Count of consecutive breaks won by fast-autoplay without testing Source-tier. Triggers periodic re-probe to detect channel recovery (Twitch reversing CSAI delivery). Reset when full Source-tier probe runs or Source-tier wins.
        // Reload cooldown
        LastPlayerReload: 0,
        ReloadTimestamps: [],
        // Diagnostic flags (once-per-session)
        HasCheckedUnknownTags: false,
        HasLoggedAdAttributes: false,
        HasLoggedUnknownSignifiers: false,
        LoggedOfflineTransition: false, // Detection diagnostic: set when m3u8 transitions to offline-shape mid-session.
        ConsecutiveTokenFetchFailures: 0, // Detection diagnostic: counter for consecutive failed access-token fetches across player types. Logged at threshold, reset on success.
        LoggedTokenFailureStreak: false, // Once-per-streak guard for the threshold log.
        LoggedAdCacheSize1k: false,
        LoggedContamReorderThisBreak: false,
        LoggedFastAutoplayThisBreak: false,
        LoggedFastAutoplayReprobeThisBreak: false,
    };
}
