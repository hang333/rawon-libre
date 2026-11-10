import { AudioPlayerStatus } from "@discordjs/voice";
import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    type ColorResolvable,
    ContainerBuilder,
    type Guild,
    MediaGalleryBuilder,
    type MessageMentionOptions,
    resolveColor,
    SectionBuilder,
    SeparatorBuilder,
    StringSelectMenuBuilder,
    TextDisplayBuilder,
    ThumbnailBuilder,
} from "discord.js";
import { type Rawon } from "../../structures/Rawon.js";
import { type ServerQueue } from "../../structures/ServerQueue.js";
import { type GuildData, type LoopMode, type QueueSong } from "../../typings/index.js";
import { type FallbackDataManager, hasGetPlayerState } from "../typeGuards.js";
import { type filterArgs } from "./ffmpegArgs.js";
import { formatMarkdownLink } from "./formatMarkdownLink.js";
import { i18n__, i18n__mf } from "./i18n.js";
import { formatDuration, normalizeTime } from "./normalizeTime.js";
import { embedThumbnail } from "./thumbnails.js";

/**
 * The player panel is the message that shows what is playing together with the
 * controls for it. It comes in two sizes: "full" is the permanent player of a
 * request channel, with artwork across the whole panel; "compact" is the one
 * posted in an ordinary text channel when a track starts.
 *
 * A panel is a single container of display components, so that the text, the
 * artwork and the controls share one frame. A message built this way takes no
 * content and no embeds, and has to be sent with `MessageFlags.IsComponentsV2`.
 *
 * Every control carries one of these ids, so a panel keeps working for as long
 * as its message exists: nothing about it is held in memory.
 */
export type PanelVariant = "compact" | "full";

export type PlayerPanel = {
    components: ContainerBuilder[];
    allowedMentions: MessageMentionOptions;
};

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
    Lyrics: "RC_LYRICS",
    Add: "RC_ADD",
    AddModal: "RC_ADD_MODAL",
    Jump: "RC_JUMP",
    /** The menu of less used actions; the option picked is one of the ids below. */
    More: "RC_MORE",
    SeekBack: "RC_SEEK_BACK",
    SeekForward: "RC_SEEK_FWD",
    Remove: "RC_REMOVE",
    /** Followed by the volume to set, in percent. */
    Volume: "RC_VOLUME_",
} as const;

/** The volumes the "more" menu offers: the steps the `volume` command suggests. */
export const VOLUME_PRESETS = [10, 25, 50, 75, 100];
export const SEEK_STEP_SECONDS = 10;

/** Discord allows a select menu this many options. */
const JUMP_MENU_SIZE = 25;
const OPTION_TEXT_LIMIT = 100;
const PLACEHOLDER_LIMIT = 150;

/** Filters that change how fast a track plays, and with it when it will end. */
const TEMPO_FILTERS: (keyof typeof filterArgs)[] = ["nightcore", "vaporwave", "spedup", "slowed"];

type Translate = (phrase: string) => string;
type TranslateWith = (phrase: string, values?: Record<string, unknown>) => string;

type PanelSettings = {
    autoPlay: boolean;
    loopMode: LoopMode;
    shuffle: boolean;
    volume: number;
};

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

