import { setTimeout } from "node:timers";
import {
    ActionRowBuilder,
    type APIMessageTopLevelComponent,
    ButtonBuilder,
    type ButtonInteraction,
    ButtonStyle,
    ComponentType,
    type EmbedBuilder,
    type Guild,
    GuildMember,
    type Interaction,
    LabelBuilder,
    type Message,
    MessageFlags,
    ModalBuilder,
    type ModalSubmitInteraction,
    type StringSelectMenuInteraction,
    TextInputBuilder,
    TextInputStyle,
} from "discord.js";
import { CommandContext } from "../../structures/CommandContext.js";
import { type Rawon } from "../../structures/Rawon.js";
import { type ServerQueue } from "../../structures/ServerQueue.js";
import { type LoopMode, type LyricsAPIResult } from "../../typings/index.js";
import { assetUrl } from "../functions/assets.js";
import { chunk } from "../functions/chunk.js";
import { createEmbed } from "../functions/createEmbed.js";
import { formatMarkdownLink } from "../functions/formatMarkdownLink.js";
import { i18n__, i18n__mf } from "../functions/i18n.js";
import { canOverrideTrack, hasDjPrivilege, isQueueLocked } from "../functions/musicPermissions.js";
import { parseHTMLElements } from "../functions/parseHTMLElements.js";
import { seekFeedback, stepBackFeedback } from "../functions/playerFeedback.js";
import { PANEL_PREFIX, PanelId, truncate } from "../functions/playerPanel.js";
import { embedThumbnail } from "../functions/thumbnails.js";
import { play } from "./general/play.js";

export type PanelInteraction =
    | ButtonInteraction
    | ModalSubmitInteraction
    | StringSelectMenuInteraction;

type Panel = {
    client: Rawon;
    guild: Guild;
    member: GuildMember | undefined;
    __: ReturnType<typeof i18n__>;
    __mf: ReturnType<typeof i18n__mf>;
};

/** How long the private answer to a button press stays before it is cleared. */
const REPLY_LIFETIME_MS = 60_000;
const PAGER_LIFETIME_MS = 120_000;
const VOLUME_STEP = 10;
const SEEK_STEP_SECONDS = 10;
/** Raising the volume past this takes DJ privilege, as it does for `volume`. */
const OPEN_VOLUME_LIMIT = 100;
const VOLUME_LIMIT = 200;
/** Discord's limits on a modal's title and on the label of one of its fields. */
const MODAL_TEXT_LIMIT = 45;
const ADD_QUERY_FIELD = "query";

/**
 * The interaction as one a player panel produced, or null when it is anything
 * else. Deliberately not a type predicate: a caller that goes on to handle
 * other buttons and menus must not have those types narrowed away.
 */
export function asPanelInteraction(interaction: Interaction): PanelInteraction | null {
    return (interaction.isButton() ||
        interaction.isStringSelectMenu() ||
        interaction.isModalSubmit()) &&
        interaction.customId.startsWith(PANEL_PREFIX)
        ? interaction
        : null;
}

/** Answer privately, and clear the answer again once it has been read. */
async function respond(interaction: PanelInteraction, embed: EmbedBuilder): Promise<void> {
    // A vote to skip has already used the reply by the time the skip is reported.
    if (interaction.replied || interaction.deferred) {
        const sent = await interaction.followUp({
            flags: MessageFlags.Ephemeral,
            embeds: [embed],
        });
        setTimeout(() => {
            interaction.deleteReply(sent).catch(() => null);
        }, REPLY_LIFETIME_MS);
        return;
    }

    await interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [embed] });
    setTimeout(() => {
        interaction.deleteReply().catch(() => null);
    }, REPLY_LIFETIME_MS);
}

async function resolveMember(
    guild: Guild,
    interaction: PanelInteraction,
): Promise<GuildMember | undefined> {
    const cached = guild.members.cache.get(interaction.user.id);
    if (cached) {
        return cached;
    }

    const fetched = await guild.members.fetch(interaction.user.id).catch(() => null);
    if (fetched) {
        return fetched;
    }

    return interaction.member instanceof GuildMember && interaction.member.guild.id === guild.id
        ? interaction.member
        : undefined;
}

