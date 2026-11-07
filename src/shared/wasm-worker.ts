/** Twitch's worker scripts, by blob URL. Fetched synchronously, since the Worker constructor is synchronous. */
const cache: Record<string, string> = Object.create(null);

/** Twitch's worker script for a blob URL (cached). */
export function getWasmWorkerJs(twitchBlobUrl: string): string {
    if (cache[twitchBlobUrl]) {
        return cache[twitchBlobUrl];
    }
    const req = new XMLHttpRequest();
    req.open('GET', twitchBlobUrl, false);
    req.overrideMimeType('text/javascript');
    req.send();
    const text = req.responseText;
    cache[twitchBlobUrl] = text;
    return text;
}
