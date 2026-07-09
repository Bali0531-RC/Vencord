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
import * as openpgp from "openpgp";

const MARKER = "[ChatControlPrivacy encrypted message]";
const PROTOCOL = "vc-chat-control-privacy";
const EXT = ".cc1.pgp";
const ENCRYPTED_UPLOAD = Symbol("ChatControlPrivacyEncryptedUpload");
const DEFAULT_MAX_ATTACHMENT_SIZE_MIB = 8;
const Native = IS_WEB ? null : VencordNative.pluginHelpers.ChatControlPrivacy as PluginNative<typeof import("./native")>;
const CloudUpload: typeof TCloudUpload = findLazy(m => m.prototype?.trackUploadFinished);
const DEFAULT_PUBLIC_KEY = `-----BEGIN PGP PUBLIC KEY BLOCK-----

mDMEak+tshYJKwYBBAHaRw8BAQdAIqjCjPO61am+j4pNjbLa2aQFcu/IvwSDRZWi
OWUJHIO0QkNoYXRDb250cm9sUHJpdmFjeSBTaGFyZWQgS2V5IDxjaGF0Y29udHJv
bHByaXZhY3lAZXhhbXBsZS5pbnZhbGlkPoiQBBMWCgA4FiEEF4If0SyiH1KqCphT
ozZ1AygldcoFAmpPrbICGwMFCwkIBwIGFQoJCAsCBBYCAwECHgECF4AACgkQozZ1
Aygldcot7AEA+HPbCIoBzQEFeMuNCoMsj2tTPRG8ERl5PSZco+9xkqEBAOOjzmGs
rk/FxUcIZFeTbbEBiLqcw/WiS2FM1Q7M084HuDgEak+tshIKKwYBBAGXVQEFAQEH
QHpPQTS5vQiO6oTQMJ9uEuZHvAubHiEIW1iarj+EaLdrAwEIB4h4BBgWCgAgFiEE
F4If0SyiH1KqCphTozZ1AygldcoFAmpPrbICGwwACgkQozZ1AygldcqHCQEAsYN6
kHotFumtfM0iWB34RLTKRqjc7fTo83hyOWqlnbEBAKPILAQsna8Uw5f3HdBpI+db
S84lkPcnIJpDH8L85F4C
=dw3R
-----END PGP PUBLIC KEY BLOCK-----`;
const DEFAULT_PRIVATE_KEY = `-----BEGIN PGP PRIVATE KEY BLOCK-----

lFgEak+tshYJKwYBBAHaRw8BAQdAIqjCjPO61am+j4pNjbLa2aQFcu/IvwSDRZWi
OWUJHIMAAQDK/21B4gJ9gZ04fD1HfciVI02HWhKnOqt8UgeExEhxlA5itEJDaGF0
Q29udHJvbFByaXZhY3kgU2hhcmVkIEtleSA8Y2hhdGNvbnRyb2xwcml2YWN5QGV4
YW1wbGUuaW52YWxpZD6IkAQTFgoAOBYhBBeCH9Esoh9SqgqYU6M2dQMoJXXKBQJq
T62yAhsDBQsJCAcCBhUKCQgLAgQWAgMBAh4BAheAAAoJEKM2dQMoJXXKLewBAPhz
2wiKAc0BBXjLjQqDLI9rUz0RvBEZeT0mXKPvcZKhAQDjo85hrK5PxcVHCGRXk22x
AYi6nMP1okthTNUOzNPOB5xdBGpPrbISCisGAQQBl1UBBQEBB0B6T0E0ub0IjuqE
0DCfbhLmR7wLmx4hCFtYmq4/hGi3awMBCAcAAP9YX90LPfVLQ17kpgA3jLgWhFJg
H7pePwOVAlgkvQSkYA1eiHgEGBYKACAWIQQXgh/RLKIfUqoKmFOjNnUDKCV1ygUC
ak+tsgIbDAAKCRCjNnUDKCV1yocJAQCxg3qQei0W6a18zSJYHfhEtMpGqNzt9Ojz
eHI5aqWdsQEAo8gsBCydrxTDl/cd0Gkj51tLziWQ9ycgmkMfwvzkXgI=
=b+Z6
-----END PGP PRIVATE KEY BLOCK-----`;

