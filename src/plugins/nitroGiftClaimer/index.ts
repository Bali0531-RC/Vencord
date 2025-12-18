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
        MESSAGE_CREATE({ message }: any) {
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
            const GiftActions = findByProps("redeemGiftCode");
            if (!GiftActions) {
                logger.error("GiftActions module not found!");
                return;
            }
            GiftActions.redeemGiftCode({ code })
                .then(() => {
                    logger.log(`Successfully redeemed code: ${code}!`);
                })
                .catch((err: any) => {
                    logger.error(`Failed to redeem code ${code}:`, err);
                });
        }
    }
});
