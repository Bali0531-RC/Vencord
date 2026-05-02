/*
 * AccountSwitcher - Seamless multi-account Discord experience
 * Shows alt account servers below the main server list with unread/ping indicators.
 * Clicking an alt server switches accounts and navigates to it.
 * Common servers (shared between accounts) are filtered out.
 */

import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import {
    ModalCloseButton,
    ModalContent,
    ModalFooter,
    ModalHeader,
    ModalProps,
    ModalRoot,
    ModalSize,
    openModal,
} from "@utils/modal";
import definePlugin, { OptionType } from "@utils/types";
import { findByPropsLazy } from "@webpack";
import {
    Button,
    FluxDispatcher,
    GuildStore,
    NavigationRouter,
    React,
    showToast,
    Text,
    TextInput,
    Toasts,
    Tooltip,
    UserStore,
} from "@webpack/common";
import { findByCodeLazy } from "@webpack";

import { AltGatewayConnection, AltAccountState, AltGuild, GuildUnreadState } from "./gateway";

const createRoot: typeof import("react-dom/client").createRoot = findByCodeLazy("(299));", ".onRecoverableError");

const logger = new Logger("AccountSwitcher");
const DATA_KEY = "AccountSwitcher_accounts";

const LoginUtils = findByPropsLazy("loginToken");

// ─── Types ───────────────────────────────────────────────────────────────────

interface StoredAccount {
    token: string;
    userId: string;
    username: string;
    discriminator: string;
    avatar: string | null;
}

// ─── Settings ────────────────────────────────────────────────────────────────

const settings = definePluginSettings({
    showSeparator: {
        type: OptionType.BOOLEAN,
        description: "Show a separator line between your servers and alt servers",
        default: true,
    },
    showUnreadIndicator: {
        type: OptionType.BOOLEAN,
        description: "Show unread dot on alt servers",
        default: true,
    },
    showMentionBadge: {
        type: OptionType.BOOLEAN,
        description: "Show mention count badge on alt servers",
        default: true,
    },
    hideCommonServers: {
        type: OptionType.BOOLEAN,
        description: "Hide servers you share with alt accounts (no duplicates)",
        default: false,
    },
});

// ─── State ───────────────────────────────────────────────────────────────────

let connections: Map<string, AltGatewayConnection> = new Map();
let altAccountStates: Map<string, AltAccountState> = new Map();
let tokenCache: Map<string, string> = new Map();

async function getAccounts(): Promise<StoredAccount[]> {
    return await DataStore.get<StoredAccount[]>(DATA_KEY) ?? [];
}

async function saveAccounts(accounts: StoredAccount[]) {
    await DataStore.set(DATA_KEY, accounts);
}

async function validateToken(token: string): Promise<StoredAccount | null> {
    try {
        const res = await fetch("https://discord.com/api/v9/users/@me", {
            headers: { Authorization: token },
        });
        if (!res.ok) return null;
        const data = await res.json();
        return {
            token,
            userId: data.id,
            username: data.username,
            discriminator: data.discriminator,
            avatar: data.avatar,
        };
    } catch {
        return null;
    }
}

async function refreshTokenCache() {
    const accounts = await getAccounts();
    tokenCache.clear();
    for (const a of accounts) tokenCache.set(a.userId, a.token);
}

function getTokenForUser(userId: string): string {
    return tokenCache.get(userId) ?? "";
}

function onGatewayStateChange() {
    FluxDispatcher.dispatch({ type: "ACCOUNT_SWITCHER_STATE_UPDATE" as any });
}

async function startConnections() {
    const accounts = await getAccounts();
    const currentUserId = UserStore.getCurrentUser()?.id;

    for (const account of accounts) {
        if (account.userId === currentUserId) continue;
        if (connections.has(account.userId)) continue;

        const conn = new AltGatewayConnection(account.token, () => {
            altAccountStates.set(account.userId, conn.state);
            onGatewayStateChange();
        });
        connections.set(account.userId, conn);
        conn.connect();
    }

    // Remove stale connections
    const accountIds = new Set(accounts.map(a => a.userId));
    for (const [userId, conn] of connections) {
        if (!accountIds.has(userId) || userId === currentUserId) {
            conn.destroy();
            connections.delete(userId);
            altAccountStates.delete(userId);
        }
    }
}

