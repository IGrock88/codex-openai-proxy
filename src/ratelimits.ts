/*
 * 实现逻辑说明：
 * 通过 `codex app-server --stdio` 读取订阅配额（5 小时窗口 / 每周窗口）。
 * 登录状态由 Codex 自己维护（~/.codex/auth.json），本模块不读取也不保存令牌。
 *
 * Local addition for the DSH bundle: one long-lived app-server child, a single
 * initialize handshake, and a short cache, so repeated /usage reads do not pay
 * a process start every time. The child is killed after an idle period and
 * re-spawned on demand; a crashed child is restarted on the next read.
 */
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLIENT_INFO = { name: "dsh-codex-openai-proxy", version: "0.1.0", title: "DSH ChatGPT proxy" };
const DEFAULT_TTL_MS = 30_000;
const DEFAULT_IDLE_MS = 5 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

export interface RateLimitWindowView {
    usedPercent: number;
    remainingPercent: number;
    windowMinutes: number | null;
    resetsAt: number | null;
    resetsAtIso: string | null;
    resetsInSeconds: number | null;
}

export interface RateLimitsView {
    planType: string | null;
    fiveHour: RateLimitWindowView | null;
    weekly: RateLimitWindowView | null;
    credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null;
    rateLimitReachedType: string | null;
    resetCreditsAvailable: number;
    accountId: string | null;
    fetchedAt: string;
    cached: boolean;
    raw: unknown;
}

export interface RateLimitsReaderOptions {
    codexBin?: string;
    ttlMs?: number;
    idleMs?: number;
    requestTimeoutMs?: number;
    log?: (message: string) => void;
}

export interface RateLimitsReader {
    read(force?: boolean): Promise<RateLimitsView>;
    dispose(): void;
}

function compareVersion(left: number[], right: number[]): number {
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
        const a = left[index] ?? 0;
        const b = right[index] ?? 0;
        if (a !== b) return a - b;
    }
    return 0;
}

/**
 * A folder can exist while the Store is still installing it: the binary is there
 * but held exclusively, and spawning it fails with EBUSY. Only a file we can open
 * counts as usable.
 */
function isLaunchable(bin: string): boolean {
    try {
        const handle = fs.openSync(bin, "r");
        fs.closeSync(handle);
        return true;
    } catch {
        return false;
    }
}

/**
 * The Codex desktop app installs each build into its own versioned folder, so the
 * current binary has to be looked up rather than remembered. Returns the highest
 * version that has a usable executable, or undefined when the folder is
 * unreadable (it needs no elevation to list, but may be locked down).
 */
function storeCodexBin(): string | undefined {
    if (process.platform !== "win32") return undefined;
    const root = "C:\\Program Files\\WindowsApps";
    let best: { version: number[]; bin: string } | undefined;
    try {
        for (const entry of fs.readdirSync(root)) {
            if (!entry.startsWith("OpenAI.Codex_")) continue;
            const match = /^OpenAI\.Codex_(\d+)\.(\d+)\.(\d+)\.(\d+)_/.exec(entry);
            const version = match ? match.slice(1, 5).map(Number) : [0, 0, 0, 0];
            const bin = path.join(root, entry, "app", "resources", "codex.exe");
            if (!isLaunchable(bin)) continue;
            if (!best || compareVersion(version, best.version) > 0) best = { version, bin };
        }
    } catch {
        return undefined;
    }
    return best?.bin;
}

/**
 * Install folder of the newest registered Codex package. `C:\Program Files\
 * WindowsApps` is readable only to an elevated process, and the embedding Host
 * may run without elevation, so the per-user Appx registration is asked first.
 */
function registeredCodexBin(): string | undefined {
    if (process.platform !== "win32") return undefined;
    const script =
        "$p = @(Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue); " +
        "if ($p.Count -gt 0) { $l = $p[0]; foreach ($c in $p) { if ($c.Version -gt $l.Version) { $l = $c } }; $l.InstallLocation }";
    const shells = [
        path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        "powershell.exe",
    ];
    for (const shell of shells) {
        try {
            const out = execFileSync(shell, ["-NoProfile", "-NonInteractive", "-Command", script], {
                encoding: "utf8",
                windowsHide: true,
                timeout: 20_000,
            });
            const location = String(out).trim();
            if (!location) continue;
            const bin = path.join(location, "app", "resources", "codex.exe");
            if (isLaunchable(bin)) return bin;
        } catch {
            /* try the next shell, then fall back to the folder scan */
        }
    }
    return undefined;
}

