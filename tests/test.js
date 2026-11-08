// Unit tests for TwitchAdSolutions
// Run: node tests/test.js
//
// Unit tests load src/ modules through tests/load.js (fresh module state per load). The
// end-to-end tests at the bottom run the built vaft/vaft.user.js through tests/harness.js.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { injectWorker, startWorker } from './harness.js';
import { loadModules, ROOT } from './load.js';
import { runScenario, SCENARIOS } from './scenarios.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
    if (condition) {
        passed++;
    } else {
        failed++;
        console.error('FAIL: ' + message);
    }
}

function assertEq(actual, expected, message) {
    if (actual === expected) {
        passed++;
    } else {
        failed++;
        console.error(
            'FAIL: ' + message + ' — expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual),
        );
    }
}

function assertDeepEq(actual, expected, message) {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
        passed++;
    } else {
        failed++;
        console.error(
            'FAIL: ' + message + ' — expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual),
        );
    }
}

// ============================================================
// Worker functions under test
// ============================================================
const vaft = loadModules([
    'src/worker/ads.ts',
    'src/worker/ad-break.ts',
    'src/worker/playlist.ts',
    'src/worker/stream-info.ts',
    'src/worker/state.ts',
]);
const {
    hasAdTags,
    getMatchedAdSignifiers,
    parseAttributes,
    getServerTimeFromM3u8,
    replaceServerTimeInM3u8,
    getStreamVariantForResolution,
} = vaft;
// stripAdSegments works on a break; give the StreamInfo one if it has none.
const stripAdSegments = (text, stripAll, si) => {
    if (!si.Break) si.Break = vaft.createAdBreak('');
    return vaft.stripAdSegments(text, stripAll, si, si.Break);
};
const { isValidWorker } = loadModules(['src/page/worker-hook.ts']);
// Same Map object the loaded code reads and writes; clear() it between cases.
const AdSegmentCache = vaft.state.AdSegmentCache;

// A real StreamInfo (full field shape from createStreamInfo) with per-test overrides, in a break
// (a real AdBreak from createAdBreak) with `breakOverrides`.
function makeStreamInfo(overrides = {}, breakOverrides = {}) {
    const si = Object.assign(vaft.createStreamInfo('testchannel', '', ''), overrides);
    si.Break = Object.assign(vaft.createAdBreak(''), breakOverrides);
    return si;
}

// ============================================================
// Test: hasAdTags
// ============================================================
console.log('--- hasAdTags ---');
assert(hasAdTags('stitched-ad-12345.ts') === true, 'detects stitched-ad');
assert(hasAdTags('#EXT-X-CUE-OUT:DURATION=30') === true, 'detects EXT-X-CUE-OUT');
assert(
    hasAdTags('#EXT-X-DATERANGE:CLASS="twitch-stitched-ad"') === true,
    'detects twitch-stitched-ad (via prefix + stitched-ad)',
);
assert(hasAdTags('#EXT-X-DATERANGE:CLASS="twitch-maf-ad"') === true, 'detects twitch-maf-ad exact');
assert(hasAdTags('normal-segment-12345.ts') === false, 'clean segment returns false');
assert(hasAdTags('#EXTINF:2.000,live\nhttps://video.twitch.tv/segment.ts') === false, 'normal m3u8 returns false');
assert(hasAdTags('') === false, 'empty string returns false');
// Narrowed signifiers (removed per PR #120 to eliminate false positives): bare 'stitched', 'X-TV-TWITCH-AD', 'SCTE35-OUT'
assert(hasAdTags('stitched') === false, 'bare stitched is narrowed out (PR #120 false-positive fix)');
assert(hasAdTags('X-TV-TWITCH-AD-URL="http://example.com"') === false, 'X-TV-TWITCH-AD no longer a signifier');
assert(hasAdTags('SCTE35-OUT') === false, 'SCTE35-OUT no longer a signifier');

// ============================================================
// Test: getMatchedAdSignifiers
// ============================================================
console.log('--- getMatchedAdSignifiers ---');
assertDeepEq(
    getMatchedAdSignifiers('stitched-ad with #EXT-X-CUE-OUT marker'),
    ['stitched-ad', 'EXT-X-CUE-OUT'],
    'matches multiple signifiers',
);
assertDeepEq(getMatchedAdSignifiers('#EXT-X-CUE-OUT:DURATION=30'), ['EXT-X-CUE-OUT'], 'matches single CUE-OUT');
assertDeepEq(getMatchedAdSignifiers('normal content'), [], 'no matches on clean content');
assertDeepEq(
    getMatchedAdSignifiers('#EXT-X-DATERANGE:CLASS="twitch-stitched-ad"'),
    ['stitched-ad', 'twitch-stitched'],
    'twitch-stitched-ad hits both stitched-ad substring and twitch-stitched prefix',
);
// PR #166 broadened coverage via twitch-stitched prefix (catches future variants like twitch-stitched-mid, twitch-stitched-pod).
assert(hasAdTags('#EXT-X-DATERANGE:CLASS="twitch-stitched-mid"') === true, 'detects twitch-stitched-mid via prefix');
assert(hasAdTags('#EXT-X-DATERANGE:CLASS="twitch-stitched-pod"') === true, 'detects twitch-stitched-pod via prefix');
assert(hasAdTags('#EXT-X-DATERANGE:CLASS="twitch-trigger"') === true, 'detects twitch-trigger DATERANGE');
// Session/source metadata classes (KnownNonAdSignifiers) are not ad markers
assert(hasAdTags('#EXT-X-DATERANGE:CLASS="twitch-stream-source"') === false, 'twitch-stream-source not a signifier');
assert(hasAdTags('#EXT-X-DATERANGE:CLASS="twitch-ad-quartile"') === false, 'twitch-ad-quartile not a signifier');

// ============================================================
// Test: parseAttributes
// ============================================================
console.log('--- parseAttributes ---');
const attrs1 = parseAttributes(
    '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS="avc1.4D4028",FRAME-RATE=30.0',
);
assertEq(attrs1['RESOLUTION'], '1920x1080', 'parses resolution');
assertEq(attrs1['FRAME-RATE'], 30, 'parses frame rate as number');
assertEq(attrs1['CODECS'], 'avc1.4D4028', 'parses quoted codecs');
// BANDWIDTH is the first attribute after the colon — parseAttributes regex splits on comma-prefixed pairs
const attrs1b = parseAttributes('BANDWIDTH=6000000,RESOLUTION=1920x1080');
assertEq(attrs1b['BANDWIDTH'], 6000000, 'parses bandwidth as number when first attribute');

const attrs2 = parseAttributes(
    '#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=852x480,CODECS="hev1.1.6.L120",FRAME-RATE=60.0',
);
assertEq(attrs2['RESOLUTION'], '852x480', 'parses 480p resolution');
assertEq(attrs2['CODECS'], 'hev1.1.6.L120', 'parses HEVC codec');
assertEq(attrs2['FRAME-RATE'], 60, 'parses 60fps');

// ============================================================
// Test: getServerTimeFromM3u8
// ============================================================
console.log('--- getServerTimeFromM3u8 ---');
vaft.state.V2API = false;
assertEq(
    getServerTimeFromM3u8('#EXT-X-TWITCH-ELAPSED-SECS:10.5,SERVER-TIME="1234567890.123"'),
    '1234567890.123',
    'extracts v1 server time',
);
assertEq(getServerTimeFromM3u8('no server time here'), null, 'returns null when no server time');

vaft.state.V2API = true;
assertEq(
    getServerTimeFromM3u8('#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE="9876543210.456"'),
    '9876543210.456',
    'extracts v2 server time',
);
assertEq(getServerTimeFromM3u8('no server time here'), null, 'returns null for v2 when no match');
vaft.state.V2API = false;

// ============================================================
// Test: replaceServerTimeInM3u8
// ============================================================
console.log('--- replaceServerTimeInM3u8 ---');
vaft.state.V2API = false;
const m3u8WithTime = '#EXT-X-TWITCH-ELAPSED-SECS:10.5,SERVER-TIME="1234567890.123"';
assert(
    replaceServerTimeInM3u8(m3u8WithTime, '9999999999.000').includes('SERVER-TIME="9999999999.000"'),
    'replaces v1 server time',
);
assertEq(replaceServerTimeInM3u8(m3u8WithTime, null), m3u8WithTime, 'returns original when newServerTime is null');

vaft.state.V2API = true;
const m3u8V2 = '#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE="1234567890.123"';
assert(replaceServerTimeInM3u8(m3u8V2, '9999999999.000').includes('VALUE="9999999999.000"'), 'replaces v2 server time');
vaft.state.V2API = false;

