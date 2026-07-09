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
import definePlugin, { IconComponent, OptionType, PluginNative } from "@utils/types";
import type { CloudUpload as TCloudUpload, Message } from "@vencord/discord-types";
import { CloudUploadPlatform } from "@vencord/discord-types/enums";
import { findLazy } from "@webpack";
import { DraftType, React, showToast, Toasts, UploadAttachmentStore, useEffect, useState } from "@webpack/common";

const PROTOCOL = "vc-chat-encrypt";
const MARKER = "[ChatEncrypt encrypted message]";
const EXT = ".ce";
const PREFIX = "ce:v1:";
const KEY_SALT = "Vencord ChatEncrypt v1";
const KEY_ITERATIONS = 150_000;
// discord msg limit is 2000, leave headroom for the marker line + newline
const MAX_INLINE_LEN = 1900;
const DEFAULT_MAX_FILE_MIB = 8;
const ENCRYPTED_UPLOAD = Symbol("ChatEncryptUpload");

const Native = IS_WEB ? null : VencordNative.pluginHelpers.ChatEncrypt as PluginNative<typeof import("./native")>;
const CloudUpload: typeof TCloudUpload = findLazy(m => m.prototype?.trackUploadFinished);

type Payload =
    | { protocol: typeof PROTOCOL; version: 1; kind: "message"; content: string; createdAt: number; }
    | { protocol: typeof PROTOCOL; version: 1; kind: "attachment"; filename: string; contentType: string; data: string; };

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
    | { status: "done"; content: string; attachments: { filename: string; contentType: string; url: string; size: number; }[]; };

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
    hideEncryptedAttachments: {
        type: OptionType.BOOLEAN,
        description: "Hide encrypted attachment payloads after rendering decrypted content",
        default: true
    },
    maxAttachmentSizeMiB: {
        type: OptionType.NUMBER,
        description: "Maximum attachment size to encrypt/decrypt in MiB",
        default: DEFAULT_MAX_FILE_MIB
    }
});

const decryptCache = new Map<string, DecryptState>();
const blobUrls = new Set<string>();

let activeToggle = false;
let lastToggleState = false;
let originalUpload: TCloudUpload["upload"] | undefined;
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

async function encryptPayload(payload: Payload) {
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

async function decryptPayload(raw: string): Promise<Payload> {
    const b64 = raw.trim().startsWith(PREFIX) ? raw.trim().slice(PREFIX.length) : raw.trim();
    const envelope: Envelope = JSON.parse(new TextDecoder().decode(fromBase64(b64)));

    if (envelope.protocol !== PROTOCOL || envelope.version !== 1 || envelope.alg !== "AES-GCM")
        throw new Error("Unsupported envelope format");

    const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromBase64(envelope.iv) },
        await deriveKey(),
        fromBase64(envelope.data)
    );
    const result = JSON.parse(new TextDecoder().decode(plaintext)) as Payload;
    // sanity checks - without these a tampered ciphertext could slip through as valid
    if (result.protocol !== PROTOCOL || result.version !== 1) throw new Error("Invalid payload");
    if (result.kind === "message" && typeof result.content !== "string") throw new Error("Malformed message payload");
    if (result.kind === "attachment" && (!result.filename || !result.data)) throw new Error("Malformed attachment payload");
    return result;
}

function maxFileBytes() {
    return Math.max(1, Number(settings.store.maxAttachmentSizeMiB) || DEFAULT_MAX_FILE_MIB) * 1024 * 1024;
}

function findPayloadInContent(content: string) {
    return content.split(/\s+/).find(part => part.startsWith(PREFIX)) ?? null;
}

function isEncryptedFile(att: { filename?: string; content_type?: string; }) {
    return att.filename?.endsWith(EXT) || att.content_type === "application/octet-stream+ce";
}

function looksEncrypted(msg: Message) {
    return decryptCache.has(msg.id)
        || msg.content?.startsWith(MARKER)
        || !!findPayloadInContent(msg.content ?? "")
        || msg.attachments?.some(isEncryptedFile);
}

interface UploadOptions { attachmentsToUpload?: TCloudUpload[]; }
interface EncryptedCloudUpload extends TCloudUpload { [ENCRYPTED_UPLOAD]?: true; }

function getUploads(channelId: string, opts: UploadOptions) {
    return opts.attachmentsToUpload?.length
        ? opts.attachmentsToUpload
        : UploadAttachmentStore.getUploads(channelId, DraftType.ChannelMessage);
}

