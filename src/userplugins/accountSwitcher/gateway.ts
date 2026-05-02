/*
 * AccountSwitcher - gateway.ts
 * Minimal Discord Gateway connection for tracking unreads/mentions on alt accounts.
 */

import { Logger } from "@utils/Logger";

const logger = new Logger("AccountSwitcher:Gateway");

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const GATEWAY_OPCODES = {
    DISPATCH: 0,
    HEARTBEAT: 1,
    IDENTIFY: 2,
    RESUME: 6,
    RECONNECT: 7,
    INVALID_SESSION: 9,
    HELLO: 10,
    HEARTBEAT_ACK: 11,
};

export interface GuildUnreadState {
    mentionCount: number;
    hasUnread: boolean;
}

export interface AltGuild {
    id: string;
    name: string;
    icon: string | null;
    owner_id: string;
    features: string[];
}

export interface AltAccountState {
    guilds: AltGuild[];
    unreadMap: Map<string, GuildUnreadState>; // guildId -> unread state
    ready: boolean;
    userId: string;
    username: string;
    discriminator: string;
    avatar: string | null;
}

type StateChangeCallback = () => void;

export class AltGatewayConnection {
    private ws: WebSocket | null = null;
    private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    private sequence: number | null = null;
    private sessionId: string | null = null;
    private token: string;
    private _state: AltAccountState;
    private onStateChange: StateChangeCallback;
    private destroyed = false;
    private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    // Track read states: channelId -> lastMessageId
    private readStates: Map<string, string> = new Map();
    // Track channelId -> guildId mapping
    private channelGuildMap: Map<string, string> = new Map();

    constructor(token: string, onStateChange: StateChangeCallback) {
        this.token = token;
        this.onStateChange = onStateChange;
        this._state = {
            guilds: [],
            unreadMap: new Map(),
            ready: false,
            userId: "",
            username: "",
            discriminator: "",
            avatar: null,
        };
    }

    get state(): AltAccountState {
        return this._state;
    }

    connect() {
        if (this.destroyed) return;
        try {
            this.ws = new WebSocket(GATEWAY_URL);
            this.ws.onmessage = this.onMessage.bind(this);
            this.ws.onclose = this.onClose.bind(this);
            this.ws.onerror = (e) => logger.error("Gateway error", e);
        } catch (e) {
            logger.error("Failed to connect to gateway", e);
            this.scheduleReconnect();
        }
    }

    destroy() {
        this.destroyed = true;
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
        if (this.ws) {
            this.ws.onclose = null;
            this.ws.close(1000);
        }
        this.ws = null;
    }

