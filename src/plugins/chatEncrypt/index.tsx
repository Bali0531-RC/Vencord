/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { addMessagePreSendListener, MessageObject, MessageSendListener, removeMessagePreSendListener, SendMessageOptions } from "@api/MessageEvents";
import { updateMessage } from "@api/MessageUpdater";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { IconComponent, OptionType } from "@utils/types";
import type { Message } from "@vencord/discord-types";
import { React, showToast, Toasts, useEffect, useState } from "@webpack/common";

const PROTOCOL = "vc-chat-encrypt";
const MARKER = "[ChatEncrypt encrypted message]";
const PREFIX = "ce:v1:";
const KEY_SALT = "Vencord ChatEncrypt v1";
const KEY_ITERATIONS = 150_000;
// discord msg limit is 2000, leave headroom for the marker line + newline
const MAX_INLINE_LEN = 1900;

type MsgPayload = { protocol: typeof PROTOCOL; version: 1; kind: "message"; content: string; createdAt: number; };

interface Envelope {
    protocol: typeof PROTOCOL;
    version: 1;
    alg: "AES-GCM";
    iv: string;
    data: string;
}

type DecryptState =
    | { status: "pending"; }
    | { status: "error"; error: string; }
    | { status: "done"; content: string; };

const settings = definePluginSettings({
    sharedSecret: {
        type: OptionType.STRING,
        description: "Shared secret used to encrypt and decrypt messages. Everyone who should read the message needs the same value.",
        default: "ChatEncrypt-global-v1-sharedkey",
        placeholder: "Enter a shared secret"
    },
    persistState: {
        type: OptionType.BOOLEAN,
        description: "Keep the encryption toggle enabled when switching channels",
        default: false,
        onChange(value: boolean) {
            if (!value) lastToggleState = false;
        }
    },
    autoDisable: {
        type: OptionType.BOOLEAN,
        description: "Disable the encryption toggle after sending one message",
        default: true
    },
});

const decryptCache = new Map<string, DecryptState>();

let activeToggle = false;
let lastToggleState = false;
let cachedSecret = "";
let cachedKey: CryptoKey | undefined;

const LockIcon: IconComponent = ({ height = 20, width = 20, className, children }) => (
    <svg aria-hidden="true" className={className} height={height} viewBox="0 0 24 24" width={width}>
        <path
            fill="currentColor"
            d="M17 9V7A5 5 0 0 0 7 7v2a3 3 0 0 0-3 3v6a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-6a3 3 0 0 0-3-3Zm-8 0V7a3 3 0 0 1 6 0v2H9Zm4 7.73V18a1 1 0 1 1-2 0v-1.27a2 2 0 1 1 2 0Z"
        />
        {children}
    </svg>
);

const LockDisabledIcon: IconComponent = props => (
    <LockIcon {...props}>
        <path d="M4 20 20 4" stroke="var(--status-danger)" strokeLinecap="round" strokeWidth="2.6" />
    </LockIcon>
);

// String.fromCharCode blows the call stack on large buffers without chunking
function toBase64(bytes: Uint8Array) {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
}

function fromBase64(str: string) {
    const raw = atob(str);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
}

async function deriveKey() {
    const secret = settings.store.sharedSecret.trim();
    if (!secret) throw new Error("Set a shared secret in ChatEncrypt settings first.");
    if (cachedKey && cachedSecret === secret) return cachedKey;

    const enc = new TextEncoder();
    const base = await crypto.subtle.importKey("raw", enc.encode(secret), "PBKDF2", false, ["deriveKey"]);
    cachedKey = await crypto.subtle.deriveKey(
        { name: "PBKDF2", hash: "SHA-256", salt: enc.encode(KEY_SALT), iterations: KEY_ITERATIONS },
        base,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
    );
    cachedSecret = secret;
    return cachedKey;
}

async function encrypt(payload: MsgPayload) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await deriveKey(), plaintext);

    const envelope: Envelope = {
        protocol: PROTOCOL,
        version: 1,
        alg: "AES-GCM",
        iv: toBase64(iv),
        data: toBase64(new Uint8Array(ciphertext))
    };
    return PREFIX + toBase64(new TextEncoder().encode(JSON.stringify(envelope)));
}

async function decrypt(raw: string): Promise<MsgPayload> {
    const b64 = raw.trim().startsWith(PREFIX) ? raw.trim().slice(PREFIX.length) : raw.trim();
    const envelope: Envelope = JSON.parse(new TextDecoder().decode(fromBase64(b64)));

    if (envelope.protocol !== PROTOCOL || envelope.version !== 1 || envelope.alg !== "AES-GCM")
        throw new Error("Unsupported envelope format");

    const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromBase64(envelope.iv) },
        await deriveKey(),
        fromBase64(envelope.data)
    );
    const result = JSON.parse(new TextDecoder().decode(plaintext)) as MsgPayload;
    if (result.protocol !== PROTOCOL || result.kind !== "message")
        throw new Error("Decrypted payload isn't a valid ChatEncrypt message");
    return result;
}

