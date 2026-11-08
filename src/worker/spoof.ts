import type { AdBreak } from '../shared/types.ts';
import { parseAttributes } from './playlist.ts';
import { gqlRequest } from './gql.ts';

let loggedNoMatch = false;
let loggedNoToken = false;
let loggedBadStatus = false;

export function notifyAdComplete(textStr: string, brk: AdBreak) {
    try {
        // Each ad in a pod has its own stitched-ad DATERANGE, and Twitch reveals it only when that ad
        // starts, so a pod surfaces one ad per poll.
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
        // POD-LENGTH is the whole pod, though its DATERANGEs surface one poll at a time.
        const podLenMatch = textStr.match(/X-TV-TWITCH-AD-POD-LENGTH="(\d+)"/);
        const podLength = podLenMatch ? parseInt(podLenMatch[1], 10) : matches.length;
        if (spoofedSet.size >= podLength) {
            return;
        }
        let newSpoofed = 0;
        let firstRollType = '';
        let podCompleteSent = false;
        for (let i = 0; i < matches.length; i++) {
            const idMatch = matches[i][1].match(/^ID="([^"]+)"/);
            const stitchedAdId = idMatch ? idMatch[1] : '';
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
            // Older Twitch playlists lack POD-POSITION.
            const adPosition = parseInt(attr['X-TV-TWITCH-AD-POD-POSITION'] || String(i), 10);
            // Claim an audible, visible, full-length view: muted or zero-duration beside quartile 4 and
            // pod_complete would contradict itself if Twitch cross-checks.
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
            // One batched GQL POST (Twitch's endpoint takes JSON arrays) rather than six rapid requests.
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
            if (stitchedAdId) spoofedSet.add(stitchedAdId);
            const batch = [
                makePacket('video_ad_impression'),
                makePacket('video_ad_quartile_complete', { quartile: 1 }),
                makePacket('video_ad_quartile_complete', { quartile: 2 }),
                makePacket('video_ad_quartile_complete', { quartile: 3 }),
                makePacket('video_ad_quartile_complete', { quartile: 4 }),
            ];
            // A real player sends pod_complete once, after the whole pod; never claim it early.
            if (spoofedSet.size === podLength) {
                batch.push(makePacket('video_ad_pod_complete'));
                podCompleteSent = true;
            }
            // fetch resolves on HTTP errors, so only the status shows Twitch rejecting or rate-limiting.
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