const PGP_MESSAGE_RE = /-----BEGIN PGP MESSAGE-----[\s\S]+?-----END PGP MESSAGE-----/;

interface EncryptedTextPayload {
    protocol: typeof PROTOCOL;
    version: 1;
    kind: "message";
    content: string;
    createdAt: number;
}

interface EncryptedAttachmentPayload {
    protocol: typeof PROTOCOL;
    version: 1;
    kind: "attachment";
    filename: string;
    contentType: string;
    data: string;
}

type EncryptedPayload = EncryptedTextPayload | EncryptedAttachmentPayload;

interface DecryptedAttachment {
    filename: string;
    contentType: string;
    url: string;
    size: number;
}

type DecryptState =
    | { status: "pending"; }
    | { status: "error"; error: string; }
    | { status: "done"; content: string; attachments: DecryptedAttachment[]; };

interface UploadOptions {
    attachmentsToUpload?: TCloudUpload[];
}

interface EncryptedCloudUpload extends TCloudUpload {
    [ENCRYPTED_UPLOAD]?: true;
}

const decryptCache = new Map<string, DecryptState>();
const blobUrls = new Set<string>();

let activeToggleState = false;
let lastToggleState = false;
let cachedPublicKeyInput = "";
let cachedPrivateKeyInput = "";
let cachedPassphrase = "";
let cachedPublicKey: any;
let cachedPrivateKey: any;
let originalUpload: TCloudUpload["upload"] | undefined;

const settings = definePluginSettings({
    persistState: {
        type: OptionType.BOOLEAN,
        description: "Whether to keep the encryption toggle enabled when changing channels",
        default: false,
        onChange(newValue: boolean) {
            if (newValue === false) lastToggleState = false;
        }
    },
    autoDisable: {
        type: OptionType.BOOLEAN,
        description: "Automatically disable the encryption toggle after sending one message",
        default: true
    },
    publicKey: {
        type: OptionType.STRING,
        description: "Shared armored GPG/OpenPGP public key used for encrypting messages",
        default: DEFAULT_PUBLIC_KEY,
        multiline: true,
        placeholder: "-----BEGIN PGP PUBLIC KEY BLOCK-----"
    },
    privateKey: {
        type: OptionType.STRING,
        description: "Shared armored GPG/OpenPGP private key used for decrypting messages",
        default: DEFAULT_PRIVATE_KEY,
        multiline: true,
        placeholder: "-----BEGIN PGP PRIVATE KEY BLOCK-----"
    },
    passphrase: {
        type: OptionType.STRING,
        description: "Passphrase for the private key, if it is protected",
        default: ""
    },
    hideEncryptedAttachments: {
        type: OptionType.BOOLEAN,
        description: "Hide encrypted .cc1.pgp attachments after rendering decrypted content",
        default: true
    },
    maxAttachmentSizeMiB: {
        type: OptionType.NUMBER,
        description: "Maximum original attachment size to encrypt/decrypt in MiB. This avoids locking up the client on huge files.",
        default: DEFAULT_MAX_ATTACHMENT_SIZE_MIB
    }
});