// ============================================================
// Test: getStreamVariantForResolution
// ============================================================
console.log('--- getStreamVariantForResolution ---');
const encodingsM3u8 = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS="avc1.4D4028",FRAME-RATE=30.0',
    'https://video.twitch.tv/1080p30.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS="avc1.4D401F",FRAME-RATE=60.0',
    'https://video.twitch.tv/720p60.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=852x480,CODECS="avc1.4D401E",FRAME-RATE=30.0',
    'https://video.twitch.tv/480p30.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=600000,RESOLUTION=640x360,CODECS="avc1.4D401E",FRAME-RATE=30.0',
    'https://video.twitch.tv/360p30.m3u8',
].join('\n');

assertEq(
    getStreamVariantForResolution(encodingsM3u8, { Resolution: '1920x1080', FrameRate: 30 })?.url,
    'https://video.twitch.tv/1080p30.m3u8',
    'exact resolution + framerate match',
);
assertEq(
    getStreamVariantForResolution(encodingsM3u8, { Resolution: '1280x720', FrameRate: 60 })?.url,
    'https://video.twitch.tv/720p60.m3u8',
    'exact 720p60 match',
);
assertEq(
    getStreamVariantForResolution(encodingsM3u8, { Resolution: '1280x720', FrameRate: 30 })?.url,
    'https://video.twitch.tv/720p60.m3u8',
    'resolution match without framerate match returns closest',
);
assert(
    getStreamVariantForResolution(encodingsM3u8, { Resolution: '1600x900', FrameRate: 30 }) != null,
    'non-exact resolution returns closest match',
);

// ============================================================
// Test: stripAdSegments
// ============================================================
console.log('--- stripAdSegments ---');

// Reset cache before each test group
AdSegmentCache.clear();

// Test: strips ad segments
const adM3u8 = [
    '#EXTM3U',
    '#EXT-X-TWITCH-PREFETCH:https://prefetch.url',
    '#EXTINF:2.000,stitched-ad',
    'https://ad-segment-1.ts',
    '#EXTINF:2.000,live',
    'https://live-segment-1.ts',
].join('\n');

let streamInfo = makeStreamInfo();
let result = stripAdSegments(adM3u8, false, streamInfo);
assertEq(streamInfo.Break.StrippedSegments, 1, 'counts stripped ad segment');
assert(streamInfo.Break.IsStripping === true, 'marks as stripping');
assert(AdSegmentCache.has('https://ad-segment-1.ts'), 'caches ad segment URL');
assert(!result.includes('https://prefetch.url'), 'removes prefetch URLs during ads');
assert(streamInfo.Break.RecoverySegments.length === 1, 'caches live segment for recovery');

// Test: no stripping on clean m3u8
AdSegmentCache.clear();
const cleanM3u8 = [
    '#EXTM3U',
    '#EXTINF:2.000,live',
    'https://live-segment-1.ts',
    '#EXTINF:2.000,live',
    'https://live-segment-2.ts',
].join('\n');

streamInfo = makeStreamInfo({}, { StrippedSegments: 5, IsStripping: true });
result = stripAdSegments(cleanM3u8, false, streamInfo);
assertEq(streamInfo.Break.StrippedSegments, 5, "keeps the break's stripped total on a poll that strips nothing");
assert(streamInfo.Break.IsStripping === false, 'not stripping on clean m3u8');

// Test: SCTE-35 CUE-OUT/CUE-IN stripping
AdSegmentCache.clear();
const scteM3u8 = [
    '#EXTM3U',
    '#EXT-X-CUE-OUT:DURATION=30',
    '#EXTINF:2.000,live',
    'https://cue-out-segment.ts',
    '#EXT-X-CUE-IN',
    '#EXTINF:2.000,live',
    'https://normal-segment.ts',
].join('\n');

streamInfo = makeStreamInfo();
result = stripAdSegments(scteM3u8, false, streamInfo);
assert(AdSegmentCache.has('https://cue-out-segment.ts'), 'strips segment inside CUE-OUT');
assert(!AdSegmentCache.has('https://normal-segment.ts'), 'does not strip segment after CUE-IN');

// Test: URL pattern detection
AdSegmentCache.clear();
const urlPatternM3u8 = [
    '#EXTM3U',
    '#EXTINF:2.000,live',
    'https://cdn.twitch.tv/adsquared/ad-123.ts',
    '#EXTINF:2.000,live',
    'https://cdn.twitch.tv/normal-segment.ts',
].join('\n');

streamInfo = makeStreamInfo();
result = stripAdSegments(urlPatternM3u8, false, streamInfo);
assert(AdSegmentCache.has('https://cdn.twitch.tv/adsquared/ad-123.ts'), 'detects /adsquared/ URL pattern');
assert(!AdSegmentCache.has('https://cdn.twitch.tv/normal-segment.ts'), 'does not flag normal URL');

// Test: ad tracking URL replacement
AdSegmentCache.clear();
const trackingM3u8 = [
    '#EXTM3U',
    '#EXTINF:2.000,stitched-ad',
    'https://ad.ts',
    'X-TV-TWITCH-AD-URL="https://tracking.example.com"',
    'X-TV-TWITCH-AD-CLICK-TRACKING-URL="https://click.example.com"',
    'X-TV-TWITCH-AD-FIRST-QUARTILE-URL="https://q1.example.com"',
    'X-TV-TWITCH-AD-IMPRESSION-URLS="https://imp.example.com"',
    'X-TV-TWITCH-AD-COMMERCIAL-ID="abc123"',
].join('\n');

streamInfo = makeStreamInfo();
result = stripAdSegments(trackingM3u8, false, streamInfo);
assert(result.includes('X-TV-TWITCH-AD-URL="https://twitch.tv"'), 'replaces ad URL with twitch.tv');
assert(result.includes('X-TV-TWITCH-AD-CLICK-TRACKING-URL="https://twitch.tv"'), 'replaces click tracking URL');
assert(result.includes('X-TV-TWITCH-AD-FIRST-QUARTILE-URL="https://twitch.tv"'), 'replaces quartile URL');
assert(result.includes('X-TV-TWITCH-AD-IMPRESSION-URLS="https://twitch.tv"'), 'replaces impression URLS (plural)');
assert(result.includes('X-TV-TWITCH-AD-COMMERCIAL-ID="abc123"'), 'leaves non-URL attributes alone');

// Test: recovery segments restore when all stripped
AdSegmentCache.clear();
const allAdM3u8 = [
    '#EXTM3U',
    '#EXTINF:2.000,stitched-ad',
    'https://ad-1.ts',
    '#EXTINF:2.000,stitched-ad',
    'https://ad-2.ts',
].join('\n');

streamInfo = makeStreamInfo(
    {},
    {
        RecoverySegments: [
            { extinf: '#EXTINF:2.000,live', url: 'https://recovery-1.ts' },
            { extinf: '#EXTINF:2.000,live', url: 'https://recovery-2.ts' },
        ],
    },
);
result = stripAdSegments(allAdM3u8, false, streamInfo);
assert(result.includes('https://recovery-1.ts'), 'restores recovery segment 1');
assert(result.includes('https://recovery-2.ts'), 'restores recovery segment 2');

// Test: MEDIA-SEQUENCE is rewritten on recovery injection
AdSegmentCache.clear();
const playlistWithSeq = [
    '#EXTM3U',
    '#EXT-X-MEDIA-SEQUENCE:100',
    '#EXTINF:2.000,live',
    'https://s100.ts',
    '#EXTINF:2.000,live',
    'https://s101.ts',
    '#EXTINF:2.000,live',
    'https://s102.ts',
].join('\n');
// Cache phase: all 3 live segments, MEDIA-SEQUENCE=100 → RecoveryStartSeq = 100
streamInfo = makeStreamInfo();
stripAdSegments(playlistWithSeq, false, streamInfo);
assertEq(streamInfo.Break.RecoveryStartSeq, 100, 'captures RecoveryStartSeq at cache time');
// Injection phase: ads-only playlist with MEDIA-SEQUENCE=200 → should rewrite to 100
AdSegmentCache.clear();
const adOnlyWithSeq = ['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:200', '#EXTINF:2.000,stitched-ad', 'https://ad.ts'].join('\n');
result = stripAdSegments(adOnlyWithSeq, false, streamInfo);
assert(result.includes('#EXT-X-MEDIA-SEQUENCE:100'), 'rewrites MEDIA-SEQUENCE to match recovery segments');
assert(!result.includes('#EXT-X-MEDIA-SEQUENCE:200'), 'replaces original MEDIA-SEQUENCE');

// Test: stripAllSegments mode
AdSegmentCache.clear();
const mixedM3u8 = ['#EXTM3U', '#EXTINF:2.000,live', 'https://live-segment.ts'].join('\n');

