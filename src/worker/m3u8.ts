import type { AdBreak, PlayerType, ResolutionInfo, StreamInfo } from '../shared/types.ts';
import { getMatchedAdSignifiers, hasAdTags, stripAdSegments } from './ads.ts';
import { createAdBreak, decideBreakEndAction, onAdFreePoll, onAdPoll } from './ad-break.ts';
import { stepEarlyReload } from './early-reload.ts';
import { notifyAdComplete } from './spoof.ts';
import { getStreamVariantForResolution, isCodecMismatch, isEnhancedCodec } from './playlist.ts';
import { getAccessToken } from './gql.ts';
import { requestReload } from './reload.ts';
import { state } from './state.ts';
import { postToPage } from './post.ts';

const POST_AD_REENTRY_GUARD_MS = 8000;
const STICKY_ESCAPE_POLLS = 4;
const FAST_AUTOPLAY_REPROBE_INTERVAL = 5;

export async function processM3U8(url: string, textStr: string, realFetch: typeof fetch): Promise<string> {
    const streamInfo = state.StreamInfosByUrl[url];
    if (!streamInfo) {
        return textStr;
    }
    streamInfo.LastSeenAt = Date.now();
    if (streamInfo.ReloadPending) {
        streamInfo.ReloadPending = false;
        streamInfo.LastPlayerReload = Date.now();
    }
    // Twitch may answer suspected ad blocking by ending the stream: EXT-X-ENDLIST with no segments.
    if (!streamInfo.LoggedOfflineTransition && textStr.includes('#EXT-X-ENDLIST') && !textStr.includes('#EXTINF:')) {
        streamInfo.LoggedOfflineTransition = true;
        console.log(
            '[AD DEBUG] Stream ended / offline shape detected — m3u8 has #EXT-X-ENDLIST with no segments. Possible Twitch detection response, broadcaster ended stream, or natural end-of-broadcast',
        );
    }
    if (!streamInfo.HasCheckedUnknownTags) {
        streamInfo.HasCheckedUnknownTags = true;
        const unknownAdTags = textStr.match(/#EXT[^:\n]*(?:ad|cue|scte|sponsor)[^:\n]*/gi);
        if (unknownAdTags) {
            const unknown = unknownAdTags.filter((t) => !state.AdSignifiers.some((s) => s && t.includes(s)));
            if (unknown.length > 0) {
                console.log('[AD DEBUG] Unknown ad-related tags found: ' + [...new Set(unknown)].join(', '));
            }
        }
    }
    const haveAdTags = hasAdTags(textStr) || state.SimulatedAdsDepth > 0;
    if (haveAdTags) {
        return handleAdPoll(streamInfo, url, textStr, realFetch);
    }
    const brk = streamInfo.Break;
    if (brk) {
        handleAdFreePoll(streamInfo, brk, textStr);
    } else if (textStr.indexOf('#EXTINF') !== -1) {
        streamInfo.LastCleanNativeM3U8 = textStr;
        streamInfo.LastCleanNativePlaylistAt = Date.now();
    }
    postBanner(streamInfo);
    return textStr;
}

async function handleAdPoll(
    streamInfo: StreamInfo,
    url: string,
    textStr: string,
    realFetch: typeof fetch,
): Promise<string> {
    let brk = streamInfo.Break;
    const isMidroll = textStr.includes('"MIDROLL"') || textStr.includes('"midroll"');
    if (brk) {
        onAdPoll(brk);
        brk.IsMidroll = isMidroll;
    } else {
        brk = streamInfo.Break = createAdBreak(textStr);
        brk.IsMidroll = isMidroll;
        console.log(
            '[AD DEBUG] Ad detected — type: ' +
                (isMidroll ? 'midroll' : 'preroll') +
                ', channel: ' +
                streamInfo.ChannelName +
                ', pod: ' +
                brk.PodLength +
                ' ad(s) (~' +
                brk.PodLength * 30 +
                's expected), signifiers: ' +
                getMatchedAdSignifiers(textStr).join(', '),
        );
        postToPage({
            key: 'UpdateAdBlockBanner',
            isMidroll,
            hasAds: true,
            isStrippingAdSegments: false,
        });
    }
    if (!state.DisableAdSpoofing) {
        // Off the playlist response path: a late playlist makes the player stutter (TTV-AB v8.0.0).
        const spoofBreak = brk;
        setTimeout(() => notifyAdComplete(textStr, spoofBreak), 0);
    }
    const lines = textStr.split(/\r?\n/);
    if (!brk.IsMidroll) {
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.startsWith('#EXTINF') && lines.length > i + 1) {
                if (!line.includes(',live') && !brk.RequestedAds.has(lines[i + 1])) {
                    brk.RequestedAds.add(lines[i + 1]);
                    fetch(lines[i + 1])
                        .then((response) => response.blob())
                        .catch(() => {});
                    break;
                }
            }
        }
    }
    const currentResolution = streamInfo.Urls[url];
    if (!currentResolution) {
        console.log('Ads will leak due to missing resolution info for ' + url);
        return stripAdSegments(textStr, false, streamInfo, brk);
    }
    const isEnhanced = isEnhancedCodec(currentResolution.Codecs);
    const codecSwapStarted = isEnhanced && maybeStartCodecSwap(streamInfo, brk);
    if (
        state.PreferLowQualityBackup &&
        brk.Path === 'sticky-csai' &&
        brk.ConsecutiveAllStrippedPolls >= STICKY_ESCAPE_POLLS
    ) {
        const stuckPolls = brk.ConsecutiveAllStrippedPolls;
        const earlyReloadInfo = brk.EarlyReloadCount + '/' + Math.max(1, brk.PodLength);
        console.log(
            '[AD DEBUG] Sticky CSAI escape hatch — stuck ' +
                stuckPolls +
                ' polls (~' +
                stuckPolls * 2 +
                's), EarlyReloadCount=' +
                earlyReloadInfo +
                ', recovery cache=' +
                brk.RecoverySegments.length +
                ' segments, falling through to backup search',
        );
        brk.Path = 'escaped';
    }
    // Every player type carries the same CSAI ads, so a backup wouldn't help.
    if (brk.Path === 'sticky-csai' && streamInfo.CodecSwap === 'native') {
        textStr = stripAdSegments(textStr, false, streamInfo, brk);
        stepEarlyReload(brk, ' (sticky path)');
        postBanner(streamInfo, null);
        return textStr;
    }
    // CSAI ads arrive outside the m3u8, so an all-live playlist is clean, and switching to a backup
    // costs a 20-40s rebuffer gap.
    const hasNonLiveSegment = lines.some((line) => line.startsWith('#EXTINF') && !line.includes(',live'));
    if (brk.Path === 'probing' && !hasNonLiveSegment && streamInfo.CodecSwap === 'native' && !state.BackupSwapFirst) {
        brk.Path = 'sticky-csai';
        console.log('[AD DEBUG] CSAI fast path — all segments live, skipping backup search');
        textStr = stripAdSegments(textStr, false, streamInfo, brk);
        postBanner(streamInfo, null);
        return textStr;
    }
    const backup = await searchBackup(streamInfo, brk, currentResolution, realFetch);
    if (streamInfo.Break !== brk) {
        if (backup) {
            console.log(
                '[AD DEBUG] Discarded stale backup commit (' +
                    backup.playerType +
                    ', ' +
                    (Date.now() - backup.searchStartedAt) +
                    'ms) — break ended during search',
            );
        }
        textStr = stripAdSegments(textStr, false, streamInfo, brk);
        postBanner(streamInfo);
        return textStr;
    }
    if (backup) {
        textStr = backup.m3u8;
        commitBackup(streamInfo, brk, backup.playerType, backup.searchStartedAt, backup.coldTokenFetches);
    }
    const stripAll = backup
        ? isCodecMismatch(currentResolution.Codecs, backup.codecs)
        : isEnhanced && !!streamInfo.ModifiedM3U8;
    textStr = stripAdSegments(textStr, stripAll, streamInfo, brk);
    stepEarlyReload(brk, '', !codecSwapStarted);
    postBanner(streamInfo);
    return textStr;
}