const LockIcon: IconComponent = ({ height = 20, width = 20, className, children }) => (
    <svg
        aria-hidden="true"
        className={className}
        height={height}
        viewBox="0 0 24 24"
        width={width}
    >
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

async function getEncryptionKey() {
    if (!settings.store.publicKey.trim()) throw new Error("Missing public key in plugin settings.");

    if (cachedPublicKey && cachedPublicKeyInput === settings.store.publicKey) {
        return cachedPublicKey;
    }

    cachedPublicKeyInput = settings.store.publicKey;
    cachedPublicKey = await openpgp.readKey({ armoredKey: settings.store.publicKey });
    return cachedPublicKey;
}

async function getDecryptionKey() {
    if (!settings.store.privateKey.trim()) throw new Error("Missing private key in plugin settings.");

    if (
        cachedPrivateKey
        && cachedPrivateKeyInput === settings.store.privateKey
        && cachedPassphrase === settings.store.passphrase
    ) {
        return cachedPrivateKey;
    }

    const privateKey = await openpgp.readPrivateKey({ armoredKey: settings.store.privateKey });

    cachedPrivateKeyInput = settings.store.privateKey;
    cachedPassphrase = settings.store.passphrase;
    cachedPrivateKey = settings.store.passphrase
        ? await openpgp.decryptKey({ privateKey, passphrase: settings.store.passphrase })
        : privateKey;

    return cachedPrivateKey;
}

async function encryptPayload(payload: EncryptedPayload) {
    const message = await openpgp.createMessage({ text: JSON.stringify(payload) });

    return await openpgp.encrypt({
        message,
        encryptionKeys: await getEncryptionKey(),
        format: "armored"
    }) as string;
}

async function decryptPayload(armoredMessage: string): Promise<EncryptedPayload> {
    const message = await openpgp.readMessage({ armoredMessage: normalizeArmoredMessage(armoredMessage) });
    const { data } = await openpgp.decrypt({
        message,
        decryptionKeys: await getDecryptionKey(),
        format: "utf8"
    });

    const payload = JSON.parse(String(data));
    assertEncryptedPayload(payload);

    return payload;
}

function normalizeArmoredMessage(armoredMessage: string) {
    const block = PGP_MESSAGE_RE.exec(armoredMessage)?.[0] ?? armoredMessage;
    const lines = block
        .replace(/\r/g, "")
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .split("\n")
        .map(line => line.trim());
    const begin = lines.findIndex(line => line === "-----BEGIN PGP MESSAGE-----");
    const end = lines.findIndex(line => line === "-----END PGP MESSAGE-----");

    if (begin === -1 || end === -1 || end <= begin) {
        throw new Error("No armored PGP message found.");
    }

    const body = lines
        .slice(begin + 1, end)
        .filter(line => line && !line.includes(":"));

    return [
        "-----BEGIN PGP MESSAGE-----",
        "",
        ...body,
        "-----END PGP MESSAGE-----",
        ""
    ].join("\n");
}

function assertEncryptedPayload(payload: unknown): asserts payload is EncryptedPayload {
    if (!payload || typeof payload !== "object") throw new Error("Invalid encrypted payload.");

    const data = payload as Partial<EncryptedPayload>;
    if (data.protocol !== PROTOCOL || data.version !== 1) throw new Error("Unsupported encrypted payload.");

    if (data.kind === "message") {
        if (typeof data.content !== "string") throw new Error("Invalid encrypted text payload.");
        return;
    }

    if (data.kind === "attachment") {
        if (typeof data.filename !== "string") throw new Error("Invalid encrypted attachment filename.");
        if (typeof data.contentType !== "string") throw new Error("Invalid encrypted attachment content type.");
        if (typeof data.data !== "string") throw new Error("Invalid encrypted attachment data.");
        return;
    }

    throw new Error("Unknown encrypted payload kind.");
}

function getMaxAttachmentSizeBytes() {
    const maxMiB = Number(settings.store.maxAttachmentSizeMiB) || DEFAULT_MAX_ATTACHMENT_SIZE_MIB;
    return Math.max(1, maxMiB) * 1024 * 1024;
}

function getBase64DecodedSize(data: string) {
    const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
    return Math.floor(data.length * 3 / 4) - padding;
}

async function fetchEncryptedAttachmentText(url: string) {
    if (Native) return await Native.fetchEncryptedAttachment(url);

    throw new Error("Attachment decryption requires the desktop client because Discord's CDN blocks browser fetches.");
}

function toBase64(buffer: ArrayBuffer) {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;

    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }

    return btoa(binary);
}

function fromBase64(data: string) {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }

    return bytes;
}