    private send(data: any) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    }

    private onMessage(event: MessageEvent) {
        const data = JSON.parse(event.data);
        const { op, t, s, d } = data;

        if (s) this.sequence = s;

        switch (op) {
            case GATEWAY_OPCODES.HELLO:
                this.startHeartbeat(d.heartbeat_interval);
                this.identify();
                break;

            case GATEWAY_OPCODES.HEARTBEAT:
                this.sendHeartbeat();
                break;

            case GATEWAY_OPCODES.RECONNECT:
                this.ws?.close();
                break;

            case GATEWAY_OPCODES.INVALID_SESSION:
                // d = can_resume
                if (d) {
                    this.resume();
                } else {
                    this.sessionId = null;
                    this.sequence = null;
                    setTimeout(() => this.connect(), 1000 + Math.random() * 4000);
                }
                break;

            case GATEWAY_OPCODES.DISPATCH:
                this.handleDispatch(t, d);
                break;
        }
    }

    private onClose() {
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
        if (!this.destroyed) {
            this.scheduleReconnect();
        }
    }

    private scheduleReconnect() {
        if (this.destroyed) return;
        this.reconnectTimeout = setTimeout(() => {
            if (!this.destroyed) this.connect();
        }, 5000 + Math.random() * 5000);
    }

    private startHeartbeat(interval: number) {
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = setInterval(() => this.sendHeartbeat(), interval);
        // Send first heartbeat with jitter
        setTimeout(() => this.sendHeartbeat(), interval * Math.random());
    }

    private sendHeartbeat() {
        this.send({ op: GATEWAY_OPCODES.HEARTBEAT, d: this.sequence });
    }

    private identify() {
        this.send({
            op: GATEWAY_OPCODES.IDENTIFY,
            d: {
                token: this.token,
                intents: 1 | (1 << 9) | (1 << 15), // GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT (minimal)
                properties: {
                    os: "linux",
                    browser: "Discord Client",
                    device: "Discord Client",
                },
                // Request minimal data
                large_threshold: 1,
            },
        });
    }

    private resume() {
        if (!this.sessionId) {
            this.connect();
            return;
        }
        this.send({
            op: GATEWAY_OPCODES.RESUME,
            d: {
                token: this.token,
                session_id: this.sessionId,
                seq: this.sequence,
            },
        });
    }

    private handleDispatch(eventName: string, data: any) {
        switch (eventName) {
            case "READY":
                this.handleReady(data);
                break;
            case "MESSAGE_CREATE":
                this.handleMessageCreate(data);
                break;
            case "MESSAGE_ACK":
                this.handleMessageAck(data);
                break;
            case "GUILD_CREATE":
                this.handleGuildCreate(data);
                break;
            case "GUILD_DELETE":
                this.handleGuildDelete(data);
                break;
            case "CHANNEL_CREATE":
            case "CHANNEL_UPDATE":
                if (data.guild_id) {
                    this.channelGuildMap.set(data.id, data.guild_id);
                }
                break;
        }
    }

    private handleReady(data: any) {
        this.sessionId = data.session_id;

        // User info
        this._state.userId = data.user.id;
        this._state.username = data.user.username;
        this._state.discriminator = data.user.discriminator;
        this._state.avatar = data.user.avatar;

        // Guilds
        this._state.guilds = (data.guilds || []).map((g: any) => ({
            id: g.id,
            name: g.properties?.name ?? g.name ?? "Unknown",
            icon: g.properties?.icon ?? g.icon ?? null,
            owner_id: g.properties?.owner_id ?? g.owner_id ?? "",
            features: g.properties?.features ?? g.features ?? [],
        }));

        // Build channel -> guild mapping from guild data
        for (const guild of data.guilds || []) {
            for (const channel of guild.channels || []) {
                this.channelGuildMap.set(channel.id, guild.id);
            }
        }

        // Read states - initialize from READY payload
        this._state.unreadMap.clear();
        this.readStates.clear();

        // Initialize all guilds as read
        for (const guild of this._state.guilds) {
            this._state.unreadMap.set(guild.id, { mentionCount: 0, hasUnread: false });
        }

        // Process read_state from READY
        const rawReadState = data.read_state;
        console.log("[AccountSwitcher] read_state type:", typeof rawReadState, "isArray:", Array.isArray(rawReadState), "keys:", rawReadState ? Object.keys(rawReadState) : "null", "value:", rawReadState);
        let readStates: any[] = [];
        if (Array.isArray(rawReadState)) {
            readStates = rawReadState;
        } else if (rawReadState && typeof rawReadState === "object") {
            if (Array.isArray(rawReadState.entries)) {
                readStates = rawReadState.entries;
            } else if (Array.isArray(rawReadState.partially_read)) {
                readStates = rawReadState.partially_read;
            } else {
                // Try to find any array property
                for (const key of Object.keys(rawReadState)) {
                    if (Array.isArray(rawReadState[key])) {
                        console.log("[AccountSwitcher] Found array in read_state under key:", key, "length:", rawReadState[key].length);
                        readStates = rawReadState[key];
                        break;
                    }
                }
            }
        }
        console.log("[AccountSwitcher] readStates length:", readStates.length);
        for (const rs of readStates) {
            if (rs.id) {
                this.readStates.set(rs.id, rs.last_message_id ?? "0");
                if (rs.mention_count > 0) {
                    const guildId = this.channelGuildMap.get(rs.id);
                    if (guildId) {
                        const current = this._state.unreadMap.get(guildId) ?? { mentionCount: 0, hasUnread: false };
                        current.mentionCount += rs.mention_count;
                        current.hasUnread = true;
                        this._state.unreadMap.set(guildId, current);
                    }
                }
            }
        }

        // Process merged_members or guild-specific unread indicators
        for (const guild of data.guilds || []) {
            // Check channels for unreads by comparing last_message_id
            for (const channel of guild.channels || []) {
                const lastMsg = channel.last_message_id;
                const readState = this.readStates.get(channel.id);
                if (lastMsg && readState && lastMsg > readState) {
                    const current = this._state.unreadMap.get(guild.id) ?? { mentionCount: 0, hasUnread: false };
                    current.hasUnread = true;
                    this._state.unreadMap.set(guild.id, current);
                }
            }
        }

        this._state.ready = true;
        this.onStateChange();
        logger.info(`Gateway ready for ${this._state.username} with ${this._state.guilds.length} guilds`);
    }

    private handleMessageCreate(data: any) {
        const guildId = data.guild_id;
        if (!guildId) return;

        // Track channel -> guild
        if (data.channel_id) {
            this.channelGuildMap.set(data.channel_id, guildId);
        }

        const current = this._state.unreadMap.get(guildId) ?? { mentionCount: 0, hasUnread: false };
        current.hasUnread = true;

        // Check for mentions of this user
        if (data.mentions?.some((m: any) => m.id === this._state.userId) ||
            data.mention_everyone) {
            current.mentionCount++;
        }

        this._state.unreadMap.set(guildId, current);
        this.onStateChange();
    }

    private handleMessageAck(data: any) {
        const channelId = data.channel_id;
        const guildId = this.channelGuildMap.get(channelId);
        if (!guildId) return;

        this.readStates.set(channelId, data.message_id);

        // Recalculate guild unread (simplified - just reset mention count for this channel)
        if (data.mention_count !== undefined) {
            const current = this._state.unreadMap.get(guildId) ?? { mentionCount: 0, hasUnread: false };
            // This is approximate - we'd need full state to be exact
            current.mentionCount = Math.max(0, current.mentionCount - (data.mention_count ?? 0));
            if (current.mentionCount === 0) {
                current.hasUnread = false; // Approximate
            }
            this._state.unreadMap.set(guildId, current);
            this.onStateChange();
        }
    }

    private handleGuildCreate(data: any) {
        const existing = this._state.guilds.find(g => g.id === data.id);
        if (!existing) {
            this._state.guilds.push({
                id: data.id,
                name: data.properties?.name ?? data.name ?? "Unknown",
                icon: data.properties?.icon ?? data.icon ?? null,
                owner_id: data.properties?.owner_id ?? data.owner_id ?? "",
                features: data.properties?.features ?? data.features ?? [],
            });
            this._state.unreadMap.set(data.id, { mentionCount: 0, hasUnread: false });

            for (const channel of data.channels || []) {
                this.channelGuildMap.set(channel.id, data.id);
            }

            this.onStateChange();
        }
    }

    private handleGuildDelete(data: any) {
        this._state.guilds = this._state.guilds.filter(g => g.id !== data.id);
        this._state.unreadMap.delete(data.id);
        this.onStateChange();
    }
}