// Not right after a reload: Twitch's post-ad continuation markers would trigger a redundant teardown.
function maybeStartCodecSwap(streamInfo: StreamInfo, brk: AdBreak): boolean {
    if (
        !streamInfo.ModifiedM3U8 ||
        streamInfo.CodecSwap !== 'native' ||
        brk.CodecSwapTried ||
        (streamInfo.LastPlayerReload && Date.now() - streamInfo.LastPlayerReload < POST_AD_REENTRY_GUARD_MS)
    ) {
        return false;
    }
    brk.CodecSwapTried = true;
    streamInfo.CodecSwap = 'switching';
    streamInfo.LastPlayerReload = Date.now();
    requestReload('codec-swap', (outcome) => {
        if (streamInfo.CodecSwap !== 'switching') return;
        if (outcome === 'reloaded') {
            streamInfo.CodecSwap = 'swapped';
        } else {
            streamInfo.CodecSwap = 'native';
            console.log(
                '[AD DEBUG] Codec-swap reload not done by the page (' + outcome + ') — staying on native codec',
            );
        }
    });
    return true;
}

function backupOrder(streamInfo: StreamInfo, brk: AdBreak): PlayerType[] {
    const types: PlayerType[] = state.PreferLowQualityBackup
        ? [...state.BackupPlayerTypes, 'autoplay']
        : [...state.BackupPlayerTypes];
    const moveToFront = (t: PlayerType): boolean => {
        const index = types.indexOf(t);
        if (index > 0) {
            types.splice(index, 1);
            types.unshift(t);
            return true;
        }
        return false;
    };
    if (streamInfo.PinnedBackupPlayerType) {
        moveToFront(streamInfo.PinnedBackupPlayerType);
    }
    if (brk.AutoplayFirst === null) {
        brk.AutoplayFirst = decideAutoplayFirst(streamInfo);
    }
    if (brk.AutoplayFirst && moveToFront('autoplay') && !brk.LoggedAutoplayOrder) {
        brk.LoggedAutoplayOrder = true;
        console.log('[AD DEBUG] Fast-autoplay first-try — prior break exhausted Source-tier; probing autoplay first');
    }
    if (brk.ContaminatedTypes.size > 0) {
        const clean = types.filter((t) => !brk.ContaminatedTypes.has(t));
        const contam = types.filter((t) => brk.ContaminatedTypes.has(t));
        if (contam.length > 0 && clean.length > 0) {
            types.length = 0;
            types.push(...clean, ...contam);
            if (!brk.LoggedContamReorder) {
                brk.LoggedContamReorder = true;
                console.log(
                    '[AD DEBUG] Contamination-aware reorder — trying [' +
                        clean.join(', ') +
                        '] before known-contaminated [' +
                        contam.join(', ') +
                        ']',
                );
            }
        }
    }
    return types;
}