function findPayloadInContent(content: string) {
    // the encrypted blob might be surrounded by other text, find the ce:v1: part
    return content.split(/\s+/).find(part => part.startsWith(PREFIX)) ?? null;
}

function looksEncrypted(msg: Message) {
    return decryptCache.has(msg.id)
        || msg.content?.startsWith(MARKER)
        || !!findPayloadInContent(msg.content ?? "");
}

async function tryDecrypt(message: Message) {
    decryptCache.set(message.id, { status: "pending" });

    try {
        const blob = findPayloadInContent(message.content);
        if (!blob) throw new Error("No encrypted payload found");

        const result = await decrypt(blob);
        decryptCache.set(message.id, { status: "done", content: result.content });
        // swap the inline ciphertext for the marker so the raw blob isn't visible
        updateMessage(message.channel_id, message.id, { content: MARKER });
    } catch (e: any) {
        decryptCache.set(message.id, { status: "error", error: e?.message ?? String(e) });
        updateMessage(message.channel_id, message.id);
    }
}

function getDecryptState(message: Message) {
    const cached = decryptCache.get(message.id);
    if (cached) return cached;
    void tryDecrypt(message);
    return { status: "pending" } satisfies DecryptState;
}

const EncryptToggle: ChatBarButtonFactory = ({ isMainChat }) => {
    const [enabled, setEnabled] = useState(lastToggleState);

    function toggle(val: boolean) {
        activeToggle = val;
        if (settings.store.persistState) lastToggleState = val;
        setEnabled(val);
    }

    useEffect(() => {
        const listener: MessageSendListener = async (channelId, messageObj, _options, _props) => {
            if (!enabled || !messageObj.content) return;

            try {
                const payload = await encrypt({
                    protocol: PROTOCOL, version: 1, kind: "message",
                    content: messageObj.content, createdAt: Date.now()
                });
                const full = `${MARKER}\n${payload}`;
                if (full.length <= MAX_INLINE_LEN) {
                    messageObj.content = full;
                } else {
                    // TODO: fall back to attachment for huge messages
                    showToast("Message too long to encrypt inline", Toasts.Type.FAILURE);
                    return { cancel: true };
                }
            } catch (e: any) {
                showToast(`Encryption failed: ${e?.message ?? e}`, Toasts.Type.FAILURE);
                return { cancel: true };
            }

            if (settings.store.autoDisable) toggle(false);
        };

        addMessagePreSendListener(listener);
        return () => void removeMessagePreSendListener(listener);
    }, [enabled]);

    if (!isMainChat) return null;

    return (
        <ChatBarButton tooltip={enabled ? "Disable ChatEncrypt" : "Enable ChatEncrypt"} onClick={() => toggle(!enabled)}>
            {enabled ? <LockIcon /> : <LockDisabledIcon />}
        </ChatBarButton>
    );
};

export default definePlugin({
    name: "ChatEncrypt",
    description: "Encrypt messages with a shared secret so only people with the same key can read them.",
    tags: ["Chat", "Privacy", "Encryption"],
    authors: [Devs.bali0531],
    dependencies: ["ChatInputButtonAPI", "MessageAccessoriesAPI", "MessageEventsAPI", "MessageUpdaterAPI"],
    settings,

    chatBarButton: { icon: LockIcon, render: EncryptToggle },

    start() {
        // nothing yet, attachment support will need prototype patching
    },

    stop() {
        decryptCache.clear();
        cachedKey = undefined;
    },

    renderMessageAccessory(props) {
        const message = props.message as Message | undefined;
        if (!message || !looksEncrypted(message)) return null;

        const state = getDecryptState(message);

        if (state.status === "pending")
            return <div className="vc-ce-container"><div className="vc-ce-header">Decrypting...</div></div>;

        if (state.status === "error")
            return (
                <div className="vc-ce-container">
                    <div className="vc-ce-header vc-ce-error">Failed to decrypt</div>
                    <div className="vc-ce-content vc-ce-error">{state.error}</div>
                </div>
            );

        return (
            <div className="vc-ce-container">
                <div className="vc-ce-header">Decrypted message</div>
                <div className="vc-ce-content">
                    <div className="vc-ce-text">{state.content}</div>
                </div>
            </div>
        );
    },
});
