import { clearInterval, clearTimeout, setInterval, setTimeout } from "node:timers";
import {
    type AudioPlayer,
    type AudioPlayerPlayingState,
    AudioPlayerStatus,
    type AudioResource,
    createAudioPlayer,
    type VoiceConnection,
} from "@discordjs/voice";
import { type Message, MessageFlags, type Snowflake, type TextChannel } from "discord.js";
import { type LoopMode, type QueueSong, type SavedQueueSong, type Song } from "../typings/index.js";
import { createEmbed } from "../utils/functions/createEmbed.js";
import { type filterArgs } from "../utils/functions/ffmpegArgs.js";
import { formatBoldPrefixedCommand } from "../utils/functions/formatCodeSpan.js";
import { formatMarkdownLink } from "../utils/functions/formatMarkdownLink.js";
import { getEffectivePrefix } from "../utils/functions/getEffectivePrefix.js";
import { i18n__mf } from "../utils/functions/i18n.js";
import { buildPlayerPanel } from "../utils/functions/playerPanel.js";
import { checkQuery, play, searchTrack } from "../utils/handlers/GeneralUtil.js";
import { SongManager } from "../utils/structures/SongManager.js";
import { BOT_SETTINGS_DEFAULTS } from "../utils/structures/SQLiteDataManager.js";
import {
    type FallbackDataManager,
    hasDeletePlayerState,
    hasDeleteQueueState,
    hasGetPlayerState,
    hasSavePlayerState,
    hasSaveQueueState,
} from "../utils/typeGuards.js";
import { type Rawon } from "./Rawon.js";

const nonEnum = { enumerable: false };

/**
 * How many recently played tracks auto-play tries not to repeat. A radio mix is
 * usually a few dozen entries, so this is wide enough to stop the same handful
 * cycling while still leaving something to choose from.
 */
const RECENTLY_PLAYED_LIMIT = 30;

/** How many finished tracks `previous` can step back through. */
const HISTORY_LIMIT = 50;

/** Discord's code for a message that no longer exists. */
const UNKNOWN_MESSAGE = 10_008;

export type SeekResult =
    | { ok: true; position: number }
    | {
          ok: false;
          reason: "buffering" | "exceeds" | "live" | "notCached" | "notPlaying" | "soundcloud";
      };

export type StepBackResult =
    | { kind: "busy" }
    | { kind: "none" }
    | { kind: "previous"; song: QueueSong }
    | { kind: "restart"; song: QueueSong };

export class ServerQueue {
    public readonly player: AudioPlayer = createAudioPlayer();
    public connection: VoiceConnection | null = null;
    public queueEndedNotified = false;
    public timeout: NodeJS.Timeout | null = null;
    public readonly songs: SongManager;
    public loopMode: LoopMode = "OFF";
    public shuffle = false;
    public autoPlay = false;
    public filters: Partial<Record<keyof typeof filterArgs, boolean>> = {};
    public seekOffset = 0;

    private _volume = BOT_SETTINGS_DEFAULTS.defaultVolume;
    private _lastVSUpdateMsg: Snowflake | null = null;
    private _lastMusicMsg: Snowflake | null = null;
    private _skipVoters: Snowflake[] = [];
    private _skipInProgress = false;
    private _lastSkipTime = 0;
    private _skipCooldownMs = 2000;
    private _positionSaveInterval: NodeJS.Timeout | null = null;
    private _suppressPlayerErrors = false;
    private _pendingCacheUrls: string[] = [];
    private _shuffleUpcomingKeys: Snowflake[] = [];
    private _prefetchedAutoplaySong: { fromSongKey: Snowflake; song: Song } | null = null;
    private _autoplayPrefetchPromise: Promise<void> | null = null;
    private _autoplayPrefetchForKey: Snowflake | null = null;
    private _recentlyPlayed: string[] = [];
    private _history: QueueSong[] = [];
    private _panel: Message | null = null;
    private _panelSongKey: Snowflake | null = null;