function isAlreadyEncrypted(upload: TCloudUpload) {
    return (upload as EncryptedCloudUpload)[ENCRYPTED_UPLOAD]
        || upload.filename.endsWith(EXT)
        || upload.item.file.name.endsWith(EXT);
}

async function encryptOneUpload(upload: TCloudUpload) {
    if (isAlreadyEncrypted(upload)) return;
    if (upload.status !== "NOT_STARTED") throw new Error(`${upload.filename} already started uploading`);

    const { file } = upload.item;
    if (file.size > maxFileBytes()) throw new Error(`${upload.filename || file.name} exceeds size limit`);

    const payload: Payload = {
        protocol: PROTOCOL,
        version: 1,
        kind: "attachment",
        filename: upload.filename || file.name || "attachment",
        contentType: file.type || upload.mimeType || "application/octet-stream",
        data: toBase64(new Uint8Array(await file.arrayBuffer()))
    };

    const encrypted = await encryptPayload(payload);
    const outFile = new File([encrypted], `${payload.filename}${EXT}`, { type: "application/octet-stream+ce" });

    // overwrite the upload fields so discord sends the encrypted blob instead
    upload.item.file = outFile;
    upload.filename = outFile.name;
    upload.mimeType = outFile.type;
    upload.isImage = false;
    upload.isVideo = false;
    upload.currentSize = outFile.size;
    upload.preCompressionSize = outFile.size;
    upload.postCompressionSize = outFile.size;
    (upload as EncryptedCloudUpload)[ENCRYPTED_UPLOAD] = true;
}

function makeUploadFromPayload(channelId: string, filename: string, payload: string) {
    const file = new File([payload], `${filename}${EXT}`, { type: "application/octet-stream+ce" });
    const upload = new CloudUpload({ file, isThumbnail: false, platform: CloudUploadPlatform.WEB }, channelId) as EncryptedCloudUpload;
    upload[ENCRYPTED_UPLOAD] = true;
    return upload;
}

async function fetchAttachmentContent(url: string) {
    if (Native) return await Native.fetchEncryptedAttachment(url);
    // can't fetch from discord CDN in browser context due to CORS
    throw new Error("Attachment decryption needs the desktop client (CORS).");
}

async function tryDecrypt(message: Message) {
    decryptCache.set(message.id, { status: "pending" });

    try {
        const inlineBlob = findPayloadInContent(message.content);
        const results = await Promise.all([
            ...(inlineBlob ? [decryptPayload(inlineBlob)] : []),
            ...message.attachments
                .filter(isEncryptedFile)
                .map(async att => decryptPayload(await fetchAttachmentContent(att.url || att.proxy_url)))
        ]);

        let content = "";
        const attachments: { filename: string; contentType: string; url: string; size: number; }[] = [];

        for (const p of results) {
            if (p.kind === "message") {
                content = p.content;
                continue;
            }
            const bytes = fromBase64(p.data);
            if (bytes.byteLength > maxFileBytes()) throw new Error(`${p.filename} too large`);

            const blob = new Blob([bytes], { type: p.contentType });
            const url = URL.createObjectURL(blob);
            blobUrls.add(url);
            attachments.push({ filename: p.filename, contentType: p.contentType, url, size: bytes.byteLength });
        }

        decryptCache.set(message.id, { status: "done", content, attachments });
        if (inlineBlob) return updateMessage(message.channel_id, message.id, { content: MARKER });
    } catch (e: any) {
        decryptCache.set(message.id, { status: "error", error: e?.message ?? String(e) });
    }

    updateMessage(message.channel_id, message.id);
}

function getDecryptState(message: Message) {
    const cached = decryptCache.get(message.id);
    if (cached) return cached;
    void tryDecrypt(message);
    return { status: "pending" } satisfies DecryptState;
}

function renderFile(att: { filename: string; contentType: string; url: string; }) {
    if (att.contentType.startsWith("image/"))
        return <img className="vc-ce-media" src={att.url} alt={att.filename} />;
    if (att.contentType.startsWith("video/"))
        return <video className="vc-ce-media" src={att.url} controls />;
    if (att.contentType.startsWith("audio/"))
        return <audio className="vc-ce-media" src={att.url} controls />;
    return <a className="vc-ce-file" href={att.url} download={att.filename}>{att.filename}</a>;
}

