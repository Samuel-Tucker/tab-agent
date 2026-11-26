"use strict";

/**
 * Gated CDP 1.3 runtime for Tab-Agent (adapted & slimmed from lizard-studio).
 * Never attaches chrome.debugger silently — only attaches on explicit `attach`
 * or an approved CDP op after the daemon's Inspect Gate verifies pageAccess=true.
 */
globalThis.createTabAgentBrowser = function ({ onStats = () => {}, onDetached = () => {} } = {}) {
  const CDP_VERSION = "1.3";
  const STEP_TIMEOUT_MS = 10_000;
  const cdpSessions = new Map(); // tabId -> { console, network, netMap, refs, waiters, ready }
  const cdpAttaching = new Map();
  let listening = false;

  const opOk = (data) => ({ ok: true, data });
  const opErr = (error) => ({ ok: false, data: null, error: String(error || "Browser op failed") });

  function cap(arr, max = 500) {
    if (arr.length > max) arr.splice(0, arr.length - max);
  }

  function emitStats(tabId) {
    const s = cdpSessions.get(tabId);
    if (!s) {
      onStats(tabId, { attached: false, consoleErrors: 0, failedRequests: 0 });
      return;
    }
    const consoleErrors = s.console.filter((e) => e.level === "error").length;
    const failedRequests = s.network.filter((r) => r.failed || (typeof r.status === "number" && r.status >= 400)).length;
    onStats(tabId, { attached: true, consoleErrors, failedRequests });
  }

  function cdpArgToStr(a) {
    if (a == null) return String(a);
    if (a.value !== undefined) return typeof a.value === "string" ? a.value : JSON.stringify(a.value);
    if (a.unserializableValue) return String(a.unserializableValue);
    if (a.description) return a.description;
    return a.type || "";
  }

  function ensureListeners() {
    if (listening) return;
    listening = true;

    chrome.debugger.onEvent.addListener((source, method, params) => {
      const tabId = source.tabId;
      const s = cdpSessions.get(tabId);
      if (!s) return;

      if (method === "Runtime.consoleAPICalled") {
        s.console.push({
          level: params.type || "log",
          text: (params.args || []).map(cdpArgToStr).join(" ").slice(0, 2000),
          ts: Date.now(),
        });
        cap(s.console);
        if (params.type === "error") emitStats(tabId);
      } else if (method === "Log.entryAdded") {
        const e = params.entry || {};
        s.console.push({ level: e.level || "info", text: String(e.text || "").slice(0, 2000), url: e.url, ts: Date.now() });
        cap(s.console);
        if (e.level === "error") emitStats(tabId);
      } else if (method === "Runtime.exceptionThrown") {
        const d = params.exceptionDetails || {};
        const txt = (d.exception && (d.exception.description || d.exception.value)) || d.text || "uncaught exception";
        s.console.push({ level: "error", text: String(txt).slice(0, 2000), ts: Date.now() });
        cap(s.console);
        emitStats(tabId);
      } else if (method === "Network.requestWillBeSent") {
        const rec = {
          id: params.requestId,
          url: params.request?.url || "",
          method: params.request?.method || "GET",
          type: params.type || "",
          status: null,
          mimeType: null,
          failed: null,
        };
        s.netMap.set(params.requestId, rec);
        s.network.push(rec);
        cap(s.network, 300);
      } else if (method === "Network.responseReceived") {
        const rec = s.netMap.get(params.requestId);
        if (rec) {
          rec.status = params.response?.status ?? null;
          rec.mimeType = params.response?.mimeType ?? null;
          if (typeof rec.status === "number" && rec.status >= 400) emitStats(tabId);
        }
      } else if (method === "Network.loadingFailed") {
        const rec = s.netMap.get(params.requestId);
        if (rec) {
          rec.failed = params.errorText || "failed";
          emitStats(tabId);
        }
      }

      if (s.waiters.length) {
        const remain = [];
        for (const w of s.waiters) {
          if (w.method === method) w.resolve(params);
          else remain.push(w);
        }
        s.waiters = remain;
      }
    });

    chrome.debugger.onDetach.addListener((source) => {
      const tabId = source.tabId;
      if (tabId == null) return;
      const s = cdpSessions.get(tabId);
      if (s) {
        for (const w of s.waiters.splice(0)) w.resolve(null);
        cdpSessions.delete(tabId);
      }
      onDetached(tabId);
    });
  }

  function dbgCall(tabId, method, params = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`CDP ${method} timed out on tab ${tabId}`));
      }, STEP_TIMEOUT_MS);
      chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(result);
        }
      });
    });
  }

  function waitForEvent(tabId, method, timeoutMs = 15_000) {
    return new Promise((resolve) => {
      const s = cdpSessions.get(tabId);
      if (!s) return resolve(null);
      const w = { method, resolve: (p) => { clearTimeout(t); resolve(p); } };
      const t = setTimeout(() => {
        s.waiters = s.waiters.filter((x) => x !== w);
        resolve(null);
      }, timeoutMs);
      s.waiters.push(w);
    });
  }

  async function ensureAttached(tabId) {
    ensureListeners();
    if (cdpAttaching.has(tabId)) return cdpAttaching.get(tabId);
    if (cdpSessions.get(tabId)?.ready) return;

    const task = (async () => {
      await new Promise((resolve, reject) => {
        chrome.debugger.attach({ tabId }, CDP_VERSION, () => {
          if (chrome.runtime.lastError) {
            const msg = chrome.runtime.lastError.message || "Attach failed";
            if (/already attached/i.test(msg)) return resolve();
            return reject(new Error(msg));
          }
          resolve();
        });
      });

      const sess = { console: [], network: [], netMap: new Map(), refs: new Map(), waiters: [], ready: false };
      cdpSessions.set(tabId, sess);
      try {
        await dbgCall(tabId, "Page.enable");
        await Promise.all([
          dbgCall(tabId, "Runtime.enable"),
          dbgCall(tabId, "Log.enable"),
          dbgCall(tabId, "Network.enable"),
          dbgCall(tabId, "DOM.enable"),
        ]);
        sess.ready = true;
        emitStats(tabId);
      } catch (err) {
        detach(tabId);
        throw err;
      }
    })();

    cdpAttaching.set(tabId, task);
    const clear = () => {
      if (cdpAttaching.get(tabId) === task) cdpAttaching.delete(tabId);
    };
    task.then(clear, clear);
    return task;
  }

  function detach(tabId) {
    const s = cdpSessions.get(tabId);
    if (s) {
      for (const w of s.waiters.splice(0)) w.resolve(null);
      cdpSessions.delete(tabId);
    }
    try {
      chrome.debugger.detach({ tabId }, () => void chrome.runtime.lastError);
    } catch {}
    emitStats(tabId);
  }

  async function getTab(tabId) {
    return new Promise((resolve) => {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(tab || null);
      });
    });
  }

  function domProbeFn(sel, fmt) {
    var root = sel ? document.querySelector(sel) : null;
    if (sel && !root) return { ok: false, error: "No element matched selector: " + sel };
    var base = root || document.body || document.documentElement;
    var out = { ok: true, url: location.href, title: document.title || "" };
    if (fmt === "html") {
      var html = (root || document.documentElement).outerHTML || "";
      out.content = html.slice(0, 60000);
      out.truncated = html.length > 60000;
    } else {
      var raw = (base && base.innerText) || "";
      out.content = raw.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 16000);
      out.truncated = raw.length > 16000;
    }
    return out;
  }

  async function refToObjectId(tabId, ref) {
    const s = cdpSessions.get(tabId);
    const backendNodeId = s?.refs.get(ref);
    if (!backendNodeId) return null;
    const r = await dbgCall(tabId, "DOM.resolveNode", { backendNodeId });
    return r?.object?.objectId || null;
  }

  async function targetCenter(tabId, args) {
    if (typeof args.x === "number" && typeof args.y === "number") return { x: args.x, y: args.y };
    const fn =
      "function(){ this.scrollIntoView({block:'center',inline:'center'}); const b=this.getBoundingClientRect(); if(!b.width&&!b.height) return null; return {x:b.left+b.width/2, y:b.top+b.height/2}; }";
    if (args.ref) {
      const objectId = await refToObjectId(tabId, args.ref);
      if (!objectId) return null;
      const r = await dbgCall(tabId, "Runtime.callFunctionOn", { objectId, functionDeclaration: fn, returnByValue: true });
      return r?.result?.value || null;
    }
    if (args.selector) {
      const expr = `(function(){var el=document.querySelector(${JSON.stringify(args.selector)});if(!el)return null;el.scrollIntoView({block:'center',inline:'center'});var b=el.getBoundingClientRect();if(!b.width&&!b.height)return null;return {x:b.left+b.width/2,y:b.top+b.height/2};})()`;
      const r = await dbgCall(tabId, "Runtime.evaluate", { expression: expr, returnByValue: true });
      return r?.result?.value || null;
    }
    return null;
  }

  async function axSnapshot(tabId, interactiveOnly) {
    try { await dbgCall(tabId, "Accessibility.enable"); } catch {}
    const res = await dbgCall(tabId, "Accessibility.getFullAXTree", {});
    const sess = cdpSessions.get(tabId);
    if (sess) sess.refs.clear();
    const nodes = res?.nodes || [];
    const lines = [];
    const SKIP = new Set(["none", "presentation", "generic", "InlineTextBox", "StaticText", "LineBreak", "paragraph", ""]);
    const INTERACTIVE = new Set([
      "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox",
      "menuitem", "tab", "switch", "slider", "option", "listbox", "textarea", "spinbutton",
    ]);
    let n = 0;
    for (const node of nodes) {
      if (node.ignored) continue;
      const role = node.role?.value;
      const name = node.name?.value ? String(node.name.value).trim() : "";
      if (!role || SKIP.has(role)) continue;
      if (interactiveOnly && (!INTERACTIVE.has(role) || !name)) continue;
      if (node.backendDOMNodeId == null) continue;
      n++;
      const ref = `@e${n}`;
      if (sess) sess.refs.set(ref, node.backendDOMNodeId);
      let line = `${ref} ${role}`;
      if (name) line += ` "${name.slice(0, 110)}"`;
      const val = node.value?.value;
      if (val != null && String(val).trim()) line += ` = ${JSON.stringify(String(val).slice(0, 80))}`;
      lines.push(line);
      if (n >= 350) break;
    }
    return {
      count: lines.length,
      elements: lines.join("\n"),
    };
  }

  async function handleOp(op, args = {}) {
    const tabId = Number(args.tabId);
    if (!Number.isInteger(tabId)) return opErr("Missing numeric tabId.");

    try {
      if (op === "attach") {
        await ensureAttached(tabId);
        const s = cdpSessions.get(tabId);
        return opOk({
          attached: true,
          tabId,
          consoleErrors: s ? s.console.filter((e) => e.level === "error").length : 0,
          failedRequests: s ? s.network.filter((r) => r.failed || (r.status && r.status >= 400)).length : 0,
        });
      }

      if (op === "detach") {
        detach(tabId);
        return opOk({ attached: false, tabId });
      }

      const tab = await getTab(tabId);
      if (!tab) return opErr(`Tab ${tabId} no longer exists.`);

      if (op === "info") {
        return opOk({ tabId, url: tab.url || "", title: tab.title || "", attached: cdpSessions.has(tabId) });
      }

      await ensureAttached(tabId);
      const sess = cdpSessions.get(tabId);

      if (op === "dom") {
        const fmt = args.format === "html" ? "html" : "text";
        const expr = `(${domProbeFn.toString()})(${JSON.stringify(args.selector || null)}, ${JSON.stringify(fmt)})`;
        const r = await dbgCall(tabId, "Runtime.evaluate", { expression: expr, returnByValue: true, timeout: 5000 });
        const val = r?.result?.value;
        if (!val || !val.ok) return opErr(val?.error || "Could not read DOM.");
        return opOk({ url: val.url, title: val.title, format: fmt, content: val.content, truncated: val.truncated });
      }

      if (op === "console") {
        const limit = Math.max(1, Math.min(Number(args.limit) || 100, 500));
        return opOk({
          entries: sess.console.slice(-limit),
          note: sess.console.length ? undefined : "No console messages yet since See Page attached. Use tab_reload to capture fresh boot logs.",
        });
      }

      if (op === "network") {
        const limit = Math.max(1, Math.min(Number(args.limit) || 80, 300));
        let list = sess.network;
        if (args.errorsOnly) {
          list = list.filter((r) => r.failed || (typeof r.status === "number" && r.status >= 400));
        }
        return opOk({
          requests: list.slice(-limit).map((r) => ({
            url: r.url,
            method: r.method,
            status: r.status,
            type: r.type,
            mimeType: r.mimeType,
            failed: r.failed || undefined,
          })),
          note: list.length ? undefined : "No matching network requests captured yet since See Page attached.",
        });
      }

      if (op === "snapshot") {
        return opOk(await axSnapshot(tabId, args.interactiveOnly !== false));
      }

      if (op === "screenshot") {
        const r = await dbgCall(tabId, "Page.captureScreenshot", { format: "png" });
        if (!r?.data) return opErr("Screenshot failed.");
        return opOk({ dataUrl: "data:image/png;base64," + r.data });
      }

      if (op === "eval") {
        const r = await dbgCall(tabId, "Runtime.evaluate", {
          expression: String(args.expression || ""),
          returnByValue: true,
          awaitPromise: true,
          userGesture: true,
          timeout: 5000,
        });
        if (r?.exceptionDetails) {
          const d = r.exceptionDetails;
          return opOk({ error: d.exception?.description || d.exception?.value || d.text || "evaluation error" });
        }
        const val = r?.result ? (r.result.value !== undefined ? r.result.value : r.result.description) : null;
        return opOk({ result: val });
      }

      if (op === "click") {
        const pt = await targetCenter(tabId, args);
        if (!pt) return opErr("Target element not found.");
        await dbgCall(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y });
        await dbgCall(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: pt.x, y: pt.y, button: "left", buttons: 1, clickCount: args.double ? 2 : 1 });
        await dbgCall(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: pt.x, y: pt.y, button: "left", buttons: 0, clickCount: args.double ? 2 : 1 });
        return opOk({ clicked: true, x: Math.round(pt.x), y: Math.round(pt.y) });
      }

      if (op === "fill") {
        const val = String(args.value || "");
        const body =
          "el.focus(); var proto=Object.getPrototypeOf(el); var d=Object.getOwnPropertyDescriptor(proto,'value'); if(d&&d.set){d.set.call(el,V);}else{el.value=V;} el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true;";
        let ok = false;
        if (args.ref) {
          const objectId = await refToObjectId(tabId, args.ref);
          if (objectId) {
            const r = await dbgCall(tabId, "Runtime.callFunctionOn", {
              objectId,
              functionDeclaration: `function(V){ var el=this; ${body} }`,
              arguments: [{ value: val }],
              returnByValue: true,
            });
            ok = Boolean(r?.result?.value);
          }
        } else if (args.selector) {
          const expr = `(function(V){var el=document.querySelector(${JSON.stringify(args.selector)});if(!el)return false;${body}})(${JSON.stringify(val)})`;
          const r = await dbgCall(tabId, "Runtime.evaluate", { expression: expr, returnByValue: true });
          ok = Boolean(r?.result?.value);
        }
        return ok ? opOk({ filled: true }) : opErr("Target input not found.");
      }

      if (op === "reload") {
        const loaded = waitForEvent(tabId, "Page.loadEventFired", 15_000);
        await dbgCall(tabId, "Page.reload", { ignoreCache: Boolean(args.hardReload) });
        await loaded;
        sess.refs.clear();
        const info = await dbgCall(tabId, "Runtime.evaluate", {
          expression: "({url:location.href,title:document.title})",
          returnByValue: true,
        });
        return opOk(info?.result?.value || { reloaded: true });
      }

      return opErr(`Unsupported browser op: ${op}`);
    } catch (err) {
      return opErr(err?.message || String(err));
    }
  }

  return {
    handleOp,
    detach,
    isAttached: (tabId) => cdpSessions.has(tabId),
  };
};
