import { URL } from "node:url";
import { type QueryData } from "../../../typings/index.js";

export function checkQuery(string: string): QueryData {
    let url: URL;
    try {
        url = new URL(string);
    } catch {
        return {
            isURL: false,
            sourceType: "query",
        };
    }

    const result: QueryData = {
        isURL: true,
    };

    if (/soundcloud|snd/gu.test(url.hostname)) {
        result.sourceType = "soundcloud";

        result.type = url.pathname.includes("/sets/") ? "playlist" : "track";
    } else if (/youtube|youtu\.be/gu.test(url.hostname)) {
        result.sourceType = "youtube";

        const isYouTube = /youtube/gu.test(url.hostname);
        const isYouTuBe = /youtu\.be/gu.test(url.hostname);
        // The URL parser never yields an empty pathname: a bare https://youtu.be is
        // "/", and https://youtu.be// keeps both slashes. Only a path with a real
        // segment carries a video id.
        const hasShortLinkId = url.pathname.split("/").some((segment) => segment.length > 0);

        if ((!isYouTuBe && url.pathname.startsWith("/playlist")) || url.searchParams.has("list")) {
            result.type = "playlist";
        } else if (
            (isYouTube &&
                (url.pathname.startsWith("/watch") ||
                    url.pathname.startsWith("/shorts/") ||
                    url.pathname.startsWith("/live/"))) ||
            (isYouTuBe && hasShortLinkId)
        ) {
            result.type = "track";
        } else {
            result.type = "unknown";
        }
    } else if (/spotify/gu.test(url.hostname)) {
        result.sourceType = "spotify";

        const pathSegments = url.pathname.split("/").filter(Boolean);
        if (pathSegments.includes("playlist") || pathSegments.includes("album")) {
            result.type = "playlist";
        } else if (pathSegments.includes("track")) {
            result.type = "track";
        } else if (pathSegments.includes("artist")) {
            result.type = "artist";
        } else {
            result.type = "unknown";
        }
    } else if (/bilibili\.com|b23\.tv/gu.test(url.hostname)) {
        result.sourceType = "bilibili";

        result.type =
            url.pathname.includes("/video/") || /b23\.tv/gu.test(url.hostname)
                ? "track"
                : "unknown";
    } else {
        result.sourceType = "unknown";
        result.type = "unknown";
    }

    return result;
}