streamInfo = makeStreamInfo();
result = stripAdSegments(mixedM3u8, true, streamInfo);
assert(AdSegmentCache.has('https://live-segment.ts'), 'strips live segments when stripAllSegments is true');

// Test: /_404/ and /processing URL patterns
AdSegmentCache.clear();
const urlPattern404M3u8 = [
    '#EXTM3U',
    '#EXTINF:2.000,live',
    'https://cdn.twitch.tv/_404/placeholder.ts',
    '#EXTINF:2.000,live',
    'https://cdn.twitch.tv/processing/ad-init.ts',
    '#EXTINF:2.000,live',
    'https://cdn.twitch.tv/normal-segment.ts',
].join('\n');

streamInfo = makeStreamInfo();
result = stripAdSegments(urlPattern404M3u8, false, streamInfo);
assert(AdSegmentCache.has('https://cdn.twitch.tv/_404/placeholder.ts'), 'detects /_404/ URL pattern');
assert(AdSegmentCache.has('https://cdn.twitch.tv/processing/ad-init.ts'), 'detects /processing URL pattern');
assert(!AdSegmentCache.has('https://cdn.twitch.tv/normal-segment.ts'), 'does not flag normal segment');

// Test: multiple signifiers in same m3u8
AdSegmentCache.clear();
const multiSignifierM3u8 = [
    '#EXTM3U',
    '#EXT-X-CUE-OUT:DURATION=30',
    '#EXTINF:2.000,stitched-ad',
    'https://ad-1.ts',
    'X-TV-TWITCH-AD-URL="https://example.com"',
    '#EXT-X-CUE-IN',
    '#EXTINF:2.000,live',
    'https://live-1.ts',
].join('\n');

streamInfo = makeStreamInfo();
result = stripAdSegments(multiSignifierM3u8, false, streamInfo);
assert(streamInfo.Break.IsStripping === true, 'detects ads with multiple signifiers');
assert(AdSegmentCache.has('https://ad-1.ts'), 'strips segment with multiple signifiers present');

// Test: AdSegmentCache deduplication
AdSegmentCache.clear();
const dupeM3u8 = ['#EXTM3U', '#EXTINF:2.000,stitched-ad', 'https://same-ad.ts'].join('\n');

streamInfo = makeStreamInfo();
stripAdSegments(dupeM3u8, false, streamInfo);
assertEq(streamInfo.Break.StrippedSegments, 1, 'first strip increments count');
const streamInfo2 = makeStreamInfo();
stripAdSegments(dupeM3u8, false, streamInfo2);
assertEq(streamInfo2.Break.StrippedSegments, 0, 'duplicate URL does not increment count (already cached)');

// ============================================================
// Test: isValidWorker
// ============================================================
console.log('--- isValidWorker ---');
assert(
    isValidWorker({ toString: () => 'function Worker() { /* twitch worker */ }' }) === false,
    'rejects worker with twitch conflict',
);
assert(
    isValidWorker({ toString: () => 'function Worker() { isVariantA }' }) === true,
    'allows worker with reinsert pattern (TwitchNoSub)',
);
assert(
    isValidWorker({ toString: () => 'function Worker() { besuper/ }' }) === true,
    'allows worker with besuper reinsert',
);
assert(
    isValidWorker({ toString: () => 'function Worker() { /* clean */ }' }) === true,
    'allows clean worker without conflicts',
);
assert(
    isValidWorker({ toString: () => 'function Worker() { twitch isVariantA }' }) === true,
    'allows conflict + reinsert combination',
);
// biome-ignore-start lint/suspicious/noTemplateCurlyInString: literal TwitchNoSub marker
assert(
    isValidWorker({ toString: () => 'function Worker() { ${patch_url} }' }) === true,
    'allows worker with ${patch_url} reinsert',
);
// biome-ignore-end lint/suspicious/noTemplateCurlyInString: literal TwitchNoSub marker

// ============================================================
// Test: AdSegmentCache TTL cleanup
// ============================================================
console.log('--- AdSegmentCache TTL ---');
AdSegmentCache.clear();
AdSegmentCache.set('old-segment.ts', Date.now() - 130000);
AdSegmentCache.set('new-segment.ts', Date.now());
// A fresh StreamInfo has no LastAdCachePruneAt, so this call runs the throttled prune.
stripAdSegments(cleanM3u8, false, makeStreamInfo());
assert(!AdSegmentCache.has('old-segment.ts'), 'removes segments older than 120s');
assert(AdSegmentCache.has('new-segment.ts'), 'keeps recent segments');

// ============================================================
// Test: hasAdTags — each signifier individually
// ============================================================
console.log('--- hasAdTags (individual signifiers) ---');
assert(hasAdTags('stitched-ad') === true, 'detects stitched-ad alone');
assert(hasAdTags('EXT-X-CUE-OUT') === true, 'detects EXT-X-CUE-OUT alone');
assert(hasAdTags('twitch-stitched') === true, 'detects twitch-stitched prefix alone');
assert(hasAdTags('EXT-X-DATERANGE:CLASS="twitch-maf-ad"') === true, 'detects twitch-maf-ad DATERANGE alone');

// ============================================================
// Test: getStreamVariantForResolution — edge cases
// ============================================================
console.log('--- getStreamVariantForResolution (edge cases) ---');
assertEq(
    getStreamVariantForResolution('#EXTM3U\n', { Resolution: '1920x1080', FrameRate: 30 })?.url ?? null,
    null,
    'returns null for empty m3u8',
);
assertEq(
    getStreamVariantForResolution('', { Resolution: '1920x1080', FrameRate: 30 })?.url ?? null,
    null,
    'returns null for empty string',
);

// ============================================================
// Test: getServerTimeFromM3u8 — edge cases
// ============================================================
console.log('--- getServerTimeFromM3u8 (edge cases) ---');
vaft.state.V2API = false;
assertEq(getServerTimeFromM3u8('SERVER-TIME=""'), null, 'returns null for empty server time');
assertEq(getServerTimeFromM3u8('SERVER-TIME="abc"'), null, 'returns null for non-numeric v1 time');
vaft.state.V2API = true;
assertEq(
    getServerTimeFromM3u8('#EXT-X-SESSION-DATA:DATA-ID="OTHER",VALUE="123"'),
    null,
    'returns null for wrong DATA-ID',
);
vaft.state.V2API = false;

// ============================================================
// Test: parseAttributes — edge cases
// ============================================================
console.log('--- parseAttributes (edge cases) ---');
const attrsEmpty = parseAttributes('');
assert(typeof attrsEmpty === 'object', 'returns object for empty string');

// ============================================================
// Test: worker master-playlist hook (hookWorkerFetch)
// ============================================================
// Async cases run in order before the results are printed (see the end of the file).
const asyncTests = [];
// An unhandled rejection from the loaded code is a failure, not a crash of the test run.
process.on('unhandledRejection', (e) => {
    failed++;
    console.error('FAIL: unhandled rejection: ' + (e && e.message));
});

// Runs one master-playlist request through the worker fetch hook with a mocked network.
// Resolves to 'resolved' or 'hung' (no answer within 500ms).
function workerMasterFetch(worker, url) {
    return Promise.race([
        worker.context.fetch(url).then(
            () => 'resolved',
            () => 'rejected',
        ),
        new Promise((resolve) => setTimeout(() => resolve('hung'), 500)),
    ]);
}
function makeWorkerContext(network) {
    const worker = loadModules(['src/worker/fetch-hook.ts', 'src/worker/stream-info.ts', 'src/worker/state.ts'], {
        globals: { Response, Blob, URL, atob, setTimeout, clearTimeout, fetch: network },
    });
    worker.hookWorkerFetch();
    return worker;
}
const masterUrl = 'https://usher.ttvnw.net/api/v2/channel/hls/testchan.m3u8?sig=1';
// v2-style master playlist: variant lines are raw CDN URLs without '.m3u8'.
const v2Encodings = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS="avc1.4D4028",FRAME-RATE=30.000',
    'https://video-edge.example.net/v1/segment/chunked/abc',
].join('\n');

asyncTests.push(async () => {
    console.log('--- hookWorkerFetch: cached-session probe ---');
    const requested = [];
    const worker = makeWorkerContext(async (input) => {
        if (typeof input !== 'string') throw new TypeError('Failed to parse URL from ' + input); // like a real fetch(undefined) in a blob worker
        requested.push(input);
        return new Response(input === masterUrl ? v2Encodings : '#EXTM3U', { status: 200 });
    });
    assertEq(await workerMasterFetch(worker, masterUrl), 'resolved', 'first master playlist request resolves');
    assertEq(
        await workerMasterFetch(worker, masterUrl),
        'resolved',
        'repeat request with a v2 cache (no .m3u8 variant line) resolves instead of hanging',
    );
    assert(
        requested.includes('https://video-edge.example.net/v1/segment/chunked/abc'),
        'v2 cache is probed through its raw CDN variant URL',
    );
    assert(worker.state.StreamInfos.testchan !== undefined, 'stream session exists after the repeat request');
});

