// Page bundle entry: becomes vaft/vaft.user.js (scripts/build.js adds the userscript header).
import { installHook } from '../shared/hook.ts';
import { monitorPlayerBuffering } from './buffer-monitor.ts';
import { hookFetch, hookXhr } from './fetch-hook.ts';
import { doTwitchPlayerTask } from './player.ts';
import { state } from './state.ts';
import { loadLocalStorageConfig, onContentLoaded } from './storage.ts';
import { hookWindowWorker } from './worker-hook.ts';
import { postTwitchWorkerMessage } from './workers.ts';

const ourTwitchAdSolutionsVersion = 97; // Used to prevent conflicts with outdated versions of the scripts

function main() {
    // Skip injection in nested frames that aren't legitimate Twitch embed contexts.
    // Twitch's main channel page has 5+ hidden cross-origin iframes (auth, analytics,
    // ad SDK, etc.) and userscript managers / uBO inject into all matching ones. Each
    // becomes a racing vaft instance that fights for player control. Only the top frame
    // hosts the player on twitch.tv/CHANNEL; nested auxiliary frames are noise.
    // Allow-list for nested-frame injection: Twitch's three documented embed contexts
    // (https://dev.twitch.tv/docs/embed/video-and-clips/) — preserves Twitch streams
    // embedded on third-party sites where vaft runs in an iframe whose parent is on
    // a different origin.
    // Use window.frameElement to detect nested frames — null on top frame, the iframe
    // element on a same-origin nested frame, throws on a cross-origin nested frame.
    // More reliable than 'window !== window.top' because Tampermonkey wraps window in a
    // proxy where the strict comparison can return true even on the top frame.
    let _isNested = false;
    try {
        _isNested = window.frameElement !== null;
    } catch (_e) {
        _isNested = true;
    }
    if (_isNested) {
        const _host = document.location.hostname;
        const _isEmbedContext =
            _host === 'player.twitch.tv' ||
            _host === 'embed.twitch.tv' ||
            document.location.pathname.startsWith('/embed/');
        if (!_isEmbedContext) {
            console.log(
                '[AD DEBUG] vaft skipped — nested frame on ' +
                    _host +
                    document.location.pathname +
                    ' (not a Twitch embed). If you see this on twitch.tv/CHANNEL top frame, please report.',
            );
            return;
        }
    }
    // Skip injection on the Twitch clip editor — clips.twitch.tv host or /<channel>/clip/<slug> path.
    // Our fetch/Worker hooks and buffer monitor are aimed at the live channel player; on the
    // clip editor's seekable preview they have no ads to act on and have caused the preview
    // to freeze when the user drags the trim range. (Sync'd with TTV-AB v6.4.9.)
    {
        const _clipHost = document.location.hostname;
        const _clipPath = document.location.pathname || '';
        if (_clipHost === 'clips.twitch.tv' || /^\/[^/]+\/clip\/[^/]+/.test(_clipPath)) {
            console.log('[AD DEBUG] vaft skipped — clip editor page (' + _clipHost + _clipPath + ').');
            return;
        }
    }
    console.log('[AD DEBUG] TwitchAdSolutions vaft v' + ourTwitchAdSolutionsVersion + ' loading');
    if (
        typeof window.twitchAdSolutionsVersion !== 'undefined' &&
        window.twitchAdSolutionsVersion >= ourTwitchAdSolutionsVersion
    ) {
        console.log(
            '[AD DEBUG] CONFLICT: vaft v' +
                ourTwitchAdSolutionsVersion +
                ' skipped — another script already active (v' +
                window.twitchAdSolutionsVersion +
                '). Remove duplicate scripts.',
        );
        return;
    }
    // installHook rather than assignment for these globals: if a property was left locked
    // (another copy, another extension) the assignment would throw under strict mode and stop
    // vaft starting; the debug helpers are not worth that.
    installHook(window, 'twitchAdSolutionsVersion', ourTwitchAdSolutionsVersion, 'window.twitchAdSolutionsVersion');
    installHook(
        window,
        'reloadTwitchPlayer',
        () => {
            doTwitchPlayerTask('reload');
        },
        'window.reloadTwitchPlayer',
    );
    loadLocalStorageConfig();
    console.log(
        '[AD DEBUG] Config: ReloadPlayerAfterAd = ' +
            state.ReloadPlayerAfterAd +
            ', ForceAccessTokenPlayerType = ' +
            state.ForceAccessTokenPlayerType +
            ', PinBackupPlayerType = ' +
            state.PinBackupPlayerType,
    );
    hookWindowWorker();
    hookFetch();
    // Hook XHR to detect CSAI ad requests that bypass fetch
    hookXhr();
    if (state.PlayerBufferingFix) {
        monitorPlayerBuffering();
    }
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        onContentLoaded();
    } else {
        window.addEventListener('DOMContentLoaded', function () {
            onContentLoaded();
        });
    }
    installHook(
        window,
        'simulateAds',
        (depth?: number) => {
            if (depth === undefined || depth < 0) {
                console.log(
                    'Ad depth parameter required (0 = no simulated ad, 1+ = use backup player for given depth)',
                );
                return;
            }
            postTwitchWorkerMessage('SimulateAds', depth);
        },
        'window.simulateAds',
    );
    installHook(
        window,
        'allSegmentsAreAdSegments',
        () => {
            postTwitchWorkerMessage('AllSegmentsAreAdSegments');
        },
        'window.allSegmentsAreAdSegments',
    );
}

main();