function stopConnections() {
    for (const conn of connections.values()) conn.destroy();
    connections.clear();
    altAccountStates.clear();
}

function switchToAccount(token: string, guildId?: string) {
    if (guildId) DataStore.set("AccountSwitcher_pendingNav", guildId);
    FluxDispatcher.dispatch({ type: "LOGOUT" as any, isSwitchingAccount: true });
    setTimeout(() => LoginUtils.loginToken(token), 100);
}

// ─── Guild Rendering Helpers ─────────────────────────────────────────────────

function getGuildIconUrl(guild: AltGuild, size = 48): string | null {
    if (!guild.icon) return null;
    const ext = guild.icon.startsWith("a_") ? "gif" : "png";
    return `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.${ext}?size=${size}`;
}

function getGuildAcronym(name: string): string {
    return name.replace(/'s /g, " ").replace(/\w+/g, w => w[0]).replace(/\s/g, "");
}

// ─── Components ──────────────────────────────────────────────────────────────

function AltGuildIcon({
    guild, unread, account,
}: {
    guild: AltGuild;
    unread: GuildUnreadState | undefined;
    account: StoredAccount;
}) {
    const iconUrl = getGuildIconUrl(guild);
    const hasUnread = settings.store.showUnreadIndicator && (unread?.hasUnread ?? false);
    const mentionCount = settings.store.showMentionBadge ? (unread?.mentionCount ?? 0) : 0;
    const [hovered, setHovered] = React.useState(false);

    const radius = hovered || hasUnread ? 16 : 24;

    return (
        <Tooltip text={`${guild.name} (${account.username})`} position="right">
            {(tooltipProps: any) => (
                <div
                    {...tooltipProps}
                    onMouseEnter={(e: any) => {
                        setHovered(true);
                        tooltipProps.onMouseEnter?.(e);
                    }}
                    onMouseLeave={(e: any) => {
                        setHovered(false);
                        tooltipProps.onMouseLeave?.(e);
                    }}
                    style={{
                        position: "relative",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: 48,
                        height: 48,
                        cursor: "pointer",
                    }}
                    onClick={() => {
                        showToast(`Switching to ${account.username} → ${guild.name}...`, Toasts.Type.MESSAGE);
                        switchToAccount(account.token, guild.id);
                    }}
                >
                    {/* Unread pill (left side) */}
                    {hasUnread && (
                        <div style={{
                            position: "absolute",
                            left: -14,
                            width: 8,
                            height: mentionCount > 0 || hovered ? 20 : 8,
                            borderRadius: 4,
                            backgroundColor: "var(--header-primary)",
                            transition: "height 0.15s ease",
                        }} />
                    )}

                    {/* Icon */}
                    {iconUrl ? (
                        <img
                            src={iconUrl}
                            alt={guild.name}
                            width={48}
                            height={48}
                            style={{
                                borderRadius: radius,
                                transition: "border-radius 0.15s ease-out",
                                objectFit: "cover",
                                display: "block",
                            }}
                        />
                    ) : (
                        <div style={{
                            width: 48, height: 48,
                            borderRadius: radius,
                            transition: "border-radius 0.15s ease-out",
                            backgroundColor: hovered ? "var(--brand-500)" : "var(--background-primary)",
                            color: hovered ? "#fff" : "var(--text-normal)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: 14,
                            fontWeight: 600,
                            overflow: "hidden",
                        }}>
                            {getGuildAcronym(guild.name)}
                        </div>
                    )}

                    {/* Mention badge (bottom right) */}
                    {mentionCount > 0 && (
                        <div style={{
                            position: "absolute",
                            bottom: -4,
                            right: -4,
                            minWidth: 16,
                            height: 16,
                            padding: "0 4px",
                            borderRadius: 8,
                            backgroundColor: "var(--status-danger)",
                            color: "#fff",
                            fontSize: 12,
                            fontWeight: 700,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            border: "2px solid var(--background-tertiary)",
                            boxSizing: "content-box",
                        }}>
                            {mentionCount > 99 ? "99+" : mentionCount}
                        </div>
                    )}
                </div>
            )}
        </Tooltip>
    );
}

function AltAccountServerList() {
    const [, forceUpdate] = React.useReducer(x => x + 1, 0);

    React.useEffect(() => {
        const handler = () => forceUpdate();
        FluxDispatcher.subscribe("ACCOUNT_SWITCHER_STATE_UPDATE" as any, handler);
        return () => FluxDispatcher.unsubscribe("ACCOUNT_SWITCHER_STATE_UPDATE" as any, handler);
    }, []);

    // Get current account's guild IDs for filtering
    const currentGuildIds = new Set(Object.keys(GuildStore.getGuilds()));

    const entries: { account: StoredAccount; guilds: AltGuild[]; state: AltAccountState; }[] = [];
    console.log("[AccountSwitcher] Rendering: altAccountStates size:", altAccountStates.size, "currentGuildIds:", currentGuildIds.size);
    for (const [userId, state] of altAccountStates) {
        console.log("[AccountSwitcher] Account", userId, "ready:", state.ready, "guilds:", state.guilds.length, "guildNames:", state.guilds.map(g => g.name));
        if (!state.ready || state.guilds.length === 0) continue;

        let guilds = state.guilds;
        if (settings.store.hideCommonServers) {
            const before = guilds.length;
            guilds = guilds.filter(g => !currentGuildIds.has(g.id));
            console.log("[AccountSwitcher] Filtered common servers:", before, "->", guilds.length);
        }
        if (guilds.length === 0) continue;

        entries.push({
            account: {
                token: getTokenForUser(userId),
                userId: state.userId,
                username: state.username,
                discriminator: state.discriminator,
                avatar: state.avatar,
            },
            guilds,
            state,
        });
    }

    if (entries.length === 0) return null;

    return (
        <div style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            width: "100%",
            order: 9999, // Push to bottom of the flex guild list
        }}>
            {entries.map(({ account, guilds, state }) => (
                <React.Fragment key={account.userId}>
                    {/* Separator + account label */}
                    {settings.store.showSeparator && (
                        <Tooltip text={`${account.username}'s servers`} position="right">
                            {(tooltipProps: any) => (
                                <div
                                    {...tooltipProps}
                                    style={{
                                        width: 32,
                                        height: 2,
                                        borderRadius: 1,
                                        backgroundColor: "var(--background-modifier-accent)",
                                        marginTop: 4,
                                        marginBottom: 8,
                                    }}
                                />
                            )}
                        </Tooltip>
                    )}

                    {/* Alt guild icons */}
                    {guilds.map(guild => (
                        <div key={guild.id} style={{ marginBottom: 8, display: "flex", justifyContent: "center" }}>
                            <AltGuildIcon
                                guild={guild}
                                unread={state.unreadMap.get(guild.id)}
                                account={account}
                            />
                        </div>
                    ))}
                </React.Fragment>
            ))}
        </div>
    );
}