asyncTests.push(async () => {
    const worker = makeWorkerContext(async (input) => {
        if (input !== masterUrl) throw new TypeError('network error');
        return new Response(v2Encodings, { status: 200 });
    });
    await workerMasterFetch(worker, masterUrl);
    const first = worker.state.StreamInfos.testchan;
    assertEq(
        await workerMasterFetch(worker, masterUrl),
        'resolved',
        'repeat request still resolves when the cache probe rejects',
    );
    assert(worker.state.StreamInfos.testchan !== first, 'a rejected probe rebuilds the stream session');
});

asyncTests.push(async () => {
    console.log('--- hookWorkerFetch: processing errors pass the playlist through ---');
    const mediaUrl = 'https://video-edge.example.net/v1/playlist/abc.m3u8';
    const mediaText = '#EXTM3U\n#EXTINF:2.000,live\nhttps://video-edge.example.net/seg-1.ts';
    const worker = makeWorkerContext(async (input) => new Response(input === mediaUrl ? mediaText : v2Encodings));
    const broken = worker.createStreamInfo('testchan', v2Encodings, '');
    Object.defineProperty(broken, 'LastSeenAt', {
        set() {
            throw new Error('boom');
        },
    });
    worker.state.StreamInfosByUrl[mediaUrl] = broken;
    assertEq(
        await (await worker.context.fetch(mediaUrl)).text(),
        mediaText,
        'media playlist whose processing throws is returned unmodified (was: request never settled)',
    );
    worker.state.StreamInfos.testchan = {
        get EncodingsM3U8() {
            throw new Error('boom');
        },
    };
    assertEq(
        await (await worker.context.fetch(masterUrl)).text(),
        v2Encodings,
        'master playlist whose processing throws is returned unmodified (was: request never settled)',
    );
});

// ============================================================
// Test: pruneStreamInfos drops URLs of replaced stream sessions
// ============================================================
{
    console.log('--- pruneStreamInfos ---');
    const w = loadModules(['src/worker/stream-info.ts', 'src/worker/state.ts']);
    const replaced = w.createStreamInfo('chan', '', '');
    const current = w.createStreamInfo('chan', '', '');
    w.state.StreamInfos.chan = current;
    current.Urls['https://new/a.m3u8'] = {};
    w.state.StreamInfosByUrl['https://old/a.m3u8'] = replaced;
    w.state.StreamInfosByUrl['https://new/a.m3u8'] = current;
    w.pruneStreamInfos();
    assert(!('https://old/a.m3u8' in w.state.StreamInfosByUrl), 'variant URL of a replaced StreamInfo is dropped');
    assertEq(w.state.StreamInfosByUrl['https://new/a.m3u8'], current, 'current session URLs are kept');
}

// ============================================================
// Test: end of break (processM3U8 → decideBreakEndAction)
// ============================================================
// A worker with one stream in a break; `poll(text)` runs a playlist poll through processM3U8 and
// returns what the worker posted to the page.
function breakWorker(breakOverrides = {}, streamOverrides = {}, stateOverrides = {}) {
    const posted = [];
    const w = loadModules(
        [
            'src/worker/m3u8.ts',
            'src/worker/ads.ts',
            'src/worker/ad-break.ts',
            'src/worker/stream-info.ts',
            'src/worker/state.ts',
        ],
        { globals: { postMessage: (m) => posted.push(m), setTimeout, fetch: async () => new Response('') } },
    );
    Object.assign(w.state, stateOverrides);
    const url = 'https://video-edge.example.net/v1/playlist/abc.m3u8';
    const si = Object.assign(w.createStreamInfo('chan', '', ''), streamOverrides);
    si.Break = Object.assign(w.createAdBreak(''), breakOverrides);
    w.state.StreamInfosByUrl[url] = si;
    return {
        w,
        si,
        async poll(text = '#EXTM3U\n#EXTINF:2.000,live\nhttps://edge/seg-1.ts') {
            posted.length = 0;
            await w.processM3U8(url, text, fetch);
            return posted.slice();
        },
    };
}
const lastClean = (bw) => bw.poll(); // with End.cleanPolls 2, this is the third ad-free poll
const reloads = (msgs) => msgs.filter((m) => m.key === 'ReloadPlayer');

asyncTests.push(async () => {
    console.log('--- end of break: cycle rescue ---');
    const endBreak = async (totalAllStrippedPolls) => {
        const bw = breakWorker({
            End: { since: Date.now(), cleanPolls: 2, bounces: 0 },
            StrippedSegments: 4,
            CycleRescued: true,
            TotalAllStrippedPolls: totalAllStrippedPolls,
        });
        return (await lastClean(bw)).map((m) => m.key);
    };
    assert(
        !(await endBreak(1)).includes('ReloadPlayer'),
        'short freeze rescued by a backup switch: no end-of-break reload',
    );
    assert(
        (await endBreak(5)).includes('ReloadPlayer'),
        'long freeze (>2 all-stripped polls): end-of-break reload still fires (was skipped: the count was reset first)',
    );
});

asyncTests.push(async () => {
    console.log('--- end of break: reload kind ---');
    // Stripped earlier in the break, then clean backups (polls that strip nothing): still a
    // stripped break. The count used to reset on every poll that stripped nothing, which turned
    // these into "no-strip" breaks and skipped the MediaSource flush.
    let bw = breakWorker({
        End: { since: Date.now(), cleanPolls: 2, bounces: 0 },
        LastCommittedBackupPlayerType: 'site',
    });
    const strip = (text) => bw.w.stripAdSegments(text, false, bw.si, bw.si.Break);
    strip('#EXTM3U\n#EXTINF:2.000,\nhttps://edge/ad-1.ts\n#EXTINF:2.000,live\nhttps://edge/l-1.ts');
    strip('#EXTM3U\n#EXTINF:2.000,live\nhttps://edge/l-2.ts');
    assertEq(bw.si.Break.StrippedSegments, 1, 'stripped total survives a poll that strips nothing');
    assertDeepEq(
        reloads(await lastClean(bw)).map((m) => m.kind),
        ['early'],
        'break that stripped earlier ends with a hard reload',
    );
    assertEq(bw.si.Break, null, 'break dropped at its end');

    bw = breakWorker({ End: { since: Date.now(), cleanPolls: 2, bounces: 0 }, LastCommittedBackupPlayerType: 'site' });
    assertDeepEq(
        reloads(await lastClean(bw)).map((m) => m.kind),
        ['post-ad'],
        'no-strip backup break: soft reload',
    );

    bw = breakWorker({
        End: { since: Date.now(), cleanPolls: 2, bounces: 0 },
        LastCommittedBackupPlayerType: 'autoplay',
    });
    assertDeepEq(
        reloads(await lastClean(bw)).map((m) => m.kind),
        ['early'],
        'autoplay backup: hard reload',
    );

    bw = breakWorker({ End: { since: Date.now(), cleanPolls: 2, bounces: 0 } });
    assertEq(reloads(await lastClean(bw)).length, 0, 'no-strip break without a backup: no reload');

    // Codec swap, nothing stripped, no backup committed: used to drop the swap without a reload,
    // leaving the player on the AVC-only master playlist.
    bw = breakWorker({ End: { since: Date.now(), cleanPolls: 2, bounces: 0 } }, { CodecSwap: 'swapped' });
    assertDeepEq(
        reloads(await lastClean(bw)).map((m) => m.kind),
        ['post-ad'],
        'codec swap is undone by a reload',
    );
    assertEq(bw.si.CodecSwap, 'native', 'codec swap back to native at break end');
});

// ============================================================
// Test: ad-break lifecycle (onAdPoll / onAdFreePoll)
// ============================================================
{
    console.log('--- ad-break lifecycle ---');
    const ab = loadModules(['src/worker/ad-break.ts']);
    let brk = ab.createAdBreak('X-TV-TWITCH-AD-POD-LENGTH="3",X-TV-TWITCH-AD-RADS-TOKEN="t"');
    assertEq(brk.PodLength, 3, 'pod length parsed');
    assert(brk.HasConfirmedAdAttrs, 'RADS token confirms the break');
    assertEq(ab.onAdFreePoll(brk, true), null, 'first ad-free poll: break goes on');
    assertEq(ab.onAdFreePoll(brk, true), null, 'second ad-free poll: break goes on');
    ab.onAdPoll(brk);
    assertEq(brk.End.cleanPolls, 0, 'bounce resets the clean-poll run');
    assertEq(brk.End.bounces, 1, 'bounce counted, candidate kept');
    assertEq(ab.onAdFreePoll(brk, true), null, 'after a bounce the run starts over');
    ab.onAdFreePoll(brk, true);
    assertEq(ab.onAdFreePoll(brk, true), 'clean-polls', 'three ad-free polls in a row end the break');
    brk = ab.createAdBreak('');
    assertEq(ab.onAdFreePoll(brk, false), 'no-live-segments', 'ad-free poll without live segments ends it');
    brk = ab.createAdBreak('');
    ab.onAdFreePoll(brk, true);
    brk.End.since -= 12000;
    ab.onAdPoll(brk);
    assertEq(brk.End, null, 'a stale candidate is dropped by an ad-marked poll');
    ab.onAdFreePoll(brk, true);
    brk.End.since -= 12000;
    assertEq(ab.onAdFreePoll(brk, true), 'max-wait', 'an old candidate ends the break on max wait');
}