function isEncryptedAttachment(attachment: { filename?: string; content_type?: string; }) {
    return attachment.filename?.endsWith(EXT) || attachment.content_type === "application/pgp-encrypted";
}

function isEncryptedMessage(message: Message) {
    return decryptCache.has(message.id)
        || message.content?.startsWith(MARKER)
        || PGP_MESSAGE_RE.test(message.content)
        || message.attachments?.some(isEncryptedAttachment);
}

function getDraftUploads(channelId: string, options: UploadOptions) {
    return options.attachmentsToUpload?.length
        ? options.attachmentsToUpload
        : UploadAttachmentStore.getUploads(channelId, DraftType.ChannelMessage);
}

function getInlineEncryptedPayload(content: string) {
    return PGP_MESSAGE_RE.exec(content)?.[0] ?? null;
}

function isUploadEncrypted(upload: TCloudUpload) {
    return (upload as EncryptedCloudUpload)[ENCRYPTED_UPLOAD]
        || upload.filename.endsWith(EXT)
        || upload.item.file.name.endsWith(EXT)
        || upload.mimeType === "application/pgp-encrypted";
}

function makeEncryptedUpload(channelId: string, filename: string, armored: string) {
    const encryptedFile = new File([armored], `${filename}${EXT}`, { type: "application/pgp-encrypted" });
    const upload = new CloudUpload({
        file: encryptedFile,
        isThumbnail: false,
        platform: CloudUploadPlatform.WEB,
    }, channelId) as EncryptedCloudUpload;

    upload[ENCRYPTED_UPLOAD] = true;
    return upload;
}

async function encryptUpload(upload: TCloudUpload) {
    if (isUploadEncrypted(upload)) return;
    if (upload.status !== "NOT_STARTED") {
        throw new Error(`${upload.filename} already started uploading. Remove and reattach it after enabling encryption.`);
    }

    const { item: { file } } = upload;
    if (file.size > getMaxAttachmentSizeBytes()) {
        throw new Error(`${upload.filename || file.name || "Attachment"} is larger than ${settings.store.maxAttachmentSizeMiB} MiB.`);
    }

    const payload: EncryptedAttachmentPayload = {
        protocol: PROTOCOL,
        version: 1,
        kind: "attachment",
        filename: upload.filename || file.name || "attachment",
        contentType: file.type || upload.mimeType || "application/octet-stream",
        data: toBase64(await file.arrayBuffer())
    };

    const encryptedFile = new File([await encryptPayload(payload)], `${payload.filename}${EXT}`, { type: "application/pgp-encrypted" });

    upload.item.file = encryptedFile;
    upload.filename = encryptedFile.name;
    upload.mimeType = encryptedFile.type;
    upload.isImage = false;
    upload.isVideo = false;
    upload.currentSize = encryptedFile.size;
    upload.preCompressionSize = encryptedFile.size;
    upload.postCompressionSize = encryptedFile.size;
    (upload as EncryptedCloudUpload)[ENCRYPTED_UPLOAD] = true;
}

async function decryptMessage(message: Message) {
    decryptCache.set(message.id, { status: "pending" });

    try {
        const inlineEncryptedPayload = getInlineEncryptedPayload(message.content);
        const inlinePayload = inlineEncryptedPayload ? [await decryptPayload(inlineEncryptedPayload)] : [];
        const decrypted = await Promise.all(
            message.attachments
                .filter(isEncryptedAttachment)
                .map(async attachment => {
                    const armored = await fetchEncryptedAttachmentText(attachment.url || attachment.proxy_url);
                    return decryptPayload(armored);
                })
        );

        let content = "";
        const attachments: DecryptedAttachment[] = [];

        for (const payload of [...inlinePayload, ...decrypted]) {
            if (payload.kind === "message") {
                content = payload.content;
                continue;
            }

            const decodedSize = getBase64DecodedSize(payload.data);
            if (decodedSize > getMaxAttachmentSizeBytes()) {
                throw new Error(`${payload.filename} is larger than ${settings.store.maxAttachmentSizeMiB} MiB.`);
            }

            const bytes = fromBase64(payload.data);
            const blob = new Blob([bytes], { type: payload.contentType });
            const url = URL.createObjectURL(blob);
            blobUrls.add(url);

            attachments.push({
                filename: payload.filename,
                contentType: payload.contentType,
                url,
                size: bytes.byteLength
            });
        }

        decryptCache.set(message.id, { status: "done", content, attachments });

        if (inlineEncryptedPayload) {
            updateMessage(message.channel_id, message.id, { content: MARKER });
            return;
        }
    } catch (e) {
        decryptCache.set(message.id, {
            status: "error",
            error: e instanceof Error ? e.message : String(e)
        });
    }

    updateMessage(message.channel_id, message.id);
}

