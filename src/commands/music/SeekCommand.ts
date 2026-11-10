/** biome-ignore-all lint/style/useNamingConvention: disable naming convention rule for this file */
import { ApplyOptions } from "@sapphire/decorators";
import { type Command } from "@sapphire/framework";
import { type CommandContext, ContextCommand } from "@stegripe/command-context";
import { PermissionFlagsBits, type SlashCommandBuilder } from "discord.js";
import i18n from "../../config/index.js";
import { type CommandContext as LocalCommandContext } from "../../structures/CommandContext.js";
import { type Rawon } from "../../structures/Rawon.js";
import { haveQueue, inVC, sameVC } from "../../utils/decorators/MusicUtil.js";
import { createEmbed } from "../../utils/functions/createEmbed.js";
import { i18n__, i18n__mf } from "../../utils/functions/i18n.js";
import { parseTime } from "../../utils/functions/parseTime.js";
import { seekFeedback } from "../../utils/functions/playerFeedback.js";

@ApplyOptions<Command.Options>({
    name: "seek",
    aliases: ["sk"],
    description: i18n.__("commands.music.seek.description"),
    detailedDescription: { usage: i18n.__("commands.music.seek.usage") },
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
            .setName(opts.name ?? "seek")
            .setDescription(opts.description ?? i18n.__("commands.music.seek.description"))
            .addStringOption((opt) =>
                opt
                    .setName("time")
                    .setDescription(i18n.__("commands.music.seek.slashTimeDescription"))
                    .setRequired(true),
            ) as SlashCommandBuilder;
    },
})
export class SeekCommand extends ContextCommand {
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

        const queue = ctx.guild?.queue;
        if (!queue) {
            return;
        }

        const song = queue.currentSong;

        // Whether the track can be sought at all comes before what was typed, so
        // that a live stream is reported as such rather than as a bad time.
        const timeArg = localCtx.args[0] ?? localCtx.options?.getString("time");
        const seekSeconds = timeArg ? parseTime(timeArg) : null;
        if (seekSeconds === null || seekSeconds < 0) {
            const unseekable = queue.seekability();
            await ctx.reply({
                embeds: [
                    unseekable === null
                        ? createEmbed(
                              "warn",
                              timeArg
                                  ? __mf("commands.music.seek.invalidTime", {
                                        time: `**\`${timeArg}\`**`,
                                    })
                                  : __("commands.music.seek.noTime"),
                          )
                        : seekFeedback({ ok: false, reason: unseekable }, song, __, __mf),
                ],
            });
            return;
        }

        await ctx.reply({ embeds: [seekFeedback(queue.seek(seekSeconds), song, __, __mf)] });
    }
}
