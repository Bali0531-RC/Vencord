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
    description: "Quick support message commands (.psms, .loop, .transcript)",
    authors: [Devs.Vendicated],

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
                response = `## 📦 Parse Duration Fix

1. Open your \`package.json\` file
2. Find \`"parse-duration"\` and change the version to \`"1.1.2"\`
3. Delete the following:
   - \`node_modules\` folder
   - \`package-lock.json\` file
4. Run \`npm install\` again`;
            }
            else if (content === ".loop") {
                response = `## ⚙️ Loop/Secure Configuration

Please make sure to **disable Secure** in the config.

> **Note:** In case of PlexTickets, also make sure to have at least one role assigned to you that's set up as a **support role** for any of the ticket categories.`;
            }
            else if (content === ".transcript") {
                response = `## 🐛 Transcript Error Fix

This error is caused by the \`discord-html-transcripts\` npm package that was recently updated to version **3.3.0** and introduced a bug that breaks transcript generation.

You'll need to **downgrade to version 3.2.0** to fix this issue.

---

### 📁 If using Pterodactyl Panel / Shared Hosting / Web Panel:

1. Open your \`package.json\` file in the file manager
2. Find the line: \`"discord-html-transcripts": "^3.3.0"\`
3. Replace it with: \`"discord-html-transcripts": "3.2.0"\`
   - ⚠️ Make sure to **remove the \`^\` symbol**
4. Save the file
5. Delete the following:
   - \`node_modules\` folder
   - \`package-lock.json\` file
   - \`.npm\` folder (if it exists)
6. Restart your bot - it should automatically reinstall the correct version

---

### 💻 If using VPS / Dedicated Server / Command Line:

1. Stop your bot
2. Run: \`npm install discord-html-transcripts@3.2.0\`
3. Start your bot again`;
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
