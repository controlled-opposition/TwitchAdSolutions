import type { AdBreak, StreamInfo } from '../shared/types.ts';

const AD_END_CLEAN_POLLS = 3;
const AD_END_MAX_WAIT_MS = 12000;

export function createAdBreak(textStr: string): AdBreak {
    const podLengthMatch = textStr.match(/X-TV-TWITCH-AD-POD-LENGTH="(\d+)"/);
    return {
        StartedAt: Date.now(),
        IsMidroll: false,
        PodLength: podLengthMatch ? parseInt(podLengthMatch[1], 10) : 1,
        // Twitch sets these only on real ads, unlike some AdSignifiers matches.
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

export function onAdPoll(brk: AdBreak): void {
    if (brk.End && Date.now() - brk.End.since < AD_END_MAX_WAIT_MS) {
        brk.End.bounces++;
        brk.End.cleanPolls = 0;
    } else {
        brk.End = null;
    }
}

type BreakEndReason = 'clean-polls' | 'no-live-segments' | 'max-wait';

/**
 * Twitch can serve a clean playlist mid-break before re-injecting markers; two clean polls (~4s)
 * weren't always enough to ride that out (TTV-AB v6.6.7).
 */
export function onAdFreePoll(brk: AdBreak, hasLiveSegments: boolean): BreakEndReason | null {
    if (!brk.End) {
        brk.End = { since: Date.now(), cleanPolls: 0, bounces: 0 };
    }
    brk.End.cleanPolls++;
    if (brk.End.cleanPolls >= AD_END_CLEAN_POLLS) return 'clean-polls';
    if (!hasLiveSegments) return 'no-live-segments';
    if (Date.now() - brk.End.since >= AD_END_MAX_WAIT_MS) return 'max-wait';
    return null;
}

type BreakEndAction =
    | { action: 'reload'; kind: 'early' | 'post-ad'; reason: string }
    | { action: 'pause-play' }
    | { action: 'none' };

/**
 * Leaving autoplay (360p) needs an access-token refresh, which only an 'early' reload does. A soft
 * reload keeps the MediaSource buffer, so once BLANK_MP4/recovery segments went in only a hard
 * reload avoids A/V desync.
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

function cycleRescuedCleanly(brk: AdBreak): boolean {
    return brk.CycleRescued && brk.TotalAllStrippedPolls <= 2 && brk.EarlyReloadCount === 0;
}
