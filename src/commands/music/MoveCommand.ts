/** biome-ignore-all lint/style/useNamingConvention: disable naming convention rule for this file */
import { ApplyOptions } from "@sapphire/decorators";
import { type Command } from "@sapphire/framework";
import { type CommandContext, ContextCommand } from "@stegripe/command-context";
import { type GuildMember, PermissionFlagsBits, type SlashCommandBuilder } from "discord.js";
import i18n from "../../config/index.js";
import { type CommandContext as LocalCommandContext } from "../../structures/CommandContext.js";
import { type Rawon } from "../../structures/Rawon.js";
import { haveQueue, inVC, sameVC } from "../../utils/decorators/MusicUtil.js";
import { createEmbed } from "../../utils/functions/createEmbed.js";
import { formatMarkdownLink } from "../../utils/functions/formatMarkdownLink.js";
import { i18n__, i18n__mf } from "../../utils/functions/i18n.js";
import { isQueueLocked } from "../../utils/functions/musicPermissions.js";
import { embedThumbnail } from "../../utils/functions/thumbnails.js";

@ApplyOptions<Command.Options>({
    name: "move",
    aliases: ["mv"],
    description: i18n.__("commands.music.move.description"),
    detailedDescription: { usage: i18n.__("commands.music.move.usage") },
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
            .setName(opts.name ?? "move")
            .setDescription(opts.description ?? i18n.__("commands.music.move.description"))
            .addIntegerOption((opt) =>
                opt
                    .setName("from")
                    .setDescription(i18n.__("commands.music.move.slashFromDescription"))
                    .setMinValue(1)
                    .setRequired(true),
            )
            .addIntegerOption((opt) =>
                opt
                    .setName("to")
                    .setDescription(i18n.__("commands.music.move.slashToDescription"))
                    .setMinValue(1)
                    .setRequired(true),
            ) as SlashCommandBuilder;
    },
})
export class MoveCommand extends ContextCommand {
    private getClient(ctx: CommandContext): Rawon {
        return ctx.client as Rawon;
    }

    @inVC
    @haveQueue
    @sameVC
    public async contextRun(ctx: CommandContext): Promise<void> {
        const localCtx = ctx as CommandContext & LocalCommandContext;
        const client = this.getClient(ctx);
        const __ = i18n__(client, ctx.guild);
        const __mf = i18n__mf(client, ctx.guild);

        const guild = ctx.guild;
        const queue = guild?.queue;
        if (!guild || !queue) {
            return;
        }

        if (await isQueueLocked(client, guild, ctx.member as GuildMember | null)) {
            await ctx.reply({
                embeds: [createEmbed("error", __("commands.music.remove.noPermission"), true)],
            });
            return;
        }

        // Positions are the numbers the `queue` command shows.
        const from = localCtx.options?.getInteger("from") ?? Number(localCtx.args[0]);
        const to = localCtx.options?.getInteger("to") ?? Number(localCtx.args[1]);
        const song = Number.isInteger(from) && Number.isInteger(to) ? queue.move(from, to) : null;

        if (song === null) {
            await ctx.reply({ embeds: [createEmbed("warn", __("commands.music.move.invalid"))] });
            return;
        }

        await ctx
            .reply({
                embeds: [
                    createEmbed(
                        "success",
                        `↕️ **|** ${__mf("commands.music.move.moved", {
                            song: `**${formatMarkdownLink(song.song.title, song.song.url)}**`,
                            position: `**\`${to}\`**`,
                        })}`,
                    ).setThumbnail(embedThumbnail(song.song.thumbnail)),
                ],
            })
            .catch((error: unknown) => this.container.logger.error("MOVE_CMD_ERR:", error));
    }
}