function getState(message: Message) {
    const state = decryptCache.get(message.id);
    if (state) return state;

    void decryptMessage(message);
    return { status: "pending" } satisfies DecryptState;
}

function renderAttachment(attachment: DecryptedAttachment) {
    if (attachment.contentType.startsWith("image/")) {
        return <img className="vc-ccp-media" src={attachment.url} alt={attachment.filename} />;
    }

    if (attachment.contentType.startsWith("video/")) {
        return <video className="vc-ccp-media" src={attachment.url} controls />;
    }

    if (attachment.contentType.startsWith("audio/")) {
        return <audio className="vc-ccp-media" src={attachment.url} controls />;
    }

    return (
        <a className="vc-ccp-file" href={attachment.url} download={attachment.filename}>
            {attachment.filename} ({Math.ceil(attachment.size / 1024)} KiB)
        </a>
    );
}

async function encryptOutgoingMessage(channelId: string, messageObj: MessageObject, options: SendMessageOptions, hasAttachments: boolean) {
    const uploadOptions = options as SendMessageOptions & UploadOptions;
    const uploads = [...getDraftUploads(channelId, uploadOptions)];

    if (hasAttachments && !uploads.length) {
        showToast("Could not access pending attachments. Send cancelled to avoid leaking plaintext files.", Toasts.Type.FAILURE);
        return { cancel: true };
    }

    if (!messageObj.content && !uploads.length) {
        showToast("Nothing to encrypt.", Toasts.Type.FAILURE);
        return { cancel: true };
    }

    try {
        for (const upload of uploads) {
            if (upload.status !== "NOT_STARTED" && !isUploadEncrypted(upload)) {
                throw new Error(`${upload.filename} already started uploading. Remove and reattach it after enabling encryption.`);
            }

            await encryptUpload(upload);
        }

        const textPayload: EncryptedTextPayload = {
            protocol: PROTOCOL,
            version: 1,
            kind: "message",
            content: messageObj.content,
            createdAt: Date.now()
        };
        let encryptedContent = MARKER;

        if (messageObj.content) {
            const encryptedText = await encryptPayload(textPayload);
            const inlineContent = `${MARKER}\n${encryptedText}`;

            if (inlineContent.length <= 1900) {
                encryptedContent = inlineContent;
            } else {
                uploadOptions.attachmentsToUpload = [
                    ...uploads,
                    makeEncryptedUpload(channelId, "message.txt", encryptedText)
                ];
            }
        }

        messageObj.content = encryptedContent;
    } catch (e) {
        showToast(`Encryption failed: ${e instanceof Error ? e.message : String(e)}`, Toasts.Type.FAILURE);
        return { cancel: true };
    }
}

