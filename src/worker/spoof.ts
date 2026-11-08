import type { AdBreak } from '../shared/types.ts';
import { parseAttributes } from './playlist.ts';
import { gqlRequest } from './gql.ts';

// Once-per-worker log guards.
let loggedNoMatch = false;
let loggedNoToken = false;
let loggedBadStatus = false;

// Spoof ad completion to Twitch's GQL endpoint when an ad break is detected.
// Twitch's player would normally fire video_ad_impression / video_ad_quartile_complete
// / video_ad_pod_complete beacons as the ad plays. With ad-blocking, those beacons
// never fire. Spoofing them mimics the "ad played normally" signal, potentially
// reducing detection escalation. RADS-token extracted from the stitched-ad DATERANGE
// line. Failures swallowed — never block normal ad-block flow.
export function notifyAdComplete(textStr: string, brk: AdBreak) {
    try {
        // Each ad in a pod has its OWN #EXT-X-DATERANGE:ID="stitched-ad-..." line
        // with its own RADS-token, ad-id, creative-id, line-item-id, position, etc.
        // Twitch reveals each ad's DATERANGE only when that ad starts playing, so a
        // 6-ad pod surfaces ONE ad per m3u8 poll across the break. This function is
        // called on every ad-laden poll; brk.SpoofedAdIds dedups across polls
        // so each ad is spoofed exactly once as it appears (full N/N pod coverage).
        const matches = [...textStr.matchAll(/#EXT-X-DATERANGE:(ID="stitched-ad-[^\n]+)\n/g)];
        if (matches.length === 0) {
            if (!loggedNoMatch) {
                loggedNoMatch = true;
                const dateRangeLine = textStr.match(/#EXT-X-DATERANGE:[^\n]{0,200}/);
                console.log(
                    '[AD DEBUG] notifyAdComplete: no stitched-ad DATERANGE match. Sample DATERANGE: ' +
                        (dateRangeLine ? dateRangeLine[0] : 'none found'),
                );
            }
            return;
        }
        const spoofedSet = brk.SpoofedAdIds;
        // True pod size from the m3u8 attribute (present on each DATERANGE); fall
        // back to visible-match count if absent. Keeps total_ads consistent across
        // all ads in the pod even though they surface one poll at a time.
        const podLenMatch = textStr.match(/X-TV-TWITCH-AD-POD-LENGTH="(\d+)"/);
        const podLength = podLenMatch ? parseInt(podLenMatch[1], 10) : matches.length;
        // Hot-path early-out: notifyAdComplete now runs every ad-laden poll, and a
        // long multi-ad break has hundreds of polls AFTER the whole pod is already
        // spoofed. Once the dedup set covers the pod, every remaining poll is pure
        // waste — bail before the per-match parseAttributes loop. (size at entry is
        // before this poll's additions, so the poll that completes the pod still
        // runs and attaches pod_complete; only subsequent polls short-circuit.)
        if (spoofedSet.size >= podLength) {
            return;
        }
        let newSpoofed = 0;
        let firstRollType = '';
        let podCompleteSent = false;
        for (let i = 0; i < matches.length; i++) {
            // Cheap ID pre-extract for the dedup check — the DATERANGE capture
            // always starts with ID="stitched-ad-<UUID>". Checking the dedup set
            // before the full parseAttributes() avoids re-parsing every already-
            // spoofed ad's attribute string on each poll during the spoofing phase.
            const idMatch = matches[i][1].match(/^ID="([^"]+)"/);
            const stitchedAdId = idMatch ? idMatch[1] : '';
            // Multi-poll dedup: skip ads already spoofed earlier this break.
            if (stitchedAdId && spoofedSet.has(stitchedAdId)) {
                continue;
            }
            const attr = parseAttributes(matches[i][1]);
            const radToken = attr['X-TV-TWITCH-AD-RADS-TOKEN'];
            if (!radToken) {
                if (i === 0 && !loggedNoToken) {
                    loggedNoToken = true;
                    console.log(
                        '[AD DEBUG] notifyAdComplete: matched DATERANGE but no RADS token. Attributes: ' +
                            Object.keys(attr).join(', '),
                    );
                }
                continue;
            }
            const rollType = (attr['X-TV-TWITCH-AD-ROLL-TYPE'] || '').toLowerCase();
            if (!firstRollType) firstRollType = rollType;
            // Prefer m3u8's explicit pod-position when present (e.g. X-TV-TWITCH-AD-POD-POSITION="2");
            // fall back to iteration index for older formats.
            const adPosition = parseInt(attr['X-TV-TWITCH-AD-POD-POSITION'] || String(i), 10);
            // Payload internally consistent with the events we claim happened. Sending
            // quartile_complete{4} + pod_complete = "watched 100% of the ad to completion."
            // Pairing that with mute=true / volume=0 / visible=false / duration=0 is the
            // obvious cross-validation flag if Twitch ever audits. Mirror a normal-viewer
            // state: audio on, visible, full duration. Duration comes from the m3u8
            // attribute when present (fallback 0 keeps the previous behavior if missing).
            const adDuration = parseInt(attr['X-TV-TWITCH-AD-DURATION'] || '0', 10) || 0;
            const payload = {
                stitched: true,
                ad_id: stitchedAdId,
                roll_type: rollType,
                creative_id: attr['X-TV-TWITCH-AD-CREATIVE-ID'] || '',
                order_id: attr['X-TV-TWITCH-AD-ORDER-ID'] || '',
                line_item_id: attr['X-TV-TWITCH-AD-LINE-ITEM-ID'] || '',
                player_mute: false,
                player_volume: 1.0,
                visible: true,
                duration: adDuration,
                ad_position: adPosition,
                total_ads: podLength,
            };
            // Batch all 6 events for this ad into one GQL POST. Twitch's endpoint
            // supports JSON-array batched operations natively. Reduces request count
            // 6× and avoids the bot-like fingerprint of firing 6 separate requests
            // in rapid succession.
            const makePacket: (event: string, extra?: object) => object = (event, extra) => ({
                operationName: 'ClientSideAdEventHandling_RecordAdEvent',
                variables: {
                    input: { eventName: event, eventPayload: JSON.stringify({ ...payload, ...extra }), radToken },
                },
                extensions: {
                    persistedQuery: {
                        version: 1,
                        sha256Hash: '7e6c69e6eb59f8ccb97ab73686f3d8b7d85a72a0298745ccd8bfc68e4054ca5b',
                    },
                },
            });
            // Mark this ad spoofed BEFORE building the batch so the pod-complete
            // size check below reflects it.
            if (stitchedAdId) spoofedSet.add(stitchedAdId);
            const batch = [
                makePacket('video_ad_impression'),
                makePacket('video_ad_quartile_complete', { quartile: 1 }),
                makePacket('video_ad_quartile_complete', { quartile: 2 }),
                makePacket('video_ad_quartile_complete', { quartile: 3 }),
                makePacket('video_ad_quartile_complete', { quartile: 4 }),
            ];
            // pod_complete fires ONCE per pod — not per ad. A real player sends a
            // single pod_complete after the whole pod finishes; emitting it on every
            // ad (6× for a 6-ad pod) is itself a fingerprint. Attach it to the ad
            // that brings the dedup set up to the true pod size (the last ad). If
            // the pod never fully surfaces (some DATERANGEs missed / break ended
            // early) pod_complete is correctly never sent — a real player wouldn't
            // claim pod completion it didn't reach either.
            if (spoofedSet.size === podLength) {
                batch.push(makePacket('video_ad_pod_complete'));
                podCompleteSent = true;
            }
            // Surveil GQL response status — distinguishes "spoof fired, accepted" from
            // "spoof fired, Twitch rejected" (400/403/429/5xx). The .catch only fires for
            // network errors / timeouts; non-200 status resolves normally. Without this,
            // detection escalation (Twitch starts rejecting spoof beacons) would be a
            // silent failure mode invisible in field logs. Once-per-session guard prevents
            // spam if rate-limit kicks in across consecutive breaks.
            gqlRequest(batch)
                .then((response) => {
                    if (response && response.status !== 200 && !loggedBadStatus) {
                        loggedBadStatus = true;
                        console.log(
                            '[AD DEBUG] notifyAdComplete: GQL response status ' +
                                response.status +
                                ' — spoof may be rejected/rate-limited',
                        );
                    }
                })
                .catch(() => {});
            newSpoofed++;
        }
        if (newSpoofed > 0) {
            const total = spoofedSet.size;
            // src= which stream the spoofed DATERANGEs came from (primary vs a
            // committed backup player-type) — surfaces the stream-swap ad-ID
            // mixing limitation: a pod that spoofs across primary+backup shows
            // src changing mid-pod. pod-complete= whether this poll attached the
            // single video_ad_pod_complete (lets you confirm pod completion
            // explicitly instead of inferring it from the total/POD ratio).
            const src = brk.ActiveBackupPlayerType || 'primary';
            console.log(
                '[AD DEBUG] Spoofed ad completion for ' +
                    newSpoofed +
                    ' new ad(s) (' +
                    total +
                    '/' +
                    podLength +
                    ' pod) — roll: ' +
                    firstRollType +
                    ', src: ' +
                    src +
                    ', pod-complete: ' +
                    (podCompleteSent ? 'yes' : 'no'),
            );
        }
    } catch (err) {
        console.log('[AD DEBUG] Ad completion spoof failed: ' + (err as Error).message);
    }
}