/** What the panel shows as set: the queue's settings, or the saved ones without a queue. */
function readSettings(client: Rawon, guild: Guild): PanelSettings {
    const queue = guild.queue;
    if (queue) {
        return {
            autoPlay: queue.autoPlay,
            loopMode: queue.loopMode,
            shuffle: queue.shuffle,
            volume: queue.volume,
        };
    }

    const saved = readSavedState(client, guild);
    return {
        autoPlay: saved?.autoplay ?? false,
        loopMode: saved?.loopMode ?? "OFF",
        shuffle: saved?.shuffle === true,
        volume: saved?.volume ?? client.data.botSettings.defaultVolume,
    };
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

/** The text of the panel: the track, how far along it is, and the state of the queue. */
function describePlayer(
    queue: ServerQueue | undefined,
    entry: QueueSong | undefined,
    settings: PanelSettings,
    variant: PanelVariant,
    __: Translate,
    __mf: TranslateWith,
): string {
    const lines: string[] = [];

    if (queue === undefined || entry === undefined) {
        lines.push(
            `### 🎵 ${__("requestChannel.title")}`,
            __(variant === "full" ? "requestChannel.standby" : "requestChannel.nothingPlaying"),
        );
    } else {
        lines.push(
            `### ${formatMarkdownLink(entry.song.title, entry.song.url)}`,
            describeProgress(queue, entry, __, __mf),
            `${__("requestChannel.requestedBy")}: ${entry.requester.toString()}`,
        );

        const next = queue.peekNext();
        if (next !== undefined) {
            lines.push(
                `⏭️ ${__("requestChannel.upNext")}: ${formatMarkdownLink(next.title, next.url)}`,
            );
        }
    }

    const totalDuration = (queue?.songs.map((queued) => queued.song.duration) ?? []).reduce(
        (acc, duration) => acc + duration,
        0,
    );
    const footer = formatQueueFooter(
        queue?.songs.size ?? 0,
        totalDuration > 0 ? formatDuration(totalDuration) : "0:00",
        settings.autoPlay,
        __,
        __mf,
    );
    lines.push(`-# 🔊 ${settings.volume}% ${footer}`);

    return lines.join("\n");
}

function buildMoreMenu(__: Translate, __mf: TranslateWith): StringSelectMenuBuilder {
    const seconds = SEEK_STEP_SECONDS;

    return new StringSelectMenuBuilder()
        .setCustomId(PanelId.More)
        .setPlaceholder(truncate(__("requestChannel.morePlaceholder"), PLACEHOLDER_LIMIT))
        .addOptions(
            {
                label: truncate(__mf("requestChannel.seekBack", { seconds }), OPTION_TEXT_LIMIT),
                value: PanelId.SeekBack,
                emoji: "⏪",
            },
            {
                label: truncate(__mf("requestChannel.seekForward", { seconds }), OPTION_TEXT_LIMIT),
                value: PanelId.SeekForward,
                emoji: "⏩",
            },
            ...VOLUME_PRESETS.map((percent) => ({
                label: truncate(`${__("requestChannel.volume")}: ${percent}%`, OPTION_TEXT_LIMIT),
                value: `${PanelId.Volume}${percent}`,
                emoji: percent < 50 ? "🔈" : percent < 100 ? "🔉" : "🔊",
            })),
            {
                label: truncate(__("requestChannel.removeCurrent"), OPTION_TEXT_LIMIT),
                value: PanelId.Remove,
                emoji: "🗑️",
            },
        );
}

function buildJumpMenu(
    queue: ServerQueue,
    upcoming: QueueSong[],
    __: Translate,
): StringSelectMenuBuilder {
    const positions = new Map(queue.listed().map((entry, index) => [entry.key, index + 1]));

    return new StringSelectMenuBuilder()
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
}

/**
 * The controls, top to bottom: what is pressed all the time, then the switches,
 * which are green while on, then the two menus. A row holds five buttons at
 * most, and a menu takes a row to itself.
 */
function addControls(
    container: ContainerBuilder,
    queue: ServerQueue | undefined,
    settings: PanelSettings,
    variant: PanelVariant,
    __: Translate,
    __mf: TranslateWith,
): void {
    // With nothing queued there is nothing for a control to act on. Only a
    // request channel shows a panel in that state, and there a request is typed.
    const idle = !queue || queue.songs.size === 0;

    const button = (id: string, emoji: string, style: ButtonStyle): ButtonBuilder =>
        new ButtonBuilder().setCustomId(id).setEmoji(emoji).setStyle(style).setDisabled(idle);
    const toggle = (on: boolean): ButtonStyle => (on ? ButtonStyle.Success : ButtonStyle.Secondary);

    const transport = [
        button(PanelId.Previous, "⏮️", ButtonStyle.Primary),
        button(PanelId.PauseResume, queue?.playing === true ? "⏸️" : "▶️", ButtonStyle.Primary),
        button(PanelId.Skip, "⏭️", ButtonStyle.Primary),
        button(PanelId.Stop, "⏹️", ButtonStyle.Danger),
    ];
    if (variant === "compact") {
        // A request channel takes requests as plain messages; elsewhere this
        // button is the way to queue a track without leaving the panel.
        transport.push(button(PanelId.Add, "➕", ButtonStyle.Success).setDisabled(false));
    }

    const switches = [
        button(
            PanelId.Loop,
            settings.loopMode === "SONG" ? "🔂" : "🔁",
            toggle(settings.loopMode !== "OFF"),
        ),
        button(PanelId.Shuffle, "🔀", toggle(settings.shuffle)),
        button(PanelId.AutoPlay, "♾️", toggle(settings.autoPlay)),
        button(PanelId.Queue, "📋", ButtonStyle.Secondary),
        button(PanelId.Lyrics, "📜", ButtonStyle.Secondary),
    ];

    container.addActionRowComponents(
        new ActionRowBuilder<ButtonBuilder>().addComponents(transport),
        new ActionRowBuilder<ButtonBuilder>().addComponents(switches),
    );

    if (idle) {
        return;
    }

    const menus = [buildMoreMenu(__, __mf)];
    const upcoming = queue.upcoming();
    if (upcoming.length > 0) {
        menus.push(buildJumpMenu(queue, upcoming, __));
    }

    container.addActionRowComponents(
        menus.map((menu) => new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)),
    );
}

