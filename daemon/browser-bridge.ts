import { randomUUID } from "node:crypto";
import type { ServerWebSocket } from "bun";
import type { TabAgentStore } from "./db";

export interface BrowserRpcResult {
  ok: boolean;
  data: any;
  error?: string;
}

interface PendingRpc {
  resolve: (res: BrowserRpcResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

const PASSIVE_ALLOWED_OPS = new Set(["info", "tabs"]);

export class BrowserBridge {
  private extensionSockets = new Set<ServerWebSocket<any>>();
  private pending = new Map<string, PendingRpc>();
  private cdpStatsByTab = new Map<
    number,
    { attached: boolean; consoleErrors: number; failedRequests: number; updatedAt: number }
  >();

  constructor(private readonly store: TabAgentStore) {}

  registerExtensionSocket(ws: ServerWebSocket<any>): void {
    this.extensionSockets.add(ws);
  }

  unregisterExtensionSocket(ws: ServerWebSocket<any>): void {
    this.extensionSockets.delete(ws);
    if (this.extensionSockets.size === 0) {
      for (const [bid, p] of this.pending) {
        clearTimeout(p.timer);
        p.resolve({ ok: false, data: null, error: "Chrome extension disconnected." });
        this.pending.delete(bid);
      }
    }
  }

  isExtensionConnected(): boolean {
    return this.extensionSockets.size > 0;
  }

  broadcastToExtensions(payload: Record<string, unknown>): void {
    const raw = JSON.stringify(payload);
    for (const ws of this.extensionSockets) {
      try {
        ws.send(raw);
      } catch {
        this.extensionSockets.delete(ws);
      }
    }
  }

  updateCdpStats(
    tabId: number,
    stats: { attached: boolean; consoleErrors: number; failedRequests: number }
  ): void {
    this.cdpStatsByTab.set(tabId, { ...stats, updatedAt: Date.now() });
  }

  getCdpStats(tabId: number | null): {
    attached: boolean;
    consoleErrors: number;
    failedRequests: number;
  } {
    if (tabId === null) return { attached: false, consoleErrors: 0, failedRequests: 0 };
    return (
      this.cdpStatsByTab.get(tabId) || {
        attached: false,
        consoleErrors: 0,
        failedRequests: 0,
      }
    );
  }

  handleExtensionResult(msg: {
    bid?: string;
    ok?: boolean;
    data?: any;
    error?: string;
  }): boolean {
    if (!msg.bid) return false;
    const p = this.pending.get(msg.bid);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(msg.bid);
    p.resolve({
      ok: Boolean(msg.ok),
      data: msg.data ?? null,
      error: msg.error,
    });
    return true;
  }

  /**
   * Dispatch a browser tool operation to the connected Chrome extension.
   * Enforces the Inspect Gate: when pageAccess is OFF for the session,
   * all CDP/DOM/action ops return PAGE_INSPECT_DISABLED without ever attaching chrome.debugger.
   */
  async callBrowserOp(
    sessionId: string,
    op: string,
    args: Record<string, unknown> = {},
    opts: { bypassGate?: boolean; timeoutMs?: number } = {}
  ): Promise<BrowserRpcResult> {
    const sess = this.store.getSession(sessionId);
    if (!sess) {
      return { ok: false, data: null, error: `Unknown session: ${sessionId}` };
    }

    const boundTabId = this.store.getTabIdForSession(sessionId);

    // Passive metadata works even with See Page OFF
    if (op === "info" && !sess.pageAccess && !opts.bypassGate) {
      return {
        ok: true,
        data: {
          tabId: boundTabId,
          url: sess.lastUrl,
          title: sess.pageTitle,
          repoPath: sess.repoPath,
          repoName: sess.repoName,
          pageAccess: false,
          note: "Passive URL metadata only. Ask the user to click 'See Page' to inspect DOM, console, network, or screenshots.",
        },
      };
    }

    if (!opts.bypassGate && !PASSIVE_ALLOWED_OPS.has(op) && !sess.pageAccess) {
      return {
        ok: false,
        data: null,
        error:
          "PAGE_INSPECT_DISABLED: Page inspection is OFF for this tab. Ask the user to click 'See Page' (⌘.) in the sidebar to grant live DOM/DevTools access.",
      };
    }

    const ws = this.extensionSockets.values().next().value as ServerWebSocket<any> | undefined;
    if (!ws) {
      return {
        ok: false,
        data: null,
        error: "Chrome extension is not connected to the Tab-Agent daemon.",
      };
    }

    const bid = randomUUID().slice(0, 12);
    const effectiveArgs = { ...args };
    if (effectiveArgs.tabId === undefined && boundTabId !== null) {
      effectiveArgs.tabId = boundTabId;
    }

    const timeoutMs = opts.timeoutMs ?? 25_000;
    return await new Promise<BrowserRpcResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(bid);
        resolve({
          ok: false,
          data: null,
          error: `Browser operation '${op}' timed out after ${timeoutMs}ms.`,
        });
      }, timeoutMs);

      this.pending.set(bid, { resolve, timer });
      try {
        ws.send(
          JSON.stringify({
            type: "browser_rpc",
            bid,
            sessionId,
            op,
            args: effectiveArgs,
          })
        );
      } catch (err: any) {
        clearTimeout(timer);
        this.pending.delete(bid);
        resolve({
          ok: false,
          data: null,
          error: `Failed to send RPC to extension: ${err?.message || String(err)}`,
        });
      }
    });
  }

  /** Ask extension to immediately attach or detach CDP for a bound tab (when user clicks See Page). */
  async syncInspectState(
    sessionId: string,
    enabled: boolean
  ): Promise<BrowserRpcResult> {
    const tabId = this.store.getTabIdForSession(sessionId);
    if (tabId === null) {
      return { ok: true, data: { attached: false, note: "Session has no active tab bound." } };
    }
    return this.callBrowserOp(
      sessionId,
      enabled ? "attach" : "detach",
      { tabId },
      { bypassGate: true, timeoutMs: 12_000 }
    );
  }
}
