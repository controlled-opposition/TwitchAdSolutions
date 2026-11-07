import type { M3u8Attributes, ResolutionInfo, VideoCodecFamily } from '../shared/types.ts';
import { state } from './state.ts';

export function parseAttributes(str: string): M3u8Attributes {
    if (!str) return {};
    // Normalize: always pass only attribute section
    if (str.charCodeAt(0) === 35) {
        // '#'
        const idx = str.indexOf(':');
        if (idx !== -1) str = str.slice(idx + 1);
    }
    return Object.fromEntries(
        str
            .split(/(?:^|,)((?:[^=]*)=(?:"[^"]*"|[^,]*))/)
            .filter(Boolean)
            .map((x) => {
                const idx = x.indexOf('=');
                const key = x.substring(0, idx);
                const value = x.substring(idx + 1);
                const num = Number(value);
                return [key, Number.isNaN(num) ? (value.startsWith('"') ? JSON.parse(value) : value) : num];
            }),
    );
}
export function getServerTimeFromM3u8(encodingsM3u8: string): string | null {
    if (state.V2API) {
        const matches = encodingsM3u8.match(/#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE="([^"]+)"/);
        return matches && matches.length > 1 ? matches[1] : null;
    }
    const matches = encodingsM3u8.match(/SERVER-TIME="([0-9.]+)"/);
    return matches && matches.length > 1 ? matches[1] : null;
}
export function replaceServerTimeInM3u8(encodingsM3u8: string, newServerTime: string | null): string {
    if (state.V2API) {
        return newServerTime
            ? encodingsM3u8.replace(
                  /(#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE=")[^"]+(")/,
                  `$1${newServerTime}$2`,
              )
            : encodingsM3u8;
    }
    return newServerTime
        ? encodingsM3u8.replace(/(SERVER-TIME=")[0-9.]+"/, `SERVER-TIME="${newServerTime}"`)
        : encodingsM3u8;
}
// Find the closest matching stream URL for a given resolution from a master m3u8
// Video codec family from an m3u8 CODECS attribute. Returns 'unknown' for a missing or
// unrecognised attribute rather than throwing — a variant without CODECS used to blow up
// the raw .startsWith() checks below and hang the master-playlist fetch. Ported from
// testing v674.
export function videoCodecFamily(codecs: string | undefined): VideoCodecFamily {
    if (!codecs) return 'unknown';
    // Scan every comma-separated entry rather than assuming the video codec is listed
    // first — an audio-first CODECS value would otherwise silently classify 'unknown'.
    const parts = String(codecs).toLowerCase().split(',');
    for (let i = 0; i < parts.length; i++) {
        const c = parts[i].trim();
        if (c.startsWith('avc')) return 'avc';
        if (c.startsWith('hev') || c.startsWith('hvc')) return 'hevc';
        if (c.startsWith('av0')) return 'av1';
    }
    return 'unknown';
}
// HEVC and AV1: codecs that can go black for a whole ad break when the backup stream switches
// to AVC, so a stream carrying them is swapped onto its AVC variants.
export function isEnhancedCodec(codecs: string | undefined): boolean {
    const family = videoCodecFamily(codecs);
    return family === 'hevc' || family === 'av1';
}
// Pixel area of an m3u8 RESOLUTION value ('1920x1080'), for picking the closest variant.
export function resolutionArea(resolution: string): number {
    const [width, height] = resolution.split('x').map(Number);
    return width * height;
}
export function getStreamUrlForResolution(
    encodingsM3u8: string,
    resolutionInfo: Pick<ResolutionInfo, 'Resolution' | 'FrameRate'>,
): string | null {
    const encodingsLines = encodingsM3u8.split(/\r?\n/);
    const targetArea = resolutionArea(resolutionInfo.Resolution);
    let matchedResolutionUrl = null;
    let matchedFrameRate = false;
    let closestResolutionUrl = null;
    let closestResolutionDifference = Infinity;
    for (let i = 0; i < encodingsLines.length - 1; i++) {
        // Accept v2 API variant URLs which are raw CDN URLs without '.m3u8' in the path.
        // v1 API: next line is '...index-<resolution>.m3u8?...'
        // v2 API: next line is a raw CDN URL like 'https://video-edge-...net/v1/.../chunked/...'
        // without '.m3u8'. Matching only on '.m3u8' would skip v2 variants entirely,
        // causing getStreamUrlForResolution to return null and backup selection to fail.
        const nextLine = encodingsLines[i + 1]?.trim();
        if (
            encodingsLines[i].startsWith('#EXT-X-STREAM-INF') &&
            nextLine &&
            !nextLine.startsWith('#') &&
            (nextLine.includes('.m3u8') || nextLine.includes('://'))
        ) {
            const attributes = parseAttributes(encodingsLines[i]);
            const resolution = attributes['RESOLUTION'];
            const frameRate = attributes['FRAME-RATE'];
            if (resolution) {
                if (
                    resolution === resolutionInfo.Resolution &&
                    (!matchedResolutionUrl || (!matchedFrameRate && frameRate === resolutionInfo.FrameRate))
                ) {
                    matchedResolutionUrl = encodingsLines[i + 1];
                    matchedFrameRate = frameRate === resolutionInfo.FrameRate;
                    if (matchedFrameRate) {
                        return matchedResolutionUrl;
                    }
                }
                const difference = Math.abs(resolutionArea(resolution) - targetArea);
                if (difference < closestResolutionDifference) {
                    closestResolutionUrl = encodingsLines[i + 1];
                    closestResolutionDifference = difference;
                }
            }
        }
    }
    return closestResolutionUrl;
}
