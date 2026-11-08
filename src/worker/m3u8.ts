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

/** Within this long after a player reload, a new break doesn't start another codec-swap reload. */
const POST_AD_REENTRY_GUARD_MS = 8000;
/** All-stripped polls on the sticky CSAI path before the escape hatch tries backups (~8s). */
const STICKY_ESCAPE_POLLS = 4;
/** Every Nth break won by autoplay-first re-probes the Source tier (channel recovery check). */
const FAST_AUTOPLAY_REPROBE_INTERVAL = 5;

// Core ad-blocking logic: detect ads in m3u8, fetch backup streams, strip ad segments
export async function processM3U8(url: string, textStr: string, realFetch: typeof fetch): Promise<string> {
    const streamInfo = state.StreamInfosByUrl[url];
    if (!streamInfo) {
        return textStr;
    }
    streamInfo.LastSeenAt = Date.now();
    // The first poll after a page-side reload marks when the reloaded player started polling:
    // that is what the minimal-requests window and the post-ad re-entry guards measure from.
    if (streamInfo.ReloadPending) {
        streamInfo.ReloadPending = false;
        streamInfo.LastPlayerReload = Date.now();
    }
    // Detection diagnostic: if Twitch shuts a stream down (anti-ad-block detection
    // response observed in field reports), the m3u8 transitions to a stream-end shape
    // — `EXT-X-ENDLIST` present and no `#EXTINF:` segment lines. Log once per stream
    // session so users / bug reporters can include the transition timestamp in repros.
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
        // Cache the clean main stream m3u8 for all-stripped recovery fallback: by the time a
        // break starts, this holds a snapshot ~1-2s old with several live segments, which
        // stripAdSegments replays instead of the thin per-segment recovery cache.
        // Mirrors TTV-AB src/modules/processor.ts:733-736.
        streamInfo.LastCleanNativeM3U8 = textStr;
        streamInfo.LastCleanNativePlaylistAt = Date.now();
    }
    postBanner(streamInfo);
    return textStr;
}