export async function handlePlayerPanelInteraction(interaction: PanelInteraction): Promise<void> {
    const client = interaction.client as Rawon;
    // With several bots in one process, work from this bot's own copy of the guild.
    const guild =
        interaction.guildId === null ? undefined : client.guilds.cache.get(interaction.guildId);
    if (!guild) {
        return;
    }

    if (interaction.isMessageComponent() && interaction.message.author.id !== client.user?.id) {
        await interaction.deferUpdate().catch(() => null);
        return;
    }

    client.logger.debug(
        `${interaction.user.tag} [${interaction.user.id}] used ${interaction.customId} ` +
            `in guild: ${guild.name} [${guild.id}]`,
    );

    const __ = i18n__(client, guild);
    const __mf = i18n__mf(client, guild);
    const member = await resolveMember(guild, interaction);
    const panel: Panel = { client, guild, member, __, __mf };
    const queue = guild.queue;

    // Looking something up does not take a seat in the voice channel.
    if (interaction.isButton() && interaction.customId === PanelId.Lyrics) {
        await showLyrics(panel, interaction, queue);
        return;
    }
    if (interaction.isButton() && interaction.customId === PanelId.Queue) {
        await showQueue(panel, interaction, queue);
        return;
    }

    const voiceChannel = member?.voice.channel;
    if (!voiceChannel) {
        await respond(interaction, createEmbed("warn", __("requestChannel.notInVoice")));
        return;
    }

    const queueVoiceChannelId = queue?.connection?.joinConfig.channelId ?? null;
    if (queueVoiceChannelId && queueVoiceChannelId !== voiceChannel.id) {
        await respond(interaction, createEmbed("warn", __("utils.musicDecorator.sameVC")));
        return;
    }

    if (interaction.isModalSubmit()) {
        await addFromModal(panel, interaction, voiceChannel.id);
        return;
    }
    if (interaction.customId === PanelId.Add) {
        if (interaction.isButton()) {
            await interaction.showModal(buildAddModal(__));
        }
        return;
    }

    if (interaction.customId === PanelId.Stop) {
        await stopPlayer(panel, interaction, queue);
    } else if (!queue || queue.songs.size === 0) {
        await respond(interaction, createEmbed("warn", __("requestChannel.nothingPlaying")));
        return;
    } else if (interaction.isStringSelectMenu()) {
        if (interaction.customId === PanelId.Jump) {
            await jumpTo(panel, interaction, queue);
        }
    } else {
        await pressButton(panel, interaction, queue);
    }

    await client.requestChannelManager.updatePlayerMessage(guild);
    await reconcilePanel(client, guild, interaction.message);
}

