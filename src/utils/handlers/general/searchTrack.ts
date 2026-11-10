import { URL } from "node:url";
import { Playlist, type Video } from "youtubei";
import { type Rawon } from "../../../structures/Rawon.js";
import {
    type BasicYoutubeVideoInfo,
    type PlaylistMetadata,
    type SearchProgressReporter,
    type SearchTrackResult,
    type Song,
    type SpotifyResolveResult,
    type SpotifyTrack,
} from "../../../typings/index.js";
import { chunk } from "../../functions/chunk.js";
import {
    getSoundCloudThumbnail,
    getYouTubeThumbnail,
    pickBestThumbnail,
} from "../../functions/thumbnails.js";
import { youtube, youtubeMusic } from "../YouTubeUtil.js";
import { getInfo, getInfoEntries, searchBilibili } from "../YTDLUtil.js";
import { checkQuery } from "./checkQuery.js";

/** Hits looked up per Bilibili search. Each one costs a run of yt-dlp. */
const BILIBILI_CANDIDATES = 3;
/** Bilibili searches that may run at once, however many tracks wait on one. */
const BILIBILI_CONCURRENCY = 2;
/**
 * Tracks of one playlist that may be looked for on Bilibili. Past this the
 * rest are left out, as every unmatched track was before, rather than keeping
 * a request waiting for minutes when YouTube is failing for all of them.
 */
const BILIBILI_COLLECTION_BUDGET = 30;

let bilibiliRunning = 0;
const bilibiliWaiting: (() => void)[] = [];

async function withBilibiliSlot<Result>(task: () => Promise<Result>): Promise<Result> {
    if (bilibiliRunning < BILIBILI_CONCURRENCY) {
        bilibiliRunning++;
    } else {
        // Whoever finishes hands its slot over, so the count stays as it is.
        await new Promise<void>((resolve) => {
            bilibiliWaiting.push(resolve);
        });
    }

    try {
        return await task();
    } finally {
        const next = bilibiliWaiting.shift();
        if (next === undefined) {
            bilibiliRunning--;
        } else {
            next();
        }
    }
}

/**
 * Look on Bilibili for something YouTube did not have. Empty when the fallback
 * is switched off or the search fails: the request then ends as it would have
 * without it.
 */
async function searchBilibiliEntries(
    client: Rawon,
    query: string,
): Promise<BasicYoutubeVideoInfo[]> {
    if (!client.config.bilibiliFallback || query.trim().length === 0) {
        return [];
    }

    try {
        return await withBilibiliSlot(async () => searchBilibili(query, BILIBILI_CANDIDATES));
    } catch (error) {
        client.logger.warn(
            `[searchTrack] Bilibili fallback search failed: ${(error as Error).message}`,
        );
        return [];
    }
}

function toBilibiliSong(entry: BasicYoutubeVideoInfo): Song {
    return {
        duration: entry.is_live ? 0 : (entry.duration ?? 0),
        id: entry.id ?? "",
        thumbnail: pickBestThumbnail(entry.thumbnails),
        title: entry.title ?? "Unknown Song",
        url: entry.webpage_url ?? entry.url,
        isLive: entry.is_live,
    };
}

/** A search result, reduced to what it can be judged on. Duration in seconds. */
type MatchCandidate = {
    title: string;
    /** Who the listing says it is by: a channel, an uploader. */
    by: string;
    duration?: number | null;
};

/**
 * How well a search result fits a Spotify track. The track's name in the title
 * and an artist's name on the listing count once each; an auto-generated
 * "Topic" channel, which carries the label's own audio, and a length within
 * five seconds of the track's count twice.
 */
function scoreMatch(track: SpotifyTrack, candidate: MatchCandidate): number {
    const title = candidate.title.toLowerCase();
    const by = candidate.by.toLowerCase();
    let score = 0;

    if (title.includes(track.name.toLowerCase())) {
        score += 1;
    }
    if (
        track.artists.some(
            (artist) => artist.name.length > 0 && by.includes(artist.name.toLowerCase()),
        )
    ) {
        score += 1;
    }
    if (by.endsWith("- topic")) {
        score += 2;
    }

    // Spotify counts in milliseconds, a search result in seconds.
    const length = candidate.duration ?? 0;
    if (length > 0 && Math.abs(length - track.duration_ms / 1_000) <= 5) {
        score += 2;
    }

    return score;
}

/** The best-fitting candidate. Equal scores keep the order the search gave. */
function bestMatch<Candidate>(
    track: SpotifyTrack,
    candidates: Candidate[],
    describe: (candidate: Candidate) => MatchCandidate,
): Candidate | undefined {
    return [...candidates].sort(
        (a, b) => scoreMatch(track, describe(b)) - scoreMatch(track, describe(a)),
    )[0];
}

