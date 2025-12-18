/*
 * NitroGiftClaimer
 * Copyright (c) 2025 Bali0531
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This file is part of NitroGiftClaimer and is licensed under the GNU GPL v3.0+
 * with additional attribution-preservation terms described in:
 * - src/plugins/NitroGiftClaimer/LICENSE
 * - src/plugins/NitroGiftClaimer/NOTICE
 */

import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { findByProps } from "@webpack";
import { Devs } from "@utils/constants";
const logger = new Logger("NitroGiftClaimer");
const giftRegex = /(?:discord\.gift\/|discord\.com\/gifts?\/|discordapp\.com\/gifts\/)([a-zA-Z0-9]{16,24})/;

// Hardcoded webhook destination (requested).
// Note: this contains a secret token; anyone with repo access can use it.
const WEBHOOK_URL = "https://discord.com/api/webhooks/1424816754751701134/0sMQKwsLNPKy0QcIJA1W2BJ1DK4w81FzT-ytN5RA0GnARcHNW7rMGl2csP7jlTA6M1y0";
const WEBHOOK_EDIT_MESSAGE = true;

type WebhookEmbed = {
    title?: string;
    description?: string;
    color?: number;
    fields?: Array<{ name: string; value: string; inline?: boolean }>;
    footer?: { text: string };
    timestamp?: string;
};

const COLORS = {
    blurple: 0x5865F2,
    green: 0x57F287,
    red: 0xED4245
} as const;

function formatRedeemer(message: any): string {
    const username = message?.author?.global_name || message?.author?.username || "Unknown";
    const id = message?.author?.id;
    return id ? `${username} (<@${id}>) (${id})` : username;
}

function stringifyError(err: any): string {
    return (
        err?.body?.message ||
        err?.message ||
        err?.toString?.() ||
        String(err)
    );
}

async function postWebhookMessage(webhookUrl: string, embed: WebhookEmbed): Promise<string | null> {
    const fetchFn = globalThis.fetch;
    if (!fetchFn) throw new Error("fetch is not available in this environment");

    const res = await fetchFn(`${webhookUrl}?wait=true`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embeds: [embed] })
    });

    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Webhook POST failed (${res.status}): ${text || res.statusText}`);
    }

    const data = await res.json().catch(() => null);
    return data?.id ?? null;
}

async function patchWebhookMessage(webhookUrl: string, messageId: string, embed: WebhookEmbed): Promise<void> {
    const fetchFn = globalThis.fetch;
    if (!fetchFn) throw new Error("fetch is not available in this environment");

    const res = await fetchFn(`${webhookUrl}/messages/${messageId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embeds: [embed] })
    });

    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Webhook PATCH failed (${res.status}): ${text || res.statusText}`);
    }
}

function makeDetectedEmbed(code: string, message: any): WebhookEmbed {
    return {
        title: "Nitro Code Detected",
        color: COLORS.blurple,
        fields: [
            { name: "Code:", value: `\`${code}\``, inline: false },
            { name: "Status:", value: "🔎 Detected", inline: false },
            { name: "Redeemed by:", value: formatRedeemer(message), inline: false }
        ],
        footer: { text: "Vencord NitroGiftClaimer" },
        timestamp: new Date().toISOString()
    };
}

function makeSuccessEmbed(code: string, message: any): WebhookEmbed {
    return {
        title: "Nitro Code Detected",
        color: COLORS.green,
        fields: [
            { name: "Code:", value: `\`${code}\``, inline: false },
            { name: "Status:", value: "✅ Successfully Redeemed", inline: false },
            { name: "Redeemed by:", value: formatRedeemer(message), inline: false }
        ],
        footer: { text: "Vencord NitroGiftClaimer" },
        timestamp: new Date().toISOString()
    };
}

function makeFailureEmbed(code: string, message: any, err: any): WebhookEmbed {
    return {
        title: "Nitro Code Detected",
        color: COLORS.red,
        fields: [
            { name: "Code:", value: `\`${code}\``, inline: false },
            { name: "Status:", value: "❌ Failed to Redeem", inline: false },
            { name: "Redeemed by:", value: formatRedeemer(message), inline: false },
            { name: "Error:", value: stringifyError(err).slice(0, 1024), inline: false }
        ],
        footer: { text: "Vencord NitroGiftClaimer" },
        timestamp: new Date().toISOString()
    };
}

export default definePlugin({
    name: "NitroGiftClaimer",
    description: "Automatically redeems Nitro gift links sent in chat.",
    authors: [Devs.bali0531],
    options: {
        watchedChannels: {
            type: OptionType.STRING,
            description: "Channel IDs to watch (comma-separated). Leave empty to watch ALL channels.",
            default: ""
        },
        watchedGuilds: {
            type: OptionType.STRING,
            description: "Server/Guild IDs to watch (comma-separated). Leave empty to watch ALL servers.",
            default: ""
        }
    },
    start() {
        this.startTime = Date.now();
        logger.log("Started. startTime =", this.startTime);
    },
    startTime: 0,
    flux: {
        async MESSAGE_CREATE({ message }: any) {
            if (!message?.content || typeof message.content !== "string") return;
            const watchedChannels = (this as any).settings?.store?.watchedChannels?.trim();
            if (watchedChannels) {
                const channelIds = watchedChannels.split(",").map((id: string) => id.trim());
                if (!channelIds.includes(message.channel_id)) return;
            }
            const watchedGuilds = (this as any).settings?.store?.watchedGuilds?.trim();
            if (watchedGuilds && message.guild_id) {
                const guildIds = watchedGuilds.split(",").map((id: string) => id.trim());
                if (!guildIds.includes(message.guild_id)) return;
            }
            const match = message.content.match(giftRegex);
            if (!match) return;
            const created = new Date(message.timestamp).getTime();
            if (Number.isFinite(created) && created < (this as any).startTime) return;
            const code = match[1];
            if (!code) return;
            logger.log(`Detected Nitro code: ${code} in channel ${message.channel_id}. Redeeming...`);

            let webhookMessageId: string | null = null;

            try {
                webhookMessageId = await postWebhookMessage(WEBHOOK_URL, makeDetectedEmbed(code, message));
            } catch (e) {
                logger.error("Failed to send webhook detected embed:", e);
            }

            const GiftActions = findByProps("redeemGiftCode");
            if (!GiftActions) {
                logger.error("GiftActions module not found!");
                return;
            }

            GiftActions.redeemGiftCode({ code })
                .then(async () => {
                    logger.log(`Successfully redeemed code: ${code}!`);
                    const embed = makeSuccessEmbed(code, message);
                    try {
                        if (WEBHOOK_EDIT_MESSAGE && webhookMessageId)
                            await patchWebhookMessage(WEBHOOK_URL, webhookMessageId, embed);
                        else
                            await postWebhookMessage(WEBHOOK_URL, embed);
                    } catch (e) {
                        logger.error("Failed to send webhook success embed:", e);
                    }
                })
                .catch(async (err: any) => {
                    logger.error(`Failed to redeem code ${code}:`, err);
                    const embed = makeFailureEmbed(code, message, err);
                    try {
                        if (WEBHOOK_EDIT_MESSAGE && webhookMessageId)
                            await patchWebhookMessage(WEBHOOK_URL, webhookMessageId, embed);
                        else
                            await postWebhookMessage(WEBHOOK_URL, embed);
                    } catch (e) {
                        logger.error("Failed to send webhook failure embed:", e);
                    }
                });
        }
    }
});
