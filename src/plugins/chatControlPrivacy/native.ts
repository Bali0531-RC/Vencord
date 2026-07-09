/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IpcMainInvokeEvent } from "electron";

const discordAttachmentUrl = /^https:\/\/(?:cdn|media)\.discordapp\.(?:com|net)\/attachments\/\d+\/\d+\//;

export async function fetchEncryptedAttachment(_: IpcMainInvokeEvent, url: string) {
    if (!discordAttachmentUrl.test(url)) {
        throw new Error("Refusing to fetch non-Discord attachment URL.");
    }

    const response = await fetch(url);
    const text = await response.text().catch(() => "");

    if (!response.ok) {
        throw new Error(`Failed to fetch encrypted attachment (${response.status}): ${text || response.statusText}`);
    }

    return text;
}