// An ad-marked poll: start the break if needed, then serve the CSAI fast path or a backup.
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
    // Spoof ad-completion every ad-laden poll (not just break-start). Twitch
    // discloses each ad's DATERANGE only as that ad starts, so multi-ad pods
    // surface one ad per poll — notifyAdComplete dedups via SpoofedAdIds so
    // each ad is spoofed once across the break (full N/N coverage).
    if (!state.DisableAdSpoofing) {
        // Defer off the playlist critical path — synchronous matchAll + parse +
        // JSON.stringify here delays the modified-m3u8 return to the player
        // (ad-break stutter). Next tick is fine; spoof beacons aren't time-critical.
        // (GosuDRM TTV-AB v8.0.0 field finding on this same spoof code.)
        const spoofBreak = brk;
        setTimeout(() => notifyAdComplete(textStr, spoofBreak), 0);
    }
    // textStr is not modified before the CSAI fast-path check below, so split it once for both.
    const lines = textStr.split(/\r?\n/);
    if (!brk.IsMidroll) {
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.startsWith('#EXTINF') && lines.length > i + 1) {
                if (!line.includes(',live') && !brk.RequestedAds.has(lines[i + 1])) {
                    // Only request one .ts file per .m3u8 request to avoid making too many requests
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
    // AV1 parity: the ModifiedM3U8 build covers AV1 ('av0*') as well as hev/hvc.
    const isEnhanced = isEnhancedCodec(currentResolution.Codecs);
    const codecSwapStarted =
        ((isEnhanced && !state.SkipPlayerReloadOnHevc) || state.AlwaysReloadPlayerOnAd) &&
        maybeStartCodecSwap(streamInfo, brk);
    // Sticky CSAI escape hatch (PreferLowQualityBackup): if the sticky path has
    // been stuck in all-stripped state for too long (~8s), fall through to backup
    // search. Gives heavy-SSAI channels a way out of the sticky freeze by trying
    // Source backups + autoplay fallback instead of sitting in recovery loop.
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
    // Sticky CSAI fast path: a prior poll in THIS break confirmed the break is CSAI-only
    // (all segments live), so stay on the fast path for the rest of the break.
    // stripAdSegments still handles any real EXTINF ad segments that show up on later
    // polls (they get cached and the fetch hook returns BLANK_MP4), so ads are blocked
    // even without the backup switch. Skipping backup search for the whole CSAI break
    // saves ~20 wasted fetches per break — the backup wouldn't help anyway since every
    // player type has the same CSAI ads.
    if (brk.Path === 'sticky-csai' && streamInfo.CodecSwap === 'native') {
        textStr = stripAdSegments(textStr, false, streamInfo, brk);
        // Early reload during prolonged freeze: without it, heavy SSAI breaks on
        // CSAI-confirmed streams leave the player replaying the thin recovery cache for
        // the full break (observed: 35.9s freeze on a pod-1 break).
        stepEarlyReload(brk, ' (sticky path)');
        postBanner(streamInfo, null);
        return textStr;
    }
    // CSAI fast path: if all segments in the main stream are live, skip backup search.
    // CSAI ads are delivered outside the m3u8 — the main stream segments are clean.
    // Just strip tracking URLs and return the main stream directly, avoiding the
    // backup stream switch that causes a 20-40s rebuffer gap.
    // BackupSwapFirst (default) skips this and always searches for a backup — avoids
    // MediaSource mixing from strip activity (no BLANK_MP4 injection, no recovery
    // segment replay), which users report produces fewer loading circles.
    const hasNonLiveSegment = lines.some((line) => line.startsWith('#EXTINF') && !line.includes(',live'));
    if (brk.Path === 'probing' && !hasNonLiveSegment && streamInfo.CodecSwap === 'native' && !state.BackupSwapFirst) {
        brk.Path = 'sticky-csai';
        console.log('[AD DEBUG] CSAI fast path — all segments live, skipping backup search');
        textStr = stripAdSegments(textStr, false, streamInfo, brk);
        postBanner(streamInfo, null);
        return textStr;
    }
    const backup = await searchBackup(streamInfo, brk, currentResolution, realFetch);
    // Stale-commit guard: several processM3U8 calls can be in flight for the same stream (one
    // per poll). If this search outlived its break (a later poll ended it, maybe started another),
    // committing would feed stale playlist data to the player. Strip and hand back the poll
    // without touching the break that is current now.
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
    // Strip every segment when the playlist served can't be decoded by the player's MediaSource:
    // a backup in another codec family (either way, see isCodecMismatch), or, with no backup, the
    // native enhanced-codec playlist while the AVC swap exists (the player is being moved off it).
    const stripAll = backup
        ? isCodecMismatch(currentResolution.Codecs, backup.codecs)
        : isEnhanced && !!streamInfo.ModifiedM3U8;
    textStr = stripAdSegments(textStr, stripAll, streamInfo, brk);
    // Not on the poll that started the codec-swap reload: that reload already fetches fresh content.
    stepEarlyReload(brk, '', !codecSwapStarted);
    postBanner(streamInfo);
    return textStr;
}

// Codec swap (CodecSwapState): reload the player onto the AVC-only master playlist so it can
// switch to the (AVC) backups. Once per break; not right after a reload, where post-ad
// continuation markers would otherwise trigger a redundant teardown/rebuild ~seconds after the
// previous reload settled.
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
        // Only a reload makes the player fetch the master playlist again (and get the AVC one).
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

// Player types in the order to try them for this poll's backup search.
function backupOrder(streamInfo: StreamInfo, brk: AdBreak): PlayerType[] {
    // When PreferLowQualityBackup is enabled, append 'autoplay' (360p) as a last-resort
    // fallback — mirrors pixeltris's original behavior. Source backups are tried first;
    // autoplay only kicks in when they're all ad-laden. Keeps Source quality when
    // available while guaranteeing a clean backup for heavy SSAI breaks.
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
    // Real-time contamination reorder: on poll 2+ of a break, move types that were
    // already ad-laden earlier in the same break to the end of iteration, so
    // untried/clean types (typically autoplay on SSAI-heavy channels) get tried first.
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

// FastAutoplayFirstTry, decided once per break: when a recent break found every Source-tier type
// ad-laden (SourceTierExhausted), try autoplay first and save ~1.5-2s of probing. Every
// FAST_AUTOPLAY_REPROBE_INTERVAL'th such break probes Source normally instead, to notice the
// channel recovering (Twitch reversing CSAI delivery); otherwise it would stay at 360p.
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

interface BackupFound {
    playerType: PlayerType;
    m3u8: string;
    searchStartedAt: number;
    /** Cold-cache token round-trips this search (0 = warm, encodings cache hit). */
    coldTokenFetches: number;
    /** CODECS of the backup variant served. */
    codecs: string;
}

// Look for an ad-free backup playlist across player types. Falls back to an ad-laden one only
// when every type is ad-laden (the strip + recovery path then engages).
async function searchBackup(
    streamInfo: StreamInfo,
    brk: AdBreak,
    currentResolution: ResolutionInfo,
    realFetch: typeof fetch,
): Promise<BackupFound | null> {
    const backupSearchStart = Date.now();
    let backupColdTokenFetches = 0;
    let backupPlayerType: PlayerType | null = null;
    let backupM3u8: string | null = null;
    let backupCodecs = '';
    let fallbackM3u8 = null;
    let fallbackCodecs = '';
    let startIndex = 0;
    let isDoingMinimalRequests = false;
    if (streamInfo.LastPlayerReload > Date.now() - state.PlayerReloadMinimalRequestsTime) {
        // When doing player reload there are a lot of requests which causes the backup stream to load in slow. Briefly prefer using a single version to prevent long delays
        startIndex = state.PlayerReloadMinimalRequestsPlayerIndex;
        isDoingMinimalRequests = true;
    }
    const playerTypesToTry = backupOrder(streamInfo, brk);
    for (
        let playerTypeIndex = startIndex;
        !backupM3u8 && playerTypeIndex < playerTypesToTry.length;
        playerTypeIndex++
    ) {
        const playerType = playerTypesToTry[playerTypeIndex];
        const failedAt = brk.FailedBackupPlayerTypes.get(playerType);
        // 5s (was 15s): in the CSAI-flip world a contaminated backup type can
        // recover within seconds; the 15s lockout kept us off a now-clean type far
        // too long (TTV-AB/GosuDRM v8.0.0 "reduced ad-induced stalling"). Tradeoff:
        // ~3x more retry fetches — watched via the cold/warm token-fetch log (#228).
        if (failedAt && Date.now() - failedAt < 5000) {
            continue;
        }
        for (let i = 0; i < 2; i++) {
            // This caches the m3u8 if it doesn't have ads. If the already existing cache has ads it fetches a new version (second loop)
            let isFreshM3u8 = false;
            let encodingsM3u8 = streamInfo.BackupEncodingsM3U8Cache[playerType];
            if (!encodingsM3u8) {
                isFreshM3u8 = true;
                backupColdTokenFetches++;
                try {
                    const accessTokenResponse = await getAccessToken(streamInfo.ChannelName, playerType);
                    if (accessTokenResponse.status === 200) {
                        const accessToken = await accessTokenResponse.json();
                        // Twitch returns streamPlaybackAccessToken in two observed shapes:
                        //   { data: { streamPlaybackAccessToken: {...} } } (most player types)
                        //   { streamPlaybackAccessToken: {...} } (flatter, observed for 'embed')
                        // Accept either. Field-observed silently dropping embed backup otherwise.
                        const spat =
                            accessToken?.data?.streamPlaybackAccessToken || accessToken?.streamPlaybackAccessToken;
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
                            continue;
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
                        if (encodingsM3u8Response.status === 200) {
                            encodingsM3u8 = streamInfo.BackupEncodingsM3U8Cache[playerType] =
                                await encodingsM3u8Response.text();
                            // Reset detection diagnostic counter on success — token fetched, m3u8 fetched.
                            streamInfo.ConsecutiveTokenFetchFailures = 0;
                            streamInfo.LoggedTokenFailureStreak = false;
                        } else {
                            console.log('[AD DEBUG] Usher HTTP ' + encodingsM3u8Response.status + ' for ' + playerType);
                        }
                    } else {
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
                    }
                } catch (err) {
                    console.log('[AD DEBUG] Access token failed for ' + playerType + ': ' + (err as Error).message);
                    recordTokenFetchFailure(streamInfo, brk, playerType);
                }
            }
            if (encodingsM3u8) {
                try {
                    const variant = getStreamVariantForResolution(encodingsM3u8, currentResolution);
                    const streamM3u8Url = variant?.url;
                    if (!variant || !streamM3u8Url) {
                        // Previously fetch(null), which threw on the blob-relative URL; same catch below, clearer message.
                        throw new Error('no variant playlist in the backup encodings');
                    }
                    const streamM3u8Response = await realFetch(streamM3u8Url);
                    if (streamM3u8Response.status === 200) {
                        const m3u8Text = await streamM3u8Response.text();
                        if (m3u8Text) {
                            if (playerType === state.FallbackPlayerType) {
                                fallbackM3u8 = m3u8Text;
                                fallbackCodecs = variant.codecs;
                            }
                            const backupHasAds = hasAdTags(m3u8Text);
                            if (
                                (!backupHasAds &&
                                    (state.SimulatedAdsDepth === 0 ||
                                        playerTypeIndex >= state.SimulatedAdsDepth - 1)) ||
                                (!fallbackM3u8 && playerTypeIndex >= playerTypesToTry.length - 1)
                            ) {
                                if (brk.ConsecutiveAllStrippedPolls >= 1 && !backupHasAds) {
                                    const prevType = brk.LastCommittedBackupPlayerType;
                                    if (prevType && prevType !== playerType) {
                                        console.log(
                                            '[AD DEBUG] Cycle switched to different clean type (' +
                                                playerType +
                                                ', was ' +
                                                prevType +
                                                ') during freeze — recovered without reload',
                                        );
                                        // Only mark as cycle-rescued when we ACTUALLY switched player types.
                                        // Natural recovery (same type became clean) still needs the end-of-break
                                        // reload to refresh the player buffer — skipping it leaves the player
                                        // stuck with low buffer and the buffer monitor unable to recover.
                                        brk.CycleRescued = true;
                                    } else {
                                        console.log(
                                            '[AD DEBUG] Same backup type (' +
                                                playerType +
                                                ') became clean during freeze — natural recovery',
                                        );
                                    }
                                }
                                backupPlayerType = playerType;
                                backupM3u8 = m3u8Text;
                                backupCodecs = variant.codecs;
                                break;
                            }
                            if (backupHasAds) {
                                if (!brk.ContaminatedTypes.has(playerType)) {
                                    brk.ContaminatedTypes.add(playerType);
                                    console.log('[AD DEBUG] Backup stream (' + playerType + ') also has ads');
                                }
                            }
                            if (isDoingMinimalRequests) {
                                backupPlayerType = playerType;
                                backupM3u8 = m3u8Text;
                                backupCodecs = variant.codecs;
                                break;
                            }
                            // Cycle through all player types looking for a clean backup. Only commit
                            // an ad-laden backup as a last resort when we've exhausted all options.
                            // PR #89 previously committed the first ad-laden type immediately — that
                            // caused the v58 freeze regression (issue #112) because the strip+recovery
                            // loop would engage even when a clean alternate was available on another
                            // player type.
                            if (backupHasAds && playerTypeIndex >= playerTypesToTry.length - 1) {
                                console.log(
                                    '[AD DEBUG] All backup player types ad-laden — taking ' +
                                        playerType +
                                        ' as last-resort fallback (strip+recovery path will engage)',
                                );
                                backupPlayerType = playerType;
                                backupM3u8 = m3u8Text;
                                backupCodecs = variant.codecs;
                                break;
                            }
                        }
                    } else {
                        console.log(
                            '[AD DEBUG] Backup stream fetch failed for ' +
                                playerType +
                                ' (status ' +
                                streamM3u8Response.status +
                                ')',
                        );
                    }
                } catch (err) {
                    console.log('[AD DEBUG] Backup stream error for ' + playerType + ': ' + (err as Error).message);
                }
            }
            streamInfo.BackupEncodingsM3U8Cache[playerType] = null;
            if (isFreshM3u8) {
                break;
            }
        }
    }
    if (!backupM3u8 && fallbackM3u8) {
        // Don't fall back to a type already marked contaminated this break: we'd silently
        // re-commit the same ad-laden playlist on every poll. Better to leave backupM3u8 null
        // and let the "No ad-free backup stream found" log fire so it's visible.
        if (brk.ContaminatedTypes.has(state.FallbackPlayerType)) {
            console.log(
                '[AD DEBUG] Skipping fallback to ' +
                    state.FallbackPlayerType +
                    ' — marked contaminated this break (' +
                    [...brk.ContaminatedTypes].join(', ') +
                    ' all ad-laden)',
            );
        } else {
            backupPlayerType = state.FallbackPlayerType;
            backupM3u8 = fallbackM3u8;
            backupCodecs = fallbackCodecs;
        }
    }
    if (backupM3u8 && backupPlayerType) {
        return {
            playerType: backupPlayerType,
            m3u8: backupM3u8,
            searchStartedAt: backupSearchStart,
            coldTokenFetches: backupColdTokenFetches,
            codecs: backupCodecs,
        };
    }
    console.log(
        '[AD DEBUG] No ad-free backup stream found — ads may leak. Tried: ' +
            playerTypesToTry.slice(startIndex).join(', '),
    );
    return null;
}

// Serve a backup for this poll, and on a switch of player type update pinning and the
// autoplay-first bookkeeping.
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
    // Never pin 'autoplay': PreferLowQualityBackup keeps it LAST so the last-resort branch can
    // commit it when every Source type is ad-laden. Pinned to the front, the last-resort branch
    // would commit a different ad-laden Source type instead (strip + recovery, freezes likely).
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
        // Only a full probe (all 4 Source types ad-laden) marks the Source tier exhausted.
        if (state.FastAutoplayFirstTry && sourceTried >= 4) {
            streamInfo.SourceTierExhausted = true;
            streamInfo.FastAutoplayWins = 0;
        }
    } else if (state.FastAutoplayFirstTry && backupPlayerType !== 'autoplay') {
        // A Source-tier type committed: the channel recovered, back to normal ordering.
        streamInfo.SourceTierExhausted = false;
        streamInfo.FastAutoplayWins = 0;
    }
}

// An ad-free poll during a break: maybe end the break.
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
    // Only count toward the false-positive guard if the m3u8 lacked high-confidence ad markers.
    // Confirmed ads that produce 0 strips are real ads avoided via a clean backup.
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

// `activeBackupPlayerType` overrides the break's (the CSAI fast paths report none).
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

// Bookkeeping shared by every way a backup access-token fetch can fail: lock the player type
// out briefly and log once per streak of consecutive failures.
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