/** Locate the Codex CLI: explicit option, then env, then the desktop app, then the usual install paths, then PATH. */
export function resolveCodexBin(explicit?: string): string {
    const candidates = [explicit, process.env.CODEX_BIN].filter((value): value is string => typeof value === "string" && value !== "");
    for (const candidate of candidates) return candidate;
    const platform = process.platform;
    const home = os.homedir();
    const fromStore = storeCodexBin() ?? registeredCodexBin();
    if (fromStore) return fromStore;
    const known = platform === "win32"
        ? [
            path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "Programs", "OpenAI", "Codex", "bin", "codex.exe"),
            path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "npm", "codex.cmd"),
        ]
        : ["/usr/local/bin/codex", "/opt/homebrew/bin/codex", path.join(home, ".local", "bin", "codex")];
    for (const candidate of known) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return "codex";
}

function toWindow(window: unknown, nowSeconds: number): RateLimitWindowView | null {
    if (!window || typeof window !== "object") return null;
    const record = window as { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown };
    if (typeof record.usedPercent !== "number") return null;
    const usedPercent = Math.max(0, Math.min(100, Math.round(record.usedPercent)));
    const resetsAt = typeof record.resetsAt === "number" ? record.resetsAt : null;
    return {
        usedPercent,
        remainingPercent: 100 - usedPercent,
        windowMinutes: typeof record.windowDurationMins === "number" ? record.windowDurationMins : null,
        resetsAt,
        resetsAtIso: resetsAt === null ? null : new Date(resetsAt * 1000).toISOString(),
        resetsInSeconds: resetsAt === null ? null : Math.max(0, Math.round(resetsAt - nowSeconds)),
    };
}

/** Project the app-server payload onto the two windows a subscription actually has. */
export function normalizeRateLimits(payload: unknown): Omit<RateLimitsView, "cached"> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const root = (payload ?? {}) as Record<string, unknown>;
    const byId = root.rateLimitsByLimitId;
    let snapshot = root.rateLimits as Record<string, unknown> | undefined;
    if ((!snapshot || typeof snapshot !== "object") && byId && typeof byId === "object") {
        snapshot = Object.values(byId as Record<string, Record<string, unknown>>)[0];
    }
    snapshot = snapshot && typeof snapshot === "object" ? snapshot : {};
    const credits = snapshot.credits as { hasCredits?: unknown; unlimited?: unknown; balance?: unknown } | null | undefined;
    const resetCredits = root.rateLimitResetCredits as { availableCount?: unknown } | null | undefined;
    const planType = typeof snapshot.planType === "string" ? snapshot.planType : null;
    const rateLimitReachedType = typeof snapshot.rateLimitReachedType === "string" ? snapshot.rateLimitReachedType : null;
    return {
        planType,
        fiveHour: toWindow(snapshot.primary, nowSeconds),
        weekly: toWindow(snapshot.secondary, nowSeconds),
        credits: credits && typeof credits === "object"
            ? {
                hasCredits: credits.hasCredits === true,
                unlimited: credits.unlimited === true,
                balance: typeof credits.balance === "string" ? credits.balance : null,
            }
            : null,
        rateLimitReachedType,
        resetCreditsAvailable: resetCredits && typeof resetCredits.availableCount === "number" ? resetCredits.availableCount : 0,
        accountId: typeof root.accountId === "string" ? root.accountId : null,
        fetchedAt: new Date().toISOString(),
        raw: payload,
    };
}

class AppServerSession {
    private child: ChildProcessWithoutNullStreams | null = null;
    private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    private buffer = "";
    private nextId = 1;
    private ready: Promise<void> | null = null;
    private stderrTail = "";
    private lastUsedAt = Date.now();
    private idleTimer: NodeJS.Timeout | null = null;

    constructor(private readonly options: Required<Pick<RateLimitsReaderOptions, "requestTimeoutMs" | "idleMs">> & { resolveBin: () => string; log: (message: string) => void }) {}

    /** One request, opening (and handshaking) the child when it is not running yet. */
    async request(method: string, params: unknown): Promise<unknown> {
        await this.ensureStarted();
        this.lastUsedAt = Date.now();
        this.scheduleIdleStop();
        return await this.send(method, params);
    }

    private async ensureStarted(): Promise<void> {
        if (this.child && !this.ready) return;
        if (this.ready) {
            await this.ready;
            return;
        }
        this.ready = this.start();
        try {
            await this.ready;
        }
        catch (error) {
            this.ready = null;
            this.stopChild();
            throw error;
        }
    }

