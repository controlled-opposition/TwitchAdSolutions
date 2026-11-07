import type { PlayerType } from '../shared/types.ts';
import { getMatchedAdSignifiers, hasAdTags, stripAdSegments } from './ads.ts';
import { notifyAdComplete } from './spoof.ts';
import { getStreamUrlForResolution, videoCodecFamily } from './playlist.ts';
import { getAccessToken } from './gql.ts';
import { state } from './state.ts';
import { postToPage } from './post.ts';

// Core ad-blocking logic: detect ads in m3u8, fetch backup streams, strip ad segments
export async function processM3U8(url: string, textStr: string, realFetch: typeof fetch): Promise<string> {
    const streamInfo = state.StreamInfosByUrl[url];
    if (!streamInfo) {
        return textStr;
    }
    streamInfo.LastSeenAt = Date.now();
    if (state.HasTriggeredPlayerReload) {
        state.HasTriggeredPlayerReload = false;
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
    // Cache the clean main stream m3u8 for all-stripped recovery fallback.
    // Updated during non-ad polls (outside of any ad break), so by the time an ad
    // break starts, streamInfo.LastCleanNativeM3U8 holds a snapshot ~1-2 seconds old
    // with several live segments. When heavy SSAI breaks leave the main playlist
    // entirely stripped, stripAdSegments replays this snapshot instead of the thin
    // RecoverySegments array — typically gives the player 4-6 live segments of
    // content to chew on vs the 1-2 cached individual segments.
    // Mirrors TTV-AB src/modules/processor.ts:733-736.
    if (!haveAdTags && !streamInfo.IsShowingAd && textStr.indexOf('#EXTINF') !== -1) {
        streamInfo.LastCleanNativeM3U8 = textStr;
        streamInfo.LastCleanNativePlaylistAt = Date.now();
    }
    if (haveAdTags) {
        // Bounce-tolerant reset: keep PendingAdEndAt alive across short flips back to ad-marked
        // so the slow-path max-wait gate can still fire when bouncing markers prevent
        // CleanPlaylistCount from reaching threshold. Mirrors TTV-AB v6.6.7 #1.
        const adEndStalenessMs = 12000;
        if (streamInfo.PendingAdEndAt && Date.now() - streamInfo.PendingAdEndAt < adEndStalenessMs) {
            streamInfo.AdEndBounceCount = (streamInfo.AdEndBounceCount || 0) + 1;
        } else {
            streamInfo.PendingAdEndAt = 0;
            streamInfo.AdEndBounceCount = 0;
        }
        streamInfo.CleanPlaylistCount = 0;
        streamInfo.IsMidroll = textStr.includes('"MIDROLL"') || textStr.includes('"midroll"');
        if (!streamInfo.IsShowingAd) {
            streamInfo.IsShowingAd = true;
            streamInfo.AdBreakStartedAt = Date.now();
            const podLengthMatch = textStr.match(/X-TV-TWITCH-AD-POD-LENGTH="(\d+)"/);
            const podLength = podLengthMatch ? parseInt(podLengthMatch[1], 10) : 1;
            // Reset early-reload state for new ad break; allow up to one early reload per ad in pod
            streamInfo.PodLength = podLength;
            streamInfo.EarlyReloadTriggered = false;
            streamInfo.EarlyReloadCount = 0;
            streamInfo.EarlyReloadAtPoll = 0;
            // Track high-confidence ad markers to distinguish real ads from false-positive signifier matches
            streamInfo.HasConfirmedAdAttrs =
                textStr.includes('X-TV-TWITCH-AD-AD-SESSION-ID') || textStr.includes('X-TV-TWITCH-AD-RADS-TOKEN');
            streamInfo.CycleRescuedThisBreak = false;
            streamInfo.LastCommittedBackupPlayerType = null;
            streamInfo.FreezeStartedAt = 0;
            streamInfo.CsaiOnlyThisBreak = false; // Reset sticky CSAI flag for new break
            console.log(
                '[AD DEBUG] Ad detected — type: ' +
                    (streamInfo.IsMidroll ? 'midroll' : 'preroll') +
                    ', channel: ' +
                    streamInfo.ChannelName +
                    ', pod: ' +
                    podLength +
                    ' ad(s) (~' +
                    podLength * 30 +
                    's expected), signifiers: ' +
                    getMatchedAdSignifiers(textStr).join(', '),
            );
            postToPage({
                key: 'UpdateAdBlockBanner',
                isMidroll: streamInfo.IsMidroll,
                hasAds: streamInfo.IsShowingAd,
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
            setTimeout(() => notifyAdComplete(textStr, streamInfo), 0);
        }
        if (!streamInfo.IsMidroll) {
            const lines = textStr.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (line.startsWith('#EXTINF') && lines.length > i + 1) {
                    if (!line.includes(',live') && !streamInfo.RequestedAds.has(lines[i + 1])) {
                        // Only request one .ts file per .m3u8 request to avoid making too many requests
                        streamInfo.RequestedAds.add(lines[i + 1]);
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
            return stripAdSegments(textStr, false, streamInfo);
        }
        // AV1 parity: v68.5.0 added AV1 ('av0*') to the ModifiedM3U8 build on the master
        // side, but this media-playlist trigger still only matched hev/hvc — so a
        // native-AV1 stream built the AVC swap and then never reloaded onto it, playing
        // AV1 straight into the strip path. Ported from testing v674.
        const currentCodecFamily = videoCodecFamily(currentResolution.Codecs);
        const isEnhanced = currentCodecFamily === 'hevc' || currentCodecFamily === 'av1';
        // Post-ad reload-loop guard: at end of break, IsUsingModifiedM3U8 is reset to false.
        // If post-ad continuation markers arrive within ~8s, the next ad-detect fires the
        // HEVC reload AGAIN because the !IsUsingModifiedM3U8 condition is satisfied — causing
        // a redundant player teardown/rebuild cycle ~seconds after the previous reload
        // already settled. Skip the reload if we just reloaded recently; the backup-stream
        // path will handle this break instead.
        const postAdReentryGuardMs = 8000;
        const recentlyReloaded =
            streamInfo.LastPlayerReload && Date.now() - streamInfo.LastPlayerReload < postAdReentryGuardMs;
        if (
            ((isEnhanced && !state.SkipPlayerReloadOnHevc) || state.AlwaysReloadPlayerOnAd) &&
            streamInfo.ModifiedM3U8 &&
            !streamInfo.IsUsingModifiedM3U8 &&
            !recentlyReloaded
        ) {
            streamInfo.IsUsingModifiedM3U8 = true;
            streamInfo.LastPlayerReload = Date.now();
            postToPage({
                key: 'ReloadPlayer',
            });
        }
        // Sticky CSAI fast path: if a prior poll in THIS break already confirmed the break
        // is CSAI-only (all segments live on poll 1), stay on the fast path for the rest
        // of the break. stripAdSegments still handles any real EXTINF ad segments that
        // show up on later polls (they get cached and the fetch hook returns BLANK_MP4),
        // so ads are blocked even without the backup switch. Skipping backup search for
        // the whole CSAI break saves ~20 wasted fetches per break — the backup wouldn't
        // help anyway since every player type has the same CSAI ads. Flag is cleared
        // only at break end (IsShowingAd=false path).
        // Sticky CSAI escape hatch (PreferLowQualityBackup): if the sticky path has
        // been stuck in all-stripped state for too long (~8s), fall through to backup
        // search. Gives heavy-SSAI channels a way out of the sticky freeze by trying
        // Source backups + autoplay fallback instead of sitting in recovery loop.
        if (
            state.PreferLowQualityBackup &&
            streamInfo.CsaiOnlyThisBreak &&
            (streamInfo.ConsecutiveAllStrippedPolls || 0) >= 4
        ) {
            const stuckPolls = streamInfo.ConsecutiveAllStrippedPolls;
            const recoveryCacheSize = streamInfo.RecoverySegments?.length || 0;
            const earlyReloadInfo = (streamInfo.EarlyReloadCount || 0) + '/' + Math.max(1, streamInfo.PodLength || 1);
            console.log(
                '[AD DEBUG] Sticky CSAI escape hatch — stuck ' +
                    stuckPolls +
                    ' polls (~' +
                    stuckPolls * 2 +
                    's), EarlyReloadCount=' +
                    earlyReloadInfo +
                    ', recovery cache=' +
                    recoveryCacheSize +
                    ' segments, falling through to backup search',
            );
            streamInfo.CsaiOnlyThisBreak = false;
            streamInfo.EscapeHatchFired = true;
        }
        if (streamInfo.CsaiOnlyThisBreak && !streamInfo.IsUsingModifiedM3U8) {
            if (state.IsAdStrippingEnabled) {
                textStr = stripAdSegments(textStr, false, streamInfo);
            }
            // Early reload during prolonged freeze — mirrors the check in the normal
            // backup-search path (line ~952) which we'd otherwise skip entirely by
            // returning early from the sticky path. Without this, heavy SSAI breaks
            // on CSAI-confirmed streams leave the player replaying the thin recovery
            // cache for the full break duration (observed: 35.9s freeze on pod-1
            // break, 3 all-stripped polls, 1-segment recovery cache).
            // Bounded to maxEarlyReloads per ad in pod so reload loops are impossible.
            // Check early reload result from previous poll (sticky path returns before the normal-path check)
            if (streamInfo.EarlyReloadAwaitingResult) {
                streamInfo.EarlyReloadAwaitingResult = false;
                console.log('[AD DEBUG] Early reload result (sticky path): still ads — continuing recovery loop');
                streamInfo.EarlyReloadTriggered = false;
            }
            const stickyRecoveryThin = (streamInfo.RecoverySegments?.length || 0) < 3;
            const stickyMaxEarlyReloads = stickyRecoveryThin
                ? Math.max(2, streamInfo.PodLength || 1)
                : Math.max(1, streamInfo.PodLength || 1);
            const stickyEffectiveThreshold = stickyRecoveryThin ? 1 : state.EarlyReloadPollThreshold;
            if (
                state.EarlyReloadPollThreshold > 0 &&
                (streamInfo.ConsecutiveAllStrippedPolls || 0) >= stickyEffectiveThreshold &&
                !streamInfo.EarlyReloadTriggered &&
                (streamInfo.EarlyReloadCount || 0) < stickyMaxEarlyReloads
            ) {
                streamInfo.EarlyReloadTriggered = true;
                streamInfo.EarlyReloadAwaitingResult = true;
                streamInfo.EarlyReloadCount = (streamInfo.EarlyReloadCount || 0) + 1;
                streamInfo.EarlyReloadAtPoll =
                    streamInfo.TotalAllStrippedPolls || streamInfo.ConsecutiveAllStrippedPolls;
                const stickyReason = stickyRecoveryThin
                    ? ' (thin recovery cache: ' + (streamInfo.RecoverySegments?.length || 0) + ' segments)'
                    : '';
                console.log(
                    '[AD DEBUG] Early reload triggered (sticky path) — ' +
                        streamInfo.ConsecutiveAllStrippedPolls +
                        ' consecutive all-stripped polls' +
                        stickyReason +
                        ' [' +
                        streamInfo.EarlyReloadCount +
                        '/' +
                        stickyMaxEarlyReloads +
                        ']',
                );
                postToPage({ key: 'ReloadPlayer', kind: 'early' });
            }
            postToPage({
                key: 'UpdateAdBlockBanner',
                isMidroll: streamInfo.IsMidroll,
                hasAds: streamInfo.IsShowingAd,
                isStrippingAdSegments: streamInfo.IsStrippingAdSegments,
                numStrippedAdSegments: streamInfo.NumStrippedAdSegments,
                activeBackupPlayerType: null,
            });
            return textStr;
        }
        // CSAI fast path: if all segments in the main stream are live, skip backup search.
        // CSAI ads are delivered outside the m3u8 — the main stream segments are clean.
        // Just strip tracking URLs and return the main stream directly, avoiding the
        // backup stream switch that causes a 20-40s rebuffer gap.
        const mainStreamLines = textStr.split(/\r?\n/);
        let hasNonLiveSegment = false;
        for (let i = 0; i < mainStreamLines.length; i++) {
            if (mainStreamLines[i].startsWith('#EXTINF') && !mainStreamLines[i].includes(',live')) {
                hasNonLiveSegment = true;
                break;
            }
        }
        // BackupSwapFirst (opt-in): skip sticky CSAI path entirely, always fall through to
        // backup search on ad detect. Mimics TTV-AB's backup-swap-first flow — avoids
        // MediaSource mixing from strip activity (no BLANK_MP4 injection, no recovery
        // segment replay), which users report produces fewer loading circles. Cost: extra
        // fetches on every ad break (token requests for each backup type tried).
        if (!hasNonLiveSegment && !streamInfo.IsUsingModifiedM3U8 && !state.BackupSwapFirst) {
            streamInfo.CsaiOnlyThisBreak = true; // Mark break as confirmed CSAI so subsequent polls stay on the fast path
            console.log('[AD DEBUG] CSAI fast path — all segments live, skipping backup search');
            if (state.IsAdStrippingEnabled) {
                textStr = stripAdSegments(textStr, false, streamInfo);
            }
            postToPage({
                key: 'UpdateAdBlockBanner',
                isMidroll: streamInfo.IsMidroll,
                hasAds: streamInfo.IsShowingAd,
                isStrippingAdSegments: streamInfo.IsStrippingAdSegments,
                numStrippedAdSegments: streamInfo.NumStrippedAdSegments,
                activeBackupPlayerType: null,
            });
            return textStr;
        }
        const backupSearchStart = Date.now();
        let backupColdTokenFetches = 0; // diag: cold-cache token round-trips this backup search (0 = warm — encodings cache hit)
        let backupPlayerType: PlayerType | null = null;
        let backupM3u8: string | null = null;
        let fallbackM3u8 = null;
        let startIndex = 0;
        let isDoingMinimalRequests = false;
        if (streamInfo.LastPlayerReload > Date.now() - state.PlayerReloadMinimalRequestsTime) {
            // When doing player reload there are a lot of requests which causes the backup stream to load in slow. Briefly prefer using a single version to prevent long delays
            startIndex = state.PlayerReloadMinimalRequestsPlayerIndex;
            isDoingMinimalRequests = true;
        }
        // Try pinned backup player type first if available
        // When PreferLowQualityBackup is enabled, append 'autoplay' (360p) as a last-resort
        // fallback — mirrors pixeltris's original behavior. Source backups are tried first;
        // autoplay only kicks in when they're all ad-laden. Keeps Source quality when
        // available while guaranteeing a clean backup for heavy SSAI breaks.
        const playerTypesToTry = state.PreferLowQualityBackup
            ? [...state.BackupPlayerTypes, 'autoplay']
            : [...state.BackupPlayerTypes];
        if (streamInfo.PinnedBackupPlayerType) {
            const pinnedIndex = playerTypesToTry.indexOf(streamInfo.PinnedBackupPlayerType);
            if (pinnedIndex > 0) {
                playerTypesToTry.splice(pinnedIndex, 1);
                playerTypesToTry.unshift(streamInfo.PinnedBackupPlayerType);
            }
        }
        // FastAutoplayFirstTry: when the immediately prior break committed autoplay via
        // PreferLowQualityBackup escape hatch (all 4 Source types contaminated), this
        // channel is currently SSAI-uniform — Source-tier probes are wasted ~1.5s of
        // buffering. Try autoplay first instead. If autoplay is contaminated this time,
        // iteration falls through to the rest of playerTypesToTry as normal. If a
        // Source-tier type wins (channel recovered), the "Source committed" branch
        // below resets LastBreakUsedEscapeHatch so the next break does normal iteration.
        // Default on as of v67.1.0. Opt-out via twitchAdSolutions_fastAutoplayFirstTry=false.
        //
        // Periodic re-probe: every Nth consecutive fast-autoplay win, force a full
        // Source-tier probe to catch channel recovery (e.g., Twitch reverses universal
        // CSAI delivery). Without this, once a channel hits fast-autoplay it stays on
        // 360p for the entire session — Source-tier is never re-tested so we'd miss
        // a Source-clean break. Costs ~1.5-2s of probe-loop once every N breaks; N=5
        // means ~25-50min between re-probes at typical break density.
        if (state.FastAutoplayFirstTry && streamInfo.LastBreakUsedEscapeHatch && state.PreferLowQualityBackup) {
            const FastAutoplayReprobeInterval = 5;
            const consecutive = streamInfo.FastAutoplayConsecutive || 0;
            if (consecutive >= FastAutoplayReprobeInterval) {
                // Re-probe: skip the autoplay reorder this break — let Source-tier be
                // tested. Reset counter; if Source-tier still all ad-laden, the autoplay
                // commit path below will set LastBreakUsedEscapeHatch=true again and the
                // cycle resumes. If Source-tier wins, LastBreakUsedEscapeHatch clears.
                streamInfo.FastAutoplayConsecutive = 0;
                if (!streamInfo.LoggedFastAutoplayReprobeThisBreak) {
                    streamInfo.LoggedFastAutoplayReprobeThisBreak = true;
                    console.log(
                        '[AD DEBUG] Fast-autoplay re-probe — testing Source-tier after ' +
                            consecutive +
                            ' consecutive fast-autoplay breaks (channel-recovery check)',
                    );
                }
            } else {
                const autoplayIdx = playerTypesToTry.indexOf('autoplay');
                if (autoplayIdx > 0) {
                    playerTypesToTry.splice(autoplayIdx, 1);
                    playerTypesToTry.unshift('autoplay');
                    if (!streamInfo.LoggedFastAutoplayThisBreak) {
                        streamInfo.LoggedFastAutoplayThisBreak = true;
                        console.log(
                            '[AD DEBUG] Fast-autoplay first-try — prior break exhausted Source-tier; probing autoplay first',
                        );
                    }
                }
            }
        }
        // Real-time contamination reorder: on poll 2+ of a break, move types that were
        // already logged as ad-laden earlier in the same break to the end of iteration.
        // Lets untried/clean types (typically autoplay on SSAI-heavy channels like warn)
        // get tried first instead of re-checking types we already know are contaminated.
        // LoggedBackupAdsByType is populated below at the "also has ads" log site and
        // cleared at end-of-break, so this is per-break adaptive.
        if (streamInfo.LoggedBackupAdsByType && streamInfo.LoggedBackupAdsByType.size > 0) {
            const clean = [];
            const contam = [];
            for (const t of playerTypesToTry) {
                if (streamInfo.LoggedBackupAdsByType.has(t)) contam.push(t);
                else clean.push(t);
            }
            if (contam.length > 0 && clean.length > 0) {
                playerTypesToTry.length = 0;
                playerTypesToTry.push(...clean, ...contam);
                if (!streamInfo.LoggedContamReorderThisBreak) {
                    streamInfo.LoggedContamReorderThisBreak = true;
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
        for (
            let playerTypeIndex = startIndex;
            !backupM3u8 && playerTypeIndex < playerTypesToTry.length;
            playerTypeIndex++
        ) {
            const playerType = playerTypesToTry[playerTypeIndex];
            const realPlayerType = playerType.replace('-CACHED', '');
            const failedAt = streamInfo.FailedBackupPlayerTypes.get(realPlayerType);
            // 5s (was 15s): in the CSAI-flip world a contaminated backup type can
            // recover within seconds; the 15s lockout kept us off a now-clean type far
            // too long (TTV-AB/GosuDRM v8.0.0 "reduced ad-induced stalling"). Tradeoff:
            // ~3x more retry fetches — watched via the cold/warm token-fetch log (#228).
            if (failedAt && Date.now() - failedAt < 5000) {
                continue;
            }
            const isFullyCachedPlayerType = playerType !== realPlayerType;
            for (let i = 0; i < 2; i++) {
                // This caches the m3u8 if it doesn't have ads. If the already existing cache has ads it fetches a new version (second loop)
                let isFreshM3u8 = false;
                let encodingsM3u8 = streamInfo.BackupEncodingsM3U8Cache[playerType];
                if (!encodingsM3u8) {
                    isFreshM3u8 = true;
                    backupColdTokenFetches++;
                    try {
                        const accessTokenResponse = await getAccessToken(streamInfo.ChannelName, realPlayerType);
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
                                        realPlayerType +
                                        '. Response keys: ' +
                                        JSON.stringify(Object.keys(accessToken || {})) +
                                        errInfo,
                                );
                                streamInfo.FailedBackupPlayerTypes.set(realPlayerType, Date.now());
                                streamInfo.ConsecutiveTokenFetchFailures =
                                    (streamInfo.ConsecutiveTokenFetchFailures || 0) + 1;
                                if (
                                    streamInfo.ConsecutiveTokenFetchFailures >= 3 &&
                                    !streamInfo.LoggedTokenFailureStreak
                                ) {
                                    streamInfo.LoggedTokenFailureStreak = true;
                                    console.log(
                                        '[AD DEBUG] Token fetch failed ' +
                                            streamInfo.ConsecutiveTokenFetchFailures +
                                            ' times consecutively across player types — possible Twitch detection / integrity rotation / rate limiting',
                                    );
                                }
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
                                console.log(
                                    '[AD DEBUG] Usher HTTP ' + encodingsM3u8Response.status + ' for ' + realPlayerType,
                                );
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
                                    realPlayerType +
                                    (accessTokenResponse.status === 403
                                        ? ' (integrity: ' + (state.ClientIntegrityHeader ? 'present' : 'missing') + ')'
                                        : '') +
                                    errorBody,
                            );
                            streamInfo.FailedBackupPlayerTypes.set(realPlayerType, Date.now());
                            streamInfo.ConsecutiveTokenFetchFailures =
                                (streamInfo.ConsecutiveTokenFetchFailures || 0) + 1;
                            if (streamInfo.ConsecutiveTokenFetchFailures >= 3 && !streamInfo.LoggedTokenFailureStreak) {
                                streamInfo.LoggedTokenFailureStreak = true;
                                console.log(
                                    '[AD DEBUG] Token fetch failed ' +
                                        streamInfo.ConsecutiveTokenFetchFailures +
                                        ' times consecutively across player types — possible Twitch detection / integrity rotation / rate limiting',
                                );
                            }
                        }
                    } catch (err) {
                        console.log(
                            '[AD DEBUG] Access token failed for ' + realPlayerType + ': ' + (err as Error).message,
                        );
                        streamInfo.FailedBackupPlayerTypes.set(realPlayerType, Date.now());
                        streamInfo.ConsecutiveTokenFetchFailures = (streamInfo.ConsecutiveTokenFetchFailures || 0) + 1;
                        if (streamInfo.ConsecutiveTokenFetchFailures >= 3 && !streamInfo.LoggedTokenFailureStreak) {
                            streamInfo.LoggedTokenFailureStreak = true;
                            console.log(
                                '[AD DEBUG] Token fetch failed ' +
                                    streamInfo.ConsecutiveTokenFetchFailures +
                                    ' times consecutively across player types — possible Twitch detection / integrity rotation / rate limiting',
                            );
                        }
                    }
                }
                if (encodingsM3u8) {
                    try {
                        const streamM3u8Url = getStreamUrlForResolution(encodingsM3u8, currentResolution);
                        if (!streamM3u8Url) {
                            // Previously fetch(null), which threw on the blob-relative URL; same catch below, clearer message.
                            throw new Error('no variant playlist in the backup encodings');
                        }
                        const streamM3u8Response = await realFetch(streamM3u8Url);
                        if (streamM3u8Response.status === 200) {
                            const m3u8Text = await streamM3u8Response.text();
                            if (m3u8Text) {
                                if (playerType === state.FallbackPlayerType) {
                                    fallbackM3u8 = m3u8Text;
                                }
                                if (
                                    (!hasAdTags(m3u8Text) &&
                                        (state.SimulatedAdsDepth === 0 ||
                                            playerTypeIndex >= state.SimulatedAdsDepth - 1)) ||
                                    (!fallbackM3u8 && playerTypeIndex >= playerTypesToTry.length - 1)
                                ) {
                                    if ((streamInfo.ConsecutiveAllStrippedPolls || 0) >= 1 && !hasAdTags(m3u8Text)) {
                                        const prevType = streamInfo.LastCommittedBackupPlayerType;
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
                                            streamInfo.CycleRescuedThisBreak = true;
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
                                    break;
                                }
                                if (hasAdTags(m3u8Text)) {
                                    if (!streamInfo.LoggedBackupAdsByType) streamInfo.LoggedBackupAdsByType = new Set();
                                    if (!streamInfo.LoggedBackupAdsByType.has(playerType)) {
                                        streamInfo.LoggedBackupAdsByType.add(playerType);
                                        console.log('[AD DEBUG] Backup stream (' + playerType + ') also has ads');
                                    }
                                }
                                if (isFullyCachedPlayerType || isDoingMinimalRequests) {
                                    backupPlayerType = playerType;
                                    backupM3u8 = m3u8Text;
                                    break;
                                }
                                // Cycle through all player types looking for a clean backup. Only commit
                                // an ad-laden backup as a last resort when we've exhausted all options.
                                // PR #89 previously committed the first ad-laden type immediately — that
                                // caused the v58 freeze regression (issue #112) because the strip+recovery
                                // loop would engage even when a clean alternate was available on another
                                // player type.
                                if (hasAdTags(m3u8Text) && playerTypeIndex >= playerTypesToTry.length - 1) {
                                    console.log(
                                        '[AD DEBUG] All backup player types ad-laden — taking ' +
                                            playerType +
                                            ' as last-resort fallback (strip+recovery path will engage)',
                                    );
                                    backupPlayerType = playerType;
                                    backupM3u8 = m3u8Text;
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
            // Don't fall back to a type we've already marked contaminated this break.
            // Without this guard, when all Source types go ad-laden mid-break the iteration
            // ends with no clean commit AND fallbackM3u8 still pointing at FallbackPlayerType's
            // ad-laden m3u8 — we'd silently re-commit the same contaminated site on every poll
            // (no "Blocking ads" log because ActiveBackupPlayerType unchanged), and the user
            // sees the full ad pod with no indication of failure. Better to leave backupM3u8
            // null and let the "No ad-free backup stream found" log fire so it's visible.
            if (streamInfo.LoggedBackupAdsByType && streamInfo.LoggedBackupAdsByType.has(state.FallbackPlayerType)) {
                console.log(
                    '[AD DEBUG] Skipping fallback to ' +
                        state.FallbackPlayerType +
                        ' — marked contaminated this break (' +
                        [...streamInfo.LoggedBackupAdsByType].join(', ') +
                        ' all ad-laden)',
                );
            } else {
                backupPlayerType = state.FallbackPlayerType;
                backupM3u8 = fallbackM3u8;
            }
        }
        // Stale-commit guard: multiple processM3U8 calls can be in flight concurrently for
        // the same streamInfo (one per m3u8 poll). If this backup search started during the
        // ad break but completed AFTER a later poll already ran the end-of-break reset
        // (IsShowingAd = false, ActiveBackupPlayerType = null), committing the backup here
        // would overwrite the cleared state and feed stale playlist data to the player,
        // causing buffer reconciliation failures and a forced reload. Check IsShowingAd
        // here to discard stale results.
        if (backupM3u8 && backupPlayerType && streamInfo.IsShowingAd) {
            textStr = backupM3u8;
            streamInfo.LastCommittedBackupPlayerType = backupPlayerType;
            if (streamInfo.ActiveBackupPlayerType !== backupPlayerType) {
                streamInfo.ActiveBackupPlayerType = backupPlayerType;
                const sourceQualityTypes = ['embed', 'site', 'popout'];
                // Never pin 'autoplay'. PreferLowQualityBackup keeps autoplay as the LAST
                // entry in playerTypesToTry so the iteration-end last-resort branch can
                // commit it when all Source types are ad-laden. Pinning autoplay would
                // move it to position 0, which makes the last-resort branch commit a
                // different ad-laden Source type at the new last position instead — user
                // gets a Source-tier ad-marked backup (strip+recovery path engages,
                // freezes likely) instead of the intended 360p clean autoplay backup.
                if (
                    (state.PinBackupPlayerType && backupPlayerType !== 'autoplay') ||
                    sourceQualityTypes.includes(backupPlayerType)
                ) {
                    streamInfo.PinnedBackupPlayerType = backupPlayerType;
                }
                console.log(
                    `[AD DEBUG] Blocking${streamInfo.IsMidroll ? ' midroll ' : ' '}ads (${backupPlayerType}) — backup found in ${Date.now() - backupSearchStart}ms${backupColdTokenFetches > 0 ? ` (cold cache: ${backupColdTokenFetches} token fetch${backupColdTokenFetches > 1 ? 'es' : ''})` : ' (warm cache)'}`,
                );
                if (streamInfo.EscapeHatchFired) {
                    const qualityTier = backupPlayerType === 'autoplay' ? '360p' : 'Source';
                    console.log(
                        '[AD DEBUG] Post-escape backup: ' +
                            backupPlayerType +
                            ' (' +
                            qualityTier +
                            ') — recovered from sticky-path freeze',
                    );
                } else if (backupPlayerType === 'autoplay' && state.PreferLowQualityBackup) {
                    const sourceTried = streamInfo.LoggedBackupAdsByType?.size || 0;
                    if (sourceTried === 0) {
                        console.log(
                            '[AD DEBUG] Autoplay backup committed — 360p pinned from prior break (PreferLowQualityBackup)',
                        );
                        // Fast-autoplay won without testing Source-tier — increment re-probe counter
                        streamInfo.FastAutoplayConsecutive = (streamInfo.FastAutoplayConsecutive || 0) + 1;
                    } else {
                        console.log(
                            '[AD DEBUG] Autoplay backup committed — 360p fallback after ' +
                                sourceTried +
                                ' Source type(s) ad-laden (PreferLowQualityBackup)',
                        );
                    }
                    // FastAutoplayFirstTry: only flag the channel as SSAI-uniform when 4 Source
                    // types were probed and all contaminated. The "0 sourceTried" case (pinned
                    // from prior break) doesn't add new information.
                    if (state.FastAutoplayFirstTry && sourceTried >= 4) {
                        streamInfo.LastBreakUsedEscapeHatch = true;
                        // Full probe just ran — reset re-probe counter (we just tested Source-tier)
                        streamInfo.FastAutoplayConsecutive = 0;
                    }
                } else if (state.FastAutoplayFirstTry && backupPlayerType !== 'autoplay') {
                    // Source-tier type committed cleanly — channel recovered. Reset the
                    // SSAI-uniform signal so next break does normal iteration. Also reset
                    // the re-probe counter since we just got a Source-tier win.
                    streamInfo.LastBreakUsedEscapeHatch = false;
                    streamInfo.FastAutoplayConsecutive = 0;
                }
            }
        } else if (backupM3u8 && !streamInfo.IsShowingAd) {
            console.log(
                '[AD DEBUG] Discarded stale backup commit (' +
                    backupPlayerType +
                    ', ' +
                    (Date.now() - backupSearchStart) +
                    'ms) — break ended during search',
            );
        } else {
            console.log(
                '[AD DEBUG] No ad-free backup stream found — ads may leak. Tried: ' +
                    playerTypesToTry.slice(startIndex).join(', '),
            );
        }
        // TODO: Improve hevc stripping. It should always strip when there is a codec mismatch (both ways)
        const stripEnhanced = !!(isEnhanced && streamInfo.ModifiedM3U8);
        if (state.IsAdStrippingEnabled || stripEnhanced) {
            textStr = stripAdSegments(textStr, stripEnhanced, streamInfo);
        } else if (!backupM3u8) {
            console.log('[AD DEBUG] Ad stripping disabled and no backup — ads WILL show');
        }
        // Log reload outcome on the poll after early reload triggered
        if (streamInfo.EarlyReloadAwaitingResult) {
            streamInfo.EarlyReloadAwaitingResult = false;
            if (textStr.includes(',live') && streamInfo.IsStrippingAdSegments) {
                console.log('[AD DEBUG] Early reload result: partial — some live segments returned');
            } else if (!streamInfo.IsStrippingAdSegments) {
                console.log('[AD DEBUG] Early reload result: clean — freeze ended');
                // Reset trigger flag so subsequent freezes within the same pod can re-fire (bounded by EarlyReloadCount/PodLength)
                streamInfo.EarlyReloadTriggered = false;
            } else {
                console.log('[AD DEBUG] Early reload result: still ads — continuing recovery loop');
                streamInfo.EarlyReloadTriggered = false;
            }
        }
        // Early reload during prolonged freeze: if we've been looping recovery segments
        // for N+ polls (~Nx2s), trigger a reload to attempt fresh content. Bounded to one
        // reload per ad in the pod (e.g. 2-ad pod = up to 2 early reloads).
        const recoveryThin = (streamInfo.RecoverySegments?.length || 0) < 3;
        const maxEarlyReloads = recoveryThin
            ? Math.max(2, streamInfo.PodLength || 1)
            : Math.max(1, streamInfo.PodLength || 1);
        const effectiveThreshold = recoveryThin ? 1 : state.EarlyReloadPollThreshold;
        if (
            state.EarlyReloadPollThreshold > 0 &&
            (streamInfo.ConsecutiveAllStrippedPolls || 0) >= effectiveThreshold &&
            !streamInfo.EarlyReloadTriggered &&
            (streamInfo.EarlyReloadCount || 0) < maxEarlyReloads
        ) {
            streamInfo.EarlyReloadTriggered = true;
            streamInfo.EarlyReloadAwaitingResult = true;
            streamInfo.EarlyReloadCount = (streamInfo.EarlyReloadCount || 0) + 1;
            streamInfo.EarlyReloadAtPoll = streamInfo.TotalAllStrippedPolls || streamInfo.ConsecutiveAllStrippedPolls;
            const reason = recoveryThin
                ? ' (thin recovery cache: ' + (streamInfo.RecoverySegments?.length || 0) + ' segments)'
                : '';
            console.log(
                '[AD DEBUG] Early reload triggered — ' +
                    streamInfo.ConsecutiveAllStrippedPolls +
                    ' consecutive all-stripped polls' +
                    reason +
                    ' [' +
                    streamInfo.EarlyReloadCount +
                    '/' +
                    maxEarlyReloads +
                    ']',
            );
            postToPage({ key: 'ReloadPlayer', kind: 'early' });
        }
    } else if (streamInfo.IsShowingAd) {
        // Mark first candidate-end timestamp on the first clean poll seen this break,
        // so the slow-path max-wait gate below can fire even if subsequent polls bounce
        // back to ad-marked. The bounce-tolerant haveAdTags reset keeps this alive
        // across short flips. Mirrors TTV-AB v6.6.7 #1.
        if (!streamInfo.PendingAdEndAt) {
            streamInfo.PendingAdEndAt = Date.now();
        }
        streamInfo.CleanPlaylistCount++;
        // Check if the current playlist has live segments — if not, backup stream is dead
        const hasLiveSegments = textStr.includes(',live');
        // Independent slow-path max-wait escalation — ends the visible ad cycle even when
        // marker bouncing keeps CleanPlaylistCount below threshold. Without this, the player
        // could be wedged on backup indefinitely on channels where Twitch flips markers
        // in/out faster than 3 consecutive clean polls can land. Mirrors TTV-AB v6.6.7 #4
        // ("Decoupled Slow-Path Recovery from Clean-Count").
        const adEndMaxWaitMs = 12000;
        const elapsedSinceCandidate = Date.now() - streamInfo.PendingAdEndAt;
        const slowPathReady = streamInfo.PendingAdEndAt > 0 && elapsedSinceCandidate >= adEndMaxWaitMs;
        // Require 3 consecutive clean polls before declaring ad-end. Previously only 1
        // when NumStrippedAdSegments === 0 (CSAI-only / backup-swap path) and 2 otherwise,
        // which let brief clean windows during ongoing breaks flip IsShowingAd false
        // prematurely on SSAI-uniform channels. TTV-AB hit the same false-positive at 2
        // probes and bumped to 3 in v6.6.7 ("Ad-End Re-Entry Stability") — Twitch can
        // serve a clean playlist mid-break before re-injecting markers, and 2 polls
        // (~4s) wasn't always enough to ride out the bounce.
        if (streamInfo.CleanPlaylistCount >= 3 || !hasLiveSegments || slowPathReady) {
            if (slowPathReady && streamInfo.CleanPlaylistCount < 3) {
                console.log(
                    '[AD DEBUG] Slow-path ad-end escalation — ' +
                        (streamInfo.AdEndBounceCount || 0) +
                        ' marker bounces, ' +
                        (elapsedSinceCandidate / 1000).toFixed(1) +
                        's since first clean poll',
                );
            }
            if (!hasLiveSegments) {
                console.log('[AD DEBUG] Backup stream has no live segments — forcing immediate reload');
            }
            const adBreakDurationSec = streamInfo.AdBreakStartedAt
                ? ((Date.now() - streamInfo.AdBreakStartedAt) / 1000).toFixed(1)
                : '?';
            console.log(
                '[AD DEBUG] Finished blocking ads — stripped ' +
                    streamInfo.NumStrippedAdSegments +
                    ' ad segments, duration: ' +
                    adBreakDurationSec +
                    's',
            );
            if (streamInfo.TotalAllStrippedPolls > 0) {
                const reloadInfo = streamInfo.EarlyReloadAtPoll
                    ? ', early reload at poll ' + streamInfo.EarlyReloadAtPoll
                    : '';
                const wallClockFreeze = streamInfo.FreezeStartedAt
                    ? ((Date.now() - streamInfo.FreezeStartedAt) / 1000).toFixed(1) + 's wall-clock'
                    : 'unknown';
                console.log(
                    '[AD DEBUG] Ad break stats: ' +
                        streamInfo.TotalAllStrippedPolls +
                        ' all-stripped polls, freeze duration: ' +
                        wallClockFreeze +
                        reloadInfo,
                );
            }
            const hadStrippedSegments = streamInfo.NumStrippedAdSegments > 0;
            // Only count toward false-positive guard if the m3u8 lacked high-confidence ad markers.
            // Confirmed ads (with X-TV-TWITCH-AD-AD-SESSION-ID etc.) that produce 0 strips are real ads
            // we successfully avoided via clean backup — not false positives.
            if (!hadStrippedSegments && !streamInfo.HasConfirmedAdAttrs) {
                streamInfo.ConsecutiveZeroStripBreaks++;
                if (streamInfo.ConsecutiveZeroStripBreaks >= 3) {
                    console.log(
                        '[AD DEBUG] Warning: ' +
                            streamInfo.ConsecutiveZeroStripBreaks +
                            ' consecutive unconfirmed ad breaks with 0 segments stripped — possible false positive from ad signifiers',
                    );
                }
            } else if (hadStrippedSegments || streamInfo.HasConfirmedAdAttrs) {
                // Reset is symmetric with the increment guard above — any positive "break
                // was handled cleanly" signal resets the false-positive history. Previously
                // only stripped>0 reset the counter, which let stale suspicious history
                // bleed across legitimately-handled backup-swap breaks (0 stripped + real
                // ad attrs) and trigger the warning on partially-stale state.
                streamInfo.ConsecutiveZeroStripBreaks = 0;
            }
            streamInfo.IsShowingAd = false;
            streamInfo.IsStrippingAdSegments = false;
            streamInfo.NumStrippedAdSegments = 0;
            streamInfo.ActiveBackupPlayerType = null;
            streamInfo.RequestedAds?.clear?.();
            streamInfo.SpoofedAdIds?.clear?.(); // New break = fresh ad-spoof dedup set
            streamInfo.FailedBackupPlayerTypes?.clear?.();
            if (streamInfo.LoggedBackupAdsByType) streamInfo.LoggedBackupAdsByType.clear();
            streamInfo.LoggedContamReorderThisBreak = false;
            streamInfo.CleanPlaylistCount = 0;
            streamInfo.PendingAdEndAt = 0;
            streamInfo.AdEndBounceCount = 0;
            streamInfo.ConsecutiveAllStrippedPolls = 0;
            streamInfo.EarlyReloadTriggered = false;
            streamInfo.EarlyReloadAwaitingResult = false;
            streamInfo.EarlyReloadAtPoll = 0;
            streamInfo.TotalAllStrippedPolls = 0;
            streamInfo.CsaiOnlyThisBreak = false;
            streamInfo.EscapeHatchFired = false;
            streamInfo.HasLoggedAdAttributes = false;
            streamInfo.HasLoggedUnknownSignifiers = false;
            streamInfo.LoggedFastAutoplayThisBreak = false;
            streamInfo.LoggedFastAutoplayReprobeThisBreak = false;
            // CSAI-only ad break: no segments were stripped — skip reload entirely.
            if (!hadStrippedSegments) {
                console.log('[AD DEBUG] CSAI-only ad break (stripped 0) — clearing backup without player action');
                streamInfo.IsUsingModifiedM3U8 = false;
                // Exception: if ANY backup was committed during this break (escape hatch
                // or cycle rescue that didn't meet cycleRescuedCleanly criteria), the
                // MediaSource buffer has accumulated mixed-source segments (backup-fetched
                // via alternate player-type access token + native-fetched). Mixing can
                // cause audio/video track timestamps to diverge, and without a reload the
                // drift compounds across subsequent escape-hatch breaks. Force a hard reload
                // to flush the MediaSource buffer + refresh the access token.
                // For autoplay (360p) specifically, the reload also restores Source
                // quality (autoplay-scoped token only serves 360p variant ladder).
                if (streamInfo.LastCommittedBackupPlayerType) {
                    const isAutoplay = streamInfo.LastCommittedBackupPlayerType === 'autoplay';
                    const reason = isAutoplay
                        ? 'autoplay (360p) — restoring Source quality'
                        : streamInfo.LastCommittedBackupPlayerType +
                          ' — flushing MediaSource to prevent A/V desync accumulation';
                    console.log('[AD DEBUG] End-of-break reload: ' + reason);
                    streamInfo.LastPlayerReload = Date.now();
                    if (!streamInfo.ReloadTimestamps) streamInfo.ReloadTimestamps = [];
                    streamInfo.ReloadTimestamps.push(Date.now());
                    postToPage({ key: 'ReloadPlayer', kind: 'early' });
                }
            } else {
                // Auto-escalate cooldown: if 3+ reloads in last 5 min, triple the cooldown
                if (!streamInfo.ReloadTimestamps) streamInfo.ReloadTimestamps = [];
                streamInfo.ReloadTimestamps = streamInfo.ReloadTimestamps.filter((t) => Date.now() - t < 300000);
                const recentReloads = streamInfo.ReloadTimestamps.filter((t) => Date.now() - t < 300000).length;
                const effectiveCooldown =
                    recentReloads >= 3 ? state.ReloadCooldownSeconds * 3 : state.ReloadCooldownSeconds;
                const tooSoonSinceLastReload =
                    streamInfo.LastPlayerReload && Date.now() - streamInfo.LastPlayerReload < effectiveCooldown * 1000;
                // Skip end-of-break reload when cycle rescue handled the break cleanly:
                // a freeze of ≤2 polls (~4s) was resolved by switching to a clean backup,
                // and no early reload was needed. The player is on a healthy backup stream
                // — reloading just to return to the canonical player type causes an unnecessary
                // ~1-2s loading circle.
                const cycleRescuedCleanly =
                    streamInfo.CycleRescuedThisBreak &&
                    (streamInfo.TotalAllStrippedPolls || 0) <= 2 &&
                    (streamInfo.EarlyReloadCount || 0) === 0;
                if (cycleRescuedCleanly) {
                    console.log('[AD DEBUG] Cycle rescue handled the break cleanly — skipping end-of-break reload');
                }
                // Post-ad reload bypasses cooldown: it's a buffer flush tied to natural break
                // end, not a cascade-risk retry. The ad break cycle itself rate-limits this
                // path (once per break). Cooldown still gates buffer-monitor and other
                // cascade-risk paths that can fire repeatedly in-break.
                const shouldReload =
                    streamInfo.IsUsingModifiedM3U8 ||
                    (state.ReloadPlayerAfterAd && hadStrippedSegments && !cycleRescuedCleanly);
                if (shouldReload) {
                    streamInfo.ReloadTimestamps.push(Date.now());
                    streamInfo.IsUsingModifiedM3U8 = false;
                    streamInfo.LastPlayerReload = Date.now();
                    // Hard reload when buffer may be dirty from strip or m3u8 modification —
                    // soft reload preserves the existing MediaSource buffer, and any
                    // timestamp weirdness from strip/BLANK_MP4/recovery injection persists
                    // across it, causing audio/video desync over time.
                    // Issue #129 mode D: when the break stripped NO segments (BackupSwapFirst CSAI swap),
                    // nothing was injected into the MediaSource, so the hard-reload flush is unnecessary and
                    // just pays the desktop black-screen + play-icon teardown — use a soft reload ('post-ad')
                    // there. Strip breaks stay hard ('early'). doTwitchPlayerTask maps 'post-ad' → soft.
                    const reloadKind = state.SoftReloadNoStrip && !hadStrippedSegments ? 'post-ad' : 'early';
                    postToPage({
                        key: 'ReloadPlayer',
                        kind: reloadKind,
                    });
                } else {
                    if (tooSoonSinceLastReload) {
                        console.log(
                            '[AD DEBUG] Skipping reload — last reload was ' +
                                ((Date.now() - streamInfo.LastPlayerReload) / 1000).toFixed(0) +
                                's ago (cooldown: ' +
                                effectiveCooldown +
                                's' +
                                (recentReloads >= 3
                                    ? ', auto-escalated from ' + recentReloads + ' reloads in 5min'
                                    : '') +
                                ')',
                        );
                    }
                    postToPage({
                        key: 'PauseResumePlayer',
                    });
                }
            } // end else (non-CSAI path)
        }
    }
    postToPage({
        key: 'UpdateAdBlockBanner',
        isMidroll: streamInfo.IsMidroll,
        hasAds: streamInfo.IsShowingAd,
        isStrippingAdSegments: streamInfo.IsStrippingAdSegments,
        numStrippedAdSegments: streamInfo.NumStrippedAdSegments,
        activeBackupPlayerType: streamInfo.ActiveBackupPlayerType,
    });
    return textStr;
}
