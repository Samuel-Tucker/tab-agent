importScripts("browser-runtime.js");

const DAEMON_HTTP = "http://127.0.0.1:7752";
const DAEMON_WS = "ws://127.0.0.1:7752/ws?role=extension";

let ws = null;
let reconnectTimer = null;
let keepAliveTimer = null;
const lastUrlByTab = new Map();
const boundTabIds = new Set();

function sendWs(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(payload));
    } catch {}
  }
}

const browserRuntime = globalThis.createTabAgentBrowser({
  onStats(tabId, stats) {
    sendWs({ type: "cdp_stats", tabId, ...stats });
  },
  onDetached(tabId) {
    sendWs({ type: "cdp_detached", tabId });
  },
});

function connectDaemonWs() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  try {
    ws = new WebSocket(DAEMON_WS);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    keepAliveTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        sendWs({ type: "ping", ts: Date.now() });
      }
    }, 20_000);
    restoreBoundTabPanels().finally(() => syncCurrentActiveTab());
  };

  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === "radar_updated" && msg.radar) {
      updateRadarBadge(msg.radar);
      return;
    }
    if (msg.type === "browser_rpc") {
      const res = await browserRuntime.handleOp(msg.op, msg.args || {});
      sendWs({
        type: "browser_result",
        bid: msg.bid,
        ok: res.ok,
        data: res.data,
        error: res.error,
      });
    }
  };

  ws.onclose = () => {
    ws = null;
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
    scheduleReconnect();
  };

  ws.onerror = () => {
    try { ws?.close(); } catch {}
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectDaemonWs();
  }, 2500);
}

function updateRadarBadge(radar) {
  if (!chrome.action?.setBadgeText || !radar) return;
  let text = "";
  let color = "#1E4E8C";
  const workingTotal = Number(radar.tabWorking || 0) + Number(radar.pigeonWorking || 0);
  const readyTotal = Number(radar.tabAttention || 0) + Number(radar.pigeonNeedsYou || 0);
  if (radar.tabError > 0) {
    text = "!";
    color = "#A23B17";
  } else if (readyTotal > 0) {
    text = String(Math.min(99, readyTotal));
    color = "#146A43";
  } else if (workingTotal > 0) {
    text = String(Math.min(99, workingTotal));
    color = "#1E4E8C";
  }
  chrome.action.setBadgeText({ text }).catch(() => {});
  if (text) {
    chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
    chrome.action.setBadgeTextColor?.({ color: "#FFFFFF" }).catch(() => {});
  }
  const parts = [];
  if (radar.tabError > 0) parts.push(`${radar.tabError} error`);
  if (radar.tabAttention > 0) parts.push(`${radar.tabAttention} ready`);
  if (workingTotal > 0) parts.push(`${workingTotal} working`);
  if (radar.pigeonNeedsYou > 0) parts.push(`${radar.pigeonNeedsYou} Pigeon-Hole waiting`);
  if (radar.armedTriggers > 0) parts.push(`${radar.armedTriggers} /after armed`);
  const title = parts.length ? `Tab-Agent · ${parts.join(" · ")}` : "Open Tab-Agent Sidebar";
  chrome.action.setTitle?.({ title }).catch(() => {});
}

