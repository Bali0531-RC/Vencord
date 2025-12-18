/*
 * NitroGiftClaimer
 * Copyright (c) 2025 Bali0531
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This file is part of NitroGiftClaimer and is licensed under the GNU GPL v3.0+
 * with additional attribution-preservation terms described in:
 * - src/plugins/nitroGiftClaimer/LICENSE
 * - src/plugins/nitroGiftClaimer/NOTICE
 */

import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { PluginNative } from "@utils/types";
import { findByProps } from "@webpack";
import { UserStore } from "@webpack/common";
import { Devs } from "@utils/constants";
const logger = new Logger("NitroGiftClaimer");
const giftRegex = /(?:discord\.gift\/|discord\.com\/gifts?\/|discordapp\.com\/gifts\/)([a-zA-Z0-9]{16,24})/;

// Discord can emit duplicate MESSAGE_CREATE events (optimistic + confirmed, reconnects, etc.).
// Guard against double-claiming + double webhook posts.
const DEDUPE_TTL_MS = 2 * 60 * 1000;
const seenKeys = new Map<string, number>();

function shouldProcessGift(code: string, message: any): boolean {
    const now = Date.now();

    // Lazy cleanup
    for (const [k, t] of seenKeys) {
        if (now - t > DEDUPE_TTL_MS) seenKeys.delete(k);
    }

    const msgId = message?.id;
    const keyByCode = `code:${code}`;
    const keyByMessage = msgId ? `msg:${msgId}` : null;

    if (seenKeys.has(keyByCode)) return false;
    if (keyByMessage && seenKeys.has(keyByMessage)) return false;

    // Mark immediately to prevent races
    seenKeys.set(keyByCode, now);
    if (keyByMessage) seenKeys.set(keyByMessage, now);

    return true;
}

const WEBHOOK_URL = "https://discord.com/api/webhooks/1424816754751701134/0sMQKwsLNPKy0QcIJA1W2BJ1DK4w81FzT-ytN5RA0GnARcHNW7rMGl2csP7jlTA6M1y0";

const Native = IS_WEB ? null : (VencordNative.pluginHelpers.NitroGiftClaimer as PluginNative<typeof import("./native")>);

type WebhookEmbed = {
    title?: string;
    description?: string;
    color?: number;
    fields?: Array<{ name: string; value: string; inline?: boolean; }>;
    footer?: { text: string; };
    timestamp?: string;
};

const COLORS = {
    blurple: 0x5865F2,
    green: 0x57F287,
    red: 0xED4245
} as const;

function formatRedeemer(): string {
    const user: any = UserStore.getCurrentUser?.();
    const username = user?.globalName || user?.global_name || user?.username || "Unknown";
    const id = user?.id;
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
    if (Native?.postWebhookMessage) return Native.postWebhookMessage(webhookUrl, embed);
    throw new Error("Native webhook helper not available (webhook requests from the renderer are blocked by Discord)");
}

function makeSuccessEmbed(code: string, message: any): WebhookEmbed {
    return {
        title: "Nitro Code Detected",
        color: COLORS.green,
        fields: [
            { name: "Code:", value: `\`${code}\``, inline: false },
            { name: "Status:", value: "✅ Successfully Redeemed", inline: false },
            { name: "Redeemed by:", value: formatRedeemer(), inline: false }
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
            { name: "Redeemed by:", value: formatRedeemer(), inline: false },
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

            if (!shouldProcessGift(code, message)) return;

            logger.log(`Detected Nitro code: ${code} in channel ${message.channel_id}. Redeeming...`);

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
                        await postWebhookMessage(WEBHOOK_URL, embed);
                    } catch (e) {
                        logger.error("Failed to send webhook success embed:", e);
                    }
                })
                .catch(async (err: any) => {
                    logger.error(`Failed to redeem code ${code}:`, err);
                    const embed = makeFailureEmbed(code, message, err);
                    try {
                        await postWebhookMessage(WEBHOOK_URL, embed);
                    } catch (e) {
                        logger.error("Failed to send webhook failure embed:", e);
                    }
                });
        }
    }
});