// Every Nth autoplay-first break re-probes Source, to notice Twitch serving clean Source backups again.
function decideAutoplayFirst(streamInfo: StreamInfo): boolean {
    if (!state.FastAutoplayFirstTry || !state.PreferLowQualityBackup || !streamInfo.SourceTierExhausted) {
        return false;
    }
    if (streamInfo.FastAutoplayWins >= FAST_AUTOPLAY_REPROBE_INTERVAL) {
        console.log(
            '[AD DEBUG] Fast-autoplay re-probe — testing Source-tier after ' +
                streamInfo.FastAutoplayWins +
                ' consecutive fast-autoplay breaks (channel-recovery check)',
        );
        streamInfo.FastAutoplayWins = 0;
        return false;
    }
    return true;
}

interface BackupPlaylist {
    playerType: PlayerType;
    m3u8: string;
    codecs: string;
}

interface BackupFound extends BackupPlaylist {
    searchStartedAt: number;
    coldTokenFetches: number;
}

async function searchBackup(
    streamInfo: StreamInfo,
    brk: AdBreak,
    currentResolution: ResolutionInfo,
    realFetch: typeof fetch,
): Promise<BackupFound | null> {
    const backupSearchStart = Date.now();
    let backupColdTokenFetches = 0;
    let found: BackupPlaylist | null = null;
    let fallback: BackupPlaylist | null = null;
    let startIndex = 0;
    let isDoingMinimalRequests = false;
    if (streamInfo.LastPlayerReload > Date.now() - state.PlayerReloadMinimalRequestsTime) {
        // A reloading player makes many requests, which slows the backup stream; prefer a single type.
        startIndex = state.PlayerReloadMinimalRequestsPlayerIndex;
        isDoingMinimalRequests = true;
    }
    const playerTypesToTry = backupOrder(streamInfo, brk);
    for (let playerTypeIndex = startIndex; !found && playerTypeIndex < playerTypesToTry.length; playerTypeIndex++) {
        const playerType = playerTypesToTry[playerTypeIndex];
        const failedAt = brk.FailedBackupPlayerTypes.get(playerType);
        // 5s lockout: a contaminated backup type can turn clean within seconds. Costs ~3x more retry
        // fetches (#228).
        if (failedAt && Date.now() - failedAt < 5000) {
            continue;
        }
        const isLastType = playerTypeIndex >= playerTypesToTry.length - 1;
        for (let i = 0; i < 2; i++) {
            let isFreshM3u8 = false;
            let encodingsM3u8 = streamInfo.BackupEncodingsM3U8Cache[playerType];
            if (!encodingsM3u8) {
                isFreshM3u8 = true;
                backupColdTokenFetches++;
                const fetched = await fetchBackupEncodings(streamInfo, brk, playerType, realFetch);
                if (fetched === 'missing-token') {
                    continue;
                }
                encodingsM3u8 = fetched;
            }
            const candidate = encodingsM3u8
                ? await fetchBackupPlaylist(encodingsM3u8, playerType, currentResolution, realFetch)
                : null;
            if (candidate) {
                if (playerType === state.FallbackPlayerType) {
                    fallback = candidate;
                }
                const backupHasAds = hasAdTags(candidate.m3u8);
                if (
                    (!backupHasAds &&
                        (state.SimulatedAdsDepth === 0 || playerTypeIndex >= state.SimulatedAdsDepth - 1)) ||
                    (!fallback && isLastType)
                ) {
                    if (brk.ConsecutiveAllStrippedPolls >= 1 && !backupHasAds) {
                        noteCleanDuringFreeze(brk, playerType);
                    }
                    found = candidate;
                    break;
                }
                if (backupHasAds && !brk.ContaminatedTypes.has(playerType)) {
                    brk.ContaminatedTypes.add(playerType);
                    console.log('[AD DEBUG] Backup stream (' + playerType + ') also has ads');
                }
                if (isDoingMinimalRequests) {
                    found = candidate;
                    break;
                }
                if (backupHasAds && isLastType) {
                    console.log(
                        '[AD DEBUG] All backup player types ad-laden — taking ' +
                            playerType +
                            ' as last-resort fallback (strip+recovery path will engage)',
                    );
                    found = candidate;
                    break;
                }
            }
            streamInfo.BackupEncodingsM3U8Cache[playerType] = null;
            if (isFreshM3u8) {
                break;
            }
        }
    }
    if (!found && fallback) {
        if (brk.ContaminatedTypes.has(state.FallbackPlayerType)) {
            console.log(
                '[AD DEBUG] Skipping fallback to ' +
                    state.FallbackPlayerType +
                    ' — marked contaminated this break (' +
                    [...brk.ContaminatedTypes].join(', ') +
                    ' all ad-laden)',
            );
        } else {
            found = fallback;
        }
    }
    if (found) {
        return { ...found, searchStartedAt: backupSearchStart, coldTokenFetches: backupColdTokenFetches };
    }
    console.log(
        '[AD DEBUG] No ad-free backup stream found — ads may leak. Tried: ' +
            playerTypesToTry.slice(startIndex).join(', '),
    );
    return null;
}