async function syncTabWithDaemon(tab, active = true) {
  if (!tab || tab.id == null) return null;
  const payload = {
    tabId: tab.id,
    windowId: tab.windowId ?? null,
    url: tab.url || "",
    title: tab.title || "",
    active: Boolean(active),
  };
  lastUrlByTab.set(tab.id, payload.url);
  try {
    const res = await fetch(`${DAEMON_HTTP}/api/tabs/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.session?.id) {
      boundTabIds.add(tab.id);
      enableTabPanel(tab.id);
      saveTabBindingMirror(tab.id, data.session.id, payload.url);
    } else {
      boundTabIds.delete(tab.id);
      removeTabBindingMirror(tab.id);
    }
    notifySidePanel({ type: "TAB_STATE", ...data, activeTab: payload });
    return data;
  } catch {
    notifySidePanel({ type: "DAEMON_OFFLINE", activeTab: payload });
    return null;
  }
}

async function saveTabBindingMirror(tabId, sessionId, url) {
  try {
    const cur = (await chrome.storage.local.get("tabBindings")).tabBindings || {};
    cur[String(tabId)] = { sessionId, url, updatedAt: Date.now() };
    await chrome.storage.local.set({ tabBindings: cur });
  } catch {}
}

async function removeTabBindingMirror(tabId) {
  try {
    const cur = (await chrome.storage.local.get("tabBindings")).tabBindings || {};
    if (cur[String(tabId)]) {
      delete cur[String(tabId)];
      await chrome.storage.local.set({ tabBindings: cur });
    }
  } catch {}
}

function normalizeMatchUrl(raw) {
  if (!raw || typeof raw !== "string") return "";
  try {
    const u = new URL(raw);
    // Keep Pigeon-Hole cubby hash so different cubby tabs don't collide
    if ((u.hostname === "127.0.0.1" || u.hostname === "localhost") && u.port === "7742" && u.hash) {
      return `${u.origin}${u.pathname}${u.hash}`;
    }
    return `${u.origin}${u.pathname}${u.search}`;
  } catch {
    return raw.trim();
  }
}

function enableTabPanel(tabId) {
  if (!chrome.sidePanel || tabId == null) return;
  chrome.sidePanel.setOptions({ tabId, path: PANEL_PATH, enabled: true }).catch(() => {});
}

let restoringPanels = null;
async function restoreBoundTabPanels() {
  if (restoringPanels) return restoringPanels;
  restoringPanels = (async () => {
    try {
      const openTabs = await chrome.tabs.query({});
      const openById = new Map(openTabs.filter((t) => t.id != null).map((t) => [t.id, t]));

      // 1. Fast local restore (survives extension reload even before daemon replies)
      try {
        const stored = (await chrome.storage.local.get("tabBindings")).tabBindings || {};
        for (const [idStr] of Object.entries(stored)) {
          const id = Number(idStr);
          if (openById.has(id)) {
            boundTabIds.add(id);
            enableTabPanel(id);
          }
        }
      } catch {}

      // 2. Authoritative reconcile against daemon SQLite bindings
      const res = await fetch(`${DAEMON_HTTP}/api/bootstrap`);
      if (!res.ok) return;
      const boot = await res.json();
      const bindings = Array.isArray(boot.bindings) ? boot.bindings : [];
      const liveBoundTabIds = new Set();
      const staleBindings = [];

      for (const b of bindings) {
        if (typeof b.tabId === "number" && openById.has(b.tabId)) {
          liveBoundTabIds.add(b.tabId);
          boundTabIds.add(b.tabId);
          enableTabPanel(b.tabId);
          saveTabBindingMirror(b.tabId, b.sessionId, openById.get(b.tabId)?.url || b.lastUrl || "");
        } else {
          staleBindings.push(b);
        }
      }

      // 3. Re-attach any stale binding (e.g. tab recreated with new tabId after reload/restart) to its matching open unbound tab
      if (staleBindings.length > 0) {
        const unboundOpen = openTabs.filter((t) => t.id != null && !liveBoundTabIds.has(t.id) && t.url);
        for (const b of staleBindings) {
          const targetNorm = normalizeMatchUrl(b.lastUrl || "");
          if (!targetNorm || targetNorm.startsWith("chrome://newtab")) continue;
          const idx = unboundOpen.findIndex((t) => normalizeMatchUrl(t.url) === targetNorm);
          if (idx === -1) continue;
          const [matchedTab] = unboundOpen.splice(idx, 1);
          try {
            const mv = await fetch(`${DAEMON_HTTP}/api/sessions/${encodeURIComponent(b.sessionId)}/move`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                tabId: matchedTab.id,
                windowId: matchedTab.windowId ?? null,
                url: matchedTab.url || "",
                title: matchedTab.title || "",
                reason: "reattached after reload",
              }),
            });
            if (mv.ok) {
              liveBoundTabIds.add(matchedTab.id);
              boundTabIds.add(matchedTab.id);
              enableTabPanel(matchedTab.id);
              saveTabBindingMirror(matchedTab.id, b.sessionId, matchedTab.url || "");
            }
          } catch {}
        }
      }
    } catch {
      // Daemon offline; fast local restore above already ran
    } finally {
      restoringPanels = null;
    }
  })();
  return restoringPanels;
}

function notifySidePanel(message) {
  try {
    chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
  } catch {}
}

async function getActiveTab(windowId) {
  // Each window has its own side panel: answer for the panel's own window when it says which one.
  const query = typeof windowId === "number" ? { active: true, windowId } : { active: true, lastFocusedWindow: true };
  const tabs = await chrome.tabs.query(query);
  return tabs[0] || null;
}

async function syncCurrentActiveTab() {
  const tab = await getActiveTab();
  if (tab) return syncTabWithDaemon(tab);
  return null;
}

/* ---- Per-tab side panel ----
 * No global panel (manifest has no side_panel.default_path). The toolbar icon enables the panel for that one tab
 * and opens it, so closing it with X in one tab leaves every other tab's panel as it was. */
const PANEL_PATH = "sidepanel.html";

function setupPanelBehaviour() {
  if (!chrome.sidePanel) return;
  chrome.sidePanel.setPanelBehavior?.({ openPanelOnActionClick: false }).catch(() => {});
  chrome.sidePanel
    .setOptions({ enabled: false })
    .catch(() => {})
    .finally(() => {
      restoreBoundTabPanels();
    });
}

chrome.action.onClicked.addListener((tab) => {
  if (!tab || tab.id == null || !chrome.sidePanel) return;
  // No await before open(): it must run inside the click's user gesture.
  chrome.sidePanel.setOptions({ tabId: tab.id, path: PANEL_PATH, enabled: true });
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
});

/* ---- Chrome Event Listeners ---- */
chrome.runtime.onInstalled.addListener(() => {
  setupPanelBehaviour();
  connectDaemonWs();
});

chrome.runtime.onStartup.addListener(() => {
  setupPanelBehaviour();
  connectDaemonWs();
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  connectDaemonWs();
  if (boundTabIds.has(tabId)) enableTabPanel(tabId);
  try {
    const tab = await chrome.tabs.get(tabId);
    await syncTabWithDaemon(tab);
  } catch {}
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (boundTabIds.has(tabId) && (changeInfo.status === "loading" || changeInfo.status === "complete")) {
    enableTabPanel(tabId);
  }
  if (!changeInfo.url && !changeInfo.title && changeInfo.status !== "complete") return;
  const prevUrl = lastUrlByTab.get(tabId);
  const nextUrl = tab.url || "";
  if (changeInfo.status === "complete" || (nextUrl && nextUrl !== prevUrl) || changeInfo.title) {
    if (tab.active) {
      await syncTabWithDaemon(tab);
    } else if (nextUrl && nextUrl !== prevUrl) {
      // Quiet background URL update for bound tabs
      try {
        await fetch(`${DAEMON_HTTP}/api/tabs/sync`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tabId, windowId: tab.windowId ?? null, url: nextUrl, title: tab.title || "" }),
        });
      } catch {}
    }
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  lastUrlByTab.delete(tabId);
  boundTabIds.delete(tabId);
  browserRuntime.detach(tabId);
  removeTabBindingMirror(tabId);
  try {
    await fetch(`${DAEMON_HTTP}/api/tabs/${tabId}/closed`, { method: "POST" });
  } catch {}
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  syncCurrentActiveTab();
});

/* ---- Messages from Side Panel / Picker ---- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;

  if (msg.type === "GET_ACTIVE_TAB") {
    (async () => {
      connectDaemonWs();
      const tab = await getActiveTab(msg.windowId);
      if (!tab) return sendResponse({ ok: false });
      const syncData = await syncTabWithDaemon(tab);
      sendResponse({
        ok: true,
        tab: { tabId: tab.id, windowId: tab.windowId, url: tab.url || "", title: tab.title || "" },
        syncData,
      });
    })();
    return true;
  }

  if (msg.type === "START_PICKER") {
    (async () => {
      const tab = msg.tabId ? await chrome.tabs.get(msg.tabId).catch(() => null) : await getActiveTab();
      if (!tab || tab.id == null) return sendResponse({ ok: false, error: "No active tab." });
      const mode = msg.mode === "pin" ? "pin" : "pick";
      const startIndex = typeof msg.startIndex === "number" && msg.startIndex >= 1 ? Math.floor(msg.startIndex) : 1;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (m, idx) => {
            window.__TAB_AGENT_PICKER_MODE__ = m;
            window.__TAB_AGENT_PIN_START_INDEX__ = idx;
          },
          args: [mode, startIndex],
        });
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["picker.js"] });
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || "Cannot pin on this page (restricted URL)." });
      }
    })();
    return true;
  }

  if (msg.type === "PIN_CAPTURED" && msg.pin) {
    (async () => {
      const tab = sender.tab || (await getActiveTab());
      let screenshotDataUrl = "";
      if (tab && typeof tab.windowId === "number") {
        try {
          screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
        } catch {
          screenshotDataUrl = "";
        }
      }
      notifySidePanel({
        type: "PIN_NOTE_ADDED",
        tabId: tab?.id ?? null,
        windowId: tab?.windowId ?? null,
        pin: msg.pin,
        screenshotDataUrl,
        done: Boolean(msg.done),
      });
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === "ELEMENT_PICKED" || msg.type === "PICKER_CANCELLED") {
    notifySidePanel({
      ...msg,
      tabId: sender.tab?.id ?? null,
      windowId: sender.tab?.windowId ?? null,
    });
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

setupPanelBehaviour();
connectDaemonWs();
