/** biome-ignore-all lint/style/useNamingConvention: disable naming convention rule for this file */
import { ApplyOptions } from "@sapphire/decorators";
import { type Command } from "@sapphire/framework";
import { type CommandContext, ContextCommand } from "@stegripe/command-context";
import {
    type Attachment,
    type GuildMember,
    Message,
    PermissionFlagsBits,
    type SlashCommandBuilder,
    type VoiceBasedChannel,
} from "discord.js";
import i18n from "../../config/index.js";
import { type CommandContext as LocalCommandContext } from "../../structures/CommandContext.js";
import { type Rawon } from "../../structures/Rawon.js";
import { inVC, sameVC, useRequestChannel, validVC } from "../../utils/decorators/MusicUtil.js";
import {
    attachmentsToSongs,
    getPlayableAttachments,
} from "../../utils/functions/audioAttachment.js";
import { createEmbed } from "../../utils/functions/createEmbed.js";
import { createResolveNotice } from "../../utils/functions/createResolveNotice.js";
import { formatBoldPrefixedCommand } from "../../utils/functions/formatCodeSpan.js";
import { getEffectivePrefix } from "../../utils/functions/getEffectivePrefix.js";
import { i18n__, i18n__mf } from "../../utils/functions/i18n.js";
import { checkQuery, handleVideos, searchTrack } from "../../utils/handlers/GeneralUtil.js";

@ApplyOptions<Command.Options>({
    name: "play",
    aliases: ["p", "add"],
    description: i18n.__("commands.music.play.description"),
    detailedDescription: { usage: i18n.__("commands.music.play.usage") },
    requiredClientPermissions: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
    ],
    chatInputCommand(
        builder: Parameters<NonNullable<Command.Options["chatInputCommand"]>>[0],
        opts: Parameters<NonNullable<Command.Options["chatInputCommand"]>>[1],
    ): SlashCommandBuilder {
        return builder
            .setName(opts.name ?? "play")
            .setDescription(opts.description ?? i18n.__("commands.music.play.description"))
            .addStringOption((opt) =>
                opt
                    .setName("query")
                    .setDescription(i18n.__("commands.music.play.slashQueryDescription"))
                    // Required, although an upload can stand in for it: Discord only
                    // puts what is typed after the command into an option by
                    // itself when that option is required. Left optional, plain
                    // `/play some song` arrives with no query at all. With a file
                    // attached, the text is a caption and is not searched for.
                    .setRequired(true),
            )
            .addAttachmentOption((opt) =>
                opt
                    .setName("file")
                    .setDescription(i18n.__("commands.music.play.slashFileDescription"))
                    .setRequired(false),
            ) as SlashCommandBuilder;
    },
})
export class PlayCommand extends ContextCommand {
    private getClient(ctx: CommandContext): Rawon {
        return ctx.client as Rawon;
    }

    /** Files that came with the request: attached to the message, or the slash option. */
    private getUploads(ctx: LocalCommandContext): Attachment[] {
        if (ctx.context instanceof Message) {
            return [...ctx.context.attachments.values()];
        }

        const file = ctx.options?.getAttachment("file");
        return file ? [file] : [];
    }

    @useRequestChannel
    @inVC
    @validVC
    @sameVC
    public async contextRun(ctx: CommandContext): Promise<Message | undefined> {
        return this.enqueue(ctx);
    }