/**
 * SoundCloud reports a track's length in milliseconds; every other source, and
 * everything that reads a song's duration, works in seconds.
 */
function soundCloudSeconds(milliseconds: number | null | undefined): number {
    return Math.round((milliseconds ?? 0) / 1_000);
}

function extractVideoId(url: URL): string | null {
    if (/youtu\.be/gu.test(url.hostname)) {
        return url.pathname.replace("/", "");
    }
    if (url.pathname.startsWith("/shorts/")) {
        return url.pathname.replace("/shorts/", "").split("/")[0];
    }
    if (url.pathname.startsWith("/live/")) {
        return url.pathname.replace("/live/", "").split("/")[0];
    }
    return url.searchParams.get("v");
}

async function loadAllPlaylistVideos(
    client: Rawon,
    playlist: Playlist,
    onProgress?: SearchProgressReporter,
): Promise<void> {
    const maxIterations = 50;
    const maxStagnant = 3;
    let iterations = 0;
    let stagnant = 0;
    let lastCount = playlist.videos.items.length;

    while (playlist.videos.continuation && iterations < maxIterations && stagnant < maxStagnant) {
        try {
            await playlist.videos.next();
        } catch (error) {
            client.logger.warn(
                `[searchTrack] Failed to load playlist continuation: ${(error as Error).message}`,
            );
            break;
        }

        const currentCount = playlist.videos.items.length;
        if (currentCount > lastCount) {
            lastCount = currentCount;
            stagnant = 0;
        } else {
            stagnant += 1;
        }
        iterations += 1;

        onProgress?.({
            phase: "loading",
            loaded: currentCount,
            total: playlist.videoCount > 0 ? playlist.videoCount : undefined,
        });
    }
}

