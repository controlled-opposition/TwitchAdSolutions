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
    getStreamUrlForResolution,
    stripAdSegments,
} = vaft;
const { isValidWorker } = loadModules(['src/page/worker-hook.ts']);
// Same Map object the loaded code reads and writes; clear() it between cases.
const AdSegmentCache = vaft.state.AdSegmentCache;

// A real StreamInfo (full field shape from createStreamInfo) with per-test overrides.
function makeStreamInfo(overrides = {}) {
    return Object.assign(vaft.createStreamInfo('testchannel', '', ''), overrides);
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
// Test: getStreamUrlForResolution
// ============================================================
console.log('--- getStreamUrlForResolution ---');
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
    getStreamUrlForResolution(encodingsM3u8, { Resolution: '1920x1080', FrameRate: 30 }),
    'https://video.twitch.tv/1080p30.m3u8',
    'exact resolution + framerate match',
);
assertEq(
    getStreamUrlForResolution(encodingsM3u8, { Resolution: '1280x720', FrameRate: 60 }),
    'https://video.twitch.tv/720p60.m3u8',
    'exact 720p60 match',
);
assertEq(
    getStreamUrlForResolution(encodingsM3u8, { Resolution: '1280x720', FrameRate: 30 }),
    'https://video.twitch.tv/720p60.m3u8',
    'resolution match without framerate match returns closest',
);
assert(
    getStreamUrlForResolution(encodingsM3u8, { Resolution: '1600x900', FrameRate: 30 }) != null,
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
assertEq(streamInfo.NumStrippedAdSegments, 1, 'counts stripped ad segment');
assert(streamInfo.IsStrippingAdSegments === true, 'marks as stripping');
assert(AdSegmentCache.has('https://ad-segment-1.ts'), 'caches ad segment URL');
assert(!result.includes('https://prefetch.url'), 'removes prefetch URLs during ads');
assert(streamInfo.RecoverySegments.length === 1, 'caches live segment for recovery');

// Test: no stripping on clean m3u8
AdSegmentCache.clear();
const cleanM3u8 = [
    '#EXTM3U',
    '#EXTINF:2.000,live',
    'https://live-segment-1.ts',
    '#EXTINF:2.000,live',
    'https://live-segment-2.ts',
].join('\n');

streamInfo = makeStreamInfo({ NumStrippedAdSegments: 5 });
result = stripAdSegments(cleanM3u8, false, streamInfo);
assertEq(streamInfo.NumStrippedAdSegments, 0, 'resets stripped count on clean m3u8');
assert(streamInfo.IsStrippingAdSegments === false, 'not stripping on clean m3u8');

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

streamInfo = makeStreamInfo({
    RecoverySegments: [
        { extinf: '#EXTINF:2.000,live', url: 'https://recovery-1.ts' },
        { extinf: '#EXTINF:2.000,live', url: 'https://recovery-2.ts' },
    ],
});
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
assertEq(streamInfo.RecoveryStartSeq, 100, 'captures RecoveryStartSeq at cache time');
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
assert(streamInfo.IsStrippingAdSegments === true, 'detects ads with multiple signifiers');
assert(AdSegmentCache.has('https://ad-1.ts'), 'strips segment with multiple signifiers present');

// Test: AdSegmentCache deduplication
AdSegmentCache.clear();
const dupeM3u8 = ['#EXTM3U', '#EXTINF:2.000,stitched-ad', 'https://same-ad.ts'].join('\n');

streamInfo = makeStreamInfo();
stripAdSegments(dupeM3u8, false, streamInfo);
assertEq(streamInfo.NumStrippedAdSegments, 1, 'first strip increments count');
const streamInfo2 = makeStreamInfo();
stripAdSegments(dupeM3u8, false, streamInfo2);
assertEq(streamInfo2.NumStrippedAdSegments, 0, 'duplicate URL does not increment count (already cached)');

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
// Test: getStreamUrlForResolution — edge cases
// ============================================================
console.log('--- getStreamUrlForResolution (edge cases) ---');
assertEq(
    getStreamUrlForResolution('#EXTM3U\n', { Resolution: '1920x1080', FrameRate: 30 }),
    null,
    'returns null for empty m3u8',
);
assertEq(
    getStreamUrlForResolution('', { Resolution: '1920x1080', FrameRate: 30 }),
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
    const worker = loadModules(['src/worker/fetch-hook.ts', 'src/worker/state.ts'], {
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