async function encryptOutgoing(channelId: string, messageObj: MessageObject, options: SendMessageOptions, hasAttachments: boolean) {
    const uploadOpts = options as SendMessageOptions & UploadOptions;
    const uploads = [...getUploads(channelId, uploadOpts)];
    if (hasAttachments && !uploads.length) return { cancel: true };
    if (!messageObj.content && !uploads.length) return { cancel: true };

    try {
        await Promise.all(uploads.map(encryptOneUpload));

        if (messageObj.content) {
            const payload = await encryptPayload({
                protocol: PROTOCOL, version: 1, kind: "message",
                content: messageObj.content, createdAt: Date.now()
            });
            const inline = `${MARKER}\n${payload}`;
            if (inline.length <= MAX_INLINE_LEN) {
                messageObj.content = inline;
            } else {
                // message too long for inline, shove it in an attachment
                uploadOpts.attachmentsToUpload = [...uploads, makeUploadFromPayload(channelId, "message.txt", payload)];
                messageObj.content = MARKER;
            }
        } else {
            messageObj.content = MARKER;
        }
    } catch (e: any) {
        showToast(`Encryption failed: ${e?.message ?? e}`, Toasts.Type.FAILURE);
        return { cancel: true };
    }
}

const EncryptToggle: ChatBarButtonFactory = ({ isMainChat }) => {
    const [enabled, setEnabled] = useState(lastToggleState);

    function toggle(val: boolean) {
        activeToggle = val;
        if (settings.store.persistState) lastToggleState = val;
        setEnabled(val);
    }

    useEffect(() => {
        const listener: MessageSendListener = async (channelId, messageObj, options, props) => {
            if (!enabled) return;
            const result = await encryptOutgoing(channelId, messageObj, options, props.hasAttachments);
            if (!result?.cancel && settings.store.autoDisable) toggle(false);
            return result;
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
    description: "Encrypt opt-in messages and attachments with a shared secret. Everyone who should read a message needs the same secret.",
    tags: ["Chat", "Privacy"],
    authors: [Devs.bali0531],
    dependencies: ["ChatInputButtonAPI", "MessageAccessoriesAPI", "MessageEventsAPI", "MessageUpdaterAPI"],
    settings,

    patches: [
        {
            find: "async uploadFiles(",
            replacement: { match: /async uploadFiles\((\i)\){/, replace: "$&await Promise.all($1.map($self.encryptUpload));" }
        },
        {
            find: "this.renderAttachments(",
            replacement: { match: /(?<=\i=)this\.renderAttachments\((\i)\)/g, replace: "$self.shouldHideAttachments($1)?null:$&" }
        }
    ],

    chatBarButton: { icon: LockIcon, render: EncryptToggle },

    start() {
        if (originalUpload) return;
        originalUpload = CloudUpload.prototype.upload;
        // patch the upload prototype so even drag-and-drop gets caught
        CloudUpload.prototype.upload = async function (this: TCloudUpload) {
            if (activeToggle) await encryptOneUpload(this);
            return originalUpload!.call(this);
        };
    },

    stop() {
        if (originalUpload) {
            CloudUpload.prototype.upload = originalUpload;
            originalUpload = undefined;
        }
        decryptCache.clear();
        for (const url of blobUrls) URL.revokeObjectURL(url);
        blobUrls.clear();
        cachedKey = undefined;
    },

    async encryptUpload(upload: TCloudUpload) {
        if (activeToggle) await encryptOneUpload(upload);
    },

    renderMessageAccessory(props) {
        const message = props.message as Message | undefined;
        if (!message || !looksEncrypted(message)) return null;
        const state = getDecryptState(message);

        if (state.status === "pending")
            return <div className="vc-ce-container"><div className="vc-ce-header">Decrypting...</div></div>;
        if (state.status === "error")
            return <div className="vc-ce-container"><div className="vc-ce-header vc-ce-error">Failed to decrypt</div><div className="vc-ce-content vc-ce-error">{state.error}</div></div>;

        return (
            <div className="vc-ce-container">
                <div className="vc-ce-header">Decrypted message</div>
                <div className="vc-ce-content">
                    {state.content && <div className="vc-ce-text">{state.content}</div>}
                    {!!state.attachments.length && (
                        <div className="vc-ce-media-grid">
                            {state.attachments.map(att => <div key={att.url}>{renderFile(att)}</div>)}
                        </div>
                    )}
                </div>
            </div>
        );
    },

    shouldHideAttachments(message: Message | undefined) {
        return !!message && settings.store.hideEncryptedAttachments && message.attachments?.some(isEncryptedFile);
    }
});
