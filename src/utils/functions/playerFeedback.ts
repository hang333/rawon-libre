import { type EmbedBuilder } from "discord.js";
import { type SeekResult, type StepBackResult } from "../../structures/ServerQueue.js";
import { type QueueSong } from "../../typings/index.js";
import { createEmbed } from "./createEmbed.js";
import { formatMarkdownLink } from "./formatMarkdownLink.js";
import { normalizeTime } from "./normalizeTime.js";
import { embedThumbnail } from "./thumbnails.js";

type Translate = (phrase: string) => string;
type TranslateWith = (phrase: string, values?: Record<string, unknown>) => string;

/**
 * What to tell the user about a seek or a step back. The commands and the
 * player panel both report these, and should say the same thing.
 */
export function seekFeedback(
    result: SeekResult,
    song: QueueSong | undefined,
    __: Translate,
    __mf: TranslateWith,
): EmbedBuilder {
    if (result.ok) {
        return createEmbed(
            "success",
            `⏩ **|** ${__mf("commands.music.seek.seeked", {
                time: `**\`${normalizeTime(result.position)}\`**`,
            })}`,
        );
    }

    switch (result.reason) {
        case "live":
            return createEmbed("error", __("commands.music.seek.cantSeekLive"), true);
        case "soundcloud":
            return createEmbed("error", __("commands.music.seek.cantSeekSoundcloud"), true);
        case "exceeds":
            return createEmbed(
                "warn",
                __mf("commands.music.seek.exceedsDuration", {
                    duration: `**\`${normalizeTime(song?.song.duration ?? 0)}\`**`,
                }),
            );
        case "buffering":
            return createEmbed("warn", __("commands.music.seek.waitingForCache"));
        case "notCached":
            return createEmbed("warn", __("commands.music.seek.notCached"));
        default:
            return createEmbed("warn", __("commands.music.seek.noPlaying"));
    }
}

export function stepBackFeedback(
    result: StepBackResult,
    __: Translate,
    __mf: TranslateWith,
): EmbedBuilder {
    if (result.kind === "busy") {
        return createEmbed("warn", __("requestChannel.skipInProgress"));
    }
    if (result.kind === "none") {
        return createEmbed("warn", __("commands.music.previous.noPrevious"));
    }

    const phrase =
        result.kind === "previous"
            ? "commands.music.previous.playing"
            : "commands.music.previous.restarted";

    return createEmbed(
        "success",
        `⏮️ **|** ${__mf(phrase, {
            song: `**${formatMarkdownLink(result.song.song.title, result.song.song.url)}**`,
        })}`,
    ).setThumbnail(embedThumbnail(result.song.song.thumbnail));
}