/**
 * Build the panel for a guild as it is right now. Without `controls` it only
 * reports: that is for a place where the controls are already on screen.
 */
export function buildPlayerPanel(
    client: Rawon,
    guild: Guild,
    variant: PanelVariant,
    controls = true,
): PlayerPanel {
    const queue = guild.queue;
    const bs = client.data.botSettings;
    const __ = i18n__(client, guild);
    const __mf = i18n__mf(client, guild);
    const settings = readSettings(client, guild);

    // A track removed as the last of the queue is still held for a moment, so
    // it is the empty queue that says nothing is playing. Between two tracks
    // the player holds nothing; show the one about to start.
    const idle = !queue || queue.songs.size === 0;
    const entry = idle ? undefined : (queue.currentSong ?? queue.songs.sortByIndex().first());
    const artwork = embedThumbnail(entry?.song.thumbnail);

    const container = new ContainerBuilder().setAccentColor(
        resolveColor(bs.embedColor as ColorResolvable),
    );
    const text = new TextDisplayBuilder().setContent(
        describePlayer(queue, entry, settings, variant, __, __mf),
    );

    // The full panel has the artwork across its width, which leaves the corner
    // for the server's icon. A section cannot go without something in its corner.
    const corner = variant === "full" ? guild.iconURL({ size: 256 }) : artwork;
    if (corner !== null && corner.length > 0) {
        container.addSectionComponents(
            new SectionBuilder()
                .addTextDisplayComponents(text)
                .setThumbnailAccessory(new ThumbnailBuilder().setURL(corner)),
        );
    } else {
        container.addTextDisplayComponents(text);
    }

    if (variant === "full") {
        // No splash is configured out of the box.
        const banner =
            artwork ?? (bs.requestChannelSplash.length > 0 ? bs.requestChannelSplash : null);
        if (banner !== null) {
            container.addMediaGalleryComponents(
                new MediaGalleryBuilder().addItems({ media: { url: banner } }),
            );
        }
    }

    if (controls) {
        container.addSeparatorComponents(new SeparatorBuilder());
        addControls(container, queue, settings, variant, __, __mf);
    }

    return {
        components: [container],
        // In an embed a mention is only a name. Here it would notify the
        // requester every time the panel is posted.
        allowedMentions: { parse: [], repliedUser: false },
    };
}
