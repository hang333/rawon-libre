/**
 * YouTube only generates `maxresdefault.jpg` when the source was at least 720p and
 * serves a 404 otherwise, which Discord renders as a missing image. `hqdefault.jpg`
 * is generated for every video, so it is the largest size that can be derived from
 * a video id alone without risking a broken embed.
 */
export function getYouTubeThumbnail(videoId: string): string {
    return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

export function getSoundCloudThumbnail(url: string | undefined | null): string {
    if (!url || url.length === 0) {
        return "";
    }

    let parsedUrl: URL;
    try {
        parsedUrl = new URL(url);
    } catch {
        return url;
    }

    if (!/sndcdn\.com$/u.test(parsedUrl.hostname)) {
        return url;
    }

    parsedUrl.pathname = parsedUrl.pathname.replace(
        /-(?:t\d+x\d+|crop|large|small|tiny|mini|badge|original)\.(jpg|jpeg|png|webp)$/iu,
        "-t500x500.$1",
    );

    return parsedUrl.toString();
}

/**
 * What to hand an embed for a track's artwork. An embed rejects anything that is
 * not an http(s) URL, and a track without artwork (an uploaded file, a SoundCloud
 * track with no cover) carries an empty string rather than nothing.
 */
export function embedThumbnail(url: string | null | undefined): string | null {
    return typeof url === "string" && /^https?:\/\//iu.test(url) ? url : null;
}

/**
 * Bring a YouTube thumbnail URL that came from somewhere else onto the same size as
 * the ones built here, so that a queue does not mix 120x90 stills with full-size art.
 * Non-YouTube URLs are returned untouched.
 */
export function normalizeThumbnailUrl(url: string | undefined | null): string {
    if (!url || url.length === 0) {
        return "";
    }

    let parsedUrl: URL;
    try {
        parsedUrl = new URL(url);
    } catch {
        return url;
    }

    const validHosts = ["img.youtube.com", "i.ytimg.com"];
    if (!validHosts.includes(parsedUrl.hostname)) {
        return url;
    }

    const videoIdMatch = /\/vi(?:_webp)?\/([^/]+)/u.exec(parsedUrl.pathname);
    if (!videoIdMatch?.[1]) {
        return url;
    }

    return getYouTubeThumbnail(videoIdMatch[1]);
}

/**
 * Pick the largest thumbnail an extractor actually reported. Those URLs are known to
 * exist, unlike a size guessed from a video id, so they are preferred where available.
 * Returns the fallback when the extractor reported nothing usable.
 */
export function pickBestThumbnail(
    candidates: { url: string; width: number; height: number }[] | undefined,
    fallback = "",
): string {
    if (!candidates || candidates.length === 0) {
        return fallback;
    }

    const best = candidates.reduce((largest, candidate) =>
        candidate.width * candidate.height > largest.width * largest.height ? candidate : largest,
    );

    return best.url.length > 0 ? normalizeThumbnailUrl(best.url) : fallback;
}
