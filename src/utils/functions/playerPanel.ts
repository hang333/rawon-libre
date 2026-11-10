import { AudioPlayerStatus } from "@discordjs/voice";
import {
    ActionRowBuilder,
    type APIMessageTopLevelComponent,
    ButtonBuilder,
    ButtonStyle,
    type EmbedBuilder,
    type Guild,
    StringSelectMenuBuilder,
} from "discord.js";
import { type Rawon } from "../../structures/Rawon.js";
import { type ServerQueue } from "../../structures/ServerQueue.js";
import { type GuildData, type QueueSong } from "../../typings/index.js";
import { type FallbackDataManager, hasGetPlayerState } from "../typeGuards.js";
import { createEmbed } from "./createEmbed.js";
import { type filterArgs } from "./ffmpegArgs.js";
import { formatMarkdownLink } from "./formatMarkdownLink.js";
import { i18n__, i18n__mf } from "./i18n.js";
import { formatDuration, normalizeTime } from "./normalizeTime.js";
import { embedThumbnail } from "./thumbnails.js";

/**
 * The player panel is the message that shows what is playing together with the
 * controls for it. It comes in two sizes: "full" is the permanent player of a
 * request channel, with artwork across the whole embed; "compact" is the one
 * posted in an ordinary text channel when a track starts.
 *
 * Every control carries one of these ids, so a panel keeps working for as long
 * as its message exists: nothing about it is held in memory.
 */
export type PanelVariant = "compact" | "full";

export const PANEL_PREFIX = "RC_";

export const PanelId = {
    Previous: "RC_PREVIOUS",
    PauseResume: "RC_PAUSE_RESUME",
    Skip: "RC_SKIP",
    Stop: "RC_STOP",
    Queue: "RC_QUEUE_LIST",
    Loop: "RC_LOOP",
    Shuffle: "RC_SHUFFLE",
    AutoPlay: "RC_AUTOPLAY",
    VolumeDown: "RC_VOL_DOWN",
    VolumeUp: "RC_VOL_UP",
    SeekBack: "RC_SEEK_BACK",
    SeekForward: "RC_SEEK_FWD",
    Remove: "RC_REMOVE",
    Lyrics: "RC_LYRICS",
    Add: "RC_ADD",
    AddModal: "RC_ADD_MODAL",
    Jump: "RC_JUMP",
} as const;

/** Discord allows a select menu this many options. */
const JUMP_MENU_SIZE = 25;
const OPTION_TEXT_LIMIT = 100;
const PLACEHOLDER_LIMIT = 150;

/** Filters that change how fast a track plays, and with it when it will end. */
const TEMPO_FILTERS: (keyof typeof filterArgs)[] = ["nightcore", "vaporwave", "spedup", "slowed"];

type Translate = (phrase: string) => string;
type TranslateWith = (phrase: string, values?: Record<string, unknown>) => string;