async function fetchBackupEncodings(
    streamInfo: StreamInfo,
    brk: AdBreak,
    playerType: PlayerType,
    realFetch: typeof fetch,
): Promise<string | null | 'missing-token'> {
    try {
        const accessTokenResponse = await getAccessToken(streamInfo.ChannelName, playerType);
        if (accessTokenResponse.status !== 200) {
            let errorBody = '';
            try {
                errorBody = ' — ' + (await accessTokenResponse.text()).substring(0, 200);
            } catch {}
            console.log(
                '[AD DEBUG] Access token HTTP ' +
                    accessTokenResponse.status +
                    ' for ' +
                    playerType +
                    (accessTokenResponse.status === 403
                        ? ' (integrity: ' + (state.ClientIntegrityHeader ? 'present' : 'missing') + ')'
                        : '') +
                    errorBody,
            );
            recordTokenFetchFailure(streamInfo, brk, playerType);
            return null;
        }
        const accessToken = await accessTokenResponse.json();
        // Twitch nests streamPlaybackAccessToken under data, except for 'embed', where it's top-level.
        const spat = accessToken?.data?.streamPlaybackAccessToken || accessToken?.streamPlaybackAccessToken;
        if (!spat) {
            const errInfo = accessToken?.errors
                ? ' errors: ' + JSON.stringify(accessToken.errors).substring(0, 300)
                : '';
            console.log(
                '[AD DEBUG] GQL response missing streamPlaybackAccessToken for ' +
                    playerType +
                    '. Response keys: ' +
                    JSON.stringify(Object.keys(accessToken || {})) +
                    errInfo,
            );
            recordTokenFetchFailure(streamInfo, brk, playerType);
            return 'missing-token';
        }
        const urlInfo = new URL(
            'https://usher.ttvnw.net/api/' +
                (state.V2API ? 'v2/' : '') +
                'channel/hls/' +
                streamInfo.ChannelName +
                '.m3u8' +
                streamInfo.UsherParams,
        );
        urlInfo.searchParams.set('sig', spat.signature);
        urlInfo.searchParams.set('token', spat.value);
        const encodingsM3u8Response = await realFetch(urlInfo.href);
        if (encodingsM3u8Response.status !== 200) {
            console.log('[AD DEBUG] Usher HTTP ' + encodingsM3u8Response.status + ' for ' + playerType);
            return null;
        }
        const encodingsM3u8 = await encodingsM3u8Response.text();
        streamInfo.BackupEncodingsM3U8Cache[playerType] = encodingsM3u8;
        streamInfo.ConsecutiveTokenFetchFailures = 0;
        streamInfo.LoggedTokenFailureStreak = false;
        return encodingsM3u8;
    } catch (err) {
        console.log('[AD DEBUG] Access token failed for ' + playerType + ': ' + (err as Error).message);
        recordTokenFetchFailure(streamInfo, brk, playerType);
        return null;
    }
}

