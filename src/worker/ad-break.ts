// Ad-break lifecycle:
//
//     idle ──ad-marked poll──▶ in break ──ad-free poll──▶ ending (End candidate)
//                               ▲                           │ ├─ 3 ad-free polls in a row ───┐
//                               └── ad-marked poll ─────────┘ ├─ ad-free poll, no live segs ──┼─▶ idle
//                                  (candidate kept if <12s)   └─ 12s since candidate ─────────┘
//
// StreamInfo.Break is the break in progress (null when idle). Everything that lives for one
// break is in it, so ending a break is just dropping it.
import type { AdBreak, StreamInfo } from '../shared/types.ts';

/** Ad-free polls in a row that end a break. */
const AD_END_CLEAN_POLLS = 3;
/** An end candidate this old ends the break on the next ad-free poll, however much it bounced. */
const AD_END_MAX_WAIT_MS = 12000;

export function createAdBreak(textStr: string): AdBreak {
    const podLengthMatch = textStr.match(/X-TV-TWITCH-AD-POD-LENGTH="(\d+)"/);
    return {
        StartedAt: Date.now(),
        IsMidroll: false,
        PodLength: podLengthMatch ? parseInt(podLengthMatch[1], 10) : 1,
        // High-confidence markers: tell real ads from false-positive signifier matches.
        HasConfirmedAdAttrs:
            textStr.includes('X-TV-TWITCH-AD-AD-SESSION-ID') || textStr.includes('X-TV-TWITCH-AD-RADS-TOKEN'),
        End: null,
        Path: 'probing',
        IsStripping: false,
        StrippedSegments: 0,
        RecoverySegments: [],
        RecoveryStartSeq: undefined,
        FreezeStartedAt: 0,
        ConsecutiveAllStrippedPolls: 0,
        TotalAllStrippedPolls: 0,
        ActiveBackupPlayerType: null,
        LastCommittedBackupPlayerType: null,
        FailedBackupPlayerTypes: new Map(),
        ContaminatedTypes: new Set(),
        CycleRescued: false,
        AutoplayFirst: null,
        EarlyReload: { phase: 'armed' },
        EarlyReloadCount: 0,
        EarlyReloadAtPoll: 0,
        CodecSwapTried: false,
        RequestedAds: new Set(),
        SpoofedAdIds: new Set(),
        LoggedAdAttributes: false,
        LoggedUnknownSignifiers: false,
        LoggedContamReorder: false,
        LoggedAutoplayOrder: false,
    };
}

/** An ad-marked poll during a break. Keeps a young end candidate alive (Twitch bounces markers). */
export function onAdPoll(brk: AdBreak): void {
    if (brk.End && Date.now() - brk.End.since < AD_END_MAX_WAIT_MS) {
        brk.End.bounces++;
        brk.End.cleanPolls = 0;
    } else {
        brk.End = null;
    }
}

/** Why a break ended, or null while it goes on. */
type BreakEndReason = 'clean-polls' | 'no-live-segments' | 'max-wait';

/**
 * An ad-free poll during a break. Returns why the break ends on this poll, or null.
 *
 * Three ad-free polls in a row: Twitch can serve a clean playlist mid-break before re-injecting
 * markers, and two (~4s) weren't always enough to ride that out (TTV-AB v6.6.7). The max-wait
 * escalation ends the break even when bouncing markers keep the count from reaching three.
 */
export function onAdFreePoll(brk: AdBreak, hasLiveSegments: boolean): BreakEndReason | null {
    if (!brk.End) {
        brk.End = { since: Date.now(), cleanPolls: 0, bounces: 0 };
    }
    brk.End.cleanPolls++;
    if (brk.End.cleanPolls >= AD_END_CLEAN_POLLS) return 'clean-polls';
    // The playlist (a backup's, usually) has no live segments: it is dead, leave it now.
    if (!hasLiveSegments) return 'no-live-segments';
    if (Date.now() - brk.End.since >= AD_END_MAX_WAIT_MS) return 'max-wait';
    return null;
}

/** What to do with the player when a break ends. */
type BreakEndAction =
    | { action: 'reload'; kind: 'early' | 'post-ad'; reason: string }
    | { action: 'pause-play' }
    | { action: 'none' };

/**
 * The end-of-break player action. Only reads state; the caller applies it.
 *
 * - Nothing stripped (CSAI-only, or the backup swap kept the player clean): no MediaSource
 *   flush needed. Reload only to leave a committed backup or the codec swap: autoplay (360p)
 *   needs a hard reload ('early', the only kind that refreshes the access token to restore
 *   Source); anything else reloads soft when SoftReloadNoStrip is on (issue #129 mode D).
 * - Something stripped: hard reload, because BLANK_MP4 / recovery segments went into the
 *   MediaSource and a soft reload keeps that buffer (A/V desync). Skipped when a cycle rescue
 *   ended a short freeze cleanly (the player is on a healthy backup), and when
 *   ReloadPlayerAfterAd is off; both fall back to pause/play. The codec swap always reloads.
 */
export function decideBreakEndAction(
    streamInfo: StreamInfo,
    brk: AdBreak,
    settings: { SoftReloadNoStrip: boolean; ReloadPlayerAfterAd: boolean },
): BreakEndAction {
    const codecSwapped = streamInfo.CodecSwap !== 'native';
    if (brk.StrippedSegments === 0) {
        const committed = brk.LastCommittedBackupPlayerType;
        if (committed === 'autoplay') {
            return { action: 'reload', kind: 'early', reason: 'autoplay (360p) — restoring Source quality' };
        }
        if (committed || codecSwapped) {
            const what = committed || 'codec swap';
            return settings.SoftReloadNoStrip
                ? {
                      action: 'reload',
                      kind: 'post-ad',
                      reason: what + ' — soft, nothing was stripped (SoftReloadNoStrip)',
                  }
                : {
                      action: 'reload',
                      kind: 'early',
                      reason: what + ' — flushing MediaSource to prevent A/V desync accumulation',
                  };
        }
        return { action: 'none' };
    }
    if (codecSwapped) {
        return { action: 'reload', kind: 'early', reason: 'leaving the codec swap' };
    }
    if (settings.ReloadPlayerAfterAd && !cycleRescuedCleanly(brk)) {
        return { action: 'reload', kind: 'early', reason: 'segments were stripped — flushing MediaSource' };
    }
    return { action: 'pause-play' };
}

/**
 * A freeze of at most 2 polls (~4s) was ended by switching to a different clean backup, with no
 * early reload: the player is on a healthy backup, and reloading only costs a loading circle.
 */
function cycleRescuedCleanly(brk: AdBreak): boolean {
    return brk.CycleRescued && brk.TotalAllStrippedPolls <= 2 && brk.EarlyReloadCount === 0;
}