    public constructor(public readonly textChannel: TextChannel) {
        Object.defineProperties(this, {
            _skipVoters: nonEnum,
            _lastMusicMsg: nonEnum,
            _lastVSUpdateMsg: nonEnum,
            _volume: nonEnum,
            _skipInProgress: nonEnum,
            _lastSkipTime: nonEnum,
            _skipCooldownMs: nonEnum,
            _positionSaveInterval: nonEnum,
            _suppressPlayerErrors: nonEnum,
            _prefetchedAutoplaySong: nonEnum,
            _autoplayPrefetchPromise: nonEnum,
            _autoplayPrefetchForKey: nonEnum,
            _recentlyPlayed: nonEnum,
            _history: nonEnum,
            _panel: nonEnum,
            _panelSongKey: nonEnum,
        });

        this.songs = new SongManager(this.client, this.textChannel.guild);

        this.loadSavedState();

        this.player
            .on("stateChange", async (oldState, newState) => {
                const __mf = i18n__mf(this.client, this.textChannel.guild);
                // Pausing and resuming change what a player panel shows, whichever
                // command, button or voice event caused them.
                const pausedStates: AudioPlayerStatus[] = [
                    AudioPlayerStatus.Paused,
                    AudioPlayerStatus.AutoPaused,
                ];
                if (
                    oldState.status !== newState.status &&
                    (pausedStates.includes(oldState.status) ||
                        pausedStates.includes(newState.status))
                ) {
                    this.notifyChanged();
                }

                if (
                    newState.status === AudioPlayerStatus.Playing &&
                    oldState.status !== AudioPlayerStatus.Paused
                ) {
                    this.endSkip();
                    newState.resource.volume?.setVolumeLogarithmic(this.volume / 100);

                    const currentSong = (this.player.state as AudioPlayerPlayingState).resource
                        .metadata as QueueSong;
                    const newSong = currentSong.song;

                    const isRequestChannel = this.client.requestChannelManager.isRequestChannel(
                        this.textChannel.guild,
                        this.textChannel.id,
                    );
                    if (isRequestChannel) {
                        this.client.logger.info(
                            `${this.client.shard ? `[Shard #${this.client.shard.ids[0]}]` : ""} Track: "${newSong.title}" on ${this.textChannel.guild.name} has started.`,
                        );
                    } else {
                        this.showNowPlayingPanel(currentSong);
                    }

                    void this.client.requestChannelManager.updatePlayerMessage(
                        this.textChannel.guild,
                    );

                    void this.saveQueueState();

                    this.startPositionSaveInterval();

                    this.preCacheNextSong(currentSong);
                } else if (newState.status === AudioPlayerStatus.Idle) {
                    this.stopPositionSaveInterval();

                    const song = (oldState as AudioPlayerPlayingState).resource
                        .metadata as QueueSong;
                    this.client.logger.info(
                        `${this.client.shard ? `[Shard #${this.client.shard.ids[0]}]` : ""} Track: "${
                            song.song.title
                        }" on ${this.textChannel.guild.name} has ended.`,
                    );
                    try {
                        const playingResource = (this.player.state as AudioPlayerPlayingState | any)
                            .resource as AudioResource | undefined;
                        const playbackMs = playingResource?.playbackDuration ?? null;
                        this.client.logger.debug(
                            "[ServerQueue] IdleHandler - previous resource playbackDurationMs",
                            {
                                guild: this.textChannel.guild.id,
                                playbackDurationMs: playbackMs,
                            },
                        );
                    } catch {}
                    try {
                        const upcoming = this.songs.sortByIndex().map((s) => s.key);
                        this.client.logger.debug("[ServerQueue] IdleHandler - queueState", {
                            guild: this.textChannel.guild.id,
                            songsSize: this.songs.size,
                            loopMode: this.loopMode,
                            shuffle: this.shuffle,
                            autoPlay: this.autoPlay,
                            upcomingKeys: upcoming as string[],
                        });
                    } catch {
                        this.client.logger.debug(
                            "[ServerQueue] IdleHandler - queueState (failed to serialize)",
                        );
                    }
                    this.skipVoters = [];
                    // A track somebody removed is already gone from the queue by
                    // now, and is not one `previous` should bring back.
                    if (this.loopMode === "OFF" && this.songs.delete(song.key)) {
                        this.rememberFinished(song);
                    }

                    let nextS: string | undefined;
                    if (this.shuffle && this.loopMode !== "SONG") {
                        nextS = this.getNextShuffleKey(song.key);
                    } else if (this.loopMode === "SONG") {
                        if (this.songs.has(song.key)) {
                            nextS = song.key;
                        } else {
                            const sortedSongs = this.songs.sortByIndex();
                            nextS =
                                sortedSongs.filter((x) => x.index > song.index).first()?.key ??
                                sortedSongs.first()?.key;
                        }
                    } else {
                        const sortedSongs = this.songs.sortByIndex();
                        nextS =
                            sortedSongs.filter((x) => x.index > song.index).first()?.key ??
                            (this.loopMode === "QUEUE" ? (sortedSongs.first()?.key ?? "") : "");
                    }

                    this.rememberPlayed(song.song);

                    const me = this.textChannel.guild.members.me;
                    if (!nextS && this.autoPlay && me) {
                        const autoPlaySong =
                            (await this.consumePrefetchedAutoplaySong(song)) ??
                            (await this.resolveAutoplaySong(song));

                        if (autoPlaySong !== undefined) {
                            nextS = this.songs.addSong(autoPlaySong, me);
                            this.client.logger.info(
                                `[ServerQueue] Auto-play queued for ${this.textChannel.guild.name}: ${autoPlaySong.title}`,
                            );
                        }
                    }

                    if (this._prefetchedAutoplaySong?.fromSongKey === song.key) {
                        this._prefetchedAutoplaySong = null;
                    }

                    void this.client.requestChannelManager.updatePlayerMessage(
                        this.textChannel.guild,
                    );

                    this.client.logger.debug("[ServerQueue] IdleHandler - nextCandidate", {
                        guild: this.textChannel.guild.id,
                        nextKey: nextS ?? null,
                        songsSize: this.songs.size,
                    });

                    const isRequestChannel = this.client.requestChannelManager.isRequestChannel(
                        this.textChannel.guild,
                        this.textChannel.id,
                    );
                    // A player panel stays where it is between tracks and is redrawn
                    // for the next one; only without a panel is there a notice to post.
                    if (!isRequestChannel && this._panel === null) {
                        await this.textChannel
                            .send({
                                flags: MessageFlags.SuppressNotifications,
                                embeds: [
                                    createEmbed(
                                        "info",
                                        `⏹️ **|** ${__mf("utils.generalHandler.stopPlaying", {
                                            song: `**${formatMarkdownLink(song.song.title, song.song.url)}**`,
                                        })}`,
                                    ).setThumbnail(
                                        typeof song.song.thumbnail === "string" &&
                                            /^https?:\/\//u.test(song.song.thumbnail)
                                            ? song.song.thumbnail
                                            : null,
                                    ),
                                ],
                            })
                            .then((ms) => (this.lastMusicMsg = ms.id))
                            .catch((error: unknown) =>
                                this.client.logger.error("PLAY_ERR:", error),
                            );
                    }

                    try {
                        await play(this.textChannel.guild, nextS);
                    } catch (error) {
                        this.client.logger.debug("[ServerQueue] IdleHandler - play() threw", {
                            guild: this.textChannel.guild.id,
                            nextKey: nextS ?? null,
                            error:
                                error instanceof Error
                                    ? (error.stack ?? error.message)
                                    : String(error),
                        });
                        if (!isRequestChannel) {
                            try {
                                await this.textChannel.send({
                                    flags: MessageFlags.SuppressNotifications,
                                    embeds: [
                                        createEmbed(
                                            "error",
                                            __mf("utils.generalHandler.errorPlaying", {
                                                message: `\`${error as string}\``,
                                            }),
                                            true,
                                        ),
                                    ],
                                });
                            } catch (playError) {
                                this.client.logger.error("PLAY_ERR:", playError);
                            }
                        }

                        this.client.logger.error("PLAY_ERR:", error);

                        const fallback = this.songs.first()?.key;
                        if (fallback && fallback !== nextS) {
                            try {
                                this.client.logger.info(
                                    `[ServerQueue] Attempting fallback play for ${this.textChannel.guild.name}: ${fallback}`,
                                );
                                await play(this.textChannel.guild, fallback);
                                return;
                            } catch (retryErr) {
                                this.client.logger.error("PLAY_ERR_RETRY:", retryErr);
                            }
                        }

                        try {
                            await play(this.textChannel.guild);
                        } catch (finalErr) {
                            this.client.logger.error("PLAY_ERR_FINAL:", finalErr);
                            this.connection?.disconnect();
                        }
                    }
                }
            })
            .on("error", (err) => {
                if (this._suppressPlayerErrors) {
                    this.client.logger.debug(
                        "[ServerQueue] Suppressed player error during shutdown:",
                        err instanceof Error ? (err.stack ?? err.message) : err,
                    );
                    return;
                }

                const __mf = i18n__mf(this.client, this.textChannel.guild);
                if (err && (err as Error).name === "AbortError") {
                    this.client.logger.debug("Playback aborted:", (err as Error).message);
                    return;
                }

                (async () => {
                    const isRequestChannel = this.client.requestChannelManager.isRequestChannel(
                        this.textChannel.guild,
                        this.textChannel.id,
                    );

                    const messageText = __mf("utils.generalHandler.errorPlaying", {
                        message: `\`${(err as Error)?.message ?? String(err)}\``,
                    });

                    const errorMsg = await this.textChannel
                        .send({
                            flags: MessageFlags.SuppressNotifications,
                            embeds: [createEmbed("error", messageText, true)],
                        })
                        .catch((error: unknown) => {
                            this.client.logger.error(
                                "PLAY_CMD_ERR:",
                                error instanceof Error ? (error.stack ?? error) : error,
                            );
                            return null;
                        });

                    if (isRequestChannel && errorMsg) {
                        setTimeout(() => {
                            errorMsg.delete().catch(() => null);
                        }, 60_000);
                    }
                })();
                this.client.logger.error(
                    "PLAY_ERR:",
                    err instanceof Error ? (err.stack ?? err) : err,
                );
            })
            .on("debug", (message) => {
                this.client.logger.debug(message);
            });
    }

    private loadSavedState(): void {
        const botId = this.client.user?.id ?? "unknown";
        const guildId = this.textChannel.guild.id;

        if (hasGetPlayerState(this.client.data)) {
            let savedState: {
                loopMode?: string;
                shuffle?: boolean;
                autoplay?: boolean;
                volume?: number;
                filters?: Record<string, boolean>;
            } | null = null;

            if (this.client.config.isMultiBot) {
                const botInstance = this.client.multiBotManager.getBotByClient(this.client);
                const isPrimary = botInstance?.isPrimary ?? true;

                this.client.logger.info(
                    `[MultiBot] ${this.client.user?.tag} attempting to load player state for guild ${guildId} (${this.textChannel.guild.name}), botId=${botId}, isPrimary=${isPrimary}`,
                );

                savedState = this.client.data.getPlayerState(guildId, botId) ?? null;

                if (savedState) {
                    this.client.logger.debug(
                        `[MultiBot] ${this.client.user?.tag} loaded own player state`,
                    );
                } else if (!isPrimary) {
                    const primaryBot = this.client.multiBotManager.getPrimaryBot();
                    const primaryBotId = primaryBot?.user?.id;

                    if (primaryBotId) {
                        savedState = this.client.data.getPlayerState(guildId, primaryBotId) ?? null;
                        if (savedState) {
                            this.client.logger.info(
                                `[MultiBot] ${this.client.user?.tag} (non-primary) no own state found, inheriting from PRIMARY bot (${primaryBot?.user?.tag})`,
                            );
                        }
                    }
                }
            } else {
                savedState = this.client.data.getPlayerState(guildId, botId) ?? null;
                this.client.logger.debug(
                    `Loading player state from SQLite for guild ${guildId} (${this.textChannel.guild.name}), botId=${botId}`,
                );
            }

            if (savedState) {
                this.loopMode = (savedState.loopMode as typeof this.loopMode) ?? "OFF";
                this.shuffle = savedState.shuffle ?? false;
                this.autoPlay = savedState.autoplay ?? false;
                this._volume = savedState.volume ?? this.resolvedDefaultVolume;
                this.filters = (savedState.filters ?? {}) as Partial<
                    Record<keyof typeof filterArgs, boolean>
                >;
                this.client.logger.info(
                    `✅ Loaded saved player state for guild ${this.textChannel.guild.name}: ` +
                        `loop=${this.loopMode}, shuffle=${this.shuffle}, autoPlay=${this.autoPlay}, volume=${this._volume}, filters=${JSON.stringify(this.filters)}`,
                );
            } else {
                this.client.logger.warn(
                    `⚠️ No saved player state found for guild ${this.textChannel.guild.name}, using defaults`,
                );
            }
            return;
        }

        const fallback = this.client.data as FallbackDataManager;
        const savedState = fallback.data?.[guildId]?.playerState;
        if (savedState) {
            this.loopMode = savedState.loopMode ?? "OFF";
            this.shuffle = savedState.shuffle ?? false;
            this.autoPlay = savedState.autoplay ?? false;
            this._volume = savedState.volume ?? this.resolvedDefaultVolume;
            this.filters = (savedState.filters ?? {}) as Partial<
                Record<keyof typeof filterArgs, boolean>
            >;
            this.client.logger.info(
                `✅ Loaded saved player state for guild ${this.textChannel.guild.name}: ` +
                    `loop=${this.loopMode}, shuffle=${this.shuffle}, autoPlay=${this.autoPlay}, volume=${this._volume}, filters=${JSON.stringify(this.filters)}`,
            );
        } else {
            this.client.logger.warn(
                `⚠️ No saved player state found for guild ${this.textChannel.guild.name}, using defaults`,
            );
        }
    }

    public async saveState(): Promise<void> {
        const playerState = {
            loopMode: this.loopMode,
            shuffle: this.shuffle,
            autoplay: this.autoPlay,
            volume: this._volume,
            filters: this.filters as Record<string, boolean>,
        };

        const botId = this.client.user?.id ?? "unknown";
        const guildId = this.textChannel.guild.id;

        if (hasSavePlayerState(this.client.data)) {
            this.client.logger.debug(
                `Saving player state to SQLite for guild ${guildId} (${this.textChannel.guild.name}), botId=${botId}: ` +
                    `loop=${this.loopMode}, shuffle=${this.shuffle}, autoPlay=${this.autoPlay}, volume=${this._volume}, filters=${JSON.stringify(playerState.filters)}`,
            );

            try {
                await this.client.data.savePlayerState(guildId, botId, playerState);
                this.client.logger.info(
                    `✅ Saved player state to SQLite for guild ${this.textChannel.guild.name}`,
                );
            } catch (error) {
                this.client.logger.error(`❌ Failed to save player state to SQLite:`, error);
            }
            return;
        }

        const fallback = this.client.data as FallbackDataManager;
        const currentData = fallback.data ?? {};
        const guildData = currentData[guildId] ?? {};

        guildData.playerState = playerState;

        (await fallback.save?.(() => ({
            ...currentData,
            [guildId]: guildData,
        }))) ?? Promise.resolve();
    }

    public copyStateFrom(sourceQueue: ServerQueue): void {
        this.loopMode = sourceQueue.loopMode;
        this.shuffle = sourceQueue.shuffle;
        this.autoPlay = sourceQueue.autoPlay;
        this._volume = sourceQueue.volume;
        this.filters = { ...sourceQueue.filters };
        this.client.logger.info(
            `[MultiBot] Copied player state from primary bot: loop=${this.loopMode}, shuffle=${this.shuffle}, autoPlay=${this.autoPlay}, volume=${this._volume}`,
        );
    }

    public async saveQueueState(): Promise<void> {
        let currentSongKey: string | null = null;
        let currentPosition = 0;
        if (this.player.state.status === AudioPlayerStatus.Playing) {
            const resource = (this.player.state as AudioPlayerPlayingState).resource;
            const metadata = resource.metadata as QueueSong | undefined;
            if (metadata !== undefined) {
                currentSongKey = metadata.key;
                currentPosition =
                    Math.floor((resource.playbackDuration ?? 0) / 1000) + this.seekOffset;
            }
        }

        const savedSongs: SavedQueueSong[] = this.songs.sortByIndex().map((queueSong) => ({
            requesterId: queueSong.requester.id,
            index: queueSong.index,
            song: queueSong.song,
            key: queueSong.key,
        }));

        const voiceChannelId = this.connection?.joinConfig.channelId;
        if (
            voiceChannelId === undefined ||
            voiceChannelId === null ||
            voiceChannelId.length === 0
        ) {
            return;
        }

        const queueState = {
            textChannelId: this.textChannel.id,
            voiceChannelId,
            songs: savedSongs,
            currentSongKey,
            currentPosition,
        };

        if (hasSaveQueueState(this.client.data)) {
            const botId = this.client.user?.id ?? "unknown";
            await this.client.data.saveQueueState(this.textChannel.guild.id, botId, queueState);
        } else {
            const fallback = this.client.data as FallbackDataManager;
            const currentData = fallback.data ?? {};
            const guildData = currentData[this.textChannel.guild.id] ?? {};
            guildData.queueState = queueState;

            (await fallback.save?.(() => ({
                ...currentData,
                [this.textChannel.guild.id]: guildData,
            }))) ?? Promise.resolve();
        }
    }

    public async clearQueueState(): Promise<void> {
        if (hasDeleteQueueState(this.client.data)) {
            const botId = this.client.user?.id ?? "unknown";
            await this.client.data.deleteQueueState(this.textChannel.guild.id, botId);
        } else {
            const fallback = this.client.data as FallbackDataManager;
            const currentData = fallback.data ?? {};
            const guildData = currentData[this.textChannel.guild.id] ?? {};

            delete guildData.queueState;

            (await fallback.save?.(() => ({
                ...currentData,
                [this.textChannel.guild.id]: guildData,
            }))) ?? Promise.resolve();
        }
    }

    public async clearPlayerState(): Promise<void> {
        const botId = this.client.user?.id ?? "unknown";
        const guildId = this.textChannel.guild.id;

        if (hasDeletePlayerState(this.client.data)) {
            await this.client.data.deletePlayerState(guildId, botId);
            this.client.logger.info(
                `✅ Cleared player state for guild ${this.textChannel.guild.name}`,
            );
            return;
        }

        const fallback = this.client.data as FallbackDataManager;
        const currentData = fallback.data ?? {};
        const guildData = currentData[guildId] ?? {};

        delete guildData.playerState;

        (await fallback.save?.(() => ({
            ...currentData,
            [guildId]: guildData,
        }))) ?? Promise.resolve();
        this.client.logger.info(`✅ Cleared player state for guild ${this.textChannel.guild.name}`);
    }

    public setFilter(filter: keyof typeof filterArgs, state: boolean): boolean {
        const before = this.filters[filter];
        this.filters[filter] = state;

        void this.saveState();
        this.notifyChanged();

        if (before !== state && this.player.state.status === AudioPlayerStatus.Playing) {
            const resource = (this.player.state as AudioPlayerPlayingState).resource;
            const currentSong = (resource as AudioResource<QueueSong>).metadata;
            const songUrl = currentSong.song.url;
            const isLive = currentSong.song.isLive ?? false;

            if (isLive || !this.resolvedEnableAudioCache) {
                this.seekOffset = 0;
                this.playing = false;
                void play(this.textChannel.guild, currentSong.key, true, 0);
                return false;
            }

            const isCached = this.client.audioCache.isCached(songUrl);
            const isInProgress = this.client.audioCache.isInProgress(songUrl);

            if (isCached && !isInProgress) {
                const currentPosition =
                    Math.floor((resource.playbackDuration ?? 0) / 1000) + this.seekOffset;

                this.seekOffset = currentPosition;
                this.playing = false;
                void play(this.textChannel.guild, currentSong.key, true, currentPosition);
                return true;
            }

            this.client.logger.info(
                `[ServerQueue] Filter "${filter}" set to ${state}, restarting song from beginning (not fully cached).`,
            );
            this.seekOffset = 0;
            this.playing = false;
            void play(this.textChannel.guild, currentSong.key, true, 0);
            return false;
        }

        return true;
    }

    public setLoopMode(mode: LoopMode): void {
        this.loopMode = mode;
        void this.saveState();
        this.notifyChanged();
    }

    public setShuffle(value: boolean): void {
        this.shuffle = value;
        if (value) {
            this.syncShuffleUpcomingKeys();
        } else {
            this._shuffleUpcomingKeys = [];
        }
        void this.saveState();
        this.notifyChanged();
    }

    public setAutoPlay(value: boolean): void {
        this.autoPlay = value;
        if (!value) {
            this.clearAutoplayPrefetchState();
        } else if (this.player.state.status === AudioPlayerStatus.Playing) {
            const currentSong = (this.player.state as AudioPlayerPlayingState).resource
                .metadata as QueueSong;
            this.preCacheNextSong(currentSong);
        }
        void this.saveState();
        this.notifyChanged();
    }

    public setAutoplay(value: boolean): void {
        this.setAutoPlay(value);
    }

    public stop(): void {
        this.stopPositionSaveInterval();
        try {
            const songUrls: string[] = this.songs.map((s) => s.song.url);
            try {
                const playingResource = (this.player.state as AudioPlayerPlayingState | any)
                    .resource as import("@discordjs/voice").AudioResource | undefined;
                const metadata = playingResource?.metadata as QueueSong | undefined;
                const meta = metadata as { song?: { url?: string }; url?: string } | undefined;
                const currentUrl = meta?.song?.url ?? meta?.url ?? null;
                if (currentUrl && !songUrls.includes(currentUrl)) {
                    songUrls.push(currentUrl);
                }
            } catch {}

            this._pendingCacheUrls = songUrls;
        } catch {}

        this.songs.clear();
        this.clearAutoplayPrefetchState();
        this._suppressPlayerErrors = true;
        setTimeout(() => {
            this._suppressPlayerErrors = false;
        }, 2_000);
        this.player.stop(true);
    }

    public async destroy(): Promise<void> {
        let songUrls = this.songs.map((song) => song.song.url);
        if (
            (songUrls.length === 0 || songUrls.every((s) => !s)) &&
            this._pendingCacheUrls.length > 0
        ) {
            songUrls = [...this._pendingCacheUrls];
        }
        this._suppressPlayerErrors = true;
        this.stop();
        void this.setPanel(null);

        try {
            this.connection?.disconnect();
        } catch {}

        const start = Date.now();
        const timeoutMs = 5_000;
        while (Date.now() - start < timeoutMs) {
            try {
                const guildMe = this.textChannel.guild.members.me;
                if (!guildMe?.voice?.channelId) {
                    break;
                }
            } catch {
                break;
            }
            await new Promise((r) => setTimeout(r, 100));
        }

        clearTimeout(this.timeout ?? undefined);
        await this.clearQueueState();

        if (this.client.config.isMultiBot) {
            const botInstance = this.client.multiBotManager.getBotByClient(this.client);
            if (botInstance && !botInstance.isPrimary) {
                await this.clearPlayerState();
                await this.client.requestChannelManager.deletePlayerMessage(this.textChannel.guild);
                this.client.logger.info(
                    `[MultiBot] ${this.client.user?.tag} (non-primary) cleared player state on destroy`,
                );
            } else {
                this.client.logger.info(
                    `[MultiBot] ${this.client.user?.tag} (primary) preserving player state on destroy`,
                );
            }
        }

        delete this.textChannel.guild.queue;

        if (songUrls.length > 0) {
            this.client.audioCache.clearCacheForUrls(songUrls);
            this._pendingCacheUrls.length = 0;
        }

        try {
            const isRequestChannel = this.client.requestChannelManager.isRequestChannel(
                this.textChannel.guild,
                this.textChannel.id,
            );
            if (!isRequestChannel && !this.queueEndedNotified) {
                const __mf = i18n__mf(this.client, this.textChannel.guild);
                const msg = await this.textChannel
                    .send({
                        flags: MessageFlags.SuppressNotifications,
                        embeds: [
                            createEmbed(
                                "info",
                                `⏹️ **|** ${__mf("utils.generalHandler.queueEnded", {
                                    usage: formatBoldPrefixedCommand(
                                        getEffectivePrefix(
                                            this.client,
                                            this.textChannel.guild?.id ?? null,
                                        ),
                                        "play",
                                    ),
                                })}`,
                            ),
                        ],
                    })
                    .catch(() => null);
                if (msg) {
                    this.lastMusicMsg = msg.id;
                }
            }
        } catch (e) {
            this.client.logger.debug("DESTROY_MSG_ERR:", e);
        }
    }

    private startPositionSaveInterval(): void {
        this.stopPositionSaveInterval();
        this._positionSaveInterval = setInterval(() => {
            void this.saveQueueState();
        }, 5000);
    }

    private stopPositionSaveInterval(): void {
        if (this._positionSaveInterval !== null) {
            clearInterval(this._positionSaveInterval);
            this._positionSaveInterval = null;
        }
    }

    public get volume(): number {
        return this._volume;
    }

    public set volume(newVol: number) {
        this._volume = newVol;
        const resource = (
            this.player.state as AudioPlayerPlayingState & { resource: AudioResource | undefined }
        ).resource;
        resource?.volume?.setVolumeLogarithmic(this._volume / 100);
        void this.saveState();
        this.notifyChanged();
    }

    public get skipVoters(): Snowflake[] {
        return this._skipVoters;
    }

    public set skipVoters(value: Snowflake[]) {
        this._skipVoters = value;
    }

    public get lastMusicMsg(): Snowflake | null {
        return this._lastMusicMsg;
    }

    public set lastMusicMsg(value: Snowflake | null) {
        if (this._lastMusicMsg !== null) {
            (async () => {
                await this.textChannel.messages
                    .fetch(this._lastMusicMsg ?? "")
                    // Returned, not voided, so a failed delete reaches the catch below.
                    .then(async (msg) => msg.delete())
                    .catch((error: unknown) => {
                        const discordError = error as { code?: number };
                        if (discordError.code !== 10008) {
                            this.textChannel.client.logger.error(
                                "DELETE_LAST_MUSIC_MESSAGE_ERR:",
                                error,
                            );
                        }
                    });
            })();
        }
        this._lastMusicMsg = value;
    }

    public get lastVSUpdateMsg(): Snowflake | null {
        return this._lastVSUpdateMsg;
    }

    public set lastVSUpdateMsg(value: Snowflake | null) {
        if (this._lastVSUpdateMsg !== null) {
            (async () => {
                await this.textChannel.messages
                    .fetch(this._lastVSUpdateMsg ?? "")
                    // Returned, not voided, so a failed delete reaches the catch below.
                    .then(async (msg) => msg.delete())
                    .catch((error: unknown) => {
                        const discordError = error as { code?: number };
                        if (discordError.code !== 10008) {
                            this.textChannel.client.logger.error(
                                "DELETE_LAST_VS_UPDATE_MESSAGE_ERR:",
                                error,
                            );
                        }
                    });
            })();
        }
        this._lastVSUpdateMsg = value;
    }

    public get playing(): boolean {
        return this.player.state.status === AudioPlayerStatus.Playing;
    }

    public set playing(value: boolean) {
        if (value) {
            this.player.unpause();
        } else {
            this.player.pause();
        }
    }

    public get idle(): boolean {
        return this.player.state.status === AudioPlayerStatus.Idle && this.songs.size === 0;
    }

    public get client(): Rawon {
        return this.textChannel.client as Rawon;
    }

    private get resolvedDefaultVolume(): number {
        return this.client.data.botSettings.defaultVolume;
    }

    private get resolvedEnableAudioCache(): boolean {
        return this.client.data.botSettings.enableAudioCache;
    }

    /**
     * Announce a track in the queue's text channel with a player panel: what is
     * playing, plus the buttons to control it.
     *
     * The panel is redrawn where it stands when the same track restarts (a seek
     * or a filter change) or when nothing has been posted under it, so that the
     * buttons do not jump away from whoever is using them. Once the conversation
     * has moved on, a fresh panel goes to the bottom and the old one is removed.
     */
    private showNowPlayingPanel(current: QueueSong): void {
        this.client.logger.info(
            `${this.client.shard ? `[Shard #${this.client.shard.ids[0]}]` : ""} Track: "${current.song.title}" on ${
                this.textChannel.guild.name
            } has started.`,
        );

        const panel = this._panel;
        if (
            panel !== null &&
            (this._panelSongKey === current.key || panel.channel.lastMessageId === panel.id)
        ) {
            // The caller asks every panel to redraw right after this.
            this._panelSongKey = current.key;
            return;
        }

        void (async () => {
            try {
                const message = await this.textChannel.send({
                    ...buildPlayerPanel(this.client, this.textChannel.guild, "compact"),
                    flags: [MessageFlags.IsComponentsV2, MessageFlags.SuppressNotifications],
                });

                // The track may have ended, or the queue been destroyed, while the
                // message was on its way.
                if (this.currentSong?.key !== current.key) {
                    await message.delete().catch(() => null);
                    return;
                }

                // Clears the "stopped playing" notice of a track that had no panel.
                this.lastMusicMsg = null;
                await this.setPanel(message, current.key);
            } catch (error) {
                this.client.logger.error("PLAY_ERR:", error);
            }
        })();
    }

    /** The message that currently serves as this queue's player panel, if any. */
    public get panel(): Message | null {
        return this._panel;
    }

    /**
     * Make `message` this queue's player panel, removing the one it replaces.
     * Only this bot's own messages are accepted: the panel is edited and
     * eventually deleted, which must never happen to somebody else's message.
     */
    public async setPanel(
        message: Message | null,
        songKey: Snowflake | null = null,
    ): Promise<void> {
        if (message !== null && message.author.id !== this.client.user?.id) {
            return;
        }

        const previous = this._panel;
        this._panel = message;
        this._panelSongKey = message === null ? null : songKey;

        if (previous !== null && previous.id !== message?.id) {
            await previous.delete().catch(() => null);
        }
    }

    /** Redraw the player panel to match the queue. Does nothing without one. */
    public async refreshPanel(): Promise<void> {
        const panel = this._panel;
        const current = this.currentSong;
        if (panel === null || current === undefined) {
            return;
        }

        const guild = this.textChannel.guild;
        // A channel that became the request channel has its own player message,
        // maintained by the request channel manager.
        if (this.client.requestChannelManager.isRequestChannel(guild, panel.channelId)) {
            this._panel = null;
            this._panelSongKey = null;
            return;
        }

        // A panel from before panels were laid out as components is an embed
        // with buttons under it. It is replaced rather than converted: that
        // happens once, and a new message is certain to come out right.
        if (!panel.flags.has(MessageFlags.IsComponentsV2)) {
            this._panel = null;
            this._panelSongKey = null;
            await panel.delete().catch(() => null);
            this.showNowPlayingPanel(current);
            return;
        }

        try {
            await panel.edit(buildPlayerPanel(this.client, guild, "compact"));
        } catch (error) {
            if ((error as { code?: number }).code !== UNKNOWN_MESSAGE) {
                this.client.logger.debug(
                    `Failed to update player panel: ${(error as Error).message}`,
                );
                return;
            }

            // Somebody deleted the panel. Post a new one rather than leave the
            // track without controls.
            if (this._panel?.id === panel.id) {
                this._panel = null;
                this._panelSongKey = null;
                if (this.currentSong?.key === current.key) {
                    this.showNowPlayingPanel(current);
                }
            }
        }
    }

    /**
     * Ask every player panel of this guild to redraw. Cheap to call: the request
     * channel manager debounces it. A queue that has not joined a voice channel
     * yet is still being set up and has nothing on screen to update.
     */
    public notifyChanged(): void {
        if (this.connection === null) {
            return;
        }

        void this.client.requestChannelManager.updatePlayerMessage(this.textChannel.guild);
    }

    /** The track the player currently holds, playing or paused. */
    public get currentSong(): QueueSong | undefined {
        const resource = (this.player.state as { resource?: AudioResource }).resource;
        return resource?.metadata as QueueSong | undefined;
    }

    /** How far into the current track playback is, in seconds. */
    public get position(): number {
        const resource = (this.player.state as { resource?: AudioResource }).resource;
        return Math.floor((resource?.playbackDuration ?? 0) / 1_000) + this.seekOffset;
    }

    /**
     * The queue in the order and numbering the `queue` command lists it: all of
     * it under queue repeat, otherwise the current track and what comes after.
     */
    public listed(): QueueSong[] {
        const current = this.currentSong;
        const sorted = [...this.songs.sortByIndex().values()];

        return this.loopMode === "QUEUE" || current === undefined
            ? sorted
            : sorted.filter((entry) => entry.index >= current.index);
    }

    /** What follows the current track, in the order it would be reached. */
    public upcoming(): QueueSong[] {
        const current = this.currentSong;
        const list = this.listed();
        const at = current === undefined ? -1 : list.findIndex((x) => x.key === current.key);

        return at === -1 ? list : [...list.slice(at + 1), ...list.slice(0, at)];
    }

    /** The track that plays next if nothing changes, auto-play's pick included. */
    public peekNext(): Song | undefined {
        const current = this.currentSong;
        if (current === undefined) {
            return undefined;
        }

        const nextKey = this.peekNextKey(current);
        if (nextKey !== undefined) {
            return nextKey === current.key ? undefined : this.songs.get(nextKey)?.song;
        }

        return this.autoPlay && this._prefetchedAutoplaySong?.fromSongKey === current.key
            ? this._prefetchedAutoplaySong.song
            : undefined;
    }

    /** Keep a finished track so that `previous` can return to it. */
    private rememberFinished(song: QueueSong): void {
        this._history.push(song);
        while (this._history.length > HISTORY_LIMIT) {
            this._history.shift();
        }
    }

    /**
     * Go back one track: to an earlier one still in the queue, else to the last
     * one that finished, else (under queue repeat) around to the end. When there
     * is nothing to go back to, the current track starts over, which is what a
     * "previous" button does on every other player.
     */
    public stepBack(): StepBackResult {
        const current = this.currentSong;
        const sorted = this.songs.sortByIndex();

        let target =
            current === undefined
                ? undefined
                : sorted.filter((entry) => entry.index < current.index).last();

        if (target === undefined && this._history.length === 0 && current === undefined) {
            return { kind: "none" };
        }

        if (!this.startSkip()) {
            return { kind: "busy" };
        }

        if (target === undefined) {
            const finished = this._history.pop();
            if (finished !== undefined) {
                this.songs.restoreSong(
                    finished.key,
                    finished.index,
                    finished.song,
                    finished.requester,
                );
                target = finished;
            }
        }

        if (target === undefined && current !== undefined && this.loopMode === "QUEUE") {
            target = sorted.filter((entry) => entry.key !== current.key).last();
        }

        const guild = this.textChannel.guild;
        if (target !== undefined) {
            void play(guild, target.key);
            return { kind: "previous", song: target };
        }

        // Only reachable with a current track: the empty case returned above.
        const restarting = current as QueueSong;
        this.playing = false;
        void play(guild, restarting.key, true, 0);
        return { kind: "restart", song: restarting };
    }

    /** Why the current track cannot be sought at all, or null when it can. */
    public seekability(): "live" | "notPlaying" | "soundcloud" | null {
        const current = this.currentSong;
        if (this.player.state.status !== AudioPlayerStatus.Playing || current === undefined) {
            return "notPlaying";
        }
        if (current.song.isLive === true) {
            return "live";
        }

        return checkQuery(current.song.url).sourceType === "soundcloud" ? "soundcloud" : null;
    }

    /**
     * Move playback of the current track to `seconds`. Seeking re-opens the
     * audio at an offset, which needs the track to be fully in the cache.
     */
    public seek(seconds: number): SeekResult {
        const current = this.currentSong;
        const unseekable = this.seekability();
        if (unseekable !== null || current === undefined) {
            return { ok: false, reason: unseekable ?? "notPlaying" };
        }
        if (seconds >= current.song.duration) {
            return { ok: false, reason: "exceeds" };
        }

        if (this.resolvedEnableAudioCache && seconds > 0) {
            const isCached = this.client.audioCache.isCached(current.song.url);
            const isInProgress = this.client.audioCache.isInProgress(current.song.url);

            if (!isCached) {
                return { ok: false, reason: isInProgress ? "buffering" : "notCached" };
            }
        }

        this.playing = false;
        void play(this.textChannel.guild, current.key, true, seconds);
        return { ok: true, position: seconds };
    }

    /** Remove everything but the current track. Returns how many tracks went. */
    public clearUpcoming(): number {
        const current = this.currentSong;
        const doomed = this.songs.filter((entry) => entry.key !== current?.key);

        this._shuffleUpcomingKeys = [];
        return this.songs.deleteMany([...doomed.keys()]);
    }

    /**
     * Move the track at position `from` to position `to`, both as the `queue`
     * command numbers them. The current track stays put, and outside queue
     * repeat nothing can be placed ahead of it. Returns the moved track, or null
     * when the positions do not describe a possible move.
     */
    public move(from: number, to: number): QueueSong | null {
        const current = this.currentSong;
        const list = this.listed();
        const song = list[from - 1] as QueueSong | undefined;

        if (
            song === undefined ||
            song.key === current?.key ||
            from === to ||
            !Number.isInteger(to) ||
            to < 1 ||
            to > list.length
        ) {
            return null;
        }
        if (this.loopMode !== "QUEUE" && current !== undefined && to === 1) {
            return null;
        }

        const order = list.filter((entry) => entry.key !== song.key);
        order.splice(to - 1, 0, song);
        this.songs.reposition(order.map((entry) => entry.key));

        return song;
    }

    /** Make the given tracks the next ones to play, in the order given. */
    public queueNext(keys: Snowflake[]): void {
        const current = this.currentSong;
        const moving = new Set(keys);
        const rest = [...this.songs.sortByIndex().values()].filter(
            (entry) =>
                !moving.has(entry.key) && (current === undefined || entry.index > current.index),
        );

        this.songs.reposition([...keys, ...rest.map((entry) => entry.key)]);

        if (this.shuffle) {
            this._shuffleUpcomingKeys = [
                ...keys,
                ...this._shuffleUpcomingKeys.filter((key) => !moving.has(key)),
            ];
        }
    }

    private preCacheNextSong(currentSong: QueueSong): void {
        if (this.loopMode === "SONG") {
            return;
        }

        const songsToCache: string[] = [];
        const PRE_CACHE_AHEAD = 3;

        if (this.shuffle) {
            this.syncShuffleUpcomingKeys(currentSong.key);

            for (const key of this._shuffleUpcomingKeys.slice(0, PRE_CACHE_AHEAD)) {
                const nextSong = this.songs.get(key);
                if (!nextSong || nextSong.song.isLive) {
                    continue;
                }
                songsToCache.push(nextSong.song.url);
            }
        } else {
            const sortedSongs = this.songs.sortByIndex();
            const nextSongsArray = Array.from(
                sortedSongs.filter((s) => s.index > currentSong.index && !s.song.isLive).values(),
            ).slice(0, PRE_CACHE_AHEAD);

            for (const song of nextSongsArray) {
                songsToCache.push(song.song.url);
            }

            if (songsToCache.length < PRE_CACHE_AHEAD && this.loopMode === "QUEUE") {
                const remaining = PRE_CACHE_AHEAD - songsToCache.length;
                const fromStartArray = Array.from(
                    sortedSongs
                        .filter((s) => !s.song.isLive && !songsToCache.includes(s.song.url))
                        .values(),
                ).slice(0, remaining);

                for (const song of fromStartArray) {
                    songsToCache.push(song.song.url);
                }
            }
        }

        if (songsToCache.length > 0) {
            void this.client.audioCache.preCacheMultiple(songsToCache);
        }

        if (!this.autoPlay || this.peekNextKey(currentSong) !== undefined) {
            return;
        }

        void this.preCacheAutoplaySong(currentSong);
    }

    private clearAutoplayPrefetchState(): void {
        this._prefetchedAutoplaySong = null;
        this._autoplayPrefetchForKey = null;
        this._autoplayPrefetchPromise = null;
    }

    private peekNextKey(currentSong: QueueSong): Snowflake | undefined {
        if (this.shuffle && this.loopMode !== "SONG") {
            this.syncShuffleUpcomingKeys(currentSong.key);
            return this._shuffleUpcomingKeys[0];
        }

        if (this.loopMode === "SONG") {
            if (this.songs.has(currentSong.key)) {
                return currentSong.key;
            }

            const sortedSongs = this.songs.sortByIndex();
            return (
                sortedSongs.filter((x) => x.index > currentSong.index).first()?.key ??
                sortedSongs.first()?.key
            );
        }

        const sortedSongs = this.songs.sortByIndex();
        return (
            sortedSongs.filter((x) => x.index > currentSong.index).first()?.key ??
            (this.loopMode === "QUEUE" ? sortedSongs.first()?.key : undefined)
        );
    }

    private async preCacheAutoplaySong(currentSong: QueueSong): Promise<void> {
        if (this._prefetchedAutoplaySong?.fromSongKey === currentSong.key) {
            return;
        }

        if (this._autoplayPrefetchForKey === currentSong.key && this._autoplayPrefetchPromise) {
            return;
        }

        this._autoplayPrefetchForKey = currentSong.key;
        const fromSongKey = currentSong.key;

        const task = (async () => {
            const autoPlaySong = await this.resolveAutoplaySong(currentSong);
            if (
                autoPlaySong === undefined ||
                !this.autoPlay ||
                this._autoplayPrefetchForKey !== fromSongKey
            ) {
                return;
            }

            this._prefetchedAutoplaySong = {
                fromSongKey,
                song: autoPlaySong,
            };

            if (!autoPlaySong.isLive) {
                await this.client.audioCache.preCacheUrl(autoPlaySong.url, true);
            }
        })();

        this._autoplayPrefetchPromise = task
            .catch((error: unknown) => {
                this.client.logger.debug("[ServerQueue] Auto-play pre-cache failed", {
                    guild: this.textChannel.guild.id,
                    songKey: currentSong.key,
                    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
                });
            })
            .finally(() => {
                if (this._autoplayPrefetchForKey === fromSongKey) {
                    this._autoplayPrefetchForKey = null;
                }
                this._autoplayPrefetchPromise = null;
            });

        await this._autoplayPrefetchPromise;
    }

    private async consumePrefetchedAutoplaySong(currentSong: QueueSong): Promise<Song | undefined> {
        if (this._autoplayPrefetchForKey === currentSong.key && this._autoplayPrefetchPromise) {
            await Promise.race([
                this._autoplayPrefetchPromise,
                new Promise<void>((resolve) => {
                    setTimeout(resolve, 1500);
                }),
            ]);
        }

        if (this._prefetchedAutoplaySong?.fromSongKey !== currentSong.key) {
            return undefined;
        }

        const prefetchedSong = this._prefetchedAutoplaySong.song;
        this._prefetchedAutoplaySong = null;
        return prefetchedSong;
    }

    private syncShuffleUpcomingKeys(currentKey?: Snowflake): void {
        const candidateKeys = this.songs
            .filter((song) => song.key !== currentKey && !song.song.isLive)
            .map((song) => song.key);

        if (candidateKeys.length === 0) {
            this._shuffleUpcomingKeys = [];
            return;
        }

        const candidateSet = new Set(candidateKeys);
        const preserved = this._shuffleUpcomingKeys.filter((key) => candidateSet.has(key));
        const preservedSet = new Set(preserved);
        const missing = candidateKeys.filter((key) => !preservedSet.has(key));

        for (let i = missing.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [missing[i], missing[j]] = [missing[j], missing[i]];
        }

        this._shuffleUpcomingKeys = [...preserved, ...missing];
    }

    private getNextShuffleKey(currentKey: Snowflake): Snowflake | undefined {
        this.syncShuffleUpcomingKeys(currentKey);

        let nextKey = this._shuffleUpcomingKeys.shift();

        if (!nextKey && this.loopMode === "QUEUE") {
            this._shuffleUpcomingKeys = [];
            this.syncShuffleUpcomingKeys(currentKey);
            nextKey = this._shuffleUpcomingKeys.shift();
        }

        return nextKey;
    }

    private static songIdentity(song: Song): string {
        return song.id.length > 0 ? song.id : song.url;
    }

    /**
     * Note that a track has just played, so auto-play can steer away from it.
     * Re-inserting a repeat at the end keeps the window ordered by last heard.
     */
    private rememberPlayed(song: Song): void {
        const identity = ServerQueue.songIdentity(song);
        if (identity.length === 0) {
            return;
        }

        const seenAt = this._recentlyPlayed.indexOf(identity);
        if (seenAt !== -1) {
            this._recentlyPlayed.splice(seenAt, 1);
        }

        this._recentlyPlayed.push(identity);
        while (this._recentlyPlayed.length > RECENTLY_PLAYED_LIMIT) {
            this._recentlyPlayed.shift();
        }
    }

    private wasRecentlyPlayed(song: Song): boolean {
        return this._recentlyPlayed.includes(ServerQueue.songIdentity(song));
    }

    private async resolveAutoplaySong(currentSong: QueueSong): Promise<Song | undefined> {
        const queryData = checkQuery(currentSong.song.url);
        const sourceType = queryData.sourceType;
        const normalizedCurrentTitle = currentSong.song.title.trim().toLowerCase();

        const isDifferentSong = (item: Song): boolean =>
            item.id !== currentSong.song.id &&
            item.url !== currentSong.song.url &&
            item.title.trim().toLowerCase() !== normalizedCurrentTitle;

        const tryResolve = async (
            query: string,
            source?: "soundcloud" | "youtube",
        ): Promise<Song | undefined> => {
            try {
                const result = await searchTrack(this.client, query, source);
                const candidates = result.items.filter((item) => isDifferentSong(item));

                if (candidates.length === 0) {
                    return undefined;
                }

                // Prefer anything not heard recently, but fall back to the full set
                // rather than stopping auto-play when a small mix is exhausted.
                const unheard = candidates.filter((item) => !this.wasRecentlyPlayed(item));
                const pool = unheard.length > 0 ? unheard : candidates;

                const randomIndex = Math.floor(Math.random() * pool.length);
                return pool[randomIndex];
            } catch (error) {
                this.client.logger.debug("[ServerQueue] Auto-play resolve failed", {
                    guild: this.textChannel.guild.id,
                    source: source ?? "auto",
                    query,
                    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
                });
            }

            return undefined;
        };

        if (sourceType === "soundcloud") {
            const soundCloudMatch = await tryResolve(currentSong.song.title, "soundcloud");
            if (soundCloudMatch !== undefined) {
                return soundCloudMatch;
            }

            return tryResolve(currentSong.song.title);
        }

        if (sourceType === "youtube") {
            const titleQuery = `${currentSong.song.title} topic`;
            const queries =
                currentSong.song.id.length > 0
                    ? [
                          `https://www.youtube.com/watch?v=${currentSong.song.id}&list=RD${currentSong.song.id}`,
                          titleQuery,
                      ]
                    : [titleQuery];

            for (const query of queries) {
                const nextSong = await tryResolve(query, "youtube");
                if (nextSong !== undefined) {
                    return nextSong;
                }
            }

            return undefined;
        }

        return tryResolve(currentSong.song.title);
    }

    public get skipInProgress(): boolean {
        return this._skipInProgress;
    }

    public canSkip(): boolean {
        if (this._skipInProgress) {
            return false;
        }
        const now = Date.now();
        if (now - this._lastSkipTime < this._skipCooldownMs) {
            return false;
        }
        return true;
    }

    public startSkip(): boolean {
        if (!this.canSkip()) {
            return false;
        }
        this._skipInProgress = true;
        this._lastSkipTime = Date.now();
        return true;
    }

    public endSkip(): void {
        this._skipInProgress = false;
    }
}