const ChatControlToggle: ChatBarButtonFactory = ({ isMainChat }) => {
    const [enabled, setEnabled] = useState(lastToggleState);

    function setEnabledValue(value: boolean) {
        activeToggleState = value;
        if (settings.store.persistState) lastToggleState = value;
        setEnabled(value);
    }

    useEffect(() => {
        const listener: MessageSendListener = async (channelId, messageObj, options, props) => {
            if (!enabled) return;

            const result = await encryptOutgoingMessage(channelId, messageObj, options, props.hasAttachments);
            if (!result?.cancel && settings.store.autoDisable) setEnabledValue(false);
            return result;
        };

        addMessagePreSendListener(listener);
        return () => void removeMessagePreSendListener(listener);
    }, [enabled]);

    if (!isMainChat) return null;

    return (
        <ChatBarButton
            tooltip={enabled ? "Disable ChatControlPrivacy encryption" : "Enable ChatControlPrivacy encryption"}
            onClick={() => setEnabledValue(!enabled)}
        >
            {enabled ? <LockIcon /> : <LockDisabledIcon />}
        </ChatBarButton>
    );
};

export default definePlugin({
    name: "ChatControlPrivacy",
    description: "Encrypt opt-in messages and attachments with a shared OpenPGP key pair. The bundled default key is public and only provides compatibility, not private group secrecy.",
    tags: ["Chat", "Privacy"],
    authors: [Devs.bali0531],
    dependencies: ["ChatInputButtonAPI", "MessageAccessoriesAPI", "MessageEventsAPI", "MessageUpdaterAPI"],
    settings,

    patches: [
        {
            find: "async uploadFiles(",
            replacement: {
                match: /async uploadFiles\((\i)\){/,
                replace: "$&await Promise.all($1.map($self.encryptUpload));"
            }
        },
        {
            find: "this.renderAttachments(",
            replacement: {
                match: /(?<=\i=)this\.renderAttachments\((\i)\)/g,
                replace: "$self.shouldHideAttachments($1)?null:$&"
            }
        }
    ],

    chatBarButton: {
        icon: LockIcon,
        render: ChatControlToggle
    },

    start() {
        if (originalUpload) return;

        originalUpload = CloudUpload.prototype.upload;
        CloudUpload.prototype.upload = async function (this: TCloudUpload) {
            if (activeToggleState && !isUploadEncrypted(this)) {
                try {
                    await encryptUpload(this);
                } catch (e) {
                    showToast(`Encryption failed: ${e instanceof Error ? e.message : String(e)}`, Toasts.Type.FAILURE);
                    this.cancel();
                    throw e;
                }
            }

            return originalUpload!.call(this);
        };
    },

    async encryptUpload(upload: TCloudUpload) {
        if (!activeToggleState) return;
        await encryptUpload(upload);
    },

    renderMessageAccessory(props) {
        const message = props.message as Message | undefined;
        if (!message) return null;
        if (!isEncryptedMessage(message)) return null;

        const state = getState(message);

        if (state.status === "pending") {
            return (
                <div className="vc-ccp-container">
                    <div className="vc-ccp-header">Decrypting ChatControlPrivacy message...</div>
                </div>
            );
        }

        if (state.status === "error") {
            return (
                <div className="vc-ccp-container">
                    <div className="vc-ccp-header vc-ccp-error">Failed to decrypt</div>
                    <div className="vc-ccp-content vc-ccp-error">{state.error}</div>
                </div>
            );
        }

        return (
            <div className="vc-ccp-container">
                <div className="vc-ccp-header">Decrypted ChatControlPrivacy message</div>
                <div className="vc-ccp-content">
                    {state.content && <div className="vc-ccp-text">{state.content}</div>}
                    {!!state.attachments.length && (
                        <div className="vc-ccp-media-grid">
                            {state.attachments.map(attachment => (
                                <div key={`${attachment.filename}:${attachment.url}`}>
                                    {renderAttachment(attachment)}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        );
    },

    shouldHideAttachments(message: Message | undefined) {
        return !!message
            && settings.store.hideEncryptedAttachments
            && message.attachments?.some(isEncryptedAttachment);
    },

    stop() {
        if (originalUpload) {
            CloudUpload.prototype.upload = originalUpload;
            originalUpload = undefined;
        }

        decryptCache.clear();
        for (const url of blobUrls) URL.revokeObjectURL(url);
        blobUrls.clear();
        cachedPublicKey = undefined;
        cachedPrivateKey = undefined;
    }
});
