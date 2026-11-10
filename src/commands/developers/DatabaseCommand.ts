/** biome-ignore-all lint/style/useNamingConvention: disable naming convention rule for this file */
import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { ApplyOptions } from "@sapphire/decorators";
import { type Command } from "@sapphire/framework";
import { type CommandContext, ContextCommand } from "@stegripe/command-context";
import {
    type Attachment,
    AttachmentBuilder,
    Message,
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
import {
    type DatabaseExport,
    parseDatabaseExport,
} from "../../utils/structures/SQLiteDataManager.js";

// Far above what even a very large install exports, and small enough to hold in memory.
const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

const toFileName = (exportedAt: string): string =>
    `rawon-libre-database-${exportedAt.replaceAll(/[:.]/gu, "-")}.json`;

@ApplyOptions<Command.Options>({
    name: "database",
    aliases: ["db"],
    description: i18n.__("commands.developers.database.description"),
    detailedDescription: { usage: i18n.__("commands.developers.database.usage") },
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
            .setName(opts.name ?? "database")
            .setDescription(opts.description ?? i18n.__("commands.developers.database.description"))
            .addSubcommand((sub) =>
                sub
                    .setName("export")
                    .setDescription(i18n.__("commands.developers.database.slashExportDescription")),
            )
            .addSubcommand((sub) =>
                sub
                    .setName("import")
                    .setDescription(i18n.__("commands.developers.database.slashImportDescription"))
                    .addAttachmentOption((opt) =>
                        opt
                            .setName("file")
                            .setDescription(
                                i18n.__("commands.developers.database.slashFileDescription"),
                            )
                            .setRequired(true),
                    ),
            ) as SlashCommandBuilder;
    },
})
export class DatabaseCommand extends ContextCommand {
    public async contextRun(ctx: CommandContext): Promise<Message | undefined> {
        const localCtx = ctx as CommandContext & LocalCommandContext;
        const client = ctx.client as Rawon;
        const __mf = i18n__mf(client, localCtx.guild);
        const subcommand = localCtx.options?.getSubcommand() ?? localCtx.args[0]?.toLowerCase();

        if (subcommand === "export") {
            return this.export(ctx, client);
        }
        if (subcommand === "import") {
            return this.import(ctx, localCtx, client);
        }

        return ctx.reply({
            embeds: [
                createEmbed(
                    "warn",
                    __mf("commands.developers.database.invalidSubcommand", {
                        usage: this.usage(client, localCtx),
                    }),
                ),
            ],
        });
    }

    private usage(client: Rawon, ctx: LocalCommandContext): string {
        return formatPrefixedCommand(
            getEffectivePrefix(client, ctx.guild?.id ?? null),
            "database <export | import>",
        );
    }

    /**
     * The export lists every server's settings, so it goes to the developer's
     * direct messages rather than into whatever channel the command was typed in.
     */
    private async export(ctx: CommandContext, client: Rawon): Promise<Message | undefined> {
        const __ = i18n__(client, ctx.guild);
        const __mf = i18n__mf(client, ctx.guild);
        const dump = client.data.exportData();

        try {
            await ctx.author.send({
                embeds: [createEmbed("info", __("commands.developers.database.exportDm"))],
                files: [this.toAttachment(dump)],
            });
        } catch {
            return ctx.reply({
                embeds: [createEmbed("error", __("commands.developers.database.dmFailed"), true)],
            });
        }

        return ctx.reply({
            embeds: [
                createEmbed(
                    "success",
                    __mf("commands.developers.database.exportSent", {
                        guilds: `**\`${dump.tables.guilds.length}\`**`,
                    }),
                    true,
                ),
            ],
        });
    }

    private async import(
        ctx: CommandContext,
        localCtx: LocalCommandContext,
        client: Rawon,
    ): Promise<Message | undefined> {
        const __ = i18n__(client, ctx.guild);
        const __mf = i18n__mf(client, ctx.guild);

        const upload = this.getUpload(localCtx);
        if (!upload) {
            return ctx.reply({
                embeds: [
                    createEmbed(
                        "warn",
                        __mf("commands.developers.database.noFile", {
                            usage: this.usage(client, localCtx),
                        }),
                    ),
                ],
            });
        }
        if (upload.size > MAX_IMPORT_BYTES) {
            return ctx.reply({
                embeds: [createEmbed("warn", __("commands.developers.database.tooLarge"))],
            });
        }

        // Checked in full before anything is touched, so a wrong file is turned
        // away without a backup being written or a transaction being opened.
        let parsed: DatabaseExport;
        try {
            const body = await client.request
                .get(upload.url, { timeout: { request: 30_000 } })
                .text();
            parsed = parseDatabaseExport(JSON.parse(body));
        } catch (error) {
            return ctx.reply({
                embeds: [
                    createEmbed(
                        "error",
                        __mf("commands.developers.database.invalidFile", {
                            reason:
                                error instanceof SyntaxError
                                    ? "it is not valid JSON"
                                    : (error as Error).message,
                        }),
                        true,
                    ),
                ],
            });
        }

        // Importing replaces what is there, so what is there is written to disk
        // first. A failure to do so stops the import: no backup, no overwrite.
        let backupPath: string;
        try {
            backupPath = await this.writeBackup(client.data.exportData());
        } catch (error) {
            this.container.logger.error("[DatabaseCommand] Could not write a backup:", error);
            return ctx.reply({
                embeds: [
                    createEmbed(
                        "error",
                        __mf("commands.developers.database.importFailed", {
                            reason: "the current data could not be backed up first",
                        }),
                        true,
                    ),
                ],
            });
        }

        let guilds: number;
        try {
            guilds = (await client.data.importData(parsed)).guilds;
        } catch (error) {
            return ctx.reply({
                embeds: [
                    createEmbed(
                        "error",
                        __mf("commands.developers.database.importFailed", {
                            reason: (error as Error).message,
                        }),
                        true,
                    ),
                ],
            });
        }

        this.container.logger.info(
            `[DatabaseCommand] ${ctx.author.tag} imported ${guilds} guilds; previous data saved to ${backupPath}`,
        );

        return ctx.reply({
            embeds: [
                createEmbed(
                    "success",
                    __mf("commands.developers.database.imported", {
                        guilds: `**\`${guilds}\`**`,
                        backup: `\`${path.relative(process.cwd(), backupPath)}\``,
                    }),
                    true,
                ),
            ],
        });
    }

    private getUpload(ctx: LocalCommandContext): Attachment | null {
        if (ctx.context instanceof Message) {
            return ctx.context.attachments.first() ?? null;
        }

        return ctx.options?.getAttachment("file") ?? null;
    }

    private toAttachment(dump: DatabaseExport): AttachmentBuilder {
        return new AttachmentBuilder(Buffer.from(JSON.stringify(dump, null, 2), "utf8"), {
            name: toFileName(dump.exportedAt),
        });
    }

    private async writeBackup(dump: DatabaseExport): Promise<string> {
        const directory = path.resolve(process.cwd(), "cache", "backups");
        await mkdir(directory, { recursive: true });

        const backupPath = path.join(directory, toFileName(dump.exportedAt));
        await writeFile(backupPath, JSON.stringify(dump, null, 2), "utf8");
        return backupPath;
    }
}