    private async start(): Promise<void> {
        // Resolved per start: the desktop app replaces its versioned folder on
        // update, and this reader outlives such an update.
        const codexBin = this.options.resolveBin();
        const { log } = this.options;
        const child = spawn(codexBin, ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        this.child = child;
        this.buffer = "";
        this.stderrTail = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => this.consume(chunk));
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
            this.stderrTail = (this.stderrTail + chunk).slice(-1200);
        });
        child.on("error", (error) => this.fail(`app-server failed to start (${codexBin}): ${error.message}`));
        child.on("exit", (code) => {
            if (this.child === child) this.fail(`app-server exited with code ${code}${this.stderrTail ? `: ${this.stderrTail.trim().slice(-400)}` : ""}`);
        });
        log(`started app-server pid ${child.pid ?? "?"} via ${codexBin}`);
        await this.send("initialize", { clientInfo: CLIENT_INFO });
        this.write({ jsonrpc: "2.0", method: "initialized", params: {} });
    }

    private fail(reason: string): void {
        const pending = [...this.pending.values()];
        this.pending.clear();
        this.ready = null;
        this.stopChild();
        for (const entry of pending) entry.reject(new Error(reason));
    }

    private stopChild(): void {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        const child = this.child;
        this.child = null;
        this.ready = null;
        if (child) {
            try {
                child.stdin.end();
            }
            catch {
                // ignore
            }
            try {
                child.kill();
            }
            catch {
                // ignore
            }
        }
    }

    private scheduleIdleStop(): void {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
            const idleFor = Date.now() - this.lastUsedAt;
            if (idleFor >= this.options.idleMs && this.pending.size === 0) {
                this.options.log("stopping idle app-server");
                this.stopChild();
            }
            else {
                this.scheduleIdleStop();
            }
        }, this.options.idleMs);
        this.idleTimer.unref?.();
    }

    private write(message: unknown): void {
        const child = this.child;
        if (!child) throw new Error("app-server is not running");
        child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    private send(method: string, params: unknown): Promise<unknown> {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            try {
                this.write({ jsonrpc: "2.0", id, method, params: params ?? null });
            }
            catch (error) {
                this.pending.delete(id);
                reject(error instanceof Error ? error : new Error(String(error)));
                return;
            }
            const timer = setTimeout(() => {
                if (this.pending.delete(id)) reject(new Error(`app-server timed out on ${method}`));
            }, this.options.requestTimeoutMs);
            timer.unref?.();
        });
    }

    private consume(chunk: string): void {
        this.buffer += chunk;
        let newline: number;
        while ((newline = this.buffer.indexOf("\n")) >= 0) {
            const line = this.buffer.slice(0, newline).trim();
            this.buffer = this.buffer.slice(newline + 1);
            if (!line) continue;
            let message: { id?: unknown; result?: unknown; error?: unknown };
            try {
                message = JSON.parse(line);
            }
            catch {
                continue;
            }
            if (typeof message.id !== "number") continue;
            const entry = this.pending.get(message.id);
            if (!entry) continue;
            this.pending.delete(message.id);
            if (message.error !== undefined) entry.reject(new Error(JSON.stringify(message.error).slice(0, 600)));
            else entry.resolve(message.result);
        }
    }

    dispose(): void {
        this.fail("app-server reader disposed");
    }
}

export function createRateLimitsReader(options: RateLimitsReaderOptions = {}): RateLimitsReader {
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const log = options.log ?? (() => {});
    const session = new AppServerSession({
        resolveBin: () => resolveCodexBin(options.codexBin),
        requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        idleMs: options.idleMs ?? DEFAULT_IDLE_MS,
        log,
    });
    let cached: Omit<RateLimitsView, "cached"> | null = null;
    let cachedAt = 0;
    let inflight: Promise<RateLimitsView> | null = null;

    async function fetchOnce(force: boolean): Promise<RateLimitsView> {
        if (!force && cached && Date.now() - cachedAt < ttlMs) return { ...cached, cached: true };
        if (inflight) return await inflight;
        inflight = (async () => {
            const payload = await session.request("account/rateLimits/read", null);
            cached = normalizeRateLimits(payload);
            cachedAt = Date.now();
            return { ...cached, cached: false };
        })();
        try {
            return await inflight;
        }
        finally {
            inflight = null;
        }
    }

    return {
        read: (force = false) => fetchOnce(force),
        dispose: () => session.dispose(),
    };
}
