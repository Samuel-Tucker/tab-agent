import { describe, expect, test } from "bun:test";
import { TabAgentStore } from "../daemon/db";

describe("TabAgentStore (SQLite WAL + FTS5 + Sticky Bindings)", () => {
  test("creates sticky tab session, survives reload, archives on close, and recovers by origin & FTS5", () => {
    const store = new TabAgentStore(":memory:");
    try {
      const s = store.createSession({
        id: "tab-hood1",
        name: "Kit cards spacing fix",
        repoPath: "/tmp/demo-repos/acme-web",
        repoName: "acme-web",
        repoSource: "pinned",
        url: "https://acme-web.example/kits/g5-01",
        pageTitle: "Starter Kit v2 — Acme Web",
        family: "AGY",
        model: "NEON",
        effort: "low",
        harnessId: "agy-neon",
      });
      store.bindTab(42, s.id, 1, s.lastUrl);
      store.updateProviderSessionId(s.id, "conv-agy-8899");
      store.insertMessage({ sessionId: s.id, sender: "human", text: "Why does the mobile badge wrap badly?" });
      store.insertMessage({ sessionId: s.id, sender: "agent", text: "KitCard.astro uses min-width: 190px." });

      // Reload keeps exact tab binding and provider session ID
      const binding = store.getTabBinding(42);
      expect(binding?.sessionId).toBe(s.id);
      const full = store.getSessionFull(s.id)!;
      expect(full.providerSessionId).toBe("conv-agy-8899");
      expect(full.messages.length).toBe(2);
      expect(full.tabId).toBe(42);

      // Closing tab archives binding without deleting messages
      const archivedId = store.unbindTab(42);
      expect(archivedId).toBe(s.id);
      expect(store.getTabBinding(42)).toBeNull();
      expect(store.getSession(s.id)?.archived).toBe(true);

      // Reopening same origin finds recoverable chat
      const rec = store.findRecentForOrigin("https://acme-web.example");
      expect(rec?.id).toBe(s.id);
      expect(rec?.messageCount).toBe(2);

      // FTS5 search finds by URL, chat name, repo, or message body
      expect(store.searchHistory("acme-web").map((h) => h.id)).toContain(s.id);
      expect(store.searchHistory("spacing").map((h) => h.id)).toContain(s.id);
      expect(store.searchHistory("KitCard").map((h) => h.id)).toContain(s.id);

      // Re-attach to a fresh tab restores active binding
      store.bindTab(99, s.id, 1, "https://acme-web.example/pricing");
      expect(store.getTabBinding(99)?.sessionId).toBe(s.id);
      expect(store.getSession(s.id)?.archived).toBe(false);
    } finally {
      store.close();
    }
  });

  test("manages pinned URL->repo rules cleanly", () => {
    const store = new TabAgentStore(":memory:");
    try {
      const r1 = store.upsertRule("acme-web.example", "/tmp/demo-repos/acme-web", "acme-web");
      expect(r1.pattern).toBe("acme-web.example");
      const r2 = store.upsertRule("acme-web.example", "/tmp/updated", "Updated");
      expect(r2.repoName).toBe("Updated");
      expect(store.listRules().length).toBe(1);
      expect(store.deleteRule(r2.id)).toBe(true);
      expect(store.listRules().length).toBe(0);
    } finally {
      store.close();
    }
  });

  test("moveSessionToTab keeps a chat on one tab and archives the chat it displaces", () => {
    const store = new TabAgentStore(":memory:");
    try {
      const base = {
        repoPath: "/tmp/r",
        repoName: "r",
        repoSource: "scratch" as const,
        family: "AGY" as const,
        model: "NEON",
        effort: "low",
        harnessId: "agy-neon",
      };
      const a = store.createSession({ ...base, id: "tab-a", name: "A", url: "https://a.test/", pageTitle: "A" });
      const b = store.createSession({ ...base, id: "tab-b", name: "B", url: "https://b.test/", pageTitle: "B" });
      store.bindTab(1, a.id, 1, a.lastUrl);
      store.bindTab(2, b.id, 1, b.lastUrl);

      // A moves into a brand-new tab 3: tab 1 is freed
      const m1 = store.moveSessionToTab(a.id, 3, 1, "file:///tmp/mock.html");
      expect(m1.fromTabIds).toEqual([1]);
      expect(m1.displacedSessionId).toBeNull();
      expect(store.getTabBinding(1)).toBeNull();
      expect(store.getTabBinding(3)?.sessionId).toBe(a.id);
      expect(store.getSessionFull(a.id)!.tabId).toBe(3);

      // A moves onto tab 2: B is displaced and archived, A is on tab 2 only
      const m2 = store.moveSessionToTab(a.id, 2, 1, "https://b.test/");
      expect(m2.fromTabIds).toEqual([3]);
      expect(m2.displacedSessionId).toBe(b.id);
      expect(store.getTabBinding(3)).toBeNull();
      expect(store.getTabBinding(2)?.sessionId).toBe(a.id);
      expect(store.getSession(b.id)!.archived).toBe(true);
      expect(store.listBindings().length).toBe(1);

      // Moving onto the tab it already owns changes nothing
      const m3 = store.moveSessionToTab(a.id, 2, 1, "");
      expect(m3.fromTabIds).toEqual([]);
      expect(m3.displacedSessionId).toBeNull();
    } finally {
      store.close();
    }
  });
});