async function fetchBackupPlaylist(
    encodingsM3u8: string,
    playerType: PlayerType,
    currentResolution: ResolutionInfo,
    realFetch: typeof fetch,
): Promise<BackupPlaylist | null> {
    try {
        const variant = getStreamVariantForResolution(encodingsM3u8, currentResolution);
        const streamM3u8Url = variant?.url;
        if (!variant || !streamM3u8Url) {
            throw new Error('no variant playlist in the backup encodings');
        }
        const streamM3u8Response = await realFetch(streamM3u8Url);
        if (streamM3u8Response.status !== 200) {
            console.log(
                '[AD DEBUG] Backup stream fetch failed for ' +
                    playerType +
                    ' (status ' +
                    streamM3u8Response.status +
                    ')',
            );
            return null;
        }
        const m3u8 = await streamM3u8Response.text();
        return m3u8 ? { playerType, m3u8, codecs: variant.codecs } : null;
    } catch (err) {
        console.log('[AD DEBUG] Backup stream error for ' + playerType + ': ' + (err as Error).message);
        return null;
    }
}

function noteCleanDuringFreeze(brk: AdBreak, playerType: PlayerType): void {
    const prevType = brk.LastCommittedBackupPlayerType;
    if (prevType && prevType !== playerType) {
        console.log(
            '[AD DEBUG] Cycle switched to different clean type (' +
                playerType +
                ', was ' +
                prevType +
                ') during freeze — recovered without reload',
        );
        // Same type turned clean: the player still needs the end-of-break reload, or it stays stuck
        // on a low buffer.
        brk.CycleRescued = true;
    } else {
        console.log('[AD DEBUG] Same backup type (' + playerType + ') became clean during freeze — natural recovery');
    }
}

