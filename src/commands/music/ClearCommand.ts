/** biome-ignore-all lint/style/useNamingConvention: disable naming convention rule for this file */
import { ApplyOptions } from "@sapphire/decorators";
import { type Command } from "@sapphire/framework";
import { type CommandContext, ContextCommand } from "@stegripe/command-context";
import { type GuildMember, PermissionFlagsBits, type SlashCommandBuilder } from "discord.js";
import i18n from "../../config/index.js";
import { type Rawon } from "../../structures/Rawon.js";
import { haveQueue, inVC, sameVC } from "../../utils/decorators/MusicUtil.js";
import { createEmbed } from "../../utils/functions/createEmbed.js";
import { i18n__, i18n__mf } from "../../utils/functions/i18n.js";
import { isQueueLocked } from "../../utils/functions/musicPermissions.js";

@ApplyOptions<Command.Options>({
    name: "clear",
    aliases: ["clearqueue", "cq"],
    description: i18n.__("commands.music.clear.description"),
    detailedDescription: { usage: "{prefix}clear" },
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
            .setName(opts.name ?? "clear")
            .setDescription(
                opts.description ?? i18n.__("commands.music.clear.description"),
            ) as SlashCommandBuilder;
    },
})
export class ClearCommand extends ContextCommand {
    private getClient(ctx: CommandContext): Rawon {
        return ctx.client as Rawon;
    }

    @inVC
    @haveQueue
    @sameVC
    public async contextRun(ctx: CommandContext): Promise<void> {
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

        const removed = queue.clearUpcoming();
        if (removed === 0) {
            await ctx.reply({ embeds: [createEmbed("warn", __("commands.music.clear.nothing"))] });
            return;
        }

        await ctx
            .reply({
                embeds: [
                    createEmbed(
                        "success",
                        `🧹 **|** ${__mf("commands.music.remove.songsRemoved", { removed })}`,
                    ),
                ],
            })
            .catch((error: unknown) => this.container.logger.error("CLEAR_CMD_ERR:", error));
    }
}
