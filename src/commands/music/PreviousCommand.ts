/** biome-ignore-all lint/style/useNamingConvention: disable naming convention rule for this file */
import { ApplyOptions } from "@sapphire/decorators";
import { type Command } from "@sapphire/framework";
import { type CommandContext, ContextCommand } from "@stegripe/command-context";
import { type GuildMember, PermissionFlagsBits, type SlashCommandBuilder } from "discord.js";
import i18n from "../../config/index.js";
import { type Rawon } from "../../structures/Rawon.js";
import { haveQueue, inVC, sameVC, useRequestChannel } from "../../utils/decorators/MusicUtil.js";
import { createEmbed } from "../../utils/functions/createEmbed.js";
import { i18n__, i18n__mf } from "../../utils/functions/i18n.js";
import { isQueueLocked } from "../../utils/functions/musicPermissions.js";
import { stepBackFeedback } from "../../utils/functions/playerFeedback.js";

@ApplyOptions<Command.Options>({
    name: "previous",
    aliases: ["prev", "back"],
    description: i18n.__("commands.music.previous.description"),
    detailedDescription: { usage: "{prefix}previous" },
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
            .setName(opts.name ?? "previous")
            .setDescription(
                opts.description ?? i18n.__("commands.music.previous.description"),
            ) as SlashCommandBuilder;
    },
})
export class PreviousCommand extends ContextCommand {
    private getClient(ctx: CommandContext): Rawon {
        return ctx.client as Rawon;
    }

    @useRequestChannel
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
                embeds: [createEmbed("error", __("commands.music.skipTo.noPermission"), true)],
            });
            return;
        }

        await ctx
            .reply({ embeds: [stepBackFeedback(queue.stepBack(), __, __mf)] })
            .catch((error: unknown) => this.container.logger.error("PREVIOUS_CMD_ERR:", error));
    }
}
