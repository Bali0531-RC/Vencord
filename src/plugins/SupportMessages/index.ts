/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Devs } from "@utils/constants";
import { sendMessage } from "@utils/discord";
import definePlugin from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { UserStore } from "@webpack/common";

const MessageActions = findByPropsLazy("deleteMessage", "startEditMessage");

export default definePlugin({
    name: "SupportMessages",
    description: "Quick support message commands (.psms, .loop, .transcript, .mongowhitelist, .categories)",
    authors: [Devs.bali0531],

    flux: {
        async MESSAGE_CREATE({ message, optimistic }: { message: any; optimistic: boolean; }) {
            if (optimistic) return;

            // Only trigger for messages from yourself
            const currentUser = UserStore.getCurrentUser();
            if (!currentUser || message.author.id !== currentUser.id) return;

            const content = message.content?.toLowerCase()?.trim();
            const channelId = message.channel_id;
            const messageId = message.id;

            let response: string | null = null;

            if (content === ".psms") {
                response = `## Parse Duration Fix

The \`parse-duration\` package needs to be pinned to version **1.1.2** to avoid compatibility issues.

**Steps:**
1. Open your \`package.json\` file.
2. Locate \`"parse-duration"\` and change its version to \`"1.1.2"\`.
3. Delete the \`node_modules\` folder and the \`package-lock.json\` file.
4. Run \`npm install\` to reinstall dependencies.`;
            }
            else if (content === ".loop") {
                response = `## Loop / Secure Configuration

Make sure **Secure** is set to **false** in your config file.

If you are using **PlexTickets**, you must also have at least one role assigned to you that is configured as a **support role** for one of the ticket categories. Without this, the bot will not recognise you as a staff member.`;
            }
            else if (content === ".transcript") {
                response = `## Transcript Generation Error

The \`discord-html-transcripts\` package version **3.3.0** introduced a breaking change. You need to downgrade to version **3.2.0**.

### Pterodactyl Panel / Shared Hosting / Web Panel
1. Open \`package.json\` in your file manager.
2. Find: \`"discord-html-transcripts": "^3.3.0"\`
3. Replace with: \`"discord-html-transcripts": "3.2.0"\` — make sure to remove the \`^\` prefix.
4. Save the file.
5. Delete \`node_modules\`, \`package-lock.json\`, and \`.npm\` (if present).
6. Restart the bot — dependencies will reinstall automatically.

### VPS / Dedicated Server / Command Line
1. Stop your bot.
2. Run: \`npm install discord-html-transcripts@3.2.0\`
3. Start your bot.`;
            }
            else if (content === ".mongowhitelist") {
                response = `## MongoDB Atlas — IP Whitelist

Your bot cannot connect to MongoDB because your current IP address is not whitelisted. The easiest solution is to allow access from **all IPs**.

**Steps:**
1. Go to [MongoDB Atlas](https://cloud.mongodb.com/) and open your project.
2. Navigate to **Network Access** (under *Security* in the sidebar).
3. Click **Add IP Address**.
4. Enter \`0.0.0.0/0\` to allow connections from any IP.
5. Confirm and wait for the changes to take effect.

**Video walkthrough:** https://repo.arch-linux.fun/vv9rubxc.webm`;
            }
            else if (content === ".categories") {
                response = `## Categories & Panels

Both are configured in your \`config.yml\` file.

**Categories** (\`TicketCategories\`) define the types of tickets users can open. Each category has its own settings like support roles, the Discord parent category ID where tickets are created, embed messages, button colors, and optional questions.

Example:
\`\`\`yaml
TicketCategories:
  TicketCategory1:
    CategoryName: "General Support"
    ParentCategoryID: "731044694590750821"
    SupportRoles: ["731044651078910012"]
\`\`\`

**Panels** (\`TicketPanels\`) are the embed messages with buttons that users click to open a ticket. Each panel references one or more categories by their **config ID** (e.g. \`TicketCategory1\`), **not** by the Discord category ID.

Example:
\`\`\`yaml
TicketPanels:
  Panel1:
    Name: "Support Panel"
    Categories: ["TicketCategory1", "TicketCategory3"]
\`\`\`

After configuring, use the \`/panel\` command with the panel ID to send it to a channel.

**Common mistake:** Using a Discord category ID (e.g. \`"731044694590750821"\`) in the panel's \`Categories\` list instead of the config category name (e.g. \`"TicketCategory1"\`). The \`Categories\` field must reference the names you defined under \`TicketCategories\` in your config, not Discord IDs.

Full documentation: https://docs.plexdevelopment.net/plex-tickets/categories-and-panels`;
            }

            if (response) {
                try {
                    // Delete the trigger message
                    MessageActions.deleteMessage(channelId, messageId);

                    // Send the formatted response
                    sendMessage(channelId, { content: response });
                } catch (error) {
                    console.error("[SupportMessages] Error:", error);
                }
            }
        }
    }
});
