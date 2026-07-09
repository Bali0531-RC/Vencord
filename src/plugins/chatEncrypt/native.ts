/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IpcMainInvokeEvent } from "electron";

// only allow fetching from discord's own CDN, don't want this to become an open proxy
const DISCORD_CDN = /^https:\/\/(?:cdn|media)\.discordapp\.(?:com|net)\/attachments\/\d+\/\d+\//;

export async function fetchEncryptedAttachment(_: IpcMainInvokeEvent, url: string) {
    if (!DISCORD_CDN.test(url)) {
        throw new Error("Refusing to fetch non-Discord attachment URL.");
    }

    const resp = await fetch(url);
    const text = await resp.text().catch(() => "");

    if (!resp.ok)
        throw new Error(`Fetch failed (${resp.status}): ${text || resp.statusText}`);

    return text;
}