function commitBackup(
    streamInfo: StreamInfo,
    brk: AdBreak,
    backupPlayerType: PlayerType,
    searchStartedAt: number,
    coldTokenFetches: number,
): void {
    brk.LastCommittedBackupPlayerType = backupPlayerType;
    if (brk.ActiveBackupPlayerType === backupPlayerType) {
        return;
    }
    brk.ActiveBackupPlayerType = backupPlayerType;
    if (state.PinBackupPlayerType && backupPlayerType !== 'autoplay') {
        streamInfo.PinnedBackupPlayerType = backupPlayerType;
    }
    console.log(
        `[AD DEBUG] Blocking${brk.IsMidroll ? ' midroll ' : ' '}ads (${backupPlayerType}) — backup found in ${Date.now() - searchStartedAt}ms${coldTokenFetches > 0 ? ` (cold cache: ${coldTokenFetches} token fetch${coldTokenFetches > 1 ? 'es' : ''})` : ' (warm cache)'}`,
    );
    if (brk.Path === 'escaped') {
        const qualityTier = backupPlayerType === 'autoplay' ? '360p' : 'Source';
        console.log(
            '[AD DEBUG] Post-escape backup: ' +
                backupPlayerType +
                ' (' +
                qualityTier +
                ') — recovered from sticky-path freeze',
        );
    } else if (backupPlayerType === 'autoplay' && state.PreferLowQualityBackup) {
        const sourceTried = brk.ContaminatedTypes.size;
        if (sourceTried === 0) {
            console.log('[AD DEBUG] Autoplay backup committed — 360p first-try (PreferLowQualityBackup)');
            streamInfo.FastAutoplayWins++;
        } else {
            console.log(
                '[AD DEBUG] Autoplay backup committed — 360p fallback after ' +
                    sourceTried +
                    ' Source type(s) ad-laden (PreferLowQualityBackup)',
            );
        }
        if (state.FastAutoplayFirstTry && sourceTried >= 4) {
            streamInfo.SourceTierExhausted = true;
            streamInfo.FastAutoplayWins = 0;
        }
    } else if (state.FastAutoplayFirstTry && backupPlayerType !== 'autoplay') {
        streamInfo.SourceTierExhausted = false;
        streamInfo.FastAutoplayWins = 0;
    }
}

function handleAdFreePoll(streamInfo: StreamInfo, brk: AdBreak, textStr: string): void {
    const reason = onAdFreePoll(brk, textStr.includes(',live'));
    if (!reason) {
        return;
    }
    if (reason === 'max-wait' && brk.End) {
        console.log(
            '[AD DEBUG] Slow-path ad-end escalation — ' +
                brk.End.bounces +
                ' marker bounces, ' +
                ((Date.now() - brk.End.since) / 1000).toFixed(1) +
                's since first clean poll',
        );
    } else if (reason === 'no-live-segments') {
        console.log('[AD DEBUG] Backup stream has no live segments — forcing immediate reload');
    }
    endBreak(streamInfo, brk);
}

