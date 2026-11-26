(function () {
  "use strict";

  const DAEMON_HTTP = "http://127.0.0.1:7752";
  const DAEMON_WS = "ws://127.0.0.1:7752/ws?role=panel";

  const state = {
    daemonOnline: false,
    extensionConnected: false,
    harnesses: [],
    rules: [],
    activeTab: null, // { tabId, windowId, url, title }
    session: null,   // SessionFull + cdp
    repoMatch: null, // RepoCandidate
    recoverable: null,
    domainChanged: null,
    selectedHarnessId: "agy-neon",
    selectedEffort: "low",
    pendingChips: [],
    pendingAttachments: [], // { localId, status: 'uploading'|'ready', name, size, previewUrl, blobUrl, attachment }
    dismissedSuggestHost: null,
    dismissedRecoverId: null,
    dismissedPigeonCubbyId: null,
    followingToTabId: null, // tab we just opened and moved this chat into (no "moved away" toast)
    pigeon: null,           // PigeonTabContext when on Pigeon-Hole or fetched on demand
    radar: null,            // RadarSummary across all tabs + Pigeon-Hole
    relayDrafts: {},        // relayId -> edited text
    relayTargets: {},       // relayId -> selected target cubby id
    relayBusy: {},          // relayId -> boolean
    shellRuns: {},          // runId -> ShellRunRecord
    shellRunBySlot: {},     // `${sessionId}:${msgId}:${blockIdx}` -> runId
    dismissedShellRuns: {}, // runId -> true
    sharedShellRuns: {},    // runId -> true
  };

  let myWindowId = null; // each Chrome window has its own side panel; only listen for our own window

  const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|avif|heic|heif|tiff?)$/i;
  let dragDepth = 0;
  let toastTimer = null;

  const $ = (id) => document.getElementById(id);
  const el = {
    app: $("app"),
    statusDot: $("status-dot"),
    chatTitleBtn: $("chat-title-btn"),
    chatTitleText: $("chat-title-text"),
    renameBtn: $("rename-btn"),
    emptyPickBtn: $("empty-pick-btn"),
    chatTitleInput: $("chat-title-input"),
    workingPill: $("working-pill"),
    workingPillText: $("working-pill-text"),
    modelBtn: $("model-btn"),
    newChatBtn: $("new-chat-btn"),
    closeChatBtn: $("close-chat-btn"),
    repoBtn: $("repo-btn"),
    urlHost: $("url-host"),
    repoName: $("repo-name"),
    relayModeBtn: $("relay-mode-btn"),
    inspectBtn: $("inspect-btn"),
    inspectLabel: $("inspect-label"),
    pickBtn: $("pick-btn"),
    cdpBar: $("cdp-bar"),
    cdpStatText: $("cdp-stat-text"),
    cdpDetachBtn: $("cdp-detach-btn"),
    offlineBanner: $("offline-banner"),
    retryBtn: $("retry-btn"),
    radarBar: $("radar-bar"),
    afterBanner: $("after-banner"),
    pigeonRepoBanner: $("pigeon-repo-banner"),
    pigeonRepoText: $("pigeon-repo-text"),
    pigeonRepoSwitch: $("pigeon-repo-switch"),
    pigeonRepoDismiss: $("pigeon-repo-dismiss"),
    repoSuggestBanner: $("repo-suggest-banner"),
    repoSuggestText: $("repo-suggest-text"),
    repoSuggestPin: $("repo-suggest-pin"),
    repoSuggestDismiss: $("repo-suggest-dismiss"),
    recoverBanner: $("recover-banner"),
    recoverTitle: $("recover-title"),
    recoverMeta: $("recover-meta"),
    recoverResumeBtn: $("recover-resume-btn"),
    recoverDismissBtn: $("recover-dismiss-btn"),
    domainChangedBanner: $("domain-changed-banner"),
    domainChangedText: $("domain-changed-text"),
    domainNewBtn: $("domain-new-btn"),
    domainDismissBtn: $("domain-dismiss-btn"),
    chatScroll: $("chat-scroll"),
    emptyState: $("empty-state"),
    emptyTabBadge: $("empty-tab-badge"),
    emptyDesc: $("empty-desc"),
    messages: $("messages"),
    eventsDrawer: $("events-drawer"),
    eventsSummaryLabel: $("events-summary-label"),
    eventsCount: $("events-count"),
    eventsList: $("events-list"),
    attachmentsTray: $("attachments-tray"),
    chipsBar: $("chips-bar"),
    promptInput: $("prompt-input"),
    attachBtn: $("attach-btn"),
    pinNoteBtn: $("pin-note-btn"),
    attachFileInput: $("attach-file-input"),
    footHint: $("foot-hint"),
    stopBtn: $("stop-btn"),
    sendBtn: $("send-btn"),
    dropOverlay: $("drop-overlay"),
    lightbox: $("image-lightbox"),
    lightboxImg: $("lightbox-img"),
    lightboxName: $("lightbox-name"),
    lightboxClose: $("lightbox-close"),
    toast: $("toast"),
    modelPopover: $("model-popover"),
    modelList: $("model-list"),
    effortRow: $("effort-row"),
    repoPopover: $("repo-popover"),
    repoPopUrl: $("repo-pop-url"),
    repoSearchInput: $("repo-search-input"),
    repoResults: $("repo-results"),
    rulesList: $("rules-list"),
    switcher: $("switcher"),
    switcherInput: $("switcher-input"),
    switcherList: $("switcher-list"),
    switcherSendto: $("switcher-sendto"),
  };

  let ws = null;
  let wsRetryTimer = null;

  // Chat switcher state
  const sw = { hits: [], flat: [], sel: 0, renaming: null, tabs: [], openTabIds: new Set(), seq: 0 };

  function hostOf(rawUrl) {
    try {
      const u = new URL(rawUrl);
      if (u.protocol === "http:" || u.protocol === "https:") {
        return u.port ? `${u.hostname.replace(/^www\./, "")}:${u.port}` : u.hostname.replace(/^www\./, "");
      }
      return u.protocol.replace(/:$/, "");
    } catch {
      return "tab";
    }
  }

  function relTime(ts) {
    const diff = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  async function api(path, opts = {}) {
    const res = await fetch(`${DAEMON_HTTP}${path}`, {
      ...opts,
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    });
    if (!res.ok) {
      let err = `HTTP ${res.status}`;
      try { const j = await res.json(); if (j.error) err = j.error; } catch {}
      throw new Error(err);
    }
    return res.json();
  }

  function closeOverlays() {
    el.modelPopover.classList.add("hidden");
    el.repoPopover.classList.add("hidden");
    el.switcher.classList.add("hidden");
    el.chatTitleBtn.classList.remove("open");
    sw.renaming = null;
    el.lightbox.classList.add("hidden");
  }

  function showToast(msg, isWarn = false) {
    el.toast.textContent = msg;
    el.toast.className = `toast${isWarn ? " warn" : ""}`;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.add("hidden"), 3200);
  }

  function formatBytes(n) {
    if (!n || n < 0) return "";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function attachmentSrc(url) {
    if (!url) return "";
    if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("blob:") || url.startsWith("data:")) {
      return url;
    }
    return `${DAEMON_HTTP}${url}`;
  }

  function openLightbox(src, name) {
    el.lightboxImg.src = src;
    el.lightboxName.textContent = name || "Image";
    el.lightbox.classList.remove("hidden");
  }

  function formatDuration(ms) {
    const sec = Math.max(0, Math.floor(ms / 1000));
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (m < 60) return `${m}m ${String(s).padStart(2, "0")}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }

  function liveRunSeverity(runStatus) {
    if (!runStatus) return "active";
    const silentMs = Math.max(0, Date.now() - (runStatus.lastActivityAt || runStatus.startedAt || Date.now()));
    if (silentMs >= 180_000) return "stale";
    if (silentMs >= 45_000) return "quiet";
    return "active";
  }

  function liveFreshnessCopy(runStatus) {
    if (!runStatus) return "starting…";
    const silentMs = Math.max(0, Date.now() - (runStatus.lastActivityAt || runStatus.startedAt || Date.now()));
    if (silentMs < 3_000) return "active now";
    if (silentMs < 45_000) return `active ${Math.floor(silentMs / 1000)}s ago`;
    if (silentMs < 180_000) return `quiet ${formatDuration(silentMs)} (still running)`;
    return `no output for ${formatDuration(silentMs)} — may be stalled`;
  }

  function updateLiveWorkTimers() {
    const s = state.session;
    const isWorking = Boolean(s && (s.state === "working" || s.isRunning));
    if (!isWorking) {
      el.workingPill.classList.add("hidden");
      return;
    }
    const rs = s.runStatus || null;
    const sev = liveRunSeverity(rs);
    const elapsed = rs?.startedAt ? formatDuration(Date.now() - rs.startedAt) : "0s";
    el.workingPill.classList.remove("hidden");
    el.workingPill.classList.toggle("quiet", sev === "quiet");
    el.workingPill.classList.toggle("stale", sev === "stale");
    el.workingPillText.textContent = sev === "stale" ? `Stalled? ${elapsed}` : elapsed;
    el.workingPill.title = `${rs?.currentStep || "Working…"} (${liveFreshnessCopy(rs)})`;

    const box = el.messages.querySelector("[data-live-work-box]");
    if (box) {
      box.classList.toggle("quiet", sev === "quiet");
      box.classList.toggle("stale", sev === "stale");
      const lbl = box.querySelector("[data-live-label]");
      if (lbl) lbl.textContent = sev === "stale" ? "No output" : sev === "quiet" ? "Waiting" : "Working";
      const elSpan = box.querySelector("[data-live-elapsed]");
      if (elSpan) elSpan.textContent = elapsed;
      const frSpan = box.querySelector("[data-live-fresh]");
      if (frSpan) frSpan.textContent = `· ${liveFreshnessCopy(rs)}`;
    }
  }

  setInterval(updateLiveWorkTimers, 1000);

  /* ---- Rendering ---- */
  function renderHeader() {
    const s = state.session;
    const isWorking = Boolean(s && (s.state === "working" || s.isRunning));
    el.statusDot.className = "status-dot " + (!state.daemonOnline ? "offline" : isWorking ? "working" : "online");
    updateLiveWorkTimers();

    el.chatTitleText.textContent = s ? s.name : "No chat on this tab";
    el.renameBtn.classList.toggle("hidden", !s);
    el.closeChatBtn.classList.toggle("hidden", !s);

    const fam = s ? s.family : (state.harnesses.find((h) => h.id === state.selectedHarnessId)?.family || "AGY");
    const mod = s ? s.model : (state.harnesses.find((h) => h.id === state.selectedHarnessId)?.model || "NEON");
    const eff = s ? s.effort : state.selectedEffort;
    el.modelBtn.textContent = `${fam} · ${mod} · ${eff} ▾`;

    const url = state.activeTab?.url || s?.lastUrl || "";
    el.urlHost.textContent = url ? hostOf(url) : "no tab";
    el.repoName.textContent = s ? s.repoName : (state.repoMatch?.repoName || "Browser Scratch");

    const pageAccess = Boolean(s && s.pageAccess);
    el.inspectBtn.className = `inspect-btn ${pageAccess ? "on" : "off"}`;
    el.inspectLabel.textContent = pageAccess ? "Seeing Page" : "See Page";
    el.pickBtn.classList.toggle("hidden", !pageAccess);

    const onPigeon = Boolean(state.pigeon?.isPigeonHole);
    const hasRelays = Boolean(s && Array.isArray(s.relays) && s.relays.length > 0);
    el.app.classList.toggle("on-pigeon-hole", onPigeon);
    el.relayModeBtn.classList.toggle("hidden", !onPigeon && !hasRelays);
    const rMode = s?.pigeonRelayMode === "auto-queue" ? "auto-queue" : "ask";
    el.relayModeBtn.textContent = rMode === "auto-queue" ? "Relay: Auto-Queue" : "Relay: Ask";
    el.relayModeBtn.classList.toggle("auto", rMode === "auto-queue");

    if (pageAccess) {
      const cdp = s.cdp || { consoleErrors: 0, failedRequests: 0 };
      el.cdpBar.classList.remove("hidden");
      el.cdpStatText.textContent = `CDP live · ${cdp.consoleErrors || 0} console err · ${cdp.failedRequests || 0} net err`;
    } else {
      el.cdpBar.classList.add("hidden");
    }

    el.stopBtn.classList.toggle("hidden", !isWorking);
    el.sendBtn.textContent = isWorking ? "Queue" : "Send";
  }

  function renderBanners() {
    el.offlineBanner.classList.toggle("hidden", state.daemonOnline);

    // Cross-tab & Pigeon-Hole Radar strip:
    // - Collapsed count pill for all working sessions ("Working: N")
    // - Individual clickable chips ONLY for Ready / Needs you / Error (removed as soon as opened or looked at)
    const curSid = state.session?.id || null;
    const curPigeonId = state.pigeon?.activeSessionId || null;
    const totalWorking = Number(state.radar?.tabWorking || 0) + Number(state.radar?.pigeonWorking || 0);
    const actionItems = (state.radar?.items || []).filter((it) => {
      if (it.state === "working") return false;
      if (it.kind === "tab" && it.id === curSid) return false;
      if (it.kind === "pigeon" && it.id === curPigeonId && state.pigeon?.isPigeonHole) return false;
      return true;
    });
    if (state.daemonOnline && (totalWorking > 0 || actionItems.length > 0)) {
      const esc = TabAgentFormat.escapeHtml;
      const prio = { error: 0, stale: 1, done: 2, "needs-you": 3 };
      const sorted = actionItems
        .slice()
        .sort((a, b) => (prio[a.state] ?? 9) - (prio[b.state] ?? 9) || b.updatedAt - a.updatedAt)
        .slice(0, 5);
      const workingPillHtml =
        totalWorking > 0
          ? `<button type="button" class="radar-chip working" data-radar-working="1" title="Open chat switcher (⌘K) to inspect working sessions"><span class="radar-dot"></span><span>Working: ${totalWorking}</span></button>`
          : "";
      const actionChipsHtml = sorted
        .map((it) => {
          const tag =
            it.state === "error"
              ? "Error"
              : it.state === "stale"
                ? "Stalled?"
                : it.state === "done"
                  ? "Ready"
                  : "Needs you";
          const prefix = it.kind === "pigeon" ? "PH · " : "";
          const title = `${prefix}${it.name} — ${it.detail || tag}`;
          const dataAttr =
            it.kind === "tab" && it.tabId !== null
              ? `data-radar-tab="${it.tabId}" data-radar-sid="${esc(it.id)}"`
              : `data-radar-url="${esc(it.url)}" data-radar-pigeon-id="${esc(it.id)}"`;
          return `<button type="button" class="radar-chip ${esc(it.state)}" ${dataAttr} title="${esc(title)}"><span class="radar-dot"></span><span>${esc(tag)}: ${esc(prefix + it.name)} ↗</span></button>`;
        })
        .join("");
      el.radarBar.innerHTML = `<span class="radar-label">Radar</span>${workingPillHtml}${actionChipsHtml}`;
      el.radarBar.classList.remove("hidden");
    } else {
      el.radarBar.classList.add("hidden");
      el.radarBar.innerHTML = "";
    }

    // Armed /after triggers on this chat
    const armedTriggers = (state.session?.triggers || []).filter((t) => t.status === "armed");
    if (state.daemonOnline && armedTriggers.length > 0) {
      const esc = TabAgentFormat.escapeHtml;
      el.afterBanner.innerHTML = armedTriggers
        .map(
          (t) => `<div class="after-row" data-trigger-id="${esc(t.id)}">
            <span class="after-copy" title="${esc(t.instruction)}">⏰ After <strong>${esc(t.targetName)}</strong> finishes → ${esc(t.instruction)}</span>
            <button type="button" class="sm-btn" data-cancel-trigger="${esc(t.id)}">Cancel</button>
          </div>`
        )
        .join("");
      el.afterBanner.classList.remove("hidden");
    } else {
      el.afterBanner.classList.add("hidden");
      el.afterBanner.innerHTML = "";
    }

    // Pigeon-Hole active cubby repo suggestion banner
    const activeCubby = state.pigeon?.online ? state.pigeon.activeCubby : null;
    const showPigeonRepo =
      state.daemonOnline &&
      activeCubby &&
      activeCubby.path &&
      state.session &&
      activeCubby.path !== state.session.repoPath &&
      state.dismissedPigeonCubbyId !== activeCubby.id;
    if (showPigeonRepo) {
      el.pigeonRepoText.innerHTML = `Cubby repo: <strong>${TabAgentFormat.escapeHtml(activeCubby.name)}</strong> (linked to ${TabAgentFormat.escapeHtml(state.session.repoName)})`;
      el.pigeonRepoBanner.classList.remove("hidden");
    } else {
      el.pigeonRepoBanner.classList.add("hidden");
    }

    // Tier 3 repo-map suggestion banner
    const curHost = hostOf(state.activeTab?.url || "");
    const showSuggest =
      state.daemonOnline &&
      state.repoMatch &&
      state.repoMatch.source === "repo-map" &&
      state.dismissedSuggestHost !== curHost &&
      (!state.session || state.session.repoSource === "scratch");
    if (showSuggest) {
      el.repoSuggestText.innerHTML = `Suggested repo for <code>${TabAgentFormat.escapeHtml(curHost)}</code>: <strong>${TabAgentFormat.escapeHtml(state.repoMatch.repoName)}</strong>`;
      el.repoSuggestBanner.classList.remove("hidden");
    } else {
      el.repoSuggestBanner.classList.add("hidden");
    }

    // Closed-tab domain reopen recovery banner
    const rec = state.recoverable;
    const showRecover =
      state.daemonOnline &&
      !state.session &&
      rec &&
      state.dismissedRecoverId !== rec.id;
    if (showRecover) {
      el.recoverTitle.textContent = rec.tabId
        ? `Chat for ${hostOf(rec.lastUrl)} is open in another tab`
        : `Previous chat for ${hostOf(rec.lastUrl)}`;
      el.recoverResumeBtn.textContent = rec.tabId ? "Move here" : "Resume";
      el.recoverMeta.textContent = `"${rec.name}" · ${rec.messageCount} msgs · ${relTime(rec.updatedAt)}`;
      el.recoverBanner.classList.remove("hidden");
    } else {
      el.recoverBanner.classList.add("hidden");
    }

    // Cross-domain navigation pill (chat stays stuck to tab)
    if (state.domainChanged && state.session) {
      el.domainChangedText.textContent = `Tab moved to ${hostOf(state.domainChanged.toOrigin)} — chat stays attached.`;
      el.domainChangedBanner.classList.remove("hidden");
    } else {
      el.domainChangedBanner.classList.add("hidden");
    }
  }

  /* ---- .html files mentioned by the agent: open them and let the chat follow ---- */
  const HTML_BACKTICK_RE = /`([^`\n]+?\.html?)`/gi;
  const HTML_URL_RE = /\b(?:https?|file):\/\/[^\s<>"'`()\[\]]+?\.html?(?:[?#][^\s<>"'`()\[\]]*[^\s<>"'`()\[\].,;:!?])?(?=[\s<>"'`()\[\].,;:!?]|$)/gi;
  const HTML_PATH_RE = /(?:^|[\s(\["'])((?:~\/|\.{1,2}\/|\/)?(?:[\w@%+=,.-]+\/)*[\w@%+=,-][\w@%+=,.-]*\.html?)(?=[\s)\]"'.,;:!?]|$)/gim;

  function extractHtmlRefs(text) {
    if (!text) return [];
    const refs = [];
    const add = (r) => {
      const v = String(r || "").trim();
      if (v && !refs.includes(v)) refs.push(v);
    };
    let rest = String(text).replace(HTML_BACKTICK_RE, (_, inner) => {
      add(inner);
      return " ";
    });
    rest = rest.replace(/\]\(([^)\s]+)\)/g, (_, href) => {
      if (/\.html?(?:[?#]|$)/i.test(href)) add(href);
      return "] ";
    });
    rest = rest.replace(HTML_URL_RE, (u) => {
      add(u);
      return " ";
    });
    for (const m of rest.matchAll(HTML_PATH_RE)) add(m[1]);
    return refs.slice(0, 6);
  }

  function htmlRefLabel(ref) {
    const clean = ref.split(/[?#]/)[0];
    return clean.split("/").filter(Boolean).pop() || ref;
  }

  function renderHtmlOpenBar(text) {
    const refs = extractHtmlRefs(text);
    if (!refs.length) return "";
    const esc = TabAgentFormat.escapeHtml;
    return `<div class="html-open-bar">${refs
      .map(
        (r) => `<div class="html-ref">
          <span class="html-ref-icon">◧</span>
          <span class="html-ref-name" title="${esc(r)}">${esc(htmlRefLabel(r))}</span>
          <button type="button" class="sm-btn primary" data-open-html="${esc(r)}" data-open-mode="tab" title="Open in a new tab — this chat moves with it">Open ↗</button>
          <button type="button" class="sm-btn" data-open-html="${esc(r)}" data-open-mode="window" title="Open in a new window — this chat moves with it">⧉</button>
        </div>`
      )
      .join("")}</div>`;
  }

  async function moveSessionTo(sessionId, tab, reason) {
    const data = await api(`/api/sessions/${encodeURIComponent(sessionId)}/move`, {
      method: "POST",
      body: JSON.stringify({ tabId: tab.tabId, windowId: tab.windowId, url: tab.url || "", title: tab.title || "", reason }),
    });
    return data.session;
  }

  // Panels are per tab: give the tab the chat moves into its own open panel.
  function enablePanelFor(tabId) {
    try {
      chrome.sidePanel?.setOptions({ tabId, path: "sidepanel.html", enabled: true });
    } catch {}
  }

  async function openPanelFor(tabId) {
    try {
      await chrome.sidePanel.open({ tabId });
    } catch {
      showToast("Chat moved — click the Tab-Agent icon on the new tab to see it");
    }
  }

  async function openHtmlAndFollow(ref, mode) {
    if (typeof chrome === "undefined" || !chrome.tabs) return;
    const sess = state.session;
    let targetUrl = ref;
    if (!/^https?:\/\//i.test(ref)) {
      if (!sess) return showToast("No chat on this tab to resolve that file", true);
      let info;
      try {
        info = await api(`/api/sessions/${encodeURIComponent(sess.id)}/resolve-file?path=${encodeURIComponent(ref)}`);
      } catch (err) {
        return showToast(err?.message || "Could not resolve file", true);
      }
      if (!info.exists) return showToast(`Not found: ${info.displayPath}`, true);
      targetUrl = info.fileUrl;
      let fileOk = true;
      try { fileOk = await chrome.extension.isAllowedFileSchemeAccess(); } catch {}
      if (!fileOk) {
        showToast("Turn on “Allow access to file URLs” for Tab-Agent, then click Open again", true);
        chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }).catch(() => {});
        return;
      }
    }

    try {
      if (mode === "window") {
        const win = await chrome.windows.create({ url: targetUrl, focused: true });
        const newTab = win.tabs && win.tabs[0];
        if (!newTab) return;
        enablePanelFor(newTab.id);
        if (sess) {
          state.followingToTabId = newTab.id;
          await moveSessionTo(sess.id, { tabId: newTab.id, windowId: win.id, url: targetUrl, title: "" }, `opened ${htmlRefLabel(ref)}`);
        }
        await openPanelFor(newTab.id);
      } else {
        const cur = state.activeTab?.tabId ? await chrome.tabs.get(state.activeTab.tabId).catch(() => null) : null;
        const createOpts = { url: targetUrl, active: false };
        if (cur) {
          createOpts.windowId = cur.windowId;
          createOpts.index = cur.index + 1;
          createOpts.openerTabId = cur.id;
        } else if (myWindowId !== null) {
          createOpts.windowId = myWindowId;
        }
        const newTab = await chrome.tabs.create(createOpts);
        enablePanelFor(newTab.id);
        if (sess) {
          state.followingToTabId = newTab.id;
          await moveSessionTo(sess.id, { tabId: newTab.id, windowId: newTab.windowId, url: targetUrl, title: "" }, `opened ${htmlRefLabel(ref)}`);
        }
        await chrome.tabs.update(newTab.id, { active: true });
        await openPanelFor(newTab.id);
      }
    } catch (err) {
      showToast(err?.message || "Could not open that page", true);
    }
  }

  // Follow the bottom only when the reader is already there (or just sent, or switched chats);
  // otherwise keep their place while replies stream in.
  let lastRenderedSessionId = null;
  let forceScrollBottom = false;
  const PIN_SLACK_PX = 48;

  function formatShellShareMarkdown(run) {
    const out = (run.output || "").trim() || "(no output)";
    const exitLbl = run.exitCode !== null ? `exit ${run.exitCode}` : run.status;
    return `Ran in \`${run.displayCwd || run.cwd}\` (${exitLbl}):\n\`\`\`sh\n${run.command}\n\`\`\`\nOutput:\n\`\`\`\n${out.slice(0, 12000)}\n\`\`\``;
  }

  function renderTermDrawerHtml(run) {
    const esc = TabAgentFormat.escapeHtml;
    const dur =
      run.finishedAt && run.startedAt
        ? ` · ${((run.finishedAt - run.startedAt) / 1000).toFixed(1)}s`
        : "";
    const statusText =
      run.status === "running"
        ? "● Running…"
        : run.status === "done"
          ? `✓ exit ${run.exitCode ?? 0}${dur}`
          : run.status === "killed"
            ? `■ stopped${dur}`
            : `✕ exit ${run.exitCode ?? 1}${dur}`;
    const hasOut = Boolean(run.output && run.output.length > 0);
    const outBody = hasOut
      ? esc(run.output) + (run.truncated ? "\n…(truncated at 64 KB)" : "")
      : run.status === "running"
        ? "Running…"
        : "(no output)";
    const shared = Boolean(state.sharedShellRuns[run.id]);
    const footBtns =
      run.status === "running"
        ? `<button type="button" class="tbtn danger" data-shell-kill="${esc(run.id)}">Stop</button>` +
          `<button type="button" class="tbtn" data-shell-copy="${esc(run.id)}">Copy</button>`
        : `<button type="button" class="tbtn ${shared ? "good" : "pri"}" data-shell-share="${esc(run.id)}">${shared ? "Shared ✓" : "Share with agent"}</button>` +
          `<button type="button" class="tbtn" data-shell-compose="${esc(run.id)}" title="Paste command + output into compose box so you can add a note">→ Compose</button>` +
          `<button type="button" class="tbtn" data-shell-copy="${esc(run.id)}">Copy</button>` +
          `<button type="button" class="tbtn close" data-shell-close="${esc(run.id)}" title="Hide output">×</button>`;

    return `<div class="term-drawer" data-shell-run="${esc(run.id)}" data-shell-status="${esc(run.status)}">` +
      `<div class="term-hd"><span class="term-status ${esc(run.status)}">${esc(statusText)}</span><span class="term-cwd" title="${esc(run.cwd || "")}">${esc(run.displayCwd || "")}</span></div>` +
      `<pre class="term-out${hasOut ? "" : " empty"}">${outBody}</pre>` +
      `<div class="term-foot">${footBtns}</div>` +
      `</div>`;
  }

  function hydrateShellDrawers() {
    const sid = state.session?.id;
    if (!sid) return;
    for (const [slotKey, runId] of Object.entries(state.shellRunBySlot)) {
      if (!slotKey.startsWith(`${sid}:`)) continue;
      if (state.dismissedShellRuns[runId]) continue;
      const run = state.shellRuns[runId];
      if (!run) continue;
      const parts = slotKey.split(":");
      const msgId = parts[1];
      const blockIdx = parts[2];
      const codeEl = el.messages.querySelector(
        `[data-msg-id="${CSS.escape(msgId)}"] .md-code[data-code-idx="${CSS.escape(blockIdx)}"]`
      );
      if (!codeEl) continue;
      const existing = codeEl.querySelector(".term-drawer");
      if (existing) existing.remove();
      codeEl.insertAdjacentHTML("beforeend", renderTermDrawerHtml(run));
      const pre = codeEl.querySelector(".term-out");
      if (pre && run.status === "running") pre.scrollTop = pre.scrollHeight;
    }
  }

  function patchShellDrawer(run) {
    if (!run || state.dismissedShellRuns[run.id]) return;
    const existing = el.messages.querySelector(`.term-drawer[data-shell-run="${CSS.escape(run.id)}"]`);
    if (existing) {
      const tmp = document.createElement("div");
      tmp.innerHTML = renderTermDrawerHtml(run);
      const nextEl = tmp.firstElementChild;
      if (nextEl) {
        existing.replaceWith(nextEl);
        const pre = nextEl.querySelector(".term-out");
        if (pre) pre.scrollTop = pre.scrollHeight;
      }
      return;
    }
    hydrateShellDrawers();
  }

  function patchShellOutput(runId, output, truncated) {
    const run = state.shellRuns[runId];
    if (!run) return;
    run.output = output;
    run.truncated = Boolean(truncated);
    const drawer = el.messages.querySelector(`.term-drawer[data-shell-run="${CSS.escape(runId)}"]`);
    if (!drawer) return;
    const pre = drawer.querySelector(".term-out");
    if (!pre) return;
    const nearBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight <= 24;
    pre.classList.remove("empty");
    pre.textContent = output + (run.truncated ? "\n…(truncated at 64 KB)" : "");
    if (nearBottom) pre.scrollTop = pre.scrollHeight;
  }

  function renderRelayCard(rel) {
    const esc = TabAgentFormat.escapeHtml;
    const busy = Boolean(state.relayBusy[rel.id]);
    const cubbies = Array.isArray(state.pigeon?.cubbies) ? state.pigeon.cubbies : [];
    const selectedTarget = state.relayTargets[rel.id] ?? rel.targetSessionId ?? "";
    const matchedCubby = cubbies.find((c) => c.id === selectedTarget) || null;
    const targetLabel = matchedCubby?.name || rel.targetName || selectedTarget || "Pick cubby";
    const isWorking = matchedCubby ? matchedCubby.state === "working" : true;
    const pigeonOffline = state.pigeon && state.pigeon.online === false;
    const draftText = state.relayDrafts[rel.id] !== undefined ? state.relayDrafts[rel.id] : rel.text;

    let cls = "relay-card";
    let hdLeft = "";
    let hdRight = "";
    if (rel.status === "staged") {
      if (rel.mode === "steer") cls += " warn";
      hdLeft = `${rel.mode === "steer" ? "Steer Gate → " : "Relay → "}${targetLabel}`;
      hdRight = pigeonOffline ? "Offline" : matchedCubby ? matchedCubby.state : selectedTarget ? "Staged" : "Pick cubby";
    } else if (rel.status === "queued") {
      cls += " sent";
      hdLeft = `Queued in ${targetLabel} ✓`;
      hdRight = rel.pigeonQueueId !== null ? `queueId #${rel.pigeonQueueId}` : "Queued";
    } else if (rel.status === "steered") {
      cls += " steered";
      hdLeft = `Steered ${targetLabel} ✓`;
      hdRight = "Live";
    } else if (rel.status === "sent") {
      cls += " sent";
      hdLeft = `Sent to ${targetLabel} ✓`;
      hdRight = "Started";
    } else if (rel.status === "undone") {
      cls += " muted";
      hdLeft = `Removed from ${targetLabel} queue`;
      hdRight = "Undone";
    } else if (rel.status === "dismissed") {
      cls += " muted";
      hdLeft = `Relay dismissed (${targetLabel})`;
      hdRight = "Not sent";
    } else {
      cls += " warn";
      hdLeft = `Relay failed (${targetLabel})`;
      hdRight = "Failed";
    }

    const errHtml = rel.error ? `<div class="relay-error">${esc(rel.error)}</div>` : "";
    let bodyHtml = "";

    if (rel.status === "staged") {
      const showPicker = cubbies.length > 0 && (!selectedTarget || cubbies.length > 1);
      const pickerHtml = showPicker
        ? `<div class="relay-target-row"><span>Cubby:</span><select class="relay-select" data-relay-target="${esc(rel.id)}" ${busy ? "disabled" : ""}>${
            !selectedTarget ? `<option value="">Choose Pigeon-Hole cubby…</option>` : ""
          }${cubbies
            .map(
              (c) =>
                `<option value="${esc(c.id)}"${c.id === selectedTarget ? " selected" : ""}>${esc(c.name)} (${esc(c.state)})</option>`
            )
            .join("")}</select></div>`
        : "";
      const dis = busy || pigeonOffline || !selectedTarget ? "disabled" : "";
      const primaryQueueLabel = isWorking ? "Queue Next" : "Send Now";
      const primaryBtns =
        rel.mode === "steer"
          ? `<button type="button" class="rbtn s" data-relay-confirm="${esc(rel.id)}" data-relay-mode="steer" ${dis}>Confirm Steer</button>` +
            `<button type="button" class="rbtn q" data-relay-confirm="${esc(rel.id)}" data-relay-mode="queue" ${dis}>Downgrade to Queue</button>`
          : `<button type="button" class="rbtn q" data-relay-confirm="${esc(rel.id)}" data-relay-mode="${isWorking ? "queue" : "send"}" ${dis}>${primaryQueueLabel}</button>` +
            `<button type="button" class="rbtn s" data-relay-confirm="${esc(rel.id)}" data-relay-mode="steer" ${dis}>Steer</button>`;
      const retryBtn = pigeonOffline
        ? `<button type="button" class="rbtn" data-relay-retry-status="1">Retry :7742</button>`
        : "";
      bodyHtml = `${pickerHtml}${errHtml}<textarea class="relay-edit" data-relay-edit="${esc(rel.id)}" ${busy ? "disabled" : ""}>${esc(draftText)}</textarea>` +
        `<div class="relay-acts">${primaryBtns}${retryBtn}<button type="button" class="rbtn" data-relay-copy="${esc(rel.id)}">Copy</button><button type="button" class="rbtn" data-relay-dismiss="${esc(rel.id)}" ${busy ? "disabled" : ""}>Dismiss</button></div>`;
    } else if (rel.status === "queued") {
      const hasQid = rel.pigeonQueueId !== null;
      bodyHtml = `${errHtml}<div class="relay-preview">${esc(rel.text)}</div>` +
        `<div class="relay-acts">${
          hasQid
            ? `<button type="button" class="rbtn s" data-relay-promote="${esc(rel.id)}" ${busy ? "disabled" : ""}>Promote to Steer</button>` +
              `<button type="button" class="rbtn d" data-relay-undo="${esc(rel.id)}" ${busy ? "disabled" : ""}>Undo</button>`
            : ""
        }<button type="button" class="rbtn" data-relay-copy="${esc(rel.id)}">Copy</button></div>`;
    } else {
      bodyHtml = `${errHtml}<div class="relay-preview">${esc(rel.text)}</div>`;
    }

    return `<div class="${cls}" data-relay-id="${esc(rel.id)}" data-relay-status="${esc(rel.status)}">` +
      `<div class="relay-hd"><span>${esc(hdLeft)}</span><span>${esc(hdRight)}</span></div>` +
      `<div class="relay-body">${bodyHtml}</div>` +
      `</div>`;
  }

  function renderMessages() {
    const s = state.session;
    const sc = el.chatScroll;
    const wasPinned = sc.scrollHeight - sc.scrollTop - sc.clientHeight <= PIN_SLACK_PX;
    const prevTop = sc.scrollTop;
    const switched = (s?.id ?? null) !== lastRenderedSessionId;
    lastRenderedSessionId = s?.id ?? null;

    // Preserve active editing inside a staged Relay Card across streaming / WS updates
    const activeEl = document.activeElement;
    const activeRelayEditId = activeEl?.getAttribute?.("data-relay-edit") || null;
    const selStart = activeRelayEditId ? activeEl.selectionStart : null;
    const selEnd = activeRelayEditId ? activeEl.selectionEnd : null;

    const relays = Array.isArray(s?.relays) ? s.relays : [];
    if (!s || ((!s.messages || s.messages.length === 0) && relays.length === 0)) {
      el.emptyState.classList.remove("hidden");
      el.emptyTabBadge.textContent = state.activeTab?.tabId ? "Sticky to this tab" : "Ready";
      el.messages.innerHTML = "";
      el.eventsDrawer.classList.add("hidden");
      return;
    }

    el.emptyState.classList.add("hidden");
    const msgIds = new Set((s.messages || []).map((m) => m.id));
    const relaysByMsg = new Map();
    const standaloneRelays = [];
    for (const rel of relays) {
      if (rel.messageId && msgIds.has(rel.messageId)) {
        const list = relaysByMsg.get(rel.messageId) || [];
        list.push(rel);
        relaysByMsg.set(rel.messageId, list);
      } else {
        standaloneRelays.push(rel);
      }
    }

    const isWorking = Boolean(s && (s.state === "working" || s.isRunning));
    const rs = isWorking ? s.runStatus || null : null;
    const activeMsgId =
      rs?.activeAgentMessageId ??
      (isWorking
        ? [...(s.messages || [])].reverse().find((x) => x.sender === "agent")?.id ?? null
        : null);

    const html = (s.messages || [])
      .map((m) => {
        const who = m.sender === "human" ? "You" : m.sender === "system" ? "Tab-Agent · /after" : `${s.family} · ${s.model}`;
        const isLiveMsg = Boolean(isWorking && m.sender === "agent" && (m.isStreaming || m.id === activeMsgId));
        const isErrMsg =
          !isLiveMsg &&
          m.sender === "agent" &&
          (/^\s*Harness error:/i.test(m.text || "") || /^\s*\*\(Stopped: no output/i.test(m.text || ""));
        const chipsHtml =
          Array.isArray(m.chips) && m.chips.length
            ? `<div class="msg-chips">${m.chips
                .map((c, idx) => {
                  const isPin = typeof c.pinIndex === "number" || typeof c.note === "string";
                  if (isPin) {
                    const num = c.pinIndex || idx + 1;
                    const lbl = TabAgentFormat.escapeHtml(c.label || c.selector || "element");
                    const note = c.note ? `<span class="el-chip-note" title="${TabAgentFormat.escapeHtml(c.note)}">“${TabAgentFormat.escapeHtml(c.note)}”</span>` : "";
                    return `<span class="el-chip is-pin" title="${TabAgentFormat.escapeHtml(c.selector || "")}"><span class="el-chip-num">#${num}</span><span class="el-chip-label">${lbl}</span>${note}</span>`;
                  }
                  return `<span class="el-chip">⦾ ${TabAgentFormat.escapeHtml(c.label || c.selector)}</span>`;
                })
                .join("")}</div>`
            : "";
        const attsHtml =
          Array.isArray(m.attachments) && m.attachments.length
            ? `<div class="msg-attachments">${m.attachments
                .map((a) => {
                  const src = TabAgentFormat.escapeHtml(attachmentSrc(a.url));
                  const name = TabAgentFormat.escapeHtml(a.name || "image");
                  return `<button type="button" class="msg-att-btn" data-lightbox-src="${src}" data-lightbox-name="${name}" title="${name}"><img src="${src}" alt="${name}" /></button>`;
                })
                .join("")}</div>`
            : "";
        const bodyHtml = m.text ? TabAgentFormat.renderMarkdown(m.text) : "";
        const streamTail = isLiveMsg && m.text ? `<span class="streaming-cursor"></span>` : "";

        let liveWorkHtml = "";
        if (isLiveMsg) {
          const sev = liveRunSeverity(rs);
          const elapsed = rs?.startedAt ? formatDuration(Date.now() - rs.startedAt) : "0s";
          const fresh = liveFreshnessCopy(rs);
          const step = rs?.currentStep || "Thinking…";
          const stepSuffix = rs?.stepCount > 0 ? ` · ${rs.stepCount} tool${rs.stepCount === 1 ? "" : "s"}` : "";
          const qBadge =
            rs?.queuedCount > 0
              ? `<span class="live-work-queue">${rs.queuedCount} queued</span>`
              : "";
          const lbl = sev === "stale" ? "No output" : sev === "quiet" ? "Waiting" : "Working";
          liveWorkHtml = `<div class="live-work-box${m.text ? " compact" : ""}${sev === "quiet" ? " quiet" : sev === "stale" ? " stale" : ""}" data-live-work-box="1">
            <div class="live-work-top">
              <span class="work-pulse"></span>
              <span data-live-label>${lbl}</span>
              <span data-live-elapsed>${elapsed}</span>
              <span class="live-work-fresh" data-live-fresh>· ${TabAgentFormat.escapeHtml(fresh)}</span>
              ${qBadge}
            </div>
            <div class="live-work-step" data-live-step>${TabAgentFormat.escapeHtml(step)}${TabAgentFormat.escapeHtml(stepSuffix)}</div>
          </div>`;
        }

        const openBar = m.sender === "agent" && !isLiveMsg ? renderHtmlOpenBar(m.text) : "";
        const msgRelays = relaysByMsg.get(m.id) || [];
        const relaysHtml = msgRelays.map(renderRelayCard).join("");
        const errPill = isErrMsg
          ? `<span class="msg-err-badge">${/Stopped: no output/i.test(m.text || "") ? "Stalled" : "Harness error"}</span>`
          : "";
        const cardCls = `msg-card ${m.sender}${isLiveMsg ? " is-working" : ""}${isErrMsg ? " is-error" : ""}`;
        return `<article class="${cardCls}" data-msg-id="${m.id}">
          <div class="msg-head"><span>${TabAgentFormat.escapeHtml(who)} ${errPill}</span><span>${TabAgentFormat.escapeHtml(m.time || "")}</span></div>
          ${chipsHtml}
          ${attsHtml}
          ${bodyHtml || streamTail ? `<div class="msg-body">${bodyHtml}${streamTail}</div>` : ""}
          ${liveWorkHtml}
          ${relaysHtml}
          ${openBar}
        </article>`;
      })
      .join("");
    const standaloneHtml = standaloneRelays.length
      ? `<div class="standalone-relays">${standaloneRelays.map(renderRelayCard).join("")}</div>`
      : "";
    el.messages.innerHTML = html + standaloneHtml;
    hydrateShellDrawers();

    if (activeRelayEditId) {
      const nextTa = el.messages.querySelector(`[data-relay-edit="${CSS.escape(activeRelayEditId)}"]`);
      if (nextTa) {
        nextTa.focus();
        if (typeof selStart === "number" && typeof selEnd === "number") {
          try { nextTa.setSelectionRange(selStart, selEnd); } catch {}
        }
      }
    }

    // Collapsible harness/tool events drawer
    const events = s.events || [];
    if (events.length > 0) {
      el.eventsDrawer.classList.remove("hidden");
      el.eventsCount.textContent = String(events.length);
      const lastEv = events[events.length - 1];
      el.eventsSummaryLabel.textContent = lastEv ? `Activity · ${lastEv.summary.slice(0, 44)}` : "Activity";
      el.eventsList.innerHTML = events
        .slice(-30)
        .reverse()
        .map(
          (ev) =>
            `<li><span class="ev-ts">${TabAgentFormat.escapeHtml(ev.ts)}</span><span>${TabAgentFormat.escapeHtml(ev.summary)}</span></li>`
        )
        .join("");
    } else {
      el.eventsDrawer.classList.add("hidden");
    }

    if (switched || forceScrollBottom || wasPinned) sc.scrollTop = sc.scrollHeight;
    else sc.scrollTop = prevTop;
    forceScrollBottom = false;
  }

  function renderChips() {
    if (state.pendingChips.length === 0) {
      el.chipsBar.classList.add("hidden");
      el.chipsBar.innerHTML = "";
      return;
    }
    el.chipsBar.classList.remove("hidden");
    el.chipsBar.innerHTML = state.pendingChips
      .map((c, i) => {
        const isPin = typeof c.pinIndex === "number" || typeof c.note === "string";
        if (isPin) {
          const num = c.pinIndex || i + 1;
          const lbl = TabAgentFormat.escapeHtml(c.label || c.selector || "element");
          const noteHtml = c.note
            ? `<span class="el-chip-note" title="${TabAgentFormat.escapeHtml(c.note)}">“${TabAgentFormat.escapeHtml(c.note)}”</span>`
            : "";
          return `<span class="el-chip is-pin" title="${TabAgentFormat.escapeHtml(c.selector || "")}"><span class="el-chip-num">#${num}</span><span class="el-chip-label">${lbl}</span>${noteHtml}<button type="button" data-remove-chip="${i}" title="Remove pin">×</button></span>`;
        }
        return `<span class="el-chip" title="${TabAgentFormat.escapeHtml(c.selector)}">⦾ ${TabAgentFormat.escapeHtml(c.label)}<button type="button" data-remove-chip="${i}">×</button></span>`;
      })
      .join("");
  }

  function renderAttachmentsTray() {
    if (state.pendingAttachments.length === 0) {
      el.attachmentsTray.classList.add("hidden");
      el.attachmentsTray.innerHTML = "";
      return;
    }
    el.attachmentsTray.classList.remove("hidden");
    el.attachmentsTray.innerHTML = state.pendingAttachments
      .map((item) => {
        const src = TabAgentFormat.escapeHtml(attachmentSrc(item.previewUrl));
        const name = TabAgentFormat.escapeHtml(item.name || "image");
        const sub = item.status === "uploading" ? "Uploading…" : formatBytes(item.size) || "Ready";
        return `<div class="att-card ${item.status === "uploading" ? "uploading" : ""}">
          <button type="button" class="att-thumb" ${src ? `data-lightbox-src="${src}" data-lightbox-name="${name}"` : "disabled"} title="${name}">
            ${src ? `<img src="${src}" alt="${name}" />` : ""}
          </button>
          <div class="att-meta">
            <span class="att-name" title="${name}">${name}</span>
            <span class="att-size">${TabAgentFormat.escapeHtml(sub)}</span>
          </div>
          <button type="button" class="att-remove" data-remove-att="${TabAgentFormat.escapeHtml(item.localId)}" title="Remove image">×</button>
        </div>`;
      })
      .join("");
  }

  function renderAll() {
    renderHeader();
    renderBanners();
    renderMessages();
    renderChips();
    renderAttachmentsTray();
  }

  /* ---- Model Popover ---- */
  function openModelPopover() {
    closeOverlays();
    const curId = state.session?.harnessId || state.selectedHarnessId;
    const curEff = state.session?.effort || state.selectedEffort;
    const curSpec = state.harnesses.find((h) => h.id === curId) || state.harnesses[0];

    el.modelList.innerHTML = state.harnesses
      .map(
        (h) =>
          `<button type="button" class="model-opt ${h.id === curId ? "active" : ""}" data-harness-id="${h.id}">
            <span>${TabAgentFormat.escapeHtml(h.label)}</span>
            <small>${TabAgentFormat.escapeHtml(h.baseModel)}</small>
          </button>`
      )
      .join("");

    const efforts = curSpec ? curSpec.efforts : ["low", "medium", "high"];
    el.effortRow.innerHTML = efforts
      .map(
        (ef) =>
          `<button type="button" class="effort-btn ${ef === curEff ? "active" : ""}" data-effort="${ef}">${ef}</button>`
      )
      .join("");

    el.modelPopover.classList.remove("hidden");
  }

  /* ---- Repo & Rules Popover ---- */
  async function openRepoPopover() {
    closeOverlays();
    el.repoPopUrl.textContent = state.activeTab?.url || state.session?.lastUrl || "(no active URL)";
    el.repoSearchInput.value = "";
    el.repoPopover.classList.remove("hidden");
    await Promise.all([loadRepoResults(""), loadRulesList()]);
    el.repoSearchInput.focus();
  }

  async function loadRepoResults(q) {
    try {
      const data = await api(`/api/repos?q=${encodeURIComponent(q)}&limit=15`);
      const curHost = hostOf(state.activeTab?.url || "");
      el.repoResults.innerHTML = (data.repos || [])
        .map(
          (r) =>
            `<div class="repo-item">
              <div class="item-row">
                <strong>${TabAgentFormat.escapeHtml(r.name)}</strong>
                <div style="display:flex;gap:4px;">
                  <button type="button" class="sm-btn" data-use-repo-path="${TabAgentFormat.escapeHtml(r.path)}" data-use-repo-name="${TabAgentFormat.escapeHtml(r.name)}">Use</button>
                  ${curHost && curHost !== "tab" ? `<button type="button" class="sm-btn primary" data-pin-repo-path="${TabAgentFormat.escapeHtml(r.path)}" data-pin-repo-name="${TabAgentFormat.escapeHtml(r.name)}">Pin ${TabAgentFormat.escapeHtml(curHost)}</button>` : ""}
                </div>
              </div>
              <div class="item-sub">${TabAgentFormat.escapeHtml(r.displayPath)}</div>
            </div>`
        )
        .join("") || `<div class="item-sub">No matching repos found.</div>`;
    } catch {
      el.repoResults.innerHTML = `<div class="item-sub">Daemon offline.</div>`;
    }
  }

  async function loadRulesList() {
    try {
      const data = await api("/api/rules");
      state.rules = data.rules || [];
      el.rulesList.innerHTML =
        state.rules
          .map(
            (r) =>
              `<div class="rule-item">
                <div class="item-row">
                  <span><code>${TabAgentFormat.escapeHtml(r.pattern)}</code> → <strong>${TabAgentFormat.escapeHtml(r.repoName)}</strong></span>
                  <button type="button" class="sm-btn" data-del-rule="${r.id}">×</button>
                </div>
              </div>`
          )
          .join("") || `<div class="item-sub">No pinned URL rules yet. Click "Pin" on any repo above.</div>`;
    } catch {}
  }

  /* ---- Chat Switcher (⌘K or the chat title) ---- */
  function shortUrl(u) {
    return String(u || "").replace(/^https?:\/\//, "").replace(/^www\./, "");
  }

  // Escape text and mark the first match of q (raw-text match, so & < > in either never break the markup)
  function highlight(text, q) {
    const esc = TabAgentFormat.escapeHtml;
    const raw = String(text || "");
    if (!q) return esc(raw);
    const i = raw.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return esc(raw);
    return `${esc(raw.slice(0, i))}<mark>${esc(raw.slice(i, i + q.length))}</mark>${esc(raw.slice(i + q.length))}`;
  }

  function isSwitcherOpen() {
    return !el.switcher.classList.contains("hidden");
  }

  async function openSwitcher() {
    closeOverlays();
    el.switcher.classList.remove("hidden");
    el.chatTitleBtn.classList.add("open");
    el.switcherInput.value = "";
    sw.sel = 0;
    sw.renaming = null;
    el.switcherInput.focus();
    await loadSwitcher("");
  }

  async function loadSwitcher(q) {
    const seq = ++sw.seq;
    let hits;
    try {
      hits = (await api(`/api/history?q=${encodeURIComponent(q)}&limit=60`)).hits || [];
    } catch {
      el.switcherList.innerHTML = `<div class="sw-empty">Daemon offline — run bin/tab-agent start</div>`;
      return;
    }
    let tabs = [];
    try { tabs = await chrome.tabs.query({}); } catch {}
    if (seq !== sw.seq) return; // a newer search finished first
    sw.hits = hits;
    sw.tabs = tabs;
    sw.openTabIds = new Set(tabs.map((t) => t.id));
    renderSwitcher();
  }

  function renderSwitcher() {
    const esc = TabAgentFormat.escapeHtml;
    const q = el.switcherInput.value.trim();
    const hereTab = state.activeTab?.tabId ?? null;
    const curId = state.session?.id ?? null;
    const isHere = (h) => h.id === curId || (h.tabId !== null && h.tabId === hereTab);
    // A binding to a tab that no longer exists (browser restarted) counts as closed.
    const isOpen = (h) => h.tabId !== null && sw.openTabIds.has(h.tabId);
    const visible = sw.hits.filter((h) => isHere(h) || h.messageCount > 0);
    const here = visible.filter(isHere);
    const open = visible.filter((h) => !isHere(h) && isOpen(h));
    const closed = visible.filter((h) => !isHere(h) && !isOpen(h));
    sw.flat = [...here, ...open, ...closed];
    if (sw.sel >= sw.flat.length) sw.sel = Math.max(0, sw.flat.length - 1);

    let idx = 0;
    const row = (h, group) => {
      const i = idx++;
      const running = state.session?.id === h.id && state.session.isRunning;
      const dot = group === "closed" ? "closed" : running ? "working" : h.state;
      const nameHtml =
        sw.renaming === h.id
          ? `<input class="sw-name-input" data-sw-ren-input="${esc(h.id)}" value="${esc(h.name)}" maxlength="120" />`
          : `<strong>${highlight(h.name, q)}</strong><button type="button" class="sw-ren" data-sw-ren="${esc(h.id)}" title="Rename">✎</button>${
              group === "closed" ? "" : `<button type="button" class="sw-close" data-sw-close="${esc(h.id)}" title="Close this chat (history kept)">⏻</button>`
            }`;
      const acts =
        group === "here"
          ? `<span class="sw-here">● here</span>`
          : group === "open"
            ? `<button type="button" class="sm-btn" data-sw-go="${esc(h.id)}">Go to</button><button type="button" class="sm-btn primary" data-sw-move="${esc(h.id)}">Move here</button>`
            : `<button type="button" class="sm-btn primary" data-sw-move="${esc(h.id)}">Attach here</button>`;
      return `<div class="sw-row${i === sw.sel ? " sel" : ""}" data-sw-idx="${i}">
        <span class="sw-dot ${esc(dot)}"></span>
        <div class="sw-name">${nameHtml}</div>
        <div class="sw-acts">${acts}</div>
        <div class="sw-url">${highlight(shortUrl(h.lastUrl) || "no page yet", q)}</div>
        <div class="sw-dir">▸ ${highlight(h.repoName, q)}</div>
      </div>`;
    };

    let html = "";
    if (here.length) html += `<div class="sw-grp">This tab</div>${here.map((h) => row(h, "here")).join("")}`;
    if (open.length) html += `<div class="sw-grp">On other open tabs</div>${open.map((h) => row(h, "open")).join("")}`;
    if (closed.length) html += `<div class="sw-grp">Closed tabs</div>${closed.map((h) => row(h, "closed")).join("")}`;
    if (!sw.flat.length) html = `<div class="sw-empty">${q ? `No chat matches “${esc(q)}”` : "No chats yet."}</div>`;
    el.switcherList.innerHTML = html;
    el.switcherList.querySelector(".sw-row.sel")?.scrollIntoView({ block: "nearest" });

    // Footer: send this chat to another open tab in this window
    if (state.session && hereTab !== null) {
      const targets = sw.tabs
        .filter((t) => t.id !== hereTab && (myWindowId === null || t.windowId === myWindowId) && /^(https?|file):/i.test(t.url || ""))
        .slice(0, 10);
      el.switcherSendto.innerHTML = targets.length
        ? `<span>Send this chat to:</span>${targets
            .map((t) => {
              const label = (t.title || hostOf(t.url || "")).trim();
              const short = label.length > 26 ? `${label.slice(0, 25)}…` : label;
              return `<button type="button" class="sm-btn" data-sw-send="${t.id}" title="${esc(`${label}\n${t.url || ""}`)}">${esc(short)}</button>`;
            })
            .join("")}`
        : "";
    } else {
      el.switcherSendto.innerHTML = "";
    }
  }

  function focusSwitcherRename() {
    const inp = el.switcherList.querySelector("[data-sw-ren-input]");
    if (inp) { inp.focus(); inp.select(); }
  }

  async function commitSwitcherRename(sessionId, value) {
    sw.renaming = null;
    const hit = sw.hits.find((h) => h.id === sessionId);
    const next = String(value || "").trim().slice(0, 120);
    if (!hit || !next || next === hit.name) return renderSwitcher();
    hit.name = next;
    renderSwitcher();
    el.switcherInput.focus();
    try {
      const data = await api(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: "PATCH",
        body: JSON.stringify({ name: next }),
      });
      if (state.session?.id === sessionId) {
        state.session = data.session;
        renderHeader();
      }
    } catch (err) {
      showToast(err?.message || "Rename failed", true);
    }
  }

  // Show a tab, with its own side panel open (panels are per tab).
  function goToTab(tabId) {
    enablePanelFor(tabId);
    // open() first, before any await, so it still counts as part of the click
    chrome.sidePanel?.open({ tabId }).catch(() => {});
    chrome.tabs.update(tabId, { active: true }).catch(() => {});
    chrome.tabs.get(tabId).then((t) => chrome.windows.update(t.windowId, { focused: true })).catch(() => {});
  }

  // Close a chat: the daemon stops any running turn, switches See Page off and takes it off its tab.
  // History stays; ⌘K → Closed tabs → Attach here brings it back.
  async function closeChat(sessionId) {
    if (!sessionId) return;
    try {
      await api(`/api/sessions/${encodeURIComponent(sessionId)}/close`, { method: "POST" });
    } catch (err) {
      return showToast(err?.message || "Could not close the chat", true);
    }
    if (isSwitcherOpen() && !sw.renaming) loadSwitcher(el.switcherInput.value.trim()).catch(() => {});
  }

  async function switcherMoveHere(sessionId) {
    if (!state.activeTab?.tabId) return showToast("No tab to move the chat onto", true);
    try {
      state.session = await moveSessionTo(sessionId, state.activeTab, "moved from switcher");
    } catch (err) {
      return showToast(err?.message || "Move failed", true);
    }
    state.recoverable = null;
    state.domainChanged = null;
    closeOverlays();
    renderAll();
    el.promptInput.focus();
  }

  function switcherGoTo(sessionId) {
    const hit = sw.hits.find((h) => h.id === sessionId);
    if (!hit || hit.tabId === null) return;
    closeOverlays();
    goToTab(hit.tabId);
  }

  async function switcherSendTo(tabId) {
    if (!state.session) return;
    const t = sw.tabs.find((x) => x.id === tabId);
    if (!t) return;
    enablePanelFor(tabId);
    chrome.sidePanel?.open({ tabId }).catch(() => {});
    const sid = state.session.id;
    state.followingToTabId = tabId;
    try {
      await moveSessionTo(sid, { tabId, windowId: t.windowId, url: t.url || "", title: t.title || "" }, "sent from switcher");
    } catch (err) {
      return showToast(err?.message || "Send failed", true);
    }
    closeOverlays();
    goToTab(tabId);
  }

  /* ---- Actions ---- */
  async function ensureSessionForActiveTab(overrides = {}) {
    if (state.session) return state.session;
    const tab = state.activeTab || { tabId: null, windowId: null, url: "", title: "" };
    const body = {
      tabId: tab.tabId,
      windowId: tab.windowId,
      url: tab.url,
      title: tab.title,
      harnessId: state.selectedHarnessId,
      effort: state.selectedEffort,
      ...overrides,
    };
    const data = await api("/api/sessions", { method: "POST", body: JSON.stringify(body) });
    state.session = data.session;
    state.recoverable = null;
    renderAll();
    return state.session;
  }

  /* ---- Image Paste & screen capture Drag-and-Drop Helpers ---- */
  function isImageFile(file) {
    if (!file) return false;
    if (file.type && file.type.toLowerCase().startsWith("image/")) return true;
    return IMAGE_EXT_RE.test(file.name || "");
  }

  function extractFilesFromDataTransfer(dt) {
    if (!dt) return [];
    if (dt.files && dt.files.length > 0) return Array.from(dt.files);
    const out = [];
    if (dt.items) {
      for (const item of dt.items) {
        if (item.kind === "file") {
          const f = item.getAsFile();
          if (f) out.push(f);
        }
      }
    }
    return out;
  }

  function extractImagePathsFromText(raw) {
    if (!raw) return [];
    const lines = String(raw)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    const out = [];
    for (const line of lines) {
      let candidate = line;
      if (/^file:\/\//i.test(candidate)) {
        try {
          candidate = decodeURIComponent(new URL(candidate).pathname);
        } catch {
          candidate = decodeURIComponent(candidate.replace(/^file:\/\//i, ""));
        }
      }
      if ((candidate.startsWith("/") || candidate.startsWith("~/")) && IMAGE_EXT_RE.test(candidate)) {
        out.push(candidate);
      }
    }
    return [...new Set(out)];
  }

  function hasDragImageCandidate(dt) {
    if (!dt) return false;
    if (
      dt.items &&
      Array.from(dt.items).some((it) => it.kind === "file" || (it.type && it.type.startsWith("image/")))
    ) {
      return true;
    }
    if (dt.types) {
      const t = Array.from(dt.types);
      return (
        t.includes("Files") ||
        t.includes("text/uri-list") ||
        t.includes("public.file-url") ||
        t.includes("public.png") ||
        t.includes("public.tiff") ||
        t.includes("NSFilenamesPboardType") ||
        t.includes("text/plain")
      );
    }
    return false;
  }

  async function uploadSingleAttachment(sessionId, entry, fetchInit) {
    state.pendingAttachments.push(entry);
    renderAttachmentsTray();
    try {
      const res = await fetch(`${DAEMON_HTTP}/api/sessions/${encodeURIComponent(sessionId)}/attachments`, fetchInit);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.attachment) {
        throw new Error(data.error || `Upload failed (${res.status})`);
      }
      entry.status = "ready";
      entry.attachment = data.attachment;
      entry.name = data.attachment.name || entry.name;
      entry.size = data.attachment.size || entry.size;
      if (entry.blobUrl) {
        URL.revokeObjectURL(entry.blobUrl);
        entry.blobUrl = "";
      }
      entry.previewUrl = data.attachment.url;
    } catch (err) {
      const idx = state.pendingAttachments.indexOf(entry);
      if (idx !== -1) state.pendingAttachments.splice(idx, 1);
      if (entry.blobUrl) {
        URL.revokeObjectURL(entry.blobUrl);
        entry.blobUrl = "";
      }
      showToast(err?.message || "Could not attach image", true);
    } finally {
      renderAttachmentsTray();
    }
  }

  async function stageImageFiles(rawFiles) {
    if (!state.daemonOnline) return showToast("Daemon offline — start bin/tab-agent", true);
    const images = Array.from(rawFiles || []).filter(isImageFile);
    if (!images.length) return showToast("Only image files can be attached", true);
    const sess = await ensureSessionForActiveTab();
    for (const file of images) {
      const localId = `att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const blobUrl = URL.createObjectURL(file);
      const fd = new FormData();
      fd.append("file", file, file.name || "pasted-image.png");
      const entry = {
        localId,
        status: "uploading",
        name: file.name || "pasted-image.png",
        size: file.size || 0,
        previewUrl: blobUrl,
        blobUrl,
        attachment: null,
      };
      uploadSingleAttachment(sess.id, entry, { method: "POST", body: fd });
    }
  }

  async function stageLocalImagePaths(paths) {
    if (!state.daemonOnline) return showToast("Daemon offline — start bin/tab-agent", true);
    if (!paths || !paths.length) return;
    const sess = await ensureSessionForActiveTab();
    for (const localPath of paths) {
      const localId = `att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const name = localPath.split("/").pop() || "capture.png";
      const entry = {
        localId,
        status: "uploading",
        name,
        size: 0,
        previewUrl: "",
        blobUrl: "",
        attachment: null,
      };
      uploadSingleAttachment(sess.id, entry, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ localPath }),
      });
    }
  }

  // The prompt box grows with what you type, up to just over half the panel, then scrolls.
  function autoGrowPrompt() {
    const ta = el.promptInput;
    ta.style.height = "auto";
    const max = Math.round(window.innerHeight * 0.55);
    ta.style.height = `${Math.min(ta.scrollHeight + 2, max)}px`;
  }

  function nextPinIndex() {
    let maxIdx = 0;
    for (const c of state.pendingChips) {
      if (typeof c.pinIndex === "number" && c.pinIndex > maxIdx) maxIdx = c.pinIndex;
    }
    return maxIdx + 1;
  }

  function cropVisibleTabDataUrl(dataUrl, rect, viewport) {
    return new Promise((resolve) => {
      if (!dataUrl) return resolve(null);
      const img = new Image();
      img.onload = () => {
        try {
          const vw = Math.max(1, Number(viewport?.width) || img.naturalWidth);
          const vh = Math.max(1, Number(viewport?.height) || img.naturalHeight);
          const scaleX = img.naturalWidth / vw;
          const scaleY = img.naturalHeight / vh;
          const pad = 36;
          const rx = Number(rect?.x) || 0;
          const ry = Number(rect?.y) || 0;
          const rw = Math.max(16, Number(rect?.width) || vw);
          const rh = Math.max(16, Number(rect?.height) || vh);

          const sx = Math.max(0, Math.floor((rx - pad) * scaleX));
          const sy = Math.max(0, Math.floor((ry - pad) * scaleY));
          const ex = Math.min(img.naturalWidth, Math.ceil((rx + rw + pad) * scaleX));
          const ey = Math.min(img.naturalHeight, Math.ceil((ry + rh + pad) * scaleY));
          const sw = Math.max(24, ex - sx);
          const sh = Math.max(24, ey - sy);

          // Cap max output edge at 1400px so crops stay crisp and lightweight
          const maxEdge = 1400;
          const down = Math.min(1, maxEdge / Math.max(sw, sh));
          const dw = Math.max(1, Math.round(sw * down));
          const dh = Math.max(1, Math.round(sh * down));

          const canvas = document.createElement("canvas");
          canvas.width = dw;
          canvas.height = dh;
          const ctx = canvas.getContext("2d");
          if (!ctx) return resolve(null);
          ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);
          canvas.toBlob((blob) => resolve(blob || null), "image/png");
        } catch {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }

  async function handlePinNoteAdded(msg) {
    const pin = msg.pin;
    if (!pin) return;
    const pinIndex = typeof pin.pinIndex === "number" ? pin.pinIndex : nextPinIndex();
    const safeSlug = String(pin.label || pin.tag || "element")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "element";
    const fileName = `pin-${pinIndex}-${safeSlug}.png`;
    const localId = `pin-att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const chip = {
      pinIndex,
      selector: pin.selector || "",
      tag: pin.tag || "div",
      label: pin.label || pin.selector || "element",
      text: pin.text || "",
      html: pin.html || "",
      xpath: pin.xpath || "",
      rect: pin.rect || undefined,
      note: pin.note || "",
      attachmentName: msg.screenshotDataUrl ? fileName : undefined,
      _attLocalId: msg.screenshotDataUrl ? localId : undefined,
    };
    state.pendingChips.push(chip);
    renderChips();

    if (msg.screenshotDataUrl && state.daemonOnline) {
      try {
        const sess = await ensureSessionForActiveTab();
        const blob = await cropVisibleTabDataUrl(msg.screenshotDataUrl, pin.rect, pin.viewport);
        if (blob) {
          const blobUrl = URL.createObjectURL(blob);
          const fd = new FormData();
          fd.append("file", blob, fileName);
          const entry = {
            localId,
            status: "uploading",
            name: fileName,
            size: blob.size || 0,
            previewUrl: blobUrl,
            blobUrl,
            attachment: null,
          };
          await uploadSingleAttachment(sess.id, entry, { method: "POST", body: fd });
          if (entry.attachment?.name) {
            chip.attachmentName = entry.attachment.name;
          }
        }
      } catch (err) {
        showToast(err?.message || "Pinned element (screenshot crop unavailable)", true);
      }
    }

    if (msg.done) {
      el.pinNoteBtn?.classList.remove("active");
      el.promptInput.focus();
      showToast(`Pinned #${pinIndex}${pin.note ? ` · "${pin.note.slice(0, 36)}"` : ""}`);
    } else {
      showToast(`Pinned #${pinIndex} — click next element or Esc when done`);
    }
  }

  async function sendPrompt() {
    const text = el.promptInput.value.trim();
    if (!state.daemonOnline) return;
    if (state.pendingAttachments.some((a) => a.status === "uploading")) {
      return showToast("Waiting for image upload to finish…");
    }
    const attachments = state.pendingAttachments
      .filter((a) => a.status === "ready" && a.attachment)
      .map((a) => a.attachment);
    const hasPinnedNotes = state.pendingChips.some((c) => Boolean(c.note && c.note.trim()));
    if (!text && attachments.length === 0 && !hasPinnedNotes) return;

    const chips = state.pendingChips.map(({ _attLocalId, ...rest }) => rest);
    el.promptInput.value = "";
    autoGrowPrompt();
    state.pendingChips = [];
    state.pendingAttachments = [];
    renderChips();
    renderAttachmentsTray();

    const sess = await ensureSessionForActiveTab();
    await api(`/api/sessions/${encodeURIComponent(sess.id)}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text, chips, attachments }),
    });
  }

  async function toggleSeePage(forceState) {
    if (!state.daemonOnline) return;
    const sess = await ensureSessionForActiveTab();
    const next = typeof forceState === "boolean" ? forceState : !sess.pageAccess;
    const data = await api(`/api/sessions/${encodeURIComponent(sess.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ pageAccess: next }),
    });
    state.session = data.session;
    renderAll();
  }

  async function applyTabSyncData(data, activeTab) {
    if (activeTab) state.activeTab = activeTab;
    state.daemonOnline = true;
    state.session = data.session || null;
    state.repoMatch = data.repoMatch || null;
    state.recoverable = data.recoverable || null;
    state.domainChanged = data.domainChanged || null;
    if (data.pigeon !== undefined) state.pigeon = data.pigeon;
    renderAll();
  }

  async function refreshPigeonStatus() {
    if (!state.daemonOnline) return;
    const rawUrl = state.activeTab?.url || state.session?.lastUrl || "";
    const qs = new URLSearchParams();
    if (rawUrl) qs.set("url", rawUrl);
    if (state.session?.id) qs.set("sessionId", state.session.id);
    try {
      const data = await api(`/api/pigeon/status?${qs.toString()}`);
      if (data.pigeon) {
        state.pigeon = data.pigeon;
        renderAll();
      }
    } catch {}
  }

  function upsertSessionRelay(relay) {
    if (!state.session || !relay) return;
    if (!Array.isArray(state.session.relays)) state.session.relays = [];
    const idx = state.session.relays.findIndex((r) => r.id === relay.id);
    if (idx === -1) {
      state.session.relays.push(relay);
      forceScrollBottom = true;
    } else {
      state.session.relays[idx] = relay;
    }
    if (relay.status !== "staged") {
      delete state.relayDrafts[relay.id];
    }
  }

  async function toggleRelayMode() {
    if (!state.daemonOnline) return;
    const sess = await ensureSessionForActiveTab();
    const next = sess.pigeonRelayMode === "auto-queue" ? "ask" : "auto-queue";
    const data = await api(`/api/sessions/${encodeURIComponent(sess.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ pigeonRelayMode: next }),
    });
    state.session = data.session;
    renderHeader();
    showToast(
      next === "auto-queue"
        ? "Pigeon-Hole Relay: Auto-Queue ON (working cubbies queue directly with Undo)"
        : "Pigeon-Hole Relay: Ask (review staged card before sending)"
    );
  }

  async function runRelayAction(relayId, endpoint, body, successToast) {
    state.relayBusy[relayId] = true;
    renderMessages();
    try {
      const data = await api(endpoint, {
        method: "POST",
        body: body ? JSON.stringify(body) : "{}",
      });
      if (data.relay) upsertSessionRelay(data.relay);
      if (successToast) showToast(successToast);
    } catch (err) {
      showToast(err?.message || "Relay action failed", true);
      await refreshPigeonStatus();
    } finally {
      delete state.relayBusy[relayId];
      renderHeader();
      renderMessages();
    }
  }

  function confirmLatestStagedRelay() {
    const relays = Array.isArray(state.session?.relays) ? state.session.relays : [];
    for (let i = relays.length - 1; i >= 0; i--) {
      const rel = relays[i];
      if (rel.status !== "staged" || state.relayBusy[rel.id]) continue;
      const text = state.relayDrafts[rel.id] !== undefined ? state.relayDrafts[rel.id] : rel.text;
      const targetSessionId = state.relayTargets[rel.id] ?? rel.targetSessionId;
      if (!targetSessionId) {
        showToast("Pick a target Pigeon-Hole cubby on the Relay Card first", true);
        return true;
      }
      const cubbies = Array.isArray(state.pigeon?.cubbies) ? state.pigeon.cubbies : [];
      const cub = cubbies.find((c) => c.id === targetSessionId);
      const effMode = rel.mode === "steer" ? "steer" : cub && cub.state !== "working" ? "send" : "queue";
      runRelayAction(
        rel.id,
        `/api/relays/${encodeURIComponent(rel.id)}/confirm`,
        { text, mode: effMode, targetSessionId },
        effMode === "steer" ? "Steered Pigeon-Hole cubby" : effMode === "send" ? "Sent to Pigeon-Hole cubby" : "Queued in Pigeon-Hole"
      ).then(() => el.promptInput.focus());
      return true;
    }
    return false;
  }

  async function bootstrap() {
    if (myWindowId === null && typeof chrome !== "undefined" && chrome.windows?.getCurrent) {
      try { myWindowId = (await chrome.windows.getCurrent()).id; } catch {}
    }
    try {
      const boot = await api("/api/bootstrap");
      state.daemonOnline = true;
      state.extensionConnected = Boolean(boot.extensionConnected);
      state.harnesses = boot.harnesses || [];
      state.rules = boot.rules || [];
      if (boot.radar) state.radar = boot.radar;
    } catch {
      state.daemonOnline = false;
      renderAll();
      return;
    }

    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: "GET_ACTIVE_TAB", windowId: myWindowId }, (resp) => {
        if (chrome.runtime.lastError || !resp?.ok) {
          renderAll();
          return;
        }
        if (resp.syncData) {
          applyTabSyncData(resp.syncData, resp.tab);
        } else {
          state.activeTab = resp.tab;
          renderAll();
        }
      });
    } else {
      renderAll();
    }
  }

  function connectPanelWs() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    try {
      ws = new WebSocket(DAEMON_WS);
    } catch {
      scheduleWsRetry();
      return;
    }

    ws.onopen = () => {
      state.daemonOnline = true;
      if (wsRetryTimer) { clearTimeout(wsRetryTimer); wsRetryTimer = null; }
      bootstrap();
    };

    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      if (msg.type === "hello" && msg.radar) {
        state.radar = msg.radar;
        renderBanners();
        return;
      }

      if (msg.type === "radar_updated" && msg.radar) {
        state.radar = msg.radar;
        renderBanners();
        return;
      }

      if (msg.type === "tab_synced" && state.activeTab && msg.tabId === state.activeTab.tabId) {
        applyTabSyncData(msg, { ...state.activeTab, url: msg.url, title: msg.title });
        return;
      }

      if (msg.type === "session_closed") {
        if (state.session && state.session.id === msg.sessionId) {
          state.session = null;
          state.domainChanged = null;
          state.dismissedRecoverId = msg.sessionId; // don't offer it straight back
          renderAll();
          showToast("Chat closed — ⌘K brings it back");
        }
        if (isSwitcherOpen() && !sw.renaming) loadSwitcher(el.switcherInput.value.trim()).catch(() => {});
        return;
      }

      if (msg.type === "session_moved") {
        const here = state.activeTab?.tabId ?? null;
        if (here !== null && msg.toTabId === here) {
          state.session = msg.session;
          state.recoverable = null;
          state.domainChanged = null;
          renderAll();
        } else if (state.session && state.session.id === msg.sessionId) {
          state.session = null;
          state.domainChanged = null;
          renderAll();
          if (msg.toTabId !== state.followingToTabId) showToast(`Chat moved to ${hostOf(msg.session?.lastUrl || "")}`);
        }
        if (msg.toTabId === state.followingToTabId) state.followingToTabId = null;
        if (isSwitcherOpen() && !sw.renaming) loadSwitcher(el.switcherInput.value.trim()).catch(() => {});
        return;
      }

      if (!state.session) return;
      const sid = state.session.id;

      if (msg.type === "session_updated" && msg.session?.id === sid) {
        state.session = msg.session;
        renderAll();
      } else if (msg.type === "human_message" && msg.sessionId === sid) {
        state.session.messages.push(msg.message);
        forceScrollBottom = true;
        renderMessages();
      } else if (msg.type === "message_start" && msg.sessionId === sid) {
        state.session.messages.push(msg.message);
        renderMessages();
      } else if (msg.type === "message_delta" && msg.sessionId === sid) {
        const m = state.session.messages.find((x) => x.id === msg.messageId);
        if (m) {
          m.text = msg.text;
          m.isStreaming = true;
          renderMessages();
        }
      } else if (msg.type === "message_end" && msg.sessionId === sid) {
        const m = state.session.messages.find((x) => x.id === msg.messageId);
        if (m) {
          m.text = msg.text;
          m.isStreaming = false;
          renderMessages();
        }
      } else if (msg.type === "session_state" && msg.sessionId === sid) {
        state.session.state = msg.state;
        state.session.isRunning = msg.state === "working";
        if (msg.runStatus !== undefined) state.session.runStatus = msg.runStatus;
        if (msg.state !== "working") state.session.runStatus = null;
        renderHeader();
        if (msg.state !== "working") renderMessages();
      } else if (msg.type === "run_status" && msg.sessionId === sid) {
        state.session.runStatus = msg.runStatus || null;
        state.session.isRunning = Boolean(msg.runStatus);
        if (msg.runStatus) state.session.state = "working";
        renderHeader();
        const box = el.messages.querySelector("[data-live-work-box]");
        if (box && msg.runStatus) {
          const stepEl = box.querySelector("[data-live-step]");
          const suffix = msg.runStatus.stepCount > 0 ? ` · ${msg.runStatus.stepCount} tool${msg.runStatus.stepCount === 1 ? "" : "s"}` : "";
          if (stepEl) stepEl.textContent = `${msg.runStatus.currentStep || "Thinking…"}${suffix}`;
          const existingQ = box.querySelector(".live-work-queue");
          if (msg.runStatus.queuedCount > 0) {
            if (existingQ) existingQ.textContent = `${msg.runStatus.queuedCount} queued`;
            else renderMessages();
          } else if (existingQ) {
            existingQ.remove();
          }
          updateLiveWorkTimers();
        } else {
          renderMessages();
        }
      } else if (msg.type === "harness_event" && msg.sessionId === sid) {
        state.session.events.push(msg.event);
        renderMessages();
      } else if (msg.type === "relay_updated" && msg.sessionId === sid && msg.relay) {
        upsertSessionRelay(msg.relay);
        renderHeader();
        renderMessages();
        if (!state.pigeon && msg.relay.status === "staged") {
          refreshPigeonStatus().catch(() => {});
        }
      } else if (msg.type === "trigger_updated" && msg.sessionId === sid && msg.trigger) {
        if (!Array.isArray(state.session.triggers)) state.session.triggers = [];
        const idx = state.session.triggers.findIndex((t) => t.id === msg.trigger.id);
        if (idx === -1) state.session.triggers.push(msg.trigger);
        else state.session.triggers[idx] = msg.trigger;
        renderBanners();
      } else if (msg.type === "shell_start" && msg.sessionId === sid && msg.run) {
        state.shellRuns[msg.run.id] = msg.run;
        delete state.dismissedShellRuns[msg.run.id];
        if (msg.run.messageId !== null && msg.run.blockIdx !== null) {
          state.shellRunBySlot[`${sid}:${msg.run.messageId}:${msg.run.blockIdx}`] = msg.run.id;
        }
        patchShellDrawer(msg.run);
      } else if (msg.type === "shell_delta" && msg.sessionId === sid && msg.runId) {
        patchShellOutput(msg.runId, msg.output || "", Boolean(msg.truncated));
      } else if (msg.type === "shell_end" && msg.sessionId === sid && msg.run) {
        state.shellRuns[msg.run.id] = msg.run;
        if (msg.run.messageId !== null && msg.run.blockIdx !== null) {
          state.shellRunBySlot[`${sid}:${msg.run.messageId}:${msg.run.blockIdx}`] = msg.run.id;
        }
        patchShellDrawer(msg.run);
      } else if (msg.type === "cdp_stats" && state.session.tabId === msg.tabId) {
        state.session.cdp = {
          attached: msg.attached,
          consoleErrors: msg.consoleErrors,
          failedRequests: msg.failedRequests,
        };
        renderHeader();
      }
    };

    ws.onclose = () => {
      ws = null;
      state.daemonOnline = false;
      renderAll();
      scheduleWsRetry();
    };
  }

  function scheduleWsRetry() {
    if (wsRetryTimer) return;
    wsRetryTimer = setTimeout(() => {
      wsRetryTimer = null;
      connectPanelWs();
    }, 2500);
  }

  /* ---- Chrome Runtime Messages from Background / Picker ---- */
  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || typeof msg !== "object") return;
      const otherWindow =
        myWindowId !== null && typeof msg.activeTab?.windowId === "number" && msg.activeTab.windowId !== myWindowId;
      if (msg.type === "TAB_STATE") {
        if (otherWindow) return;
        applyTabSyncData(msg, msg.activeTab);
      } else if (msg.type === "DAEMON_OFFLINE") {
        if (otherWindow) return;
        state.daemonOnline = false;
        state.activeTab = msg.activeTab || state.activeTab;
        renderAll();
      } else if (msg.type === "ELEMENT_PICKED" && msg.chip) {
        if (myWindowId !== null && typeof msg.windowId === "number" && msg.windowId !== myWindowId) return;
        state.pendingChips.push(msg.chip);
        renderChips();
        el.promptInput.focus();
      } else if (msg.type === "PIN_NOTE_ADDED" && msg.pin) {
        if (myWindowId !== null && typeof msg.windowId === "number" && msg.windowId !== myWindowId) return;
        handlePinNoteAdded(msg).catch(console.error);
      } else if (msg.type === "PICKER_CANCELLED") {
        if (myWindowId !== null && typeof msg.windowId === "number" && msg.windowId !== myWindowId) return;
        el.pinNoteBtn?.classList.remove("active");
      }
    });
  }

  /* ---- UI Event Wiring ---- */
  el.sendBtn.addEventListener("click", () => sendPrompt().catch(console.error));
  el.stopBtn.addEventListener("click", async () => {
    if (!state.session) return;
    await api(`/api/sessions/${encodeURIComponent(state.session.id)}/abort`, { method: "POST" });
  });

  el.promptInput.addEventListener("input", autoGrowPrompt);
  window.addEventListener("resize", autoGrowPrompt);
  el.promptInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      sendPrompt().catch(console.error);
    }
  });

  el.relayModeBtn.addEventListener("click", () => toggleRelayMode().catch(console.error));
  el.inspectBtn.addEventListener("click", () => toggleSeePage().catch(console.error));
  el.cdpDetachBtn.addEventListener("click", () => toggleSeePage(false).catch(console.error));

  el.pickBtn.addEventListener("click", () => {
    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: "START_PICKER", tabId: state.activeTab?.tabId, mode: "pick" });
    }
  });

  el.pinNoteBtn?.addEventListener("click", () => {
    if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
    const isActive = el.pinNoteBtn.classList.contains("active");
    chrome.runtime.sendMessage(
      {
        type: "START_PICKER",
        tabId: state.activeTab?.tabId,
        mode: "pin",
        startIndex: nextPinIndex(),
      },
      (res) => {
        if (chrome.runtime.lastError || !res?.ok) {
          el.pinNoteBtn.classList.remove("active");
          showToast(res?.error || "Cannot pin on this tab (chrome:// pages are blocked by Chrome)", true);
          return;
        }
        el.pinNoteBtn.classList.toggle("active", !isActive);
        if (!isActive) showToast("Pin mode active — click any element on the page");
      }
    );
  });

  el.chipsBar.addEventListener("click", (e) => {
    const idx = e.target?.getAttribute?.("data-remove-chip");
    if (idx !== null && idx !== undefined) {
      const [removed] = state.pendingChips.splice(Number(idx), 1);
      if (removed?._attLocalId) {
        const attIdx = state.pendingAttachments.findIndex((a) => a.localId === removed._attLocalId);
        if (attIdx !== -1) {
          const [remAtt] = state.pendingAttachments.splice(attIdx, 1);
          if (remAtt?.blobUrl) URL.revokeObjectURL(remAtt.blobUrl);
          renderAttachmentsTray();
        }
      }
      renderChips();
    }
  });

  // Attachment tray remove + lightbox zoom
  el.attachmentsTray.addEventListener("click", (e) => {
    const rem = e.target.closest("[data-remove-att]");
    if (rem) {
      const id = rem.getAttribute("data-remove-att");
      const idx = state.pendingAttachments.findIndex((a) => a.localId === id);
      if (idx !== -1) {
        const [removed] = state.pendingAttachments.splice(idx, 1);
        if (removed?.blobUrl) URL.revokeObjectURL(removed.blobUrl);
        renderAttachmentsTray();
      }
      return;
    }
    const thumb = e.target.closest("[data-lightbox-src]");
    if (thumb) {
      openLightbox(thumb.getAttribute("data-lightbox-src"), thumb.getAttribute("data-lightbox-name"));
    }
  });

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback for when the async clipboard is refused (panel not focused)
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    }
  }

  el.messages.addEventListener("input", (e) => {
    const ta = e.target.closest("[data-relay-edit]");
    if (ta) {
      state.relayDrafts[ta.getAttribute("data-relay-edit")] = ta.value;
    }
  });

  el.messages.addEventListener("keydown", (e) => {
    const ta = e.target.closest("[data-relay-edit]");
    if (!ta) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      ta.blur();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      const rid = ta.getAttribute("data-relay-edit");
      const rel = (state.session?.relays || []).find((r) => r.id === rid);
      if (!rel || rel.status !== "staged") return;
      const targetSessionId = state.relayTargets[rid] ?? rel.targetSessionId;
      runRelayAction(
        rid,
        `/api/relays/${encodeURIComponent(rid)}/confirm`,
        { text: ta.value, mode: rel.mode, targetSessionId },
        rel.mode === "steer" ? "Steered Pigeon-Hole cubby" : "Queued in Pigeon-Hole"
      ).then(() => el.promptInput.focus());
    }
  });

  el.messages.addEventListener("change", (e) => {
    const sel = e.target.closest("[data-relay-target]");
    if (sel) {
      state.relayTargets[sel.getAttribute("data-relay-target")] = sel.value;
      renderMessages();
    }
  });

  el.messages.addEventListener("click", (e) => {
    const relayConfirm = e.target.closest("[data-relay-confirm]");
    if (relayConfirm) {
      const rid = relayConfirm.getAttribute("data-relay-confirm");
      const mode = relayConfirm.getAttribute("data-relay-mode") || "queue";
      const rel = (state.session?.relays || []).find((r) => r.id === rid);
      if (!rel) return;
      const text = state.relayDrafts[rid] !== undefined ? state.relayDrafts[rid] : rel.text;
      const targetSessionId = state.relayTargets[rid] ?? rel.targetSessionId;
      runRelayAction(
        rid,
        `/api/relays/${encodeURIComponent(rid)}/confirm`,
        { text, mode, targetSessionId },
        mode === "steer" ? "Steered Pigeon-Hole cubby" : mode === "send" ? "Sent to Pigeon-Hole" : "Queued in Pigeon-Hole"
      ).then(() => el.promptInput.focus());
      return;
    }
    const relayUndo = e.target.closest("[data-relay-undo]");
    if (relayUndo) {
      const rid = relayUndo.getAttribute("data-relay-undo");
      runRelayAction(rid, `/api/relays/${encodeURIComponent(rid)}/undo`, null, "Removed from Pigeon-Hole queue");
      return;
    }
    const relayPromote = e.target.closest("[data-relay-promote]");
    if (relayPromote) {
      const rid = relayPromote.getAttribute("data-relay-promote");
      runRelayAction(rid, `/api/relays/${encodeURIComponent(rid)}/promote`, null, "Promoted queued prompt to Steer");
      return;
    }
    const relayDismiss = e.target.closest("[data-relay-dismiss]");
    if (relayDismiss) {
      const rid = relayDismiss.getAttribute("data-relay-dismiss");
      runRelayAction(rid, `/api/relays/${encodeURIComponent(rid)}/dismiss`, null, "Relay dismissed");
      return;
    }
    const relayCopy = e.target.closest("[data-relay-copy]");
    if (relayCopy) {
      const rid = relayCopy.getAttribute("data-relay-copy");
      const rel = (state.session?.relays || []).find((r) => r.id === rid);
      const txt = state.relayDrafts[rid] !== undefined ? state.relayDrafts[rid] : rel?.text || "";
      copyText(txt).then((ok) => {
        relayCopy.textContent = ok ? "Copied ✓" : "Failed";
        setTimeout(() => { relayCopy.textContent = "Copy"; }, 1400);
      });
      return;
    }
    if (e.target.closest("[data-relay-retry-status]")) {
      refreshPigeonStatus().then(() => {
        showToast(state.pigeon?.online ? "Pigeon-Hole connected" : "Pigeon-Hole still offline", !state.pigeon?.online);
      });
      return;
    }
    const queueCodeBtn = e.target.closest("[data-queue-code]");
    if (queueCodeBtn) {
      if (!state.session) return;
      const code = queueCodeBtn.closest(".md-code")?.querySelector("code");
      const text = (code ? code.textContent : "").trim();
      if (!text) return;
      const msgCard = queueCodeBtn.closest("[data-msg-id]");
      const messageId = msgCard ? Number(msgCard.getAttribute("data-msg-id")) : null;
      const targetSessionId = state.pigeon?.activeSessionId || undefined;
      queueCodeBtn.disabled = true;
      api(`/api/sessions/${encodeURIComponent(state.session.id)}/relays`, {
        method: "POST",
        body: JSON.stringify({
          text,
          mode: "queue",
          targetSessionId,
          messageId,
          executeNow: Boolean(state.pigeon?.activeCubby),
        }),
      })
        .then((data) => {
          if (data.relay) upsertSessionRelay(data.relay);
          renderMessages();
          showToast(data.relay?.status === "queued" ? `Queued in ${data.relay.targetName}` : "Staged Relay Card");
        })
        .catch((err) => showToast(err?.message || "Could not queue into Pigeon-Hole", true))
        .finally(() => { queueCodeBtn.disabled = false; });
      return;
    }
    const runCodeBtn = e.target.closest("[data-run-code]");
    if (runCodeBtn) {
      if (!state.session) return;
      const codeBox = runCodeBtn.closest(".md-code");
      const code = codeBox?.querySelector("code");
      const command = (code ? code.textContent : "").trim();
      if (!command) return;
      const msgCard = runCodeBtn.closest("[data-msg-id]");
      const messageId = msgCard ? Number(msgCard.getAttribute("data-msg-id")) : null;
      const blockIdx = codeBox ? Number(codeBox.getAttribute("data-code-idx")) : null;
      runCodeBtn.disabled = true;
      api(`/api/sessions/${encodeURIComponent(state.session.id)}/shell`, {
        method: "POST",
        body: JSON.stringify({ command, messageId, blockIdx }),
      })
        .then((data) => {
          if (data.run) {
            const cur = state.shellRuns[data.run.id];
            if (!cur || cur.status === "running") {
              state.shellRuns[data.run.id] = data.run;
            }
            delete state.dismissedShellRuns[data.run.id];
            if (messageId !== null && blockIdx !== null) {
              state.shellRunBySlot[`${state.session.id}:${messageId}:${blockIdx}`] = data.run.id;
            }
            patchShellDrawer(state.shellRuns[data.run.id]);
          }
        })
        .catch((err) => showToast(err?.message || "Could not run command", true))
        .finally(() => { runCodeBtn.disabled = false; });
      return;
    }
    const shellKill = e.target.closest("[data-shell-kill]");
    if (shellKill) {
      const rid = shellKill.getAttribute("data-shell-kill");
      shellKill.disabled = true;
      api(`/api/shell/${encodeURIComponent(rid)}/kill`, { method: "POST" }).catch(() => {});
      return;
    }
    const shellShare = e.target.closest("[data-shell-share]");
    if (shellShare) {
      const rid = shellShare.getAttribute("data-shell-share");
      const run = state.shellRuns[rid];
      if (!run || !state.session) return;
      shellShare.disabled = true;
      const text = formatShellShareMarkdown(run);
      api(`/api/sessions/${encodeURIComponent(state.session.id)}/prompt`, {
        method: "POST",
        body: JSON.stringify({ text, chips: [], attachments: [] }),
      })
        .then(() => {
          state.sharedShellRuns[rid] = true;
          patchShellDrawer(run);
          showToast("Shared terminal output with agent");
        })
        .catch((err) => {
          shellShare.disabled = false;
          showToast(err?.message || "Could not share output", true);
        });
      return;
    }
    const shellCompose = e.target.closest("[data-shell-compose]");
    if (shellCompose) {
      const rid = shellCompose.getAttribute("data-shell-compose");
      const run = state.shellRuns[rid];
      if (!run) return;
      const snippet = formatShellShareMarkdown(run);
      const cur = el.promptInput.value.trim();
      el.promptInput.value = cur ? `${cur}\n\n${snippet}\n` : `${snippet}\n`;
      autoGrowPrompt();
      el.promptInput.focus();
      el.promptInput.setSelectionRange(el.promptInput.value.length, el.promptInput.value.length);
      showToast("Inserted terminal output into compose box");
      return;
    }
    const shellCopy = e.target.closest("[data-shell-copy]");
    if (shellCopy) {
      const rid = shellCopy.getAttribute("data-shell-copy");
      const run = state.shellRuns[rid];
      copyText(run?.output || "").then((ok) => {
        shellCopy.textContent = ok ? "Copied ✓" : "Failed";
        setTimeout(() => { shellCopy.textContent = "Copy"; }, 1400);
      });
      return;
    }
    const shellClose = e.target.closest("[data-shell-close]");
    if (shellClose) {
      const rid = shellClose.getAttribute("data-shell-close");
      state.dismissedShellRuns[rid] = true;
      shellClose.closest(".term-drawer")?.remove();
      return;
    }
    const copyBtn = e.target.closest("[data-copy-code]");
    if (copyBtn) {
      const code = copyBtn.closest(".md-code")?.querySelector("code");
      copyText(code ? code.textContent : "").then((ok) => {
        copyBtn.textContent = ok ? "Copied ✓" : "Copy failed";
        copyBtn.classList.toggle("done", ok);
        setTimeout(() => {
          copyBtn.textContent = "Copy";
          copyBtn.classList.remove("done");
        }, 1600);
      });
      return;
    }
    const inlineCode = e.target.closest(".msg-body code");
    if (inlineCode && !inlineCode.closest("pre") && !window.getSelection()?.toString()) {
      copyText(inlineCode.textContent).then((ok) => {
        if (!ok) return;
        inlineCode.classList.add("copied");
        setTimeout(() => inlineCode.classList.remove("copied"), 1200);
        showToast(`Copied: ${inlineCode.textContent.slice(0, 60)}`);
      });
      return;
    }
    const openBtn = e.target.closest("[data-open-html]");
    if (openBtn) {
      openHtmlAndFollow(openBtn.getAttribute("data-open-html"), openBtn.getAttribute("data-open-mode")).catch(console.error);
      return;
    }
    const link = e.target.closest("a[href]");
    if (link) {
      let isHtml = false;
      try { isHtml = /\.html?$/i.test(new URL(link.href).pathname); } catch {}
      if (isHtml) {
        e.preventDefault();
        openHtmlAndFollow(link.href, e.shiftKey ? "window" : "tab").catch(console.error);
        return;
      }
    }
    const thumb = e.target.closest("[data-lightbox-src]");
    if (thumb) {
      openLightbox(thumb.getAttribute("data-lightbox-src"), thumb.getAttribute("data-lightbox-name"));
    }
  });

  el.lightboxClose.addEventListener("click", () => el.lightbox.classList.add("hidden"));
  el.lightbox.addEventListener("click", (e) => {
    if (e.target === el.lightbox) el.lightbox.classList.add("hidden");
  });

  // Manual file picker (+ Img)
  el.attachBtn.addEventListener("click", () => el.attachFileInput.click());
  el.attachFileInput.addEventListener("change", () => {
    if (el.attachFileInput.files && el.attachFileInput.files.length > 0) {
      stageImageFiles(el.attachFileInput.files).catch(console.error);
      el.attachFileInput.value = "";
    }
  });

  // Clipboard paste (screenshots, copied images, screen capture file:// URIs / paths)
  document.addEventListener("paste", (e) => {
    const cd = e.clipboardData;
    if (!cd) return;
    const files = extractFilesFromDataTransfer(cd);
    const imgFiles = files.filter(isImageFile);
    if (imgFiles.length > 0) {
      e.preventDefault();
      stageImageFiles(imgFiles).catch(console.error);
      return;
    }
    const rawUri = cd.getData("text/uri-list") || cd.getData("text/plain") || "";
    const paths = extractImagePathsFromText(rawUri);
    if (paths.length > 0) {
      e.preventDefault();
      stageLocalImagePaths(paths).catch(console.error);
    }
  });

  // Drag & drop across entire sidebar (Finder + screen captures)
  function resetDropOverlay() {
    dragDepth = 0;
    el.dropOverlay.classList.add("hidden");
  }

  window.addEventListener("dragenter", (e) => {
    if (!hasDragImageCandidate(e.dataTransfer)) return;
    e.preventDefault();
    dragDepth++;
    el.dropOverlay.classList.remove("hidden");
  });

  window.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (e.dataTransfer && hasDragImageCandidate(e.dataTransfer)) {
      e.dataTransfer.dropEffect = "copy";
    }
  });

  window.addEventListener("dragleave", () => {
    if (dragDepth > 0) dragDepth--;
    if (dragDepth === 0) el.dropOverlay.classList.add("hidden");
  });

  window.addEventListener("dragend", resetDropOverlay);
  window.addEventListener("blur", resetDropOverlay);

  window.addEventListener("drop", (e) => {
    e.preventDefault();
    resetDropOverlay();
    const files = extractFilesFromDataTransfer(e.dataTransfer);
    const imgFiles = files.filter(isImageFile);
    if (imgFiles.length > 0) {
      stageImageFiles(imgFiles).catch(console.error);
      return;
    }
    const uriList = e.dataTransfer?.getData("text/uri-list") || "";
    const plain = e.dataTransfer?.getData("text/plain") || "";
    const paths = extractImagePathsFromText(`${uriList}\n${plain}`);
    if (paths.length > 0) {
      stageLocalImagePaths(paths).catch(console.error);
      return;
    }
    if (files.length > 0) {
      showToast("Only image files can be attached", true);
    }
  });

  // Chat title opens the switcher; ✎ renames in place
  el.chatTitleBtn.addEventListener("click", () => {
    if (isSwitcherOpen()) closeOverlays();
    else openSwitcher().catch(console.error);
  });
  el.emptyPickBtn.addEventListener("click", () => openSwitcher().catch(console.error));
  el.renameBtn.addEventListener("click", () => {
    if (!state.session) return;
    closeOverlays();
    el.chatTitleInput.value = state.session.name;
    el.chatTitleBtn.classList.add("hidden");
    el.renameBtn.classList.add("hidden");
    el.chatTitleInput.classList.remove("hidden");
    el.chatTitleInput.focus();
    el.chatTitleInput.select();
  });
  async function commitRename() {
    if (el.chatTitleInput.classList.contains("hidden")) return;
    el.chatTitleInput.classList.add("hidden");
    el.chatTitleBtn.classList.remove("hidden");
    el.renameBtn.classList.toggle("hidden", !state.session);
    const next = el.chatTitleInput.value.trim();
    if (!state.session || !next || next === state.session.name) return;
    const data = await api(`/api/sessions/${encodeURIComponent(state.session.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ name: next }),
    });
    state.session = data.session;
    renderHeader();
  }
  el.chatTitleInput.addEventListener("blur", () => commitRename().catch(console.error));
  el.chatTitleInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commitRename().catch(console.error); }
    if (e.key === "Escape") {
      e.stopPropagation();
      el.chatTitleInput.classList.add("hidden");
      el.chatTitleBtn.classList.remove("hidden");
      el.renameBtn.classList.toggle("hidden", !state.session);
    }
  });

  // Model & effort popover
  el.modelBtn.addEventListener("click", () => {
    if (!el.modelPopover.classList.contains("hidden")) return closeOverlays();
    openModelPopover();
  });
  el.modelList.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-harness-id]");
    if (!btn) return;
    const id = btn.getAttribute("data-harness-id");
    const spec = state.harnesses.find((h) => h.id === id);
    state.selectedHarnessId = id;
    if (spec) state.selectedEffort = spec.defaultEffort;
    if (state.session) {
      const data = await api(`/api/sessions/${encodeURIComponent(state.session.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ harnessId: id, effort: state.selectedEffort }),
      });
      state.session = data.session;
    }
    openModelPopover();
    renderHeader();
  });
  el.effortRow.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-effort]");
    if (!btn) return;
    const ef = btn.getAttribute("data-effort");
    state.selectedEffort = ef;
    if (state.session) {
      const data = await api(`/api/sessions/${encodeURIComponent(state.session.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ effort: ef }),
      });
      state.session = data.session;
    }
    closeOverlays();
    renderHeader();
  });

  // Repo & URL rules popover
  el.repoBtn.addEventListener("click", () => {
    if (!el.repoPopover.classList.contains("hidden")) return closeOverlays();
    openRepoPopover();
  });
  el.repoSearchInput.addEventListener("input", () => loadRepoResults(el.repoSearchInput.value));
  el.repoResults.addEventListener("click", async (e) => {
    const useBtn = e.target.closest("[data-use-repo-path]");
    const pinBtn = e.target.closest("[data-pin-repo-path]");
    if (useBtn) {
      const repoPath = useBtn.getAttribute("data-use-repo-path");
      const repoName = useBtn.getAttribute("data-use-repo-name");
      const sess = await ensureSessionForActiveTab({ repoPath, repoName, repoSource: "manual" });
      const data = await api(`/api/sessions/${encodeURIComponent(sess.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ repoPath, repoName, repoSource: "manual" }),
      });
      state.session = data.session;
      closeOverlays();
      renderAll();
    } else if (pinBtn) {
      const repoPath = pinBtn.getAttribute("data-pin-repo-path");
      const repoName = pinBtn.getAttribute("data-pin-repo-name");
      const host = hostOf(state.activeTab?.url || "");
      if (host && host !== "tab") {
        await api("/api/rules", { method: "POST", body: JSON.stringify({ pattern: host, repoPath, repoName }) });
      }
      const sess = await ensureSessionForActiveTab({ repoPath, repoName, repoSource: "pinned" });
      const data = await api(`/api/sessions/${encodeURIComponent(sess.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ repoPath, repoName, repoSource: "pinned" }),
      });
      state.session = data.session;
      await loadRulesList();
      closeOverlays();
      renderAll();
    }
  });
  el.rulesList.addEventListener("click", async (e) => {
    const delBtn = e.target.closest("[data-del-rule]");
    if (!delBtn) return;
    await api(`/api/rules/${delBtn.getAttribute("data-del-rule")}`, { method: "DELETE" });
    await loadRulesList();
  });

  // Banners
  el.retryBtn.addEventListener("click", () => { connectPanelWs(); bootstrap(); });
  el.radarBar.addEventListener("click", async (e) => {
    const chip = e.target.closest(".radar-chip");
    if (!chip) return;
    if (chip.hasAttribute("data-radar-working")) {
      openSwitcher().catch(console.error);
      return;
    }
    const tabIdAttr = chip.getAttribute("data-radar-tab");
    const sid = chip.getAttribute("data-radar-sid");
    if (tabIdAttr) {
      if (sid) {
        if (state.radar?.items) {
          state.radar.items = state.radar.items.filter((x) => !(x.kind === "tab" && x.id === sid));
          renderBanners();
        }
        api(`/api/sessions/${encodeURIComponent(sid)}/ack`, { method: "POST" }).catch(() => {});
      }
      goToTab(Number(tabIdAttr));
      return;
    }
    const pigeonId = chip.getAttribute("data-radar-pigeon-id");
    if (pigeonId) {
      if (state.radar?.items) {
        state.radar.items = state.radar.items.filter((x) => !(x.kind === "pigeon" && x.id === pigeonId));
        renderBanners();
      }
      api("/api/pigeon/ack", { method: "POST", body: JSON.stringify({ cubbyId: pigeonId }) }).catch(() => {});
    }
    const targetUrl = chip.getAttribute("data-radar-url");
    if (targetUrl && typeof chrome !== "undefined" && chrome.tabs) {
      try {
        const tabs = await chrome.tabs.query({});
        const match =
          tabs.find((t) => (t.url || "") === targetUrl) ||
          tabs.find((t) => (t.url || "").startsWith(targetUrl.split("#")[0]));
        if (match?.id) {
          if (match.url !== targetUrl) await chrome.tabs.update(match.id, { url: targetUrl, active: true });
          else await chrome.tabs.update(match.id, { active: true });
          await chrome.windows.update(match.windowId, { focused: true }).catch(() => {});
        } else {
          await chrome.tabs.create({ url: targetUrl, active: true });
        }
      } catch {}
    }
  });
  el.afterBanner.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-cancel-trigger]");
    if (!btn) return;
    const tid = btn.getAttribute("data-cancel-trigger");
    btn.disabled = true;
    try {
      const data = await api(`/api/triggers/${encodeURIComponent(tid)}/cancel`, { method: "POST" });
      if (data.trigger && state.session?.triggers) {
        const idx = state.session.triggers.findIndex((t) => t.id === tid);
        if (idx !== -1) state.session.triggers[idx] = data.trigger;
      }
      renderBanners();
      showToast("Cancelled /after watcher");
    } catch (err) {
      showToast(err?.message || "Could not cancel watcher", true);
    }
  });
  el.pigeonRepoSwitch.addEventListener("click", async () => {
    const cub = state.pigeon?.activeCubby;
    if (!cub || !cub.path || !state.session) return;
    try {
      const data = await api(`/api/sessions/${encodeURIComponent(state.session.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ repoPath: cub.path, repoName: cub.name, repoSource: "manual" }),
      });
      state.session = data.session;
      renderAll();
      showToast(`Switched workspace to ${cub.name}`);
    } catch (err) {
      showToast(err?.message || "Could not switch workspace", true);
    }
  });
  el.pigeonRepoDismiss.addEventListener("click", () => {
    if (state.pigeon?.activeCubby?.id) {
      state.dismissedPigeonCubbyId = state.pigeon.activeCubby.id;
    }
    renderBanners();
  });
  el.repoSuggestPin.addEventListener("click", async () => {
    if (!state.repoMatch) return;
    const host = hostOf(state.activeTab?.url || "");
    if (host && host !== "tab") {
      await api("/api/rules", {
        method: "POST",
        body: JSON.stringify({ pattern: host, repoPath: state.repoMatch.repoPath, repoName: state.repoMatch.repoName }),
      });
    }
    const sess = await ensureSessionForActiveTab({
      repoPath: state.repoMatch.repoPath,
      repoName: state.repoMatch.repoName,
      repoSource: "pinned",
    });
    const data = await api(`/api/sessions/${encodeURIComponent(sess.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ repoPath: state.repoMatch.repoPath, repoName: state.repoMatch.repoName, repoSource: "pinned" }),
    });
    state.session = data.session;
    state.repoMatch = { ...state.repoMatch, source: "pinned", confidence: "high" };
    renderAll();
  });
  el.repoSuggestDismiss.addEventListener("click", () => {
    state.dismissedSuggestHost = hostOf(state.activeTab?.url || "");
    renderBanners();
  });

  el.recoverResumeBtn.addEventListener("click", async () => {
    if (!state.recoverable || !state.activeTab?.tabId) return;
    state.session = await moveSessionTo(state.recoverable.id, state.activeTab, "resumed on this tab");
    state.recoverable = null;
    renderAll();
  });
  el.recoverDismissBtn.addEventListener("click", () => {
    if (state.recoverable) state.dismissedRecoverId = state.recoverable.id;
    renderBanners();
  });

  el.domainNewBtn.addEventListener("click", async () => {
    state.session = null;
    state.domainChanged = null;
    await ensureSessionForActiveTab();
  });
  el.domainDismissBtn.addEventListener("click", () => {
    state.domainChanged = null;
    renderBanners();
  });

  // Close chat (⏻). If a turn is running, the first click arms it ("Stop & close?") for 3 s.
  let closeArmTimer = null;
  function disarmClose() {
    if (closeArmTimer) clearTimeout(closeArmTimer);
    closeArmTimer = null;
    el.closeChatBtn.classList.remove("armed");
    el.closeChatBtn.textContent = "⏻";
  }
  el.closeChatBtn.addEventListener("click", () => {
    if (!state.session) return;
    const running = state.session.state === "working" || state.session.isRunning;
    if (running && !el.closeChatBtn.classList.contains("armed")) {
      el.closeChatBtn.classList.add("armed");
      el.closeChatBtn.textContent = "Stop & close?";
      closeArmTimer = setTimeout(disarmClose, 3000);
      return;
    }
    disarmClose();
    closeChat(state.session.id).catch(console.error);
  });

  // New chat button
  el.newChatBtn.addEventListener("click", async () => {
    state.session = null;
    state.domainChanged = null;
    state.recoverable = null;
    await ensureSessionForActiveTab();
    el.promptInput.focus();
  });

  // Chat switcher wiring
  el.switcherInput.addEventListener("input", () => {
    sw.sel = 0;
    loadSwitcher(el.switcherInput.value.trim()).catch(console.error);
  });
  el.switcherInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      sw.sel = Math.min(sw.flat.length - 1, sw.sel + 1);
      renderSwitcher();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      sw.sel = Math.max(0, sw.sel - 1);
      renderSwitcher();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const h = sw.flat[sw.sel];
      if (!h) return;
      const onOpenTab = h.tabId !== null && sw.openTabIds.has(h.tabId);
      if ((e.metaKey || e.ctrlKey) && onOpenTab) switcherGoTo(h.id);
      else if (h.id === state.session?.id) closeOverlays();
      else switcherMoveHere(h.id).catch(console.error);
    }
  });
  el.switcherList.addEventListener("click", (e) => {
    let b;
    if ((b = e.target.closest("[data-sw-ren-input]"))) return;
    if ((b = e.target.closest("[data-sw-ren]"))) {
      sw.renaming = b.getAttribute("data-sw-ren");
      renderSwitcher();
      focusSwitcherRename();
      return;
    }
    if ((b = e.target.closest("[data-sw-close]"))) return void closeChat(b.getAttribute("data-sw-close")).catch(console.error);
    if ((b = e.target.closest("[data-sw-move]"))) return void switcherMoveHere(b.getAttribute("data-sw-move")).catch(console.error);
    if ((b = e.target.closest("[data-sw-go]"))) return switcherGoTo(b.getAttribute("data-sw-go"));
    const rowEl = e.target.closest("[data-sw-idx]");
    if (rowEl) {
      sw.sel = Number(rowEl.getAttribute("data-sw-idx"));
      renderSwitcher();
      el.switcherInput.focus();
    }
  });
  el.switcherList.addEventListener("keydown", (e) => {
    const inp = e.target.closest("[data-sw-ren-input]");
    if (!inp) return;
    if (e.key === "Enter") {
      e.preventDefault();
      commitSwitcherRename(inp.getAttribute("data-sw-ren-input"), inp.value).catch(console.error);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      sw.renaming = null;
      renderSwitcher();
      el.switcherInput.focus();
    }
  });
  el.switcherList.addEventListener("focusout", (e) => {
    const inp = e.target.closest?.("[data-sw-ren-input]");
    if (inp && sw.renaming === inp.getAttribute("data-sw-ren-input")) {
      commitSwitcherRename(sw.renaming, inp.value).catch(console.error);
    }
  });
  el.switcherSendto.addEventListener("click", (e) => {
    const b = e.target.closest("[data-sw-send]");
    if (b) switcherSendTo(Number(b.getAttribute("data-sw-send"))).catch(console.error);
  });
  // Click outside the switcher closes it
  document.addEventListener("mousedown", (e) => {
    if (isSwitcherOpen() && !e.target.closest("#switcher") && !e.target.closest("#chat-title-btn")) closeOverlays();
  });

  document.querySelectorAll("[data-close]").forEach((btn) => {
    btn.addEventListener("click", () => closeOverlays());
  });

  // Global keyboard shortcuts (⌘K switch chat, ⌘. toggle See Page, ⌘⇧↩ confirm staged relay, Esc close overlays)
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "Enter") {
      if (confirmLatestStagedRelay()) {
        e.preventDefault();
      }
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (isSwitcherOpen()) closeOverlays();
      else openSwitcher().catch(console.error);
    } else if ((e.metaKey || e.ctrlKey) && e.key === ".") {
      e.preventDefault();
      toggleSeePage().catch(console.error);
    } else if (e.key === "Escape") {
      closeOverlays();
    }
  });

  connectPanelWs();
})();