// ============================================================
// Test: early reload state machine
// ============================================================
{
    console.log('--- early reload ---');
    const posted = [];
    const er = loadModules(
        ['src/worker/early-reload.ts', 'src/worker/reload.ts', 'src/worker/ad-break.ts', 'src/worker/state.ts'],
        { globals: { postMessage: (m) => posted.push(m) } },
    );
    const frozen = (brk, polls) => {
        brk.IsStripping = true;
        brk.ConsecutiveAllStrippedPolls = polls;
        brk.TotalAllStrippedPolls = polls;
    };
    const lastRequest = () => posted.filter((m) => m.key === 'ReloadPlayer').at(-1);
    const brk = er.createAdBreak('X-TV-TWITCH-AD-POD-LENGTH="2"');
    brk.RecoverySegments = new Array(6).fill({ extinf: '#EXTINF:2.000,live', url: 'u' });
    frozen(brk, 2);
    er.stepEarlyReload(brk, '');
    assertEq(brk.EarlyReload.phase, 'armed', 'below the poll threshold: no reload');
    frozen(brk, 3);
    er.stepEarlyReload(brk, '');
    assertEq(brk.EarlyReload.phase, 'requested', 'threshold reached: reload requested');
    const first = lastRequest();
    assertEq(first.kind, 'early', 'early reload is hard');
    er.stepEarlyReload(brk, '');
    assertEq(posted.filter((m) => m.key === 'ReloadPlayer').length, 1, 'no second request while one is pending');
    er.settleReload(first.requestId + 100, 'reloaded');
    assertEq(brk.EarlyReload.phase, 'requested', 'an answer to another request is ignored');
    er.settleReload(first.requestId, 'skipped-healthy');
    assertEq(brk.EarlyReload.phase, 'armed', 'skipped as healthy: re-armed');
    assertEq(brk.EarlyReloadCount, 0, 'skipped as healthy: budget refunded');
    er.stepEarlyReload(brk, '');
    er.settleReload(lastRequest().requestId, 'reloaded');
    assertEq(brk.EarlyReload.phase, 'reloaded', 'page reloaded: waiting for the next poll');
    // Next poll: still all stripped, recovery segments (",live") injected. Used to read as
    // "partial" and latch, blocking the rest of the budget.
    er.stepEarlyReload(brk, '');
    assertEq(brk.EarlyReloadCount, 2, 'still ads: re-armed and fired again within the pod budget');
    er.settleReload(lastRequest().requestId, 'reloaded');
    er.stepEarlyReload(brk, '');
    assertEq(brk.EarlyReloadCount, 2, 'budget (one per ad in the pod) is not exceeded');
    assertEq(brk.EarlyReload.phase, 'armed', 'result reported, armed');
    const b2 = er.createAdBreak('');
    frozen(b2, 1); // thin recovery cache (0 segments): threshold 1
    er.stepEarlyReload(b2, '', false);
    assertEq(b2.EarlyReload.phase, 'armed', 'canFire=false: no reload');
    er.stepEarlyReload(b2, '');
    assertEq(b2.EarlyReload.phase, 'requested', 'thin cache: fires after one poll');
    b2.EarlyReload.at -= 11000;
    er.stepEarlyReload(b2, '', false);
    assertEq(b2.EarlyReload.phase, 'armed', 'unanswered request times out and re-arms');
    er.settleReload(lastRequest().requestId, 'reloaded');
    assertEq(b2.EarlyReload.phase, 'armed', 'late answer after the timeout is ignored');
}

// ============================================================
// Test: codec-aware backup variant selection
// ============================================================
{
    console.log('--- backup variant codec ---');
    const pl = loadModules(['src/worker/playlist.ts']);
    const enc = [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:RESOLUTION=1920x1080,CODECS="hev1.1.6.L120.90,mp4a.40.2",FRAME-RATE=60.000',
        'https://b/hevc1080.m3u8',
        '#EXT-X-STREAM-INF:RESOLUTION=1920x1080,CODECS="avc1.64002A,mp4a.40.2",FRAME-RATE=60.000',
        'https://b/avc1080.m3u8',
        '#EXT-X-STREAM-INF:RESOLUTION=2560x1440,CODECS="av01.0.12M.10,mp4a.40.2",FRAME-RATE=60.000',
        'https://b/av1-1440.m3u8',
    ].join('\n');
    const pick = (codecs) =>
        pl.getStreamVariantForResolution(enc, { Resolution: '1920x1080', FrameRate: 60, Codecs: codecs })?.url;
    assertEq(pick('avc1.4D401F'), 'https://b/avc1080.m3u8', 'AVC player gets the AVC variant (HEVC listed first)');
    assertEq(pick('hvc1.2.4.L123'), 'https://b/hevc1080.m3u8', 'HEVC player gets the HEVC variant');
    assertEq(pick('av01.0.08M.08'), 'https://b/av1-1440.m3u8', 'same family preferred over exact resolution');
    assertEq(pick(undefined), 'https://b/hevc1080.m3u8', 'no codec given: first resolution match, as before');
    assertEq(
        pl.getStreamVariantForResolution(enc, { Resolution: '1920x1080', FrameRate: 60 })?.url,
        'https://b/hevc1080.m3u8',
        'getStreamVariantForResolution without a codec',
    );
    assert(pl.isCodecMismatch('hev1.1', 'avc1.64'), 'HEVC player, AVC backup: mismatch');
    assert(pl.isCodecMismatch('avc1.64', 'hev1.1'), 'AVC player, HEVC backup: mismatch (the missing direction)');
    assert(pl.isCodecMismatch('hev1.1', ''), 'HEVC player, unknown backup codec: mismatch');
    assert(!pl.isCodecMismatch('avc1.64', ''), 'AVC player, unknown backup codec: fine');
    assert(!pl.isCodecMismatch('avc1.64', 'avc1.4D'), 'AVC to AVC: fine');
}

// ============================================================
// Test: page reload marks each stream's own next poll
// ============================================================
asyncTests.push(async () => {
    console.log('--- reload pending per stream ---');
    const w = loadModules(['src/worker/m3u8.ts', 'src/worker/stream-info.ts', 'src/worker/state.ts'], {
        globals: { postMessage() {}, setTimeout, fetch: async () => new Response('') },
    });
    const a = w.createStreamInfo('a', '', '');
    const b = w.createStreamInfo('b', '', '');
    w.state.StreamInfos.a = a;
    w.state.StreamInfos.b = b;
    w.state.StreamInfosByUrl['https://x/a.m3u8'] = a;
    a.ReloadPending = true;
    b.ReloadPending = true;
    await w.processM3U8('https://x/a.m3u8', '#EXTM3U\n#EXTINF:2.000,live\nhttps://x/s1.ts', fetch);
    assert(a.LastPlayerReload > 0 && !a.ReloadPending, 'polled stream stamps its reload');
    assert(b.ReloadPending && b.LastPlayerReload === 0, "another stream's poll doesn't consume this one's");
});

