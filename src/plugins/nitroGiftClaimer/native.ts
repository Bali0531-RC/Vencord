/*
 * NitroGiftClaimer
 * Copyright (c) 2025 Bali0531
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IpcMainInvokeEvent } from "electron";

type WebhookEmbed = {
    title?: string;
    description?: string;
    color?: number;
    fields?: Array<{ name: string; value: string; inline?: boolean; }>;
    footer?: { text: string; };
    timestamp?: string;
};

export async function postWebhookMessage(_: IpcMainInvokeEvent, webhookUrl: string, embed: WebhookEmbed): Promise<string | null> {
    const res = await fetch(`${webhookUrl}?wait=true`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embeds: [embed] })
    });

    const text = await res.text().catch(() => "");
    if (!res.ok) throw new Error(`Webhook POST failed (${res.status}): ${text || res.statusText}`);

    const json = (() => {
        try { return JSON.parse(text); } catch { return null; }
    })();

    return json?.id ?? null;
}

export async function patchWebhookMessage(_: IpcMainInvokeEvent, webhookUrl: string, messageId: string, embed: WebhookEmbed): Promise<void> {
    const res = await fetch(`${webhookUrl}/messages/${messageId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embeds: [embed] })
    });

    const text = await res.text().catch(() => "");
    if (!res.ok) throw new Error(`Webhook PATCH failed (${res.status}): ${text || res.statusText}`);
}