function endBreak(streamInfo: StreamInfo, brk: AdBreak): void {
    console.log(
        '[AD DEBUG] Finished blocking ads — stripped ' +
            brk.StrippedSegments +
            ' ad segments, duration: ' +
            ((Date.now() - brk.StartedAt) / 1000).toFixed(1) +
            's',
    );
    if (brk.TotalAllStrippedPolls > 0) {
        const reloadInfo = brk.EarlyReloadAtPoll ? ', early reload at poll ' + brk.EarlyReloadAtPoll : '';
        const wallClockFreeze = brk.FreezeStartedAt
            ? ((Date.now() - brk.FreezeStartedAt) / 1000).toFixed(1) + 's wall-clock'
            : 'unknown';
        console.log(
            '[AD DEBUG] Ad break stats: ' +
                brk.TotalAllStrippedPolls +
                ' all-stripped polls, freeze duration: ' +
                wallClockFreeze +
                reloadInfo,
        );
    }
    const hadStrippedSegments = brk.StrippedSegments > 0;
    if (!hadStrippedSegments && !brk.HasConfirmedAdAttrs) {
        streamInfo.ConsecutiveZeroStripBreaks++;
        if (streamInfo.ConsecutiveZeroStripBreaks >= 3) {
            console.log(
                '[AD DEBUG] Warning: ' +
                    streamInfo.ConsecutiveZeroStripBreaks +
                    ' consecutive unconfirmed ad breaks with 0 segments stripped — possible false positive from ad signifiers',
            );
        }
    } else {
        streamInfo.ConsecutiveZeroStripBreaks = 0;
    }
    const action = decideBreakEndAction(streamInfo, brk, state);
    streamInfo.Break = null;
    streamInfo.CodecSwap = 'native';
    if (!hadStrippedSegments) {
        console.log('[AD DEBUG] CSAI-only ad break (stripped 0) — no MediaSource flush needed');
    }
    if (action.action === 'reload') {
        console.log('[AD DEBUG] End-of-break reload: ' + action.reason);
        streamInfo.LastPlayerReload = Date.now();
        requestReload(action.kind);
    } else if (action.action === 'pause-play') {
        if (hadStrippedSegments && state.ReloadPlayerAfterAd) {
            console.log('[AD DEBUG] Cycle rescue handled the break cleanly — skipping end-of-break reload');
        }
        postToPage({ key: 'PauseResumePlayer' });
    }
}

function postBanner(streamInfo: StreamInfo, activeBackupPlayerType?: PlayerType | null): void {
    const brk = streamInfo.Break;
    postToPage({
        key: 'UpdateAdBlockBanner',
        isMidroll: brk ? brk.IsMidroll : false,
        hasAds: !!brk,
        isStrippingAdSegments: brk ? brk.IsStripping : false,
        numStrippedAdSegments: brk ? brk.StrippedSegments : 0,
        activeBackupPlayerType:
            activeBackupPlayerType === undefined ? (brk?.ActiveBackupPlayerType ?? null) : activeBackupPlayerType,
    });
}

function recordTokenFetchFailure(streamInfo: StreamInfo, brk: AdBreak, playerType: PlayerType): void {
    brk.FailedBackupPlayerTypes.set(playerType, Date.now());
    streamInfo.ConsecutiveTokenFetchFailures++;
    if (streamInfo.ConsecutiveTokenFetchFailures >= 3 && !streamInfo.LoggedTokenFailureStreak) {
        streamInfo.LoggedTokenFailureStreak = true;
        console.log(
            '[AD DEBUG] Token fetch failed ' +
                streamInfo.ConsecutiveTokenFetchFailures +
                ' times consecutively across player types — possible Twitch detection / integrity rotation / rate limiting',
        );
    }
}