// ─── Account Management Modal ────────────────────────────────────────────────

function AccountManagerModal({ modalProps }: { modalProps: ModalProps; }) {
    const [accounts, setAccounts] = React.useState<StoredAccount[]>([]);
    const [newToken, setNewToken] = React.useState("");
    const [loading, setLoading] = React.useState(false);
    const currentUserId = UserStore.getCurrentUser()?.id;

    React.useEffect(() => { getAccounts().then(setAccounts); }, []);

    const reload = async () => {
        await refreshTokenCache();
        setAccounts(await getAccounts());
    };

    const handleAdd = async () => {
        if (!newToken.trim()) return;
        setLoading(true);
        const account = await validateToken(newToken.trim());
        setLoading(false);
        if (account) {
            const accs = await getAccounts();
            const idx = accs.findIndex(a => a.userId === account.userId);
            if (idx >= 0) accs[idx] = account; else accs.push(account);
            await saveAccounts(accs);
            await reload();
            setNewToken("");
            showToast(`Added ${account.username}`, Toasts.Type.SUCCESS);
            startConnections();
        } else {
            showToast("Invalid token", Toasts.Type.FAILURE);
        }
    };

    const handleRemove = async (userId: string) => {
        await saveAccounts((await getAccounts()).filter(a => a.userId !== userId));
        const conn = connections.get(userId);
        if (conn) { conn.destroy(); connections.delete(userId); altAccountStates.delete(userId); onGatewayStateChange(); }
        await reload();
        showToast("Account removed", Toasts.Type.SUCCESS);
    };

    const handleSaveCurrent = async () => {
        const token = typeof LoginUtils.getToken === "function" ? LoginUtils.getToken() : null;
        if (!token) { showToast("Could not get current token. Add manually.", Toasts.Type.FAILURE); return; }
        const account = await validateToken(token);
        if (account) {
            const accs = await getAccounts();
            const idx = accs.findIndex(a => a.userId === account.userId);
            if (idx >= 0) accs[idx] = account; else accs.push(account);
            await saveAccounts(accs);
            await reload();
            showToast(`Saved ${account.username}`, Toasts.Type.SUCCESS);
        }
    };

    return (
        <ModalRoot {...modalProps} size={ModalSize.MEDIUM}>
            <ModalHeader>
                <Text variant="heading-lg/semibold" style={{ flexGrow: 1 }}>Account Switcher</Text>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>
            <ModalContent>
                <div style={{ padding: "16px 0" }}>
                    {accounts.length === 0 && (
                        <Text variant="text-md/normal" style={{ color: "var(--text-muted)", marginBottom: 16 }}>
                            No accounts saved. Save your current account or add one by token.
                        </Text>
                    )}

                    {accounts.map(account => {
                        const avatarUrl = account.avatar
                            ? `https://cdn.discordapp.com/avatars/${account.userId}/${account.avatar}.png?size=32`
                            : "https://cdn.discordapp.com/embed/avatars/0.png";
                        const isCurrent = account.userId === currentUserId;
                        const state = altAccountStates.get(account.userId);
                        const isConnected = state?.ready ?? false;
                        const guildCount = state?.guilds.length ?? 0;

                        return (
                            <div key={account.userId} style={{
                                display: "flex", alignItems: "center", gap: 12,
                                padding: "10px 12px", marginBottom: 8, borderRadius: 8,
                                background: isCurrent ? "var(--background-modifier-selected)" : "var(--background-secondary)",
                            }}>
                                <img src={avatarUrl} alt="" style={{ width: 32, height: 32, borderRadius: "50%" }} />
                                <div style={{ flexGrow: 1 }}>
                                    <Text variant="text-md/semibold">{account.username}{isCurrent && " (active)"}</Text>
                                    <Text variant="text-xs/normal" style={{ color: "var(--text-muted)" }}>
                                        {isCurrent ? "Currently logged in" : isConnected ? `Connected - ${guildCount} servers` : "Connecting..."}
                                    </Text>
                                </div>
                                {!isCurrent && (
                                    <Button color={Button.Colors.PRIMARY} size={Button.Sizes.SMALL}
                                        onClick={() => { modalProps.onClose(); switchToAccount(account.token); }}>
                                        Switch
                                    </Button>
                                )}
                                <Button color={Button.Colors.RED} size={Button.Sizes.SMALL}
                                    onClick={() => handleRemove(account.userId)}>
                                    Remove
                                </Button>
                            </div>
                        );
                    })}

                    <div style={{ borderTop: "1px solid var(--background-modifier-accent)", margin: "16px 0" }} />

                    <Button onClick={handleSaveCurrent} color={Button.Colors.PRIMARY} size={Button.Sizes.SMALL} style={{ marginBottom: 12 }}>
                        Save Current Account
                    </Button>

                    <Text variant="text-sm/semibold" style={{ marginBottom: 8 }}>Add account by token</Text>
                    <div style={{ display: "flex", gap: 8 }}>
                        <TextInput placeholder="Paste Discord token..." value={newToken} onChange={setNewToken} type="password" style={{ flexGrow: 1 }} />
                        <Button onClick={handleAdd} color={Button.Colors.BRAND} disabled={loading || !newToken.trim()}>
                            {loading ? "..." : "Add"}
                        </Button>
                    </div>
                </div>
            </ModalContent>
            <ModalFooter>
                <Button onClick={modalProps.onClose}>Close</Button>
            </ModalFooter>
        </ModalRoot>
    );
}