async function pressButton(
    panel: Panel,
    interaction: ButtonInteraction,
    queue: ServerQueue,
): Promise<void> {
    const { client, guild, member, __, __mf } = panel;

    switch (interaction.customId) {
        case PanelId.PauseResume: {
            const pausing = queue.playing;
            queue.playing = !pausing;
            await respond(
                interaction,
                createEmbed(
                    "success",
                    pausing
                        ? `⏸️ **|** ${__("commands.music.pause.pauseMessage")}`
                        : `▶️ **|** ${__("commands.music.resume.resumeMessage")}`,
                ),
            );
            break;
        }

        case PanelId.Skip: {
            await skipTrack(panel, interaction, queue);
            break;
        }

        case PanelId.Previous: {
            if (await isQueueLocked(client, guild, member)) {
                await respond(
                    interaction,
                    createEmbed("error", __("commands.music.skipTo.noPermission"), true),
                );
                break;
            }

            await respond(interaction, stepBackFeedback(queue.stepBack(), __, __mf));
            break;
        }

        case PanelId.Loop: {
            const modes: LoopMode[] = ["OFF", "SONG", "QUEUE"];
            const modeEmoji: Record<LoopMode, string> = { OFF: "▶️", QUEUE: "🔁", SONG: "🔂" };
            const nextMode = modes[(modes.indexOf(queue.loopMode) + 1) % modes.length];
            queue.setLoopMode(nextMode);

            await respond(
                interaction,
                createEmbed(
                    "success",
                    `${modeEmoji[nextMode]} **|** ${__mf("commands.music.repeat.newMode", {
                        mode: `**\`${nextMode}\`**`,
                    })}`,
                ),
            );
            break;
        }

        case PanelId.Shuffle: {
            queue.setShuffle(!queue.shuffle);
            await respond(
                interaction,
                createEmbed(
                    "success",
                    `${queue.shuffle ? "🔀" : "▶️"} **|** ${__mf("commands.music.shuffle.newState", {
                        state: `**\`${__(queue.shuffle ? "reusable.enabled" : "reusable.disabled")}\`**`,
                    })}`,
                ),
            );
            break;
        }

        case PanelId.AutoPlay: {
            queue.setAutoPlay(!queue.autoPlay);
            await respond(
                interaction,
                createEmbed(
                    "success",
                    `♾️ **|** ${__mf("commands.music.autoplay.newState", {
                        state: `**\`${__(queue.autoPlay ? "reusable.enabled" : "reusable.disabled")}\`**`,
                    })}`,
                ),
            );
            break;
        }

        case PanelId.VolumeDown:
        case PanelId.VolumeUp: {
            await changeVolume(panel, interaction, queue);
            break;
        }

        case PanelId.SeekBack:
        case PanelId.SeekForward: {
            const step =
                interaction.customId === PanelId.SeekBack ? -SEEK_STEP_SECONDS : SEEK_STEP_SECONDS;
            const song = queue.currentSong;
            const result = queue.seek(Math.max(0, queue.position + step));

            await respond(interaction, seekFeedback(result, song, __, __mf));
            break;
        }

        case PanelId.Remove: {
            await removeCurrent(panel, interaction, queue);
            break;
        }

        default:
            break;
    }
}

async function skipTrack(
    panel: Panel,
    interaction: ButtonInteraction,
    queue: ServerQueue,
): Promise<void> {
    const { client, guild, member, __, __mf } = panel;

    if (!queue.canSkip()) {
        await respond(interaction, createEmbed("warn", __("requestChannel.skipInProgress")));
        return;
    }

    const song = queue.currentSong;
    // Whoever has no say over the track casts a vote instead; the track goes
    // once enough of the channel has voted.
    const decides = await canOverrideTrack(client, guild, member, song);
    const carried =
        decides || (member !== undefined && (await voteToSkip(panel, interaction, queue, member)));
    if (!carried) {
        return;
    }

    if (!queue.startSkip()) {
        await respond(interaction, createEmbed("warn", __("requestChannel.skipInProgress")));
        return;
    }

    if (!queue.playing) {
        queue.playing = true;
    }
    queue.player.stop(true);

    await respond(
        interaction,
        createEmbed(
            "success",
            `⏭️ **|** ${__mf("commands.music.skip.skipMessage", {
                song: song ? `**${formatMarkdownLink(song.song.title, song.song.url)}**` : "",
            })}`,
        ).setThumbnail(embedThumbnail(song?.song.thumbnail)),
    );
}

/** Cast or withdraw a vote. True once enough listeners want the track gone. */
async function voteToSkip(
    panel: Panel,
    interaction: ButtonInteraction,
    queue: ServerQueue,
    member: GuildMember,
): Promise<boolean> {
    const { client, guild, __mf } = panel;
    const required = client.utils.requiredVoters(
        guild.members.me?.voice.channel?.members.size ?? 0,
    );

    if (queue.skipVoters.includes(member.id)) {
        queue.skipVoters = queue.skipVoters.filter((voter) => voter !== member.id);
    } else {
        queue.skipVoters.push(member.id);
    }

    const length = queue.skipVoters.length;
    await respond(
        interaction,
        createEmbed("info", __mf("commands.music.skip.voteResultMessage", { length, required })),
    );

    return queue.skipVoters.includes(member.id) && length >= required;
}

async function stopPlayer(
    panel: Panel,
    interaction: PanelInteraction,
    queue: ServerQueue | undefined,
): Promise<void> {
    const { client, guild, member, __ } = panel;

    if (!queue) {
        await respond(interaction, createEmbed("warn", __("requestChannel.nothingPlaying")));
        return;
    }

    // Once the queue has run out nobody's track is at stake, and anyone in the
    // channel may send the bot away.
    const song = queue.currentSong;
    if (song !== undefined && !(await canOverrideTrack(client, guild, member, song))) {
        await respond(interaction, createEmbed("error", __("requestChannel.noPermission"), true));
        return;
    }

    await queue.destroy();
    await respond(
        interaction,
        createEmbed("success", `⏹️ **|** ${__("commands.music.stop.stoppedMessage")}`),
    );
}

async function changeVolume(
    panel: Panel,
    interaction: ButtonInteraction,
    queue: ServerQueue,
): Promise<void> {
    const { client, guild, member, __, __mf } = panel;
    let volume = Math.max(1, queue.volume - VOLUME_STEP);

    if (interaction.customId === PanelId.VolumeUp) {
        const privileged = await hasDjPrivilege(client, guild, member);
        volume = Math.min(
            queue.volume + VOLUME_STEP,
            // Never lower a volume that a DJ has already set above the open limit.
            Math.max(queue.volume, privileged ? VOLUME_LIMIT : OPEN_VOLUME_LIMIT),
        );

        if (volume === queue.volume && !privileged) {
            await respond(
                interaction,
                createEmbed("error", __("commands.music.volume.noPermission"), true),
            );
            return;
        }
    }

    queue.volume = volume;
    await respond(
        interaction,
        createEmbed(
            "success",
            `🔊 **|** ${__mf("commands.music.volume.newVolume", {
                volume: `**\`${volume}%\`**`,
            })}`,
        ),
    );
}

async function removeCurrent(
    panel: Panel,
    interaction: ButtonInteraction,
    queue: ServerQueue,
): Promise<void> {
    const { client, guild, member, __, __mf } = panel;

    if (!queue.canSkip()) {
        await respond(interaction, createEmbed("warn", __("requestChannel.skipInProgress")));
        return;
    }

    const song = queue.currentSong;
    if (!song) {
        await respond(interaction, createEmbed("warn", __("requestChannel.nothingPlaying")));
        return;
    }

    if (!(await canOverrideTrack(client, guild, member, song))) {
        await respond(interaction, createEmbed("error", __("requestChannel.noPermission"), true));
        return;
    }

    if (!queue.startSkip()) {
        await respond(interaction, createEmbed("warn", __("requestChannel.skipInProgress")));
        return;
    }

    queue.songs.delete(song.key);
    if (!queue.playing) {
        queue.playing = true;
    }
    queue.player.stop(true);

    const removed = createEmbed(
        "info",
        `${__("commands.music.remove.songSkip")}1.) **${formatMarkdownLink(
            parseHTMLElements(song.song.title),
            song.song.url,
        )}**`,
    )
        .setAuthor({ name: __mf("commands.music.remove.songsRemoved", { removed: 1 }) })
        .setFooter({ text: `• ${__mf("reusable.pageFooter", { actual: 1, total: 1 })}` })
        .setThumbnail(embedThumbnail(song.song.thumbnail));

    await respond(interaction, removed);
}

async function jumpTo(
    panel: Panel,
    interaction: StringSelectMenuInteraction,
    queue: ServerQueue,
): Promise<void> {
    const { client, guild, member, __, __mf } = panel;
    const target = queue.songs.get(interaction.values[0] ?? "");

    // The menu was drawn a moment ago; the track may have played or been removed.
    if (!target) {
        await respond(
            interaction,
            createEmbed("error", __("commands.music.skipTo.noSongPosition"), true),
        );
        return;
    }
    if (target.key === queue.currentSong?.key) {
        await respond(interaction, createEmbed("warn", __("commands.music.skipTo.cantPlay")));
        return;
    }
    if (await isQueueLocked(client, guild, member)) {
        await respond(
            interaction,
            createEmbed("error", __("commands.music.skipTo.noPermission"), true),
        );
        return;
    }
    if (!queue.startSkip()) {
        await respond(interaction, createEmbed("warn", __("requestChannel.skipInProgress")));
        return;
    }

    void play(guild, target.key);

    await respond(
        interaction,
        createEmbed(
            "success",
            `⏭️ **|** ${__mf("commands.music.skipTo.skipMessage", {
                song: `**${formatMarkdownLink(target.song.title, target.song.url)}**`,
            })}`,
        ).setThumbnail(embedThumbnail(target.song.thumbnail)),
    );
}

function buildAddModal(__: Panel["__"]): ModalBuilder {
    return new ModalBuilder()
        .setCustomId(PanelId.AddModal)
        .setTitle(truncate(__("requestChannel.addModalTitle"), MODAL_TEXT_LIMIT))
        .addLabelComponents(
            new LabelBuilder()
                .setLabel(truncate(__("requestChannel.addModalLabel"), MODAL_TEXT_LIMIT))
                .setTextInputComponent(
                    new TextInputBuilder()
                        .setCustomId(ADD_QUERY_FIELD)
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                        .setMaxLength(500),
                ),
        );
}

/** Queue what was typed into the "add" dialog, exactly as `play` would. */
async function addFromModal(
    panel: Panel,
    interaction: ModalSubmitInteraction,
    voiceChannelId: string,
): Promise<void> {
    const { client, guild, __, __mf } = panel;

    const query = interaction.fields.getTextInputValue(ADD_QUERY_FIELD).trim();
    if (query.length === 0) {
        await respond(interaction, createEmbed("warn", __("commands.music.search.noQuery")));
        return;
    }

    // With several bots, `play` stays silent for a listener another bot serves;
    // say so here instead of leaving the dialog without an answer.
    if (!client.multiBotManager.shouldRespondToMusicCommand(client, guild, voiceChannelId)) {
        const responsible = client.multiBotManager.getResponsibleBot(guild);
        await respond(
            interaction,
            createEmbed(
                "error",
                __mf("events.createInteraction.wrongBot", {
                    botMention: responsible?.user
                        ? `<@${responsible.user.id}>`
                        : __("events.createInteraction.primaryBotFallback"),
                }),
                true,
            ),
        );
        return;
    }

    const command = client.commands.get("play") as
        | { contextRun?: (ctx: CommandContext) => Promise<unknown> }
        | undefined;
    if (!command?.contextRun) {
        return;
    }

    // Resolving a request can outlast the three seconds an interaction allows.
    await interaction.deferReply();

    const context = new CommandContext(interaction, query.split(/ +/u));
    context.guild = guild;
    await command.contextRun(context);
}

/**
 * Keep a single panel per queue. A panel posted before a restart is no longer
 * tracked but still works, since its buttons carry everything they need: when
 * one is used it is taken over, unless a newer panel exists, in which case the
 * old one has had its day.
 */
async function reconcilePanel(client: Rawon, guild: Guild, message: Message | null): Promise<void> {
    const queue = guild.queue;
    const current = queue?.currentSong;

    if (
        !message ||
        !queue ||
        !current ||
        queue.panel?.id === message.id ||
        client.requestChannelManager.isRequestChannel(guild, message.channelId)
    ) {
        return;
    }

    if (queue.panel !== null) {
        await message.delete().catch(() => null);
        return;
    }

    await queue.setPanel(message, current.key);
    await queue.refreshPanel();
}

/** Show a multi-page embed privately, with buttons to turn the pages. */
async function paginate(
    interaction: ButtonInteraction,
    embed: EmbedBuilder,
    pages: string[],
    idPrefix: string,
    footer: (page: number) => string,
): Promise<void> {
    const buttons = (): APIMessageTopLevelComponent[] => {
        if (pages.length < 2) {
            return [];
        }

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`${idPrefix}PREV10`)
                .setEmoji("⏪")
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`${idPrefix}PREV`)
                .setEmoji("⬅️")
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`${idPrefix}NEXT`)
                .setEmoji("➡️")
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`${idPrefix}NEXT10`)
                .setEmoji("⏩")
                .setStyle(ButtonStyle.Secondary),
        );
        return [row.toJSON() as APIMessageTopLevelComponent];
    };

    let page = 0;
    embed.setFooter({ text: footer(page) });

    const payload = { embeds: [embed], components: buttons() };
    if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload);
    } else {
        await interaction.reply({ flags: MessageFlags.Ephemeral, ...payload });
    }

    if (pages.length < 2) {
        return;
    }

    const steps: Record<string, number> = {
        [`${idPrefix}PREV10`]: -10,
        [`${idPrefix}PREV`]: -1,
        [`${idPrefix}NEXT`]: 1,
        [`${idPrefix}NEXT10`]: 10,
    };

    const message = await interaction.fetchReply();
    const collector = message.createMessageComponentCollector({
        componentType: ComponentType.Button,
        filter: (press) => press.user.id === interaction.user.id && press.customId in steps,
        time: PAGER_LIFETIME_MS,
    });

    collector.on("collect", async (press) => {
        page = (((page + steps[press.customId]) % pages.length) + pages.length) % pages.length;
        embed.setDescription(pages[page]).setFooter({ text: footer(page) });

        await press.update({ embeds: [embed], components: buttons() }).catch(() => null);
    });

    collector.on("end", () => {
        interaction.editReply({ embeds: [embed], components: [] }).catch(() => null);
    });
}

async function showQueue(
    panel: Panel,
    interaction: ButtonInteraction,
    queue: ServerQueue | undefined,
): Promise<void> {
    const { guild, __, __mf } = panel;

    if (!queue || queue.songs.size === 0) {
        await respond(interaction, createEmbed("warn", __("requestChannel.nothingPlaying")));
        return;
    }

    const current = queue.currentSong;
    const pages = chunk(queue.listed(), 10).map((entries, pageIndex) =>
        entries
            .map((entry, index) => {
                const mark = entry.key === current?.key ? "**" : "";
                return `${mark}${pageIndex * 10 + index + 1} - ${formatMarkdownLink(
                    entry.song.title,
                    entry.song.url,
                )}${mark}`;
            })
            .join("\n"),
    );

    const embed = createEmbed("info", pages[0] ?? `📋 **|** ${__("requestChannel.emptyQueue")}`)
        .setTitle(`📋 ${__("requestChannel.queueListTitle")}`)
        .setThumbnail(guild.iconURL({ extension: "png", size: 1_024 }) ?? null);

    await paginate(
        interaction,
        embed,
        pages,
        "RCQ_",
        (page) =>
            `• ${__mf("reusable.pageFooter", { actual: page + 1, total: Math.max(pages.length, 1) })}`,
    );
}

async function showLyrics(
    panel: Panel,
    interaction: ButtonInteraction,
    queue: ServerQueue | undefined,
): Promise<void> {
    const { client, __, __mf } = panel;

    const song = queue?.currentSong;
    if (!song) {
        await respond(interaction, createEmbed("warn", __("requestChannel.nothingPlaying")));
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const lyricsCommand = client.commands.get("lyrics") as
        | {
              fetchLyricsData?: (
                  client: Rawon,
                  song: string,
              ) => Promise<(LyricsAPIResult<false> & { source?: string }) | null>;
          }
        | undefined;
    if (!lyricsCommand?.fetchLyricsData) {
        await interaction.editReply({
            embeds: [
                createEmbed("error", __("events.createInteraction.lyricsCommandNotFound"), true),
            ],
        });
        return;
    }

    const notFound = __mf("commands.music.lyrics.noLyrics", { song: `**${song.song.title}**` });

    try {
        const data = await lyricsCommand.fetchLyricsData(client, song.song.title);
        if (
            data === null ||
            (data as { error: boolean }).error ||
            (data.lyrics?.length ?? 0) === 0
        ) {
            await interaction.editReply({ embeds: [createEmbed("warn", notFound)] });
            return;
        }

        const pages: string[] = chunk(data.lyrics ?? "", 2_048);
        const source = data.source ?? "stegripe";
        const embed = createEmbed("info", pages[0])
            .setAuthor({
                name:
                    (data.song?.length ?? 0) > 0 && (data.artist?.length ?? 0) > 0
                        ? `${data.song} - ${data.artist}`
                        : song.song.title.toUpperCase(),
            })
            .setThumbnail(
                embedThumbnail(song.song.thumbnail) ??
                    data.album_art ??
                    assetUrl(client, "icon") ??
                    null,
            );

        await paginate(
            interaction,
            embed,
            pages,
            "LYRICS_",
            (page) =>
                `• ${__mf("reusable.lyricsSource", { source })}. ${__mf("reusable.pageFooter", {
                    actual: page + 1,
                    total: pages.length,
                })}`,
        );
    } catch {
        await interaction
            .editReply({ embeds: [createEmbed("error", notFound, true)] })
            .catch(() => null);
    }
}
