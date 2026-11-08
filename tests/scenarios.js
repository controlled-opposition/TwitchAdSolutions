// Scripted ad-break scenarios for the end-to-end harness. Each scenario drives a worker through
// a sequence of playlist polls with a fake clock and returns a transcript: every playlist the
// worker handed back and every message it posted to the page. Run against two builds of the
// script, equal transcripts mean equal behaviour on that scenario.
import { injectWorker, startWorker } from './harness.js';

const CHANNEL = 'testchan';
const MASTER_URL = `https://usher.ttvnw.net/api/channel/hls/${CHANNEL}.m3u8?allow_source=true&parent_domains=example.com`;

function encodings(prefix, { hevc = false } = {}) {
    return [
        '#EXTM3U',
        '#EXT-X-TWITCH-INFO:NODE="video-edge",SERVER-TIME="1700000000.000"',
        `#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,CODECS="${hevc ? 'hev1.1.6.L120.90' : 'avc1.64002A'},mp4a.40.2",FRAME-RATE=60.000,VIDEO="chunked"`,
        `${prefix}/chunked.m3u8`,
        '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS="avc1.4D401F,mp4a.40.2",FRAME-RATE=30.000,VIDEO="720p30"',
        `${prefix}/720p30.m3u8`,
    ].join('\n');
}

function mediaPlaylist(seq, { ads = 0, prefix = 'live' } = {}) {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', `#EXT-X-MEDIA-SEQUENCE:${seq}`];
    if (ads > 0) {
        lines.push(
            '#EXT-X-DATERANGE:ID="stitched-ad-1",CLASS="twitch-stitched-ad",START-DATE="2026-01-01T00:00:00Z",DURATION=30,X-TV-TWITCH-AD-POD-LENGTH="1",X-TV-TWITCH-AD-RADS-TOKEN="rads",X-TV-TWITCH-AD-URL="https://ads.example/track"',
        );
    }
    for (let i = 0; i < 6; i++) {
        const isAd = i < ads;
        lines.push(`#EXTINF:2.000,${isAd ? '' : 'live'}`);
        lines.push(`https://edge.example/${isAd ? 'ad' : prefix}/seg-${seq + i}.ts`);
    }
    lines.push(`#EXT-X-TWITCH-PREFETCH:https://edge.example/${prefix}/seg-${seq + 6}.ts`);
    return lines.join('\n');
}

/**
 * @param {string} scriptPath
 * @param {object} spec
 * @param {Record<string, string>} [spec.localStorage]
 * @param {boolean} [spec.hevc] main stream's top variant is HEVC
 * @param {Record<string, number>} [spec.backupAds] player type -> ad segments in its playlist (default 0 = clean)
 * @param {object} [spec.console] console for the worker (silent by default)
 * @param {(message: object) => string} [spec.reload] the page's answer to a ReloadPlayer (default: reloaded)
 * @param {Array<{ ads: number, polls: number }>} spec.phases main-stream polls, in order
 */
export async function runScenario(scriptPath, spec) {
    let clock = 1_700_000_000_000;
    let seq = 1000;
    let mainAds = 0;
    const transcript = [];
    const worker = startWorker(injectWorker(scriptPath, { localStorage: spec.localStorage }), {
        now: () => clock,
        reload: spec.reload,
        console: spec.console,
        gql: (body) => {
            const playerType = body?.variables?.playerType;
            return {
                body: JSON.stringify({
                    data: { streamPlaybackAccessToken: { signature: 'sig-' + playerType, value: 'tok-' + playerType } },
                }),
            };
        },
        network: (url) => {
            if (url.startsWith(`https://usher.ttvnw.net/api/channel/hls/${CHANNEL}.m3u8`)) {
                const sig = new URL(url).searchParams.get('sig');
                if (!sig) return { body: encodings('https://main.example', { hevc: spec.hevc }) };
                return { body: encodings('https://backup.example/' + sig.slice(4)) };
            }
            if (url.startsWith('https://main.example/')) return { body: mediaPlaylist(seq, { ads: mainAds }) };
            const backup = url.match(/^https:\/\/backup\.example\/([^/]+)\//);
            if (backup) {
                const ads = spec.backupAds?.[backup[1]] ?? 0;
                return { body: mediaPlaylist(seq, { ads, prefix: 'backup-' + backup[1] }) };
            }
            if (url.startsWith('https://edge.example/')) return { body: 'segment' };
            return { status: 404, body: '' };
        },
    });
    const record = (label, result) => {
        const messages = worker.posted.splice(0).map((m) => {
            if (m.key !== 'FetchRequest') return m;
            const { 'X-Device-Id': _deviceId, ...headers } = m.value.options.headers;
            return { key: m.key, url: m.value.url, body: m.value.options.body, headers };
        });
        transcript.push({ label, status: result.status, body: result.body, messages });
    };
    record('master', await worker.fetch(MASTER_URL));
    // Settle the fire-and-forget requests (ad segment prefetch, spoof beacons) between polls.
    const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
    for (const [p, phase] of spec.phases.entries()) {
        mainAds = phase.ads;
        for (let i = 0; i < phase.polls; i++) {
            clock += 2000;
            seq += 1;
            record(`phase ${p} poll ${i}`, await worker.fetch('https://main.example/chunked.m3u8'));
            await settle();
        }
    }
    return { transcript, worker };
}

export const SCENARIOS = {
    'clean stream': { phases: [{ ads: 0, polls: 3 }] },
    'ad break, clean backup (site)': {
        phases: [
            { ads: 0, polls: 2 },
            { ads: 4, polls: 4 },
            { ads: 0, polls: 4 },
        ],
    },
    'ad break, first backups ad-laden': {
        backupAds: { site: 6, popout: 6 },
        phases: [
            { ads: 0, polls: 2 },
            { ads: 4, polls: 3 },
            { ads: 0, polls: 4 },
        ],
    },
    'ad break, every backup ad-laden (strip + recovery)': {
        backupAds: { site: 6, popout: 6, mobile_web: 6, embed: 6, autoplay: 6 },
        phases: [
            { ads: 0, polls: 2 },
            { ads: 6, polls: 6 },
            { ads: 0, polls: 4 },
        ],
    },
    'HEVC stream, ad break': {
        hevc: true,
        phases: [
            { ads: 0, polls: 2 },
            { ads: 4, polls: 3 },
            { ads: 0, polls: 4 },
        ],
    },
    'legacy strip-first path (backupSwapFirst=false)': {
        localStorage: { twitchAdSolutions_backupSwapFirst: 'false', twitchAdSolutions_disableAdSpoofing: 'false' },
        phases: [
            { ads: 0, polls: 2 },
            { ads: 3, polls: 3 },
            { ads: 0, polls: 4 },
        ],
    },
};