// ─── Plugin Definition ───────────────────────────────────────────────────────

export default definePlugin({
    name: "AccountSwitcher",
    description: "Shows alt account servers below the main server list with unread/ping indicators. Click to switch seamlessly.",
    authors: [Devs.Ven],
    settings,

    toolboxActions: {
        "Manage Accounts"() {
            openModal(props => <AccountManagerModal modalProps={props} />);
        },
    },

    flux: {
        async CONNECTION_OPEN() {
            const pendingGuild = await DataStore.get<string>("AccountSwitcher_pendingNav");
            if (pendingGuild) {
                await DataStore.del("AccountSwitcher_pendingNav");
                setTimeout(() => NavigationRouter.transitionToGuild(pendingGuild), 1500);
            }
            await refreshTokenCache();
            await startConnections();
        },
    },

    _container: null as HTMLDivElement | null,
    _root: null as any,
    _observer: null as MutationObserver | null,

    _injectIntoDOM() {
        // Already injected?
        if (this._container && document.contains(this._container)) return;

        // Try multiple selectors for the guild sidebar scroller
        const selectors = [
            'ul[data-list-id="guildsnav"]',
            'div[class*="guilds"] div[class*="scroller"]',
            'nav[class*="guilds"] div[class*="scroller"]',
            '[class*="guilds_"] [class*="scroller_"]',
            '[class*="wrapper_"][class*="guilds_"] [class*="scroller"]',
        ];

        let scroller: HTMLElement | null = null;
        for (const sel of selectors) {
            scroller = document.querySelector<HTMLElement>(sel);
            if (scroller) {
                console.log("[AccountSwitcher] Found scroller with selector:", sel, scroller.tagName, scroller.className?.substring(0, 80));
                break;
            }
        }

        if (!scroller) {
            // Fallback: find the guilds nav wrapper and dump its DOM tree
            const guildsNav = document.querySelector<HTMLElement>('nav[class*="guilds"]')
                ?? document.querySelector<HTMLElement>('[class*="guilds_"]');
            if (guildsNav) {
                console.log("[AccountSwitcher] Found guilds nav but no scroller. Dumping children:");
                const dump = (el: Element, depth: number) => {
                    if (depth > 4) return;
                    const pad = "  ".repeat(depth);
                    console.log(`[AccountSwitcher] ${pad}${el.tagName} class="${(el.className || "").substring(0, 80)}" children=${el.children.length}`);
                    for (const child of el.children) dump(child, depth + 1);
                };
                dump(guildsNav, 0);
            } else {
                console.log("[AccountSwitcher] Could not find any guilds element at all");
            }
            return;
        }

        this._container = document.createElement("div");
        this._container.id = "vc-account-switcher-servers";
        this._container.style.cssText = "display:flex;flex-direction:column;align-items:center;width:72px;padding:8px 0 16px 0;";

        scroller.appendChild(this._container);
        console.log("[AccountSwitcher] Container appended to:", scroller.tagName, scroller.className?.substring(0, 80));

        // Render React into it
        this._root = createRoot(this._container);
        this._root.render(React.createElement(AltAccountServerList));
        logger.info("Injected alt server list into DOM");
    },

    _removeFromDOM() {
        if (this._root) {
            this._root.unmount();
            this._root = null;
        }
        if (this._container) {
            this._container.remove();
            this._container = null;
        }
    },

    async start() {
        // Force hideCommonServers off (was previously defaulted to true)
        settings.store.hideCommonServers = false;

        await refreshTokenCache();
        setTimeout(() => startConnections(), 3000);

        // Try to inject immediately, then observe for re-renders
        const tryInject = () => this._injectIntoDOM();
        tryInject();

        // Re-check periodically in case Discord re-renders the guild list
        this._observer = new MutationObserver(() => {
            if (!this._container || !document.contains(this._container)) {
                tryInject();
            }
        });
        const target = document.querySelector('[class*="guilds"]') ?? document.body;
        this._observer.observe(target, { childList: true, subtree: true });

        // Also retry a few times on startup in case the DOM isn't ready yet
        for (const delay of [500, 1500, 3000, 6000]) {
            setTimeout(tryInject, delay);
        }

        logger.info("AccountSwitcher started");
    },

    stop() {
        if (this._observer) {
            this._observer.disconnect();
            this._observer = null;
        }
        this._removeFromDOM();
        stopConnections();
        logger.info("AccountSwitcher stopped");
    },
});
