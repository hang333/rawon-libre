/** biome-ignore-all lint/style/useNamingConvention: disable naming convention rule for this file */
import { Buffer } from "node:buffer";
import process from "node:process";
import { inspect } from "node:util";
import { ApplyOptions } from "@sapphire/decorators";
import { type Command } from "@sapphire/framework";
import { type CommandContext, ContextCommand } from "@stegripe/command-context";
import { AttachmentBuilder, PermissionFlagsBits, type SlashCommandBuilder } from "discord.js";
import i18n from "../../config/index.js";
import { type CommandContext as LocalCommandContext } from "../../structures/CommandContext.js";
import { type Rawon } from "../../structures/Rawon.js";
import { createEmbed } from "../../utils/functions/createEmbed.js";
import { i18n__ } from "../../utils/functions/i18n.js";

const MAX_FIELD_LENGTH = 1_024;
const OUTPUT_FILE_NAME = "output.js";

type EvalField = { value: string; files: AttachmentBuilder[] };

@ApplyOptions<Command.Options>({
    name: "eval",
    aliases: ["evaluate", "ev", "js-exec"],
    description: i18n.__("commands.developers.eval.description"),
    detailedDescription: { usage: i18n.__("commands.developers.eval.usage") },
    preconditions: ["DevOnly"],
    cooldownDelay: 0,
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
            .setName(opts.name ?? "eval")
            .setDescription(
                opts.description ?? i18n.__("commands.developers.eval.description"),
            ) as SlashCommandBuilder;
    },
})
export class EvalCommand extends ContextCommand {
    public async contextRun(ctx: CommandContext): Promise<void> {
        const localCtx = ctx as CommandContext & LocalCommandContext;
        const client = localCtx.client as Rawon;
        const __ = i18n__(client, localCtx.guild);
        const _msg = localCtx;
        const _client = client;

        const code = localCtx.args
            .join(" ")
            .replaceAll(/```(?:\S+\n)?(.*?)\n?```/gsu, (_: string, a: string) => a);
        const embed = createEmbed("info").addFields([
            {
                name: __("commands.developers.eval.inputString"),
                value: `\`\`\`js\n${code}\`\`\``,
            },
        ]);

        try {
            if (!code) {
                await localCtx.send({
                    embeds: [createEmbed("warn", __("commands.developers.eval.noCode"))],
                });
                return;
            }

            const isAsync = /--async\s*(--silent)?$/u.test(code);
            const isSilent = /--silent\s*(--async)?$/u.test(code);
            const toExecute =
                isAsync || isSilent
                    ? code.replace(/--(async|silent)\s*(--(silent|async))?$/u, "")
                    : code;
            const evaled = inspect(
                await eval(isAsync ? `(async () => {\n${toExecute}\n})()` : toExecute),
                {
                    depth: 0,
                },
            );

            if (isSilent) {
                return;
            }

            const output = await this.toField(client, this.clean(evaled));

            embed.addFields([
                { name: __("commands.developers.eval.outputString"), value: output.value },
            ]);
            await localCtx
                .send({
                    embeds: [embed],
                    files: output.files,
                })
                .catch((error: unknown) => this.container.logger.error("PROMISE_ERR:", error));
        } catch (error_) {
            const error = await this.toField(client, this.clean(String(error_)));

            embed
                .setColor("Red")
                .addFields([
                    { name: __("commands.developers.eval.errorString"), value: error.value },
                ]);
            await localCtx
                .send({
                    embeds: [embed],
                    files: error.files,
                })
                .catch((err: unknown) => this.container.logger.error("PROMISE_ERR:", err));
        }
    }

    private clean(text: string): string {
        return text
            .replaceAll(
                new RegExp(process.env.DISCORD_TOKEN ?? "thereshouldbetokenhere", "gu"),
                "[REDACTED]",
            )
            .replaceAll("`", `\`${String.fromCodePoint(8_203)}`)
            .replaceAll("@", `@${String.fromCodePoint(8_203)}`);
    }

    /**
     * Fit eval output into an embed field. What is too long for one goes to the
     * paste server named by HASTE_URL, and with none configured (or the upload
     * failing) it rides along as a file. Eval output can hold anything the process
     * can see, so it is never sent to a host the operator did not choose.
     */
    private async toField(client: Rawon, text: string): Promise<EvalField> {
        if (text.length <= MAX_FIELD_LENGTH) {
            return { value: `\`\`\`js\n${text}\`\`\``, files: [] };
        }

        const hasteUrl = client.config.hasteUrl;
        if (hasteUrl.length > 0) {
            try {
                return { value: await this.hastebin(client, hasteUrl, text), files: [] };
            } catch (error) {
                this.container.logger.warn(
                    `[EvalCommand] Upload to ${hasteUrl} failed, attaching the output instead:`,
                    error,
                );
            }
        }

        return {
            value: `📎 \`${OUTPUT_FILE_NAME}\``,
            files: [new AttachmentBuilder(Buffer.from(text, "utf8"), { name: OUTPUT_FILE_NAME })],
        };
    }

    private async hastebin(client: Rawon, hasteUrl: string, text: string): Promise<string> {
        const result = await client.request
            .post(`${hasteUrl}/documents`, {
                body: text,
                headers: {
                    "content-type": "text/plain; charset=utf-8",
                },
                timeout: { request: 15_000 },
            })
            .json<{ key: string }>();

        return `${hasteUrl}/${result.key}.js`;
    }
}