// ============================================================
// Test: page reload task outcomes and the hard-reload mute restore
// ============================================================
function makePage({ video, paused = false, pip = null, storage = {} } = {}) {
    const listeners = [];
    const timers = [];
    let now = 0;
    const setSrcCalls = [];
    const player = {
        isPaused: () => paused,
        core: { paused, state: { muted: false, volume: 1, quality: { group: 'chunked' } } },
        pause() {},
        play: () => Promise.resolve(),
        getHTMLVideoElement: () => page.videos[0],
    };
    const playerState = { setSrc: (o) => setSrcCalls.push(o), setInitialPlaybackSettings() {} };
    const fiber = {
        stateNode: null,
        child: {
            stateNode: { setPlayerActive() {}, props: { mediaPlayerInstance: player } },
            sibling: { stateNode: playerState },
        },
    };
    const store = new Map(Object.entries(storage));
    const page = {
        videos: [video],
        listeners,
        setSrcCalls,
        advance(ms) {
            now += ms;
            for (const t of timers.splice(0).sort((x, y) => x.at - y.at)) {
                if (t.at <= now && !t.cleared) t.fn();
                else if (!t.cleared) timers.push(t);
            }
        },
        dispatch(type, target) {
            for (const l of listeners.slice()) if (l.type === type) l.fn({ target });
        },
    };
    page.mod = loadModules(['src/page/player.ts', 'src/page/state.ts'], {
        globals: {
            document: {
                pictureInPictureElement: pip,
                querySelector: (sel) =>
                    sel === '#root' ? { _reactRootContainer: { _internalRoot: { current: fiber } } } : null,
                getElementsByTagName: () => page.videos,
                addEventListener: (type, fn) => listeners.push({ type, fn }),
                removeEventListener: (type, fn) => {
                    const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
                    if (i !== -1) listeners.splice(i, 1);
                },
            },
            navigator: { platform: 'Linux x86_64', maxTouchPoints: 0 },
            localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
            setTimeout: (fn, ms) => {
                const t = { fn, at: now + ms, cleared: false };
                timers.push(t);
                return t;
            },
            clearTimeout: (t) => {
                if (t) t.cleared = true;
            },
            setInterval: () => 0,
            clearInterval() {},
        },
    });
    return page;
}
function makeVideo(overrides = {}) {
    return Object.assign(
        {
            tagName: 'VIDEO',
            muted: false,
            paused: false,
            ended: false,
            readyState: 4,
            currentTime: 100,
            isConnected: true,
            dataset: {},
            playbackRate: 1,
            seekable: { length: 1, end: () => 102 },
            buffered: { length: 0 },
        },
        overrides,
    );
}
{
    console.log('--- page reload outcomes ---');
    let page = makePage({ video: makeVideo() });
    assertEq(page.mod.doTwitchPlayerTask('reload'), 'skipped-healthy', 'healthy, near live: plain reload skipped');
    assertEq(page.setSrcCalls.length, 0, 'skipped: no setSrc');
    assertEq(page.mod.doTwitchPlayerTask('reload', 'codec-swap'), 'done', 'codec-swap reload never skipped as healthy');
    assertDeepEq(
        page.setSrcCalls[0],
        { isNewMediaPlayerInstance: false, refreshAccessToken: false },
        'codec-swap reload is soft',
    );
    page = makePage({ video: makeVideo({ readyState: 1 }) });
    assertEq(page.mod.doTwitchPlayerTask('reload', 'early'), 'done', 'stalled player: early reload done');
    assertDeepEq(page.setSrcCalls[0], { isNewMediaPlayerInstance: true, refreshAccessToken: true }, 'early is hard');
    page = makePage({ video: makeVideo(), paused: true });
    page.mod.playerBufferState.userPauseIntent = true;
    assertEq(page.mod.doTwitchPlayerTask('reload', 'early'), 'not-done', 'user paused: not done');
    page = makePage({ video: makeVideo({ readyState: 1 }), pip: {} });
    assertEq(page.mod.doTwitchPlayerTask('reload', 'early'), 'not-done', 'PiP: downgraded to pause/play, not done');
    assertEq(page.setSrcCalls.length, 0, 'PiP: no setSrc');
}
{
    console.log('--- hard reload mute restore ---');
    const video = makeVideo({ readyState: 1 });
    const page = makePage({ video });
    page.mod.doTwitchPlayerTask('reload', 'early');
    assert(video.muted, 'hard reload pre-mutes');
    assertEq(page.listeners.length, 3, 'restore listens for canplay / playing / loadeddata');
    page.advance(1000);
    // Second hard reload while the first restore is pending: the element is muted by OUR
    // pre-mute. It used to be read as a user mute (no restore armed for this reload) while the
    // first reload's listeners and timers stayed live alongside.
    page.mod.doTwitchPlayerTask('reload', 'early');
    assertEq(page.listeners.length, 3, 'second reload takes over: one set of listeners, not two');
    const newVideo = makeVideo({ readyState: 1, muted: true });
    page.videos = [newVideo];
    page.dispatch('canplay', newVideo);
    assertEq(newVideo.muted, false, 'new element unmuted on canplay');
    assertEq(video.muted, false, 'pre-mute on the original element cleared');
    assertEq(page.listeners.length, 0, 'listeners removed after restore');
    assert(page.mod.playerBufferState.vaftEverUnmuted, 'vaftEverUnmuted set');
    newVideo.muted = true; // Twitch's LS-restore re-mutes
    page.advance(5500);
    assertEq(newVideo.muted, false, 'backstop unmutes once');
    // A user who was muted before the first reload stays muted.
    const mutedVideo = makeVideo({ readyState: 1, muted: true });
    // The user's mute is in localStorage (Twitch writes it); without it, the 3s restore treats
    // the mute as Chrome's autoplay policy and unmutes.
    const p2 = makePage({ video: mutedVideo, storage: { 'video-muted': '{"default":true}' } });
    p2.mod.doTwitchPlayerTask('reload', 'early');
    p2.mod.doTwitchPlayerTask('reload', 'early');
    p2.advance(6000);
    assert(mutedVideo.muted, 'muted from the start (no vaft unmute this session): mute respected');
    assertEq(p2.listeners.length, 0, 'no restore armed for a user mute');
}

// ============================================================
// Test: page stall ladder
// ============================================================
{
    console.log('--- stall ladder ---');
    const st = loadModules(['src/page/stall.ts']);
    const ladder = st.createStallLadder();
    const run = (obs, n, cap = true) => {
        const actions = [];
        for (let i = 0; i < n; i++) actions.push(st.stallTick(ladder, obs, 3, cap).action);
        return actions.filter((a) => a !== 'none');
    };
    assertDeepEq(run('frozen', 6), ['pause-play', 'pause-play'], 'two pause/plays first');
    assertDeepEq(run('hold', 5), [], 'hold neither counts nor resets');
    assertDeepEq(run('frozen', 3), ['reload'], 'third fix escalates to a reload');
    assertDeepEq(run('frozen', 9), ['pause-play', 'pause-play', 'pause-play'], 'reload cap: pause/play only');
    assert(st.stallTick(ladder, 'frozen', 3, true).capped === false, 'not capped mid-count');
    run('healthy', 1);
    assertDeepEq(ladder, { frozenTicks: 0, fixAttempts: 0, reloadUsed: false }, 'healthy tick resets the window');
    run('frozen', 9);
    assertDeepEq(run('frozen', 9, false), ['pause-play', 'pause-play', 'reload'], 'cap disabled: reloads again');
}

// ============================================================
// Test: post-break wedge watch
// ============================================================
{
    console.log('--- wedge watch ---');
    const wd = loadModules(['src/page/wedge.ts']);
    let watch = wd.armWedgeWatch();
    let t = 10;
    let frames = 1000;
    const sample = (dt, df) => {
        t += dt;
        frames += df;
        const r = wd.wedgeSample(watch, t, frames);
        watch = r.next;
        return r.step.action;
    };
    assertEq(sample(0, 0), 'none', 'first sample is the baseline');
    const wedged = [];
    for (let i = 0; i < 6; i++) wedged.push(sample(1, 0));
    assertDeepEq(wedged.slice(0, 5), ['none', 'none', 'none', 'none', 'none'], 'evidence accumulates');
    assertEq(wedged[5], 'nudge', 'sixth wedged evaluation: pause/play nudge');
    for (let i = 0; i < 5; i++) sample(1, 0);
    assertEq(sample(1, 0), 'reload', 'recurs: reload');
    assertEq(watch.phase, 'disarmed', 'reload disarms the watch');
    watch = wd.armWedgeWatch();
    sample(0, 0);
    sample(1, 30);
    sample(1, 30);
    sample(1, 30);
    assertEq(watch.phase, 'disarmed', 'three healthy evaluations disarm');
    watch = wd.armWedgeWatch();
    sample(0, 0);
    for (let i = 0; i < 5; i++) sample(1, 0);
    sample(1, -500); // reload: frame counter went backwards
    assertEq(watch.evidence, 0, 'frame counter reset is not evidence');
    sample(0.1, 0);
    assertEq(watch.evidence, 0, 'no playhead advance: not evaluated');
    watch = wd.armWedgeWatch();
    sample(0, 0);
    for (let i = 0; i < 40; i++) sample(1, 3); // ambiguous
    assertEq(watch.phase, 'disarmed', 'watch ends after 40 evaluations');
}