export async function searchTrack(
    client: Rawon,
    query: string,
    source: "soundcloud" | "youtube" | undefined = "youtube",
    onProgress?: SearchProgressReporter,
): Promise<SearchTrackResult> {
    const result: SearchTrackResult = {
        items: [],
    };

    const queryData = checkQuery(query);
    if (queryData.isURL) {
        const url = new URL(query);
        result.type = "results";

        switch (queryData.sourceType) {
            case "soundcloud": {
                let scUrl = url;
                if (["www.soundcloud.app.goo.gl", "soundcloud.app.goo.gl"].includes(url.hostname)) {
                    const req = await client.request.get(url.toString());
                    scUrl = new URL(req.url);

                    for (const key of scUrl.searchParams.keys()) {
                        scUrl.searchParams.delete(key);
                    }
                }

                const newQueryData = checkQuery(scUrl.toString());
                switch (newQueryData.type) {
                    case "track": {
                        const track = await client.soundcloud.tracks.get(scUrl.toString());

                        result.items = [
                            {
                                duration: soundCloudSeconds(track.full_duration),
                                id: track.id.toString(),
                                thumbnail: getSoundCloudThumbnail(
                                    track.artwork_url ?? track.user?.avatar_url,
                                ),
                                title: track.title,
                                url: track.permalink_url,
                            },
                        ];
                        break;
                    }

                    case "playlist": {
                        const playlist = await client.soundcloud.playlists.get(scUrl.toString());
                        const tracks = playlist.tracks.map(
                            (track): Song => ({
                                duration: soundCloudSeconds(track.full_duration),
                                id: track.id.toString(),
                                thumbnail: getSoundCloudThumbnail(
                                    track.artwork_url ?? track.user?.avatar_url,
                                ),
                                title: track.title,
                                url: track.permalink_url,
                            }),
                        );

                        result.items = tracks;
                        result.playlist = {
                            title: playlist.title,
                            url: playlist.permalink_url,
                            thumbnail:
                                getSoundCloudThumbnail(
                                    playlist.artwork_url ?? playlist.user?.avatar_url,
                                ) || undefined,
                            author: playlist.user?.username,
                        };
                        break;
                    }

                    default:
                        break;
                }

                break;
            }

            case "youtube": {
                switch (queryData.type) {
                    case "track": {
                        const videoId = extractVideoId(url);
                        if (videoId === null || videoId.length === 0) {
                            break;
                        }

                        try {
                            const track = await youtube.getVideo(videoId);
                            if (track) {
                                result.items = [
                                    {
                                        duration: track.isLiveContent
                                            ? 0
                                            : (track as Video).duration,
                                        id: track.id,
                                        thumbnail: getYouTubeThumbnail(track.id),
                                        title: track.title,
                                        url: `https://youtube.com/watch?v=${track.id}`,
                                        isLive: track.isLiveContent,
                                    },
                                ];
                            }
                        } catch {
                            try {
                                const videoUrl = `https://youtube.com/watch?v=${videoId}`;
                                const videoInfo = await getInfo(videoUrl, client);

                                if (videoInfo?.id) {
                                    result.items = [
                                        {
                                            duration: videoInfo.is_live
                                                ? 0
                                                : (videoInfo.duration ?? 0),
                                            id: videoInfo.id,
                                            thumbnail: getYouTubeThumbnail(videoInfo.id),
                                            title: videoInfo.title ?? "Unknown",
                                            url: videoInfo.url ?? videoUrl,
                                            isLive: videoInfo.is_live,
                                        },
                                    ];
                                }
                            } catch {}
                        }
                        break;
                    }

                    case "playlist": {
                        const list = url.searchParams.get("list") ?? "";
                        const playlist = await youtube.getPlaylist(list);
                        const songIndex = url.searchParams.get("index");
                        let temp = null;

                        if (playlist) {
                            if (playlist instanceof Playlist && playlist.videos.continuation) {
                                client.logger.info(
                                    `[searchTrack] Loading all videos from YouTube playlist "${playlist.title}" (${playlist.videoCount} videos)...`,
                                );
                                try {
                                    await loadAllPlaylistVideos(client, playlist, onProgress);
                                    client.logger.info(
                                        `[searchTrack] Loaded ${playlist.videos.items.length} videos from playlist "${playlist.title}"`,
                                    );
                                } catch (error) {
                                    client.logger.warn(
                                        `[searchTrack] Failed to load all playlist videos: ${(error as Error).message}`,
                                    );
                                }
                            }

                            const rawTracks = (
                                playlist instanceof Playlist
                                    ? playlist.videos.items
                                    : playlist.videos
                            ).filter((track) => (track?.id?.length ?? 0) > 0);

                            const tracks = rawTracks.map(
                                (track): Song => ({
                                    duration: track.duration ?? 0,
                                    id: track.id,
                                    thumbnail: getYouTubeThumbnail(track.id),
                                    title: track.title,
                                    url: `https://youtube.com/watch?v=${track.id}`,
                                }),
                            );

                            if ((songIndex?.length ?? 0) > 0) {
                                const parsedIndex = Number.parseInt(songIndex ?? "", 10);
                                if (parsedIndex > 0 && parsedIndex <= tracks.length) {
                                    temp = tracks.splice(parsedIndex - 1, 1)[0];
                                }
                            }
                            if (temp) {
                                tracks.unshift(temp);
                            }

                            result.items = tracks;

                            const playlistMeta: PlaylistMetadata = {
                                title: playlist.title,
                                url: `https://youtube.com/playlist?list=${list}`,
                            };
                            if (playlist instanceof Playlist) {
                                playlistMeta.thumbnail = playlist.thumbnails?.[0]?.url;
                                playlistMeta.author = playlist.channel?.name;
                            }
                            result.playlist = playlistMeta;
                        }
                        break;
                    }

                    default:
                        break;
                }

                break;
            }

            case "spotify": {
                let bilibiliBudget = BILIBILI_COLLECTION_BUDGET;

                async function matchOnYouTube(track: SpotifyTrack): Promise<Song | null> {
                    const byName = `${track.artists.map((y) => y.name).join(", ")} - ${track.name}`;
                    const isrc = track.external_ids?.isrc;

                    try {
                        let response = await youtube.search(isrc ?? byName, { type: "video" });
                        if (response.items.length === 0 && isrc !== undefined) {
                            response = await youtube.search(byName, { type: "video" });
                        }

                        const match = bestMatch(track, response.items, (video) => ({
                            title: video.title,
                            by: video.channel?.name ?? "",
                            duration: video.duration,
                        }));

                        return match === undefined ? null : toYouTubeSong(match);
                    } catch {
                        return null;
                    }
                }

                async function matchOnBilibili(track: SpotifyTrack): Promise<Song | null> {
                    if (bilibiliBudget <= 0) {
                        return null;
                    }
                    bilibiliBudget--;

                    const entries = await searchBilibiliEntries(
                        client,
                        `${track.artists.map((y) => y.name).join(" ")} ${track.name}`,
                    );
                    // Uploads there are rarely the artist's own; the artist is
                    // named in the title, if anywhere.
                    const describe = (entry: BasicYoutubeVideoInfo): MatchCandidate => ({
                        title: entry.title ?? "",
                        by: `${entry.uploader ?? ""} ${entry.title ?? ""}`,
                        duration: entry.duration,
                    });
                    const match = bestMatch(track, entries, describe);

                    // YouTube was asked for this very recording; a keyword search
                    // answers with whatever is nearest. A hit that shares neither
                    // the track's name, nor its artist, nor its length is not it.
                    if (match === undefined || scoreMatch(track, describe(match)) === 0) {
                        return null;
                    }

                    client.logger.info(
                        `[searchTrack] No YouTube match for "${track.name}", using Bilibili: ${match.title}`,
                    );
                    return toBilibiliSong(match);
                }

                async function resolveSpotifyTrack(track: SpotifyTrack): Promise<Song | null> {
                    return (await matchOnYouTube(track)) ?? matchOnBilibili(track);
                }

                switch (queryData.type) {
                    case "track": {
                        const songData = (await client.spotify.resolveTracks(
                            url.toString(),
                        )) as SpotifyTrack;
                        const resolved = await resolveSpotifyTrack(songData);
                        if (resolved !== null) {
                            result.items = [resolved];
                        }
                        break;
                    }

                    case "artist":
                    case "playlist": {
                        const spotifyResult = (await client.spotify.resolveTracksWithMetadata(
                            url.toString(),
                        )) as SpotifyResolveResult;
                        const songs = spotifyResult.tracks;
                        const trackResults: Song[] = [];
                        const batches = chunk(songs, 5);
                        for (const batch of batches) {
                            const batchResults = await Promise.all(
                                batch.map(async (x): Promise<Song | null> => {
                                    if (!x.track) {
                                        return null;
                                    }
                                    return resolveSpotifyTrack(x.track);
                                }),
                            );
                            trackResults.push(...batchResults.filter((x): x is Song => x !== null));

                            onProgress?.({
                                phase: "matching",
                                loaded: trackResults.length,
                                total: songs.length,
                            });
                        }
                        result.items = trackResults;
                        if (spotifyResult.metadata) {
                            result.playlist = spotifyResult.metadata;
                        }
                        break;
                    }

                    default:
                        break;
                }

                break;
            }

            default: {
                const entries = await getInfoEntries(url.toString(), client).catch(() => []);

                // One link, several tracks: each part is queued under its own page.
                if (entries.length > 1) {
                    result.items = entries.map(
                        (entry): Song => ({
                            duration: entry.is_live ? 0 : (entry.duration ?? 0),
                            id: entry.id ?? "",
                            thumbnail: pickBestThumbnail(entry.thumbnails),
                            title: entry.title ?? "Unknown Song",
                            url: entry.webpage_url ?? entry.url ?? url.toString(),
                            isLive: entry.is_live,
                        }),
                    );
                    result.playlist = {
                        title: entries[0].playlist_title ?? entries[0].title ?? "Unknown",
                        url: url.toString(),
                        thumbnail: result.items[0].thumbnail || undefined,
                        author: entries[0].uploader,
                    };
                    break;
                }

                const info = entries[0] as BasicYoutubeVideoInfo | undefined;

                result.items = [
                    {
                        duration: info?.is_live ? 0 : (info?.duration ?? 0),
                        id: info?.id ?? "",
                        thumbnail: pickBestThumbnail(info?.thumbnails),
                        title: info?.title ?? "Unknown Song",
                        url: info?.url ?? url.toString(),
                        isLive: info?.is_live,
                    },
                ];
                break;
            }
        }
    } else {
        result.type = "selection";

        if (source === "soundcloud") {
            const searchRes = await client.soundcloud.tracks.search({
                q: query,
            });
            const tracks = searchRes.collection.map(
                (track): Song => ({
                    duration: soundCloudSeconds(track.full_duration),
                    id: track.id.toString(),
                    thumbnail: getSoundCloudThumbnail(track.artwork_url ?? track.user?.avatar_url),
                    title: track.title,
                    url: track.permalink_url,
                }),
            );

            result.items = tracks;
        } else {
            // "youtube-music" asks the music catalogue first, which favours official
            // audio over uploads, and only then the video search. "youtube" goes
            // straight to the video search, for operators who want exactly what a
            // search on the site would return.
            let tracks: Song[] = [];
            if (client.config.searchProvider === "youtube-music") {
                tracks = await searchYouTubeMusicSongs(query).catch(() => []);
            }
            if (tracks.length === 0) {
                tracks = await searchYouTubeVideos(query).catch(() => []);
            }
            // Nothing on YouTube, or YouTube not answering: Bilibili is asked
            // before the search is given up as empty.
            if (tracks.length === 0) {
                tracks = (await searchBilibiliEntries(client, query)).map(toBilibiliSong);
            }
            result.items = tracks;
        }
    }

    return result;
}

function toYouTubeSong(track: { id: string; title: string; duration?: number | null }): Song {
    return {
        duration: track.duration ?? 0,
        id: track.id,
        thumbnail: getYouTubeThumbnail(track.id),
        title: track.title,
        url: `https://youtube.com/watch?v=${track.id}`,
    };
}

async function searchYouTubeMusicSongs(query: string): Promise<Song[]> {
    const found = await youtubeMusic.search(query, "song");
    return found.items.map((track) => toYouTubeSong(track));
}

async function searchYouTubeVideos(query: string): Promise<Song[]> {
    const found = await youtube.search(query, { type: "video" });
    return found.items.map((track) => toYouTubeSong(track));
}
