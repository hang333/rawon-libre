/** biome-ignore-all lint/style/useNamingConvention: disable naming convention rule for this file */
import { ApplyOptions } from "@sapphire/decorators";
import { type Command } from "@sapphire/framework";
import { type CommandContext, ContextCommand } from "@stegripe/command-context";
import {
    type EmbedBuilder,
    type Message,
    PermissionFlagsBits,
    type SlashCommandBuilder,
} from "discord.js";
import i18n from "../../config/index.js";
import { type CommandContext as LocalCommandContext } from "../../structures/CommandContext.js";
import { type Rawon } from "../../structures/Rawon.js";
import { createEmbed } from "../../utils/functions/createEmbed.js";
import { formatPrefixedCommand } from "../../utils/functions/formatCodeSpan.js";
import { getEffectivePrefix } from "../../utils/functions/getEffectivePrefix.js";
import { i18n__, i18n__mf } from "../../utils/functions/i18n.js";
import { checkForUpdate, type YtDlpUpdateResult } from "../../utils/yt-dlp/index.js";

/**
 * The scheduled updater leaves a release alone for its first day. This is the
 * way around that wait for when a fix is needed now, and the place to see what
 * is installed and what the updater intends to do.
 */
@ApplyOptions<Command.Options>({
    name: "ytdlp",
    aliases: ["yt-dlp", "ytdl"],
    description: i18n.__("commands.developers.ytdlp.description"),
    detailedDescription: { usage: i18n.__("commands.developers.ytdlp.usage") },
    preconditions: ["DevOnly"],
    cooldownDelay: 5000,
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
            .setName(opts.name ?? "ytdlp")
            .setDescription(opts.description ?? i18n.__("commands.developers.ytdlp.description"))
            .addSubcommand((sub) =>
                sub
                    .setName("status")
                    .setDescription(i18n.__("commands.developers.ytdlp.slashStatusDescription")),
            )
            .addSubcommand((sub) =>
                sub
                    .setName("update")
                    .setDescription(i18n.__("commands.developers.ytdlp.slashUpdateDescription")),
            ) as SlashCommandBuilder;
    },
})
export class YtDlpCommand extends ContextCommand {
    public async contextRun(ctx: CommandContext): Promise<Message | undefined> {
        const localCtx = ctx as CommandContext & LocalCommandContext;
        const client = ctx.client as Rawon;
        const __ = i18n__(client, localCtx.guild);
        const __mf = i18n__mf(client, localCtx.guild);
        const prefix = getEffectivePrefix(client, localCtx.guild?.id ?? null);

        const subcommand =
            localCtx.options?.getSubcommand() ?? localCtx.args[0]?.toLowerCase() ?? "status";
        if (subcommand !== "status" && subcommand !== "update") {
            return ctx.reply({
                embeds: [
                    createEmbed(
                        "warn",
                        __mf("commands.developers.database.invalidSubcommand", {
                            usage: formatPrefixedCommand(prefix, "ytdlp <status | update>"),
                        }),
                    ),
                ],
            });
        }

        // Asking GitHub, and an update's download, both take a moment.
        const statusMsg = await ctx.reply({
            embeds: [createEmbed("info", `🔄 **|** ${__("commands.developers.ytdlp.checking")}`)],
        });

        const result = await checkForUpdate(
            subcommand === "update" ? { force: true } : { dryRun: true },
        );
        const updateCommand = formatPrefixedCommand(prefix, "ytdlp update");

        await statusMsg?.edit({ embeds: [this.report(result, updateCommand, __, __mf)] });
        return statusMsg ?? undefined;
    }

    private report(
        result: YtDlpUpdateResult,
        updateCommand: string,
        __: ReturnType<typeof i18n__>,
        __mf: ReturnType<typeof i18n__mf>,
    ): EmbedBuilder {
        const code = (text: string | null): string =>
            `**\`${text ?? __("commands.developers.ytdlp.unknownVersion")}\`**`;
        const when = (timestamp: number | null): string =>
            timestamp === null ? "?" : `<t:${Math.floor(timestamp / 1_000)}:R>`;

        switch (result.status) {
            case "updated":
                return createEmbed(
                    "success",
                    __mf("commands.developers.ytdlp.updated", {
                        from: code(result.current),
                        to: code(result.target),
                    }),
                    true,
                );

            case "current":
                return createEmbed(
                    "info",
                    __mf("commands.developers.ytdlp.current", { version: code(result.current) }),
                );

            case "available":
                return createEmbed(
                    "info",
                    __mf("commands.developers.ytdlp.available", {
                        version: code(result.current),
                        target: code(result.target),
                        command: updateCommand,
                    }),
                );

            case "waiting":
                return createEmbed(
                    "info",
                    __mf("commands.developers.ytdlp.waiting", {
                        version: code(result.current),
                        latest: code(result.latest),
                        released: when(result.latestPublishedAt),
                        eligible: when(result.eligibleAt),
                        command: updateCommand,
                    }),
                );

            case "busy":
                return createEmbed("warn", __("commands.developers.ytdlp.busy"));

            default:
                return createEmbed(
                    "error",
                    __mf("commands.developers.ytdlp.failed", {
                        reason: `\`${(result.error ?? "unknown error").slice(0, 300)}\``,
                    }),
                    true,
                );
        }
    }
}