    /**
     * Resolve a request and queue it. Public because `playnext` is the same
     * request with a different place in the queue, and is allowed in servers
     * where `play` itself is reserved for the request channel.
     */
    public async enqueue(
        ctx: CommandContext,
        options: { next?: boolean; commandName?: string } = {},
    ): Promise<Message | undefined> {
        const placeNext = options.next === true;
        const localCtx = ctx as CommandContext & LocalCommandContext;
        const member = localCtx.member as GuildMember | null;
        const client = this.getClient(ctx);
        const __ = i18n__(client, ctx.guild);
        const __mf = i18n__mf(client, ctx.guild);

        if (ctx.isCommandInteraction() && !localCtx.deferred) {
            await localCtx.deferReply();
        }

        const voiceChannel = member?.voice.channel as VoiceBasedChannel;
        if (localCtx.additionalArgs.get("fromSearch") !== undefined) {
            const tracks = localCtx.additionalArgs.get("values") as string[];
            const searchResults = await Promise.all(
                tracks.map(async (track) => searchTrack(client, track).catch(() => null)),
            );
            const toQueue = searchResults
                .filter((result): result is NonNullable<typeof result> => result !== null)
                .map((result) => result.items[0]);

            return handleVideos(client, localCtx, toQueue, voiceChannel, undefined, placeNext);
        }

        const query =
            (localCtx.args.join(" ") || localCtx.options?.getString("query")) ??
            (localCtx.additionalArgs.get("values") === undefined
                ? undefined
                : (localCtx.additionalArgs.get("values") as (string | undefined)[])[0]);

        const uploads = this.getUploads(localCtx);
        const playableUploads = getPlayableAttachments(uploads);

        if ((query?.length ?? 0) === 0 && playableUploads.length === 0) {
            if (uploads.length > 0) {
                return ctx.reply({
                    embeds: [createEmbed("warn", __("commands.music.play.unsupportedAttachment"))],
                });
            }

            const prefix = getEffectivePrefix(client, ctx.guild?.id ?? null);
            return ctx.reply({
                embeds: [
                    createEmbed(
                        "warn",
                        __mf("reusable.invalidUsage", {
                            prefix: formatBoldPrefixedCommand(prefix, "help"),
                            name: `**\`${options.commandName ?? this.options.name}\`**`,
                        }),
                    ),
                ],
            });
        }

        if (
            ctx.guild?.queue &&
            voiceChannel.id !== ctx.guild.queue.connection?.joinConfig.channelId
        ) {
            return ctx.reply({
                embeds: [
                    createEmbed(
                        "warn",
                        __mf("commands.music.play.alreadyPlaying", {
                            voiceChannel: `**\`${
                                ctx.guild.channels.cache.get(
                                    (
                                        ctx.guild.queue.connection?.joinConfig as
                                            | { channelId: string }
                                            | undefined
                                    )?.channelId ?? "",
                                )?.name ?? "#unknown-channel"
                            }\`**`,
                        }),
                    ),
                ],
            });
        }

        // An uploaded file is the request itself; text sent along with it is a caption.
        if (playableUploads.length > 0) {
            return handleVideos(
                client,
                localCtx,
                await attachmentsToSongs(playableUploads),
                voiceChannel,
                undefined,
                placeNext,
            );
        }

        const queryCheck = checkQuery(query ?? "");
        const isCollectionQuery = queryCheck.type === "playlist" || queryCheck.type === "artist";

        const notice = await createResolveNotice(client, localCtx, isCollectionQuery);
        const songs = await searchTrack(client, query ?? "", undefined, notice.report).catch(
            (error: unknown) => {
                client.logger.error("[PlayCommand] searchTrack failed:", error);
                return undefined;
            },
        );
        await notice.dismiss();

        if (!songs || songs.items.length <= 0) {
            // The notice already used this interaction's reply; CommandContext#send
            // turns a subsequent one into an editReply, which overwrites the notice.
            return ctx.reply({
                embeds: [createEmbed("error", __("commands.music.play.noSongData"), true)],
            });
        }

        // A link can hold several tracks without looking like a playlist: a
        // multi-part Bilibili video is one URL and many parts.
        const isCollection = isCollectionQuery || songs.playlist !== undefined;

        return handleVideos(
            client,
            localCtx,
            isCollection ? songs.items : [songs.items[0]],
            voiceChannel,
            isCollection ? songs.playlist : undefined,
            placeNext,
        );
    }
}