// ============================================================
// Test: worker GQL request headers (gqlRequest)
// ============================================================
asyncTests.push(async () => {
    console.log('--- gqlRequest headers ---');
    const posted = [];
    const worker = loadModules(['src/worker/gql.ts', 'src/worker/state.ts'], {
        globals: { setTimeout, clearTimeout, postMessage: (m) => posted.push(m) },
    });
    worker.state.GQLDeviceID = 'device123';
    worker.state.AuthorizationHeader = undefined;
    worker.gqlRequest({ operationName: 'Test' }).catch(() => {});
    worker.state.AuthorizationHeader = 'OAuth abc';
    worker.gqlRequest({ operationName: 'Test' }).catch(() => {});
    const [loggedOut, loggedIn] = posted.map((m) => m.value.options.headers);
    assert(!('Authorization' in loggedOut), 'no Authorization header when logged out (was the literal "undefined")');
    assertEq(loggedIn.Authorization, 'OAuth abc', 'Authorization header sent when logged in');
    assertEq(loggedOut['X-Device-Id'], 'device123', 'device id header sent');
    for (const { timeoutId } of worker.pendingFetchRequests.values()) clearTimeout(timeoutId);
});

// ============================================================
// Test: page fetch hook (hookFetch)
// ============================================================
asyncTests.push(async () => {
    console.log('--- hookFetch ---');
    const calls = [];
    const page = loadModules(['src/page/fetch-hook.ts', 'src/page/state.ts'], {
        globals: {
            fetch: async (...args) => {
                calls.push(args);
                return 'ok';
            },
        },
    });
    page.hookFetch();
    let threw = null;
    try {
        await page.context.fetch('https://gql.twitch.tv/gql');
    } catch (e) {
        threw = e;
    }
    assertEq(threw, null, 'GQL fetch without an init object does not throw in the hook');
    assertEq(calls.length, 1, 'request is passed through to the real fetch');
    await page.context.fetch('https://gql.twitch.tv/gql', {
        headers: { 'Client-Version': 'v1', 'X-Device-Id': 'dev1' },
        body: '{}',
    });
    assertEq(page.state.ClientVersion, 'v1', 'captures Client-Version from GQL request headers');
    assertEq(page.state.GQLDeviceID, 'dev1', 'captures X-Device-Id from GQL request headers');
});

// ============================================================
// installHook / maskAsNative: hooks under strict mode
// ============================================================
{
    console.log('--- installHook ---');
    const lines = [];
    const h = loadModules(['src/shared/hook.ts', 'src/page/mask.ts'], {
        console: { log: (m) => lines.push(String(m)) },
    });
    const run = (code) => vm.runInContext(code, h.context);
    const fn = () => 'hooked';

    const plain = run('({ m() {} })');
    assertEq(h.installHook(plain, 'm', fn, 'plain'), true, 'writable property: hooked');
    assertEq(plain.m, fn, 'writable property: replaced');

    const readOnly = run("Object.defineProperty({}, 'm', { value() {}, writable: false, configurable: true })");
    assertEq(h.installHook(readOnly, 'm', fn, 'readOnly'), true, 'read-only but configurable: hooked');
    assertEq(readOnly.m, fn, 'read-only but configurable: redefined (sloppy mode used to miss this silently)');

    const getterOnly = run("Object.defineProperty({}, 'm', { get() { return 1; }, configurable: true })");
    assertEq(h.installHook(getterOnly, 'm', fn, 'getterOnly'), true, 'getter-only but configurable: hooked');

    const locked = run("Object.defineProperty({}, 'm', { value: 1, writable: false, configurable: false })");
    let threw = false;
    let result;
    try {
        result = h.installHook(locked, 'm', fn, 'locked thing');
    } catch {
        threw = true;
    }
    assertEq(threw, false, 'locked property: does not throw under strict mode');
    assertEq(result, false, 'locked property: reports not hooked');
    assertEq(locked.m, 1, 'locked property: left alone');
    assert(
        lines.some((l) => l.includes('Could not hook locked thing')),
        'locked property: logged',
    );

    const inherited = run('Object.create(Object.freeze({ m() {} }))');
    assertEq(
        h.installHook(inherited, 'm', fn, 'inherited'),
        false,
        'read-only inherited property: reports not hooked (no own-property redefinition)',
    );

    run('Object.freeze(Function.prototype)');
    const masked = h.maskAsNative(run('(function () {})'), 'fetch');
    assertEq(
        masked.toString(),
        'function fetch() { [native code] }',
        'maskAsNative works when Function.prototype is frozen',
    );
}

// ============================================================
// End to end: the built userscript (vaft/vaft.user.js)
// ============================================================
const BUILT = join(ROOT, 'vaft', 'vaft.user.js');
const quiet = { log() {}, info() {}, warn() {}, error() {}, debug() {} };

asyncTests.push(async () => {
    console.log('--- built userscript: injected worker ---');
    if (!existsSync(BUILT)) {
        assert(false, 'vaft/vaft.user.js exists (run node scripts/build.js)');
        return;
    }
    const blob = injectWorker(BUILT);
    assert(blob.startsWith('(function runWorker(__vaftInit)'), 'worker blob is the runWorker() bundle');
    assert(
        blob.includes('hookWorkerFetch'),
        "blob carries the 'hookWorkerFetch' marker the already-hooked check looks for",
    );
    const network = async () => ({ body: '#EXTM3U' });
    const worker = startWorker(blob, { network, twitchWorkerJs: 'var twitchWorkerLoaded = true;' });
    assertEq(worker.context.twitchWorkerLoaded, true, "Twitch's worker code runs in the worker's global scope");
    assert(worker.context.fetch.toString().includes('AdSegmentCache'), 'worker fetch is hooked');

    // Settings from the page reach the worker.
    const custom = startWorker(injectWorker(BUILT, { localStorage: { twitchAdSolutions_playerType: 'embed' } }), {
        network,
    });
    const r = await custom.fetch('https://usher.ttvnw.net/api/channel/hls/x.m3u8?parent_domains=a');
    assertEq(r.status, 200, 'master playlist request answered');
    assert(
        !custom.requested.some((u) => u.includes('parent_domains')),
        'ForceAccessTokenPlayerType from localStorage reached the worker (parent_domains stripped)',
    );
});

asyncTests.push(async () => {
    console.log('--- built userscript: strict mode and locked properties ---');
    if (!existsSync(BUILT)) return;
    const built = readFileSync(BUILT, 'utf8');
    assert(
        built.includes('// ==/UserScript==\n(() => {\n  "use strict";\n'),
        'page bundle: "use strict" is the first statement of its IIFE',
    );
    const blob = injectWorker(BUILT);
    assert(
        blob.startsWith('(function runWorker(__vaftInit) {\n(() => {\n  "use strict";\n'),
        'worker blob: "use strict" is the first statement of the worker IIFE',
    );

    // Another extension locked the page's fetch and XHR open: vaft logs it and still injects.
    const lock = (obj, key) =>
        Object.defineProperty(obj, key, { value: obj[key], writable: false, configurable: false });
    const pageLog = [];
    const lockedBlob = injectWorker(BUILT, {
        console: { ...quiet, log: (m) => pageLog.push(String(m)) },
        setup(page) {
            lock(page, 'fetch');
            lock(page.XMLHttpRequest.prototype, 'open');
        },
    });
    assert(lockedBlob.includes('hookWorkerFetch'), 'locked page fetch/open: worker still injected');
    assert(
        pageLog.some((l) => l.includes('Could not hook window fetch')) &&
            pageLog.some((l) => l.includes('Could not hook XMLHttpRequest.open')),
        'locked page fetch/open: logged',
    );
    assert(
        !pageLog.some((l) => l.includes('Window fetch hook installed')),
        'locked page fetch: not reported as installed',
    );

    // Worker fetch locked: no ad blocking there, but Twitch's code must still run.
    const workerLog = [];
    const network = async () => ({ body: '#EXTM3U' });
    const lockedWorker = startWorker(blob, {
        network,
        console: { ...quiet, log: (m) => workerLog.push(String(m)) },
        setup: (w) => lock(w, 'fetch'),
    });
    assertEq(lockedWorker.context.twitchWorkerLoaded, true, "locked worker fetch: Twitch's worker code still runs");
    assert(
        workerLog.some((l) => l.includes('ads will not be blocked in this worker')),
        'locked worker fetch: logged',
    );

    // Read-only but configurable (what a careless extension does): redefined, so ads are still
    // handled. Sloppy mode silently left these unhooked.
    const roWorker = startWorker(blob, {
        network,
        setup: (w) => Object.defineProperty(w, 'fetch', { value: w.fetch, writable: false, configurable: true }),
    });
    assert(roWorker.context.fetch.toString().includes('AdSegmentCache'), 'read-only worker fetch: hooked anyway');
});