export function truncate(text: string, limit: number): string {
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function formatQueueFooter(
    count: number | string,
    duration: string,
    autoPlay: boolean,
    __: Translate,
    __mf: TranslateWith,
): string {
    const autoPlayState = autoPlay ? "ON" : "OFF";
    const footerTemplate = __("requestChannel.queueFooter");

    if (footerTemplate.includes("{state}")) {
        return `• ${__mf("requestChannel.queueFooter", {
            count,
            duration,
            state: autoPlayState,
        })}`;
    }

    // A translation written before auto-play existed has no slot for its state.
    const baseFooter = __mf("requestChannel.queueFooter", { count, duration });
    const autoPlayInfo = `${__("requestChannel.autoplay").toLowerCase()}: ${autoPlayState}`;

    if (baseFooter.endsWith(")")) {
        return `• ${baseFooter.slice(0, -1)}, ${autoPlayInfo})`;
    }

    return `• ${baseFooter} (${autoPlayInfo})`;
}

function readSavedState(client: Rawon, guild: Guild): GuildData["playerState"] | null {
    if (hasGetPlayerState(client.data)) {
        return client.data.getPlayerState(guild.id, client.user?.id ?? "unknown") ?? null;
    }

    const fallback = client.data as FallbackDataManager;
    return fallback.data?.[guild.id]?.playerState ?? null;
}

/**
 * When the current track will finish, as a Unix timestamp. Discord renders that
 * as a countdown on its own, so the panel stays accurate without being edited
 * every few seconds. Null whenever the end cannot be predicted.
 */
function estimateEnd(queue: ServerQueue, entry: QueueSong): number | null {
    if (
        queue.player.state.status !== AudioPlayerStatus.Playing ||
        queue.currentSong?.key !== entry.key ||
        entry.song.isLive === true ||
        !(entry.song.duration > 0) ||
        TEMPO_FILTERS.some((filter) => queue.filters[filter] === true)
    ) {
        return null;
    }

    const remaining = entry.song.duration - queue.position;
    return remaining > 0 ? Math.floor(Date.now() / 1_000) + Math.ceil(remaining) : null;
}

function describeProgress(
    queue: ServerQueue,
    entry: QueueSong,
    __: Translate,
    __mf: TranslateWith,
): string {
    if (entry.song.isLive === true) {
        return `🔴 **\`${__("requestChannel.live")}\`**`;
    }

    const total = entry.song.duration > 0 ? normalizeTime(entry.song.duration) : "--:--";

    // A paused track is the one moment a position stays true once written down.
    if (
        queue.player.state.status === AudioPlayerStatus.Paused &&
        queue.currentSong?.key === entry.key
    ) {
        return `⏸️ **\`${normalizeTime(queue.position)}\`** / **\`${total}\`**`;
    }

    const duration = `▶️ ${__("requestChannel.songDuration")}: **\`${total}\`**`;
    const endsAt = estimateEnd(queue, entry);

    return endsAt === null
        ? duration
        : `${duration} • ${__mf("requestChannel.ends", { time: `<t:${endsAt}:R>` })}`;
}

export function buildPlayerEmbed(client: Rawon, guild: Guild, variant: PanelVariant): EmbedBuilder {
    const queue = guild.queue;
    const bs = client.data.botSettings;
    // No splash is configured out of the box, and an embed rejects an empty URL.
    const splash = bs.requestChannelSplash.length > 0 ? bs.requestChannelSplash : null;

    const __ = i18n__(client, guild);
    const __mf = i18n__mf(client, guild);
    const title = `🎵  ${__("requestChannel.title")}`;

    if (!queue || queue.songs.size === 0) {
        const saved = readSavedState(client, guild);

        return createEmbed(
            "info",
            __(variant === "full" ? "requestChannel.standby" : "requestChannel.nothingPlaying"),
        )
            .setTitle(title)
            .setImage(variant === "full" ? splash : null)
            .addFields([
                {
                    name: __("requestChannel.status"),
                    value: `▶️ ${saved?.loopMode ?? "OFF"}`,
                    inline: true,
                },
                {
                    name: __("requestChannel.shuffle"),
                    value: `🔀 ${saved?.shuffle === true ? "ON" : "OFF"}`,
                    inline: true,
                },
                {
                    name: __("requestChannel.volume"),
                    value: `🔊 ${saved?.volume ?? bs.defaultVolume}%`,
                    inline: true,
                },
            ])
            .setFooter({
                text: formatQueueFooter(0, "0:00", saved?.autoplay ?? false, __, __mf),
            });
    }

    // Between two tracks the player holds nothing; show the one about to start.
    const entry = queue.currentSong ?? queue.songs.sortByIndex().first();
    const artwork = embedThumbnail(entry?.song.thumbnail);
    const embed = createEmbed("info").setTitle(title);

    if (variant === "full") {
        embed.setImage(artwork ?? splash);

        const guildIcon = guild.iconURL({ size: 2_048 });
        if (guildIcon !== null && guildIcon.length > 0) {
            embed.setThumbnail(guildIcon);
        }
    } else {
        embed.setThumbnail(artwork);
    }

    if (entry) {
        const lines = [
            `### ${formatMarkdownLink(entry.song.title, entry.song.url)}`,
            "",
            describeProgress(queue, entry, __, __mf),
            "",
            `${__("requestChannel.requestedBy")}: ${entry.requester.toString()}`,
        ];

        const next = queue.peekNext();
        if (next !== undefined) {
            lines.push(
                `⏭️ ${__("requestChannel.upNext")}: ${formatMarkdownLink(next.title, next.url)}`,
            );
        }

        embed.setDescription(lines.join("\n"));
    } else {
        embed.setDescription(`▶️ ${__("requestChannel.standby")}`);
    }

    const loopEmoji: Record<string, string> = { OFF: "▶️", SONG: "🔂", QUEUE: "🔁" };
    embed.addFields([
        {
            name: __("requestChannel.status"),
            value: `${loopEmoji[queue.loopMode] ?? "▶️"} ${queue.loopMode}`,
            inline: true,
        },
        {
            name: __("requestChannel.shuffle"),
            value: `🔀 ${queue.shuffle ? "ON" : "OFF"}`,
            inline: true,
        },
        {
            name: __("requestChannel.volume"),
            value: `🔊 ${queue.volume}%`,
            inline: true,
        },
    ]);

    const totalQueueDuration = queue.songs
        .map((queued) => queued.song.duration)
        .reduce((acc, duration) => acc + duration, 0);

    embed.setFooter({
        text: formatQueueFooter(
            queue.songs.size.toString(),
            totalQueueDuration > 0 ? formatDuration(totalQueueDuration) : "0:00",
            queue.autoPlay,
            __,
            __mf,
        ),
    });

    return embed;
}

export function buildPlayerComponents(
    client: Rawon,
    guild: Guild,
    variant: PanelVariant,
): APIMessageTopLevelComponent[] {
    const queue = guild.queue;
    // With nothing queued there is nothing for a control to act on. Only a
    // request channel shows a panel in that state, and there a request is typed.
    const idle = !queue || queue.songs.size === 0;
    const __ = i18n__(client, guild);

    const button = (id: string, emoji: string, style: ButtonStyle): ButtonBuilder =>
        new ButtonBuilder().setCustomId(id).setEmoji(emoji).setStyle(style).setDisabled(idle);
    const toggle = (on: boolean): ButtonStyle => (on ? ButtonStyle.Success : ButtonStyle.Secondary);
    const row = (...buttons: ButtonBuilder[]): APIMessageTopLevelComponent =>
        new ActionRowBuilder<ButtonBuilder>()
            .addComponents(buttons)
            .toJSON() as APIMessageTopLevelComponent;

    const transport = row(
        button(PanelId.Previous, "⏮️", ButtonStyle.Primary),
        button(PanelId.PauseResume, queue?.playing === true ? "⏸️" : "▶️", ButtonStyle.Primary),
        button(PanelId.Skip, "⏭️", ButtonStyle.Primary),
        button(PanelId.Stop, "⏹️", ButtonStyle.Danger),
        button(PanelId.Queue, "📋", ButtonStyle.Secondary),
    );

    const modes = row(
        button(
            PanelId.Loop,
            queue?.loopMode === "SONG" ? "🔂" : "🔁",
            toggle(queue !== undefined && queue.loopMode !== "OFF"),
        ),
        button(PanelId.Shuffle, "🔀", toggle(queue?.shuffle === true)),
        button(PanelId.AutoPlay, "♾️", toggle(queue?.autoPlay === true)),
        button(PanelId.VolumeDown, "🔉", ButtonStyle.Secondary),
        button(PanelId.VolumeUp, "🔊", ButtonStyle.Secondary),
    );

    const extras = [
        button(PanelId.SeekBack, "⏪", ButtonStyle.Secondary),
        button(PanelId.SeekForward, "⏩", ButtonStyle.Secondary),
        button(PanelId.Remove, "🗑️", ButtonStyle.Danger),
        button(PanelId.Lyrics, "📜", ButtonStyle.Secondary),
    ];
    if (variant === "compact") {
        // A request channel takes requests as plain messages; elsewhere this
        // button is the way to queue a track without leaving the panel.
        extras.push(button(PanelId.Add, "➕", ButtonStyle.Success).setDisabled(false));
    }

    const components = [transport, modes, row(...extras)];

    const upcoming = queue?.upcoming() ?? [];
    if (queue !== undefined && upcoming.length > 0) {
        const positions = new Map(queue.listed().map((entry, index) => [entry.key, index + 1]));
        const menu = new StringSelectMenuBuilder()
            .setCustomId(PanelId.Jump)
            .setPlaceholder(truncate(__("requestChannel.jumpPlaceholder"), PLACEHOLDER_LIMIT))
            .addOptions(
                upcoming.slice(0, JUMP_MENU_SIZE).map((entry) => {
                    const length =
                        entry.song.isLive === true
                            ? __("requestChannel.live")
                            : entry.song.duration > 0
                              ? normalizeTime(entry.song.duration)
                              : undefined;

                    return {
                        label: truncate(
                            `${positions.get(entry.key) ?? "?"}. ${entry.song.title}`,
                            OPTION_TEXT_LIMIT,
                        ),
                        value: entry.key,
                        ...(length === undefined ? {} : { description: length }),
                    };
                }),
            );

        components.push(
            new ActionRowBuilder<StringSelectMenuBuilder>()
                .addComponents(menu)
                .toJSON() as APIMessageTopLevelComponent,
        );
    }

    return components;
}

export function buildPlayerPanel(
    client: Rawon,
    guild: Guild,
    variant: PanelVariant,
): { embeds: EmbedBuilder[]; components: APIMessageTopLevelComponent[] } {
    return {
        embeds: [buildPlayerEmbed(client, guild, variant)],
        components: buildPlayerComponents(client, guild, variant),
    };
}