asyncTests.push(async () => {
    console.log('--- built userscript: ad-break scenarios ---');
    if (!existsSync(BUILT)) return;
    const site = (await runScenario(BUILT, SCENARIOS['ad break, clean backup (site)'])).transcript;
    const adPoll = site.find((t) => t.label === 'phase 1 poll 0');
    assert(adPoll.body.includes('backup-site/'), 'ad break: playlist swapped to the clean site backup');
    assert(!adPoll.body.includes('edge.example/ad/'), 'ad break: no ad segments reach the player');
    assert(
        adPoll.messages.some((m) => m.key === 'UpdateAdBlockBanner' && m.activeBackupPlayerType === 'site'),
        'ad break: banner reports the site backup',
    );
    const end = site.filter((t) => t.label.startsWith('phase 2')).flatMap((t) => t.messages);
    assert(
        end.some((m) => m.key === 'ReloadPlayer') && end.some((m) => m.key === 'UpdateAdBlockBanner' && !m.hasAds),
        'ad break end: player reload and banner cleared',
    );

    const stripRun = await runScenario(BUILT, SCENARIOS['ad break, every backup ad-laden (strip + recovery)']);
    const stripped = stripRun.transcript.filter((t) => t.label.startsWith('phase 1'));
    // The strip path leaves ad segment lines in the playlist and answers them with a blank MP4.
    const adUrls = [...new Set(stripped.flatMap((t) => t.body.match(/^https:\/\/edge\.example\/ad\/\S+$/gm) || []))];
    assert(adUrls.length > 0, 'all backups ad-laden: playlists still list ad segments (to be blanked)');
    const answers = await Promise.all(adUrls.map((u) => stripRun.worker.fetch(u)));
    assert(
        answers.every((a) => a.body !== 'segment'),
        'all backups ad-laden: every ad segment is answered with the blank MP4, not the ad',
    );
    assertEq(
        (await stripRun.worker.fetch('https://edge.example/live/seg-1.ts')).body,
        'segment',
        'live segments still come from the network',
    );
    assert(
        stripped.flatMap((t) => t.messages).some((m) => m.key === 'ReloadPlayer' && m.kind === 'early'),
        'all backups ad-laden: early reload requested',
    );
    // End-of-break reload after a break that stripped nothing but committed a backup (#129 mode D).
    const endReloadKinds = async (spec) =>
        (await runScenario(BUILT, spec)).transcript
            .filter((t) => t.label.startsWith('phase 2'))
            .flatMap((t) => t.messages)
            .filter((m) => m.key === 'ReloadPlayer')
            .map((m) => m.kind);
    const swap = SCENARIOS['ad break, clean backup (site)'];
    assertDeepEq(await endReloadKinds(swap), ['post-ad'], 'no-strip backup swap: soft end-of-break reload');
    assertDeepEq(
        await endReloadKinds({ ...swap, localStorage: { twitchAdSolutions_softReloadNoStrip: 'false' } }),
        ['early'],
        'no-strip backup swap with softReloadNoStrip=false: hard reload',
    );
    assertDeepEq(
        await endReloadKinds({ ...swap, backupAds: { site: 6, popout: 6, mobile_web: 6, embed: 6 } }),
        ['early'],
        'no-strip break on the autoplay backup: hard reload (token refresh restores Source quality)',
    );
    // Pinning: break 1 commits popout (site is ad-laden). Break 2 starts with the pinned popout
    // (warm cache, no token fetch) unless pinning is off, where site comes first again.
    const twoBreaks = {
        backupAds: { site: 6 },
        phases: [
            { ads: 0, polls: 2 },
            { ads: 4, polls: 2 },
            { ads: 0, polls: 4 },
            { ads: 4, polls: 1 },
        ],
    };
    const secondBreakTokens = async (localStorage) =>
        (await runScenario(BUILT, { ...twoBreaks, localStorage })).transcript
            .filter((t) => t.label === 'phase 3 poll 0')
            .flatMap((t) => t.messages)
            .filter((m) => m.key === 'FetchRequest')
            .map((m) => JSON.parse(m.body).variables.playerType);
    assertDeepEq(await secondBreakTokens(), [], 'pinned popout tried first in the next break (warm, no token fetch)');
    assertDeepEq(
        await secondBreakTokens({ twitchAdSolutions_pinBackupPlayerType: 'false' }),
        ['site'],
        'pinBackupPlayerType=false: nothing pinned (site and the other Source types used to be pinned anyway)',
    );
    // Codec swap the page couldn't do (paused, PiP): back to native, not retried every poll.
    const hevc = await runScenario(BUILT, {
        ...SCENARIOS['HEVC stream, ad break'],
        reload: (m) => (m.kind === 'codec-swap' ? 'not-done' : 'reloaded'),
    });
    const swaps = hevc.transcript.flatMap((t) => t.messages).filter((m) => m.kind === 'codec-swap');
    assertEq(swaps.length, 1, 'codec swap requested once per break');
    const hevcDefault = await runScenario(BUILT, SCENARIOS['HEVC stream, ad break']);
    assertDeepEq(
        reloads(hevcDefault.transcript.find((t) => t.label === 'phase 1 poll 0').messages).map((m) => m.kind),
        ['codec-swap'],
        'the poll that starts the codec swap sends no early reload alongside it (used to send two)',
    );
    const hevcLog = [];
    const hevcStuck = await runScenario(BUILT, {
        ...SCENARIOS['HEVC stream, ad break'],
        phases: [
            { ads: 0, polls: 2 },
            { ads: 4, polls: 2 },
        ],
        console: { log: (...a) => hevcLog.push(a.join(' ')) },
        reload: (m) => (m.kind === 'codec-swap' ? 'not-done' : 'reloaded'),
    });
    assert(
        hevcLog.some((l) => l.includes('Codec-swap reload not done by the page (not-done)')),
        'codec swap not done: worker returns to the native codec',
    );
    assert(hevcStuck.transcript.length > 0, 'scenario ran');
});

// ============================================================
// Test: the page answers reload requests (ReloadResult)
// ============================================================
asyncTests.push(async () => {
    console.log('--- built userscript: reload requests ---');
    if (!existsSync(BUILT)) return;
    const sent = [];
    const handlers = [];
    injectWorker(BUILT, {
        setup(page) {
            const proto = page.Worker.prototype;
            proto.postMessage = (m) => sent.push(m);
            const add = proto.addEventListener;
            proto.addEventListener = function (type, fn) {
                add.call(this, type, fn);
                if (type === 'message') handlers.push(fn);
            };
        },
    });
    for (const fn of handlers) fn({ data: { key: 'ReloadPlayer', kind: 'early', requestId: 7 } });
    assertDeepEq(
        sent.filter((m) => m.key === 'ReloadResult'),
        [{ key: 'ReloadResult', value: { requestId: 7, outcome: 'not-done' } }],
        'no player on the page: the request is answered not-done',
    );
    sent.length = 0;
    for (const fn of handlers) fn({ data: { key: 'ReloadPlayer', kind: 'post-ad' } });
    assertEq(sent.filter((m) => m.key === 'ReloadResult').length, 0, 'no requestId: no answer');
});

asyncTests.push(async () => {
    console.log('--- built userscript: nested-frame guard ---');
    if (!existsSync(BUILT)) return;
    const runs = (setup) => {
        try {
            injectWorker(BUILT, { setup });
            return true;
        } catch (e) {
            if (/got 0/.test(e.message)) return false;
            throw e;
        }
    };
    const crossOriginTop = {
        get location() {
            throw new Error('SecurityError: cross-origin');
        },
    };
    assert(
        runs(() => {}),
        'top frame: runs',
    );
    assert(
        runs((page) => {
            page.top = { location: { href: page.document.location.href } };
        }),
        'top frame behind a userscript-manager proxy (window.top is another object): runs',
    );
    assert(
        !runs((page) => {
            page.top = crossOriginTop;
            page.document.location = {
                hostname: 'passport.twitch.tv',
                pathname: '/frame',
                href: 'https://passport.twitch.tv/frame',
            };
        }),
        'cross-origin hidden iframe (frameElement null, top unreadable): skipped',
    );
    assert(
        runs((page) => {
            page.top = crossOriginTop;
            page.document.location = {
                hostname: 'player.twitch.tv',
                pathname: '/',
                href: 'https://player.twitch.tv/?channel=testchan',
            };
        }),
        'Twitch embed in a third-party page (cross-origin): runs',
    );
    assert(
        !runs((page) => {
            page.frameElement = {};
            page.top = { location: { href: 'https://www.twitch.tv/testchan' } };
            page.document.location = { hostname: 'www.twitch.tv', pathname: '/x', href: 'https://www.twitch.tv/x' };
        }),
        'same-origin nested non-embed frame: skipped',
    );
});

// ============================================================
// Results
// ============================================================
(async () => {
    for (const run of asyncTests) {
        try {
            await run();
        } catch (e) {
            failed++;
            console.error('FAIL: async test threw', e);
        }
    }
    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    process.exit(failed > 0 ? 1 : 0);
})();
