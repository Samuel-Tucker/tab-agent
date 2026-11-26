(function () {
  "use strict";
  const HOST_ID = "__tab_agent_picker_overlay__";

  // Toggle off if already running
  if (window.__TAB_AGENT_PICKER_CLEANUP__) {
    window.__TAB_AGENT_PICKER_CLEANUP__();
    return;
  }

  const mode = window.__TAB_AGENT_PICKER_MODE__ === "pin" ? "pin" : "pick";
  let nextPinIndex =
    typeof window.__TAB_AGENT_PIN_START_INDEX__ === "number" && window.__TAB_AGENT_PIN_START_INDEX__ >= 1
      ? Math.floor(window.__TAB_AGENT_PIN_START_INDEX__)
      : 1;
  delete window.__TAB_AGENT_PICKER_MODE__;
  delete window.__TAB_AGENT_PIN_START_INDEX__;

  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = `
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .ta-box {
      position: fixed;
      border: 2px solid #A23B17;
      background: rgba(162, 59, 23, 0.11);
      border-radius: 5px;
      pointer-events: none;
      display: none;
    }
    .ta-box.is-pinned {
      background: rgba(162, 59, 23, 0.08);
      box-shadow: 0 0 0 2px rgba(250, 245, 234, 0.9), 0 0 0 4px rgba(162, 59, 23, 0.25);
    }
    .ta-tip {
      position: fixed;
      background: #1F1D1A;
      color: #FAF5EA;
      font: 600 11px/1.3 ui-monospace, Menlo, monospace;
      padding: 3px 8px;
      border-radius: 5px;
      pointer-events: none;
      display: none;
      white-space: nowrap;
      box-shadow: 0 2px 8px rgba(0,0,0,0.28);
    }
    .ta-hud {
      position: fixed;
      bottom: 16px;
      left: 50%;
      transform: translateX(-50%);
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 6px 10px 6px 12px;
      border-radius: 999px;
      background: #1F1D1A;
      color: #FAF5EA;
      font-size: 12px;
      font-weight: 500;
      box-shadow: 0 6px 22px rgba(0, 0, 0, 0.32);
      border: 1px solid rgba(250, 245, 234, 0.16);
      pointer-events: auto;
      white-space: nowrap;
      max-width: calc(100vw - 24px);
    }
    .ta-hud-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #D9653B;
      flex-shrink: 0;
    }
    .ta-hud-count {
      font: 600 11px/1 ui-monospace, Menlo, monospace;
      padding: 3px 7px;
      border-radius: 999px;
      background: rgba(250, 245, 234, 0.14);
      color: #FAF5EA;
    }
    .ta-hud-done {
      border: 0;
      border-radius: 999px;
      background: #FAF5EA;
      color: #1F1D1A;
      font-size: 11.5px;
      font-weight: 600;
      padding: 4px 10px;
      cursor: pointer;
    }
    .ta-hud-done:hover { background: #EFE6D5; }
    .ta-badge {
      position: fixed;
      display: none;
      align-items: center;
      justify-content: center;
      min-width: 24px;
      height: 22px;
      padding: 0 6px;
      border-radius: 999px;
      background: #A23B17;
      color: #FAF5EA;
      font: 700 11px/1 ui-monospace, Menlo, monospace;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.32);
      border: 1.5px solid #FAF5EA;
      pointer-events: none;
    }
    .ta-saved-pin {
      position: fixed;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 22px;
      height: 20px;
      padding: 0 6px;
      border-radius: 999px;
      background: rgba(162, 59, 23, 0.9);
      color: #FAF5EA;
      font: 700 10.5px/1 ui-monospace, Menlo, monospace;
      border: 1.5px solid #FAF5EA;
      box-shadow: 0 2px 6px rgba(0,0,0,0.25);
      pointer-events: none;
    }
    .ta-popover {
      position: fixed;
      width: 310px;
      background: #FAF5EA;
      color: #1F1D1A;
      border: 1.5px solid #A23B17;
      border-radius: 10px;
      padding: 10px;
      box-shadow: 0 12px 32px rgba(24, 20, 16, 0.28);
      pointer-events: auto;
      display: none;
      flex-direction: column;
      gap: 8px;
    }
    .ta-pop-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
    }
    .ta-pop-meta {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .ta-pop-num {
      background: #A23B17;
      color: #FAF5EA;
      font: 700 11px/1 ui-monospace, Menlo, monospace;
      padding: 3px 6px;
      border-radius: 999px;
      flex-shrink: 0;
    }
    .ta-pop-label {
      font: 600 11px/1.2 ui-monospace, Menlo, monospace;
      color: #554F47;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .ta-pop-close {
      border: 0;
      background: transparent;
      color: #776F64;
      font-size: 16px;
      line-height: 1;
      cursor: pointer;
      padding: 2px 4px;
      border-radius: 4px;
    }
    .ta-pop-close:hover { background: rgba(31, 29, 26, 0.08); color: #1F1D1A; }
    .ta-pop-input {
      width: 100%;
      border: 1px solid #C8BFA8;
      border-radius: 7px;
      padding: 7px 9px;
      font-size: 13px;
      line-height: 1.35;
      background: #FFFDF8;
      color: #1F1D1A;
      outline: none;
    }
    .ta-pop-input:focus {
      border-color: #A23B17;
      box-shadow: 0 0 0 2px rgba(162, 59, 23, 0.16);
    }
    .ta-pop-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
    }
    .ta-pop-hint {
      font: 500 10.5px/1 ui-monospace, Menlo, monospace;
      color: #776F64;
    }
    .ta-pop-btns { display: flex; gap: 6px; }
    .ta-btn {
      border: 1px solid #C8BFA8;
      background: #F4EDE0;
      color: #1F1D1A;
      font-size: 11.5px;
      font-weight: 600;
      padding: 5px 9px;
      border-radius: 6px;
      cursor: pointer;
      white-space: nowrap;
    }
    .ta-btn:hover { background: #EAE0CE; }
    .ta-btn-primary {
      border-color: #A23B17;
      background: #A23B17;
      color: #FAF5EA;
    }
    .ta-btn-primary:hover { background: #8B3112; }
  `;

  const box = document.createElement("div");
  box.className = "ta-box";
  const tip = document.createElement("div");
  tip.className = "ta-tip";
  const activeBadge = document.createElement("div");
  activeBadge.className = "ta-badge";

  const hud = document.createElement("div");
  hud.className = "ta-hud";
  hud.style.display = mode === "pin" ? "inline-flex" : "none";
  hud.innerHTML = `
    <span class="ta-hud-dot"></span>
    <span>Pin mode &middot; click element to note</span>
    <span class="ta-hud-count" id="ta-hud-count">0 pinned</span>
    <button type="button" class="ta-hud-done" id="ta-hud-done">Done (Esc)</button>
  `;

  const popover = document.createElement("div");
  popover.className = "ta-popover";
  popover.innerHTML = `
    <div class="ta-pop-head">
      <div class="ta-pop-meta">
        <span class="ta-pop-num" id="ta-pop-num">#1</span>
        <span class="ta-pop-label" id="ta-pop-label"></span>
      </div>
      <button type="button" class="ta-pop-close" id="ta-pop-close" title="Cancel pin (Esc)">&times;</button>
    </div>
    <input type="text" class="ta-pop-input" id="ta-pop-input" placeholder="Note for agent (e.g. separate this box)…" autocomplete="off" />
    <div class="ta-pop-actions">
      <span class="ta-pop-hint">↵ done · ⌘↵ +another</span>
      <div class="ta-pop-btns">
        <button type="button" class="ta-btn" id="ta-pop-more">+ Another</button>
        <button type="button" class="ta-btn ta-btn-primary" id="ta-pop-done">Pin &amp; Done</button>
      </div>
    </div>
  `;

  const savedLayer = document.createElement("div");
  shadow.append(style, savedLayer, box, activeBadge, tip, hud, popover);
  document.documentElement.appendChild(host);

  const hudCountEl = shadow.getElementById("ta-hud-count");
  const hudDoneBtn = shadow.getElementById("ta-hud-done");
  const popNumEl = shadow.getElementById("ta-pop-num");
  const popLabelEl = shadow.getElementById("ta-pop-label");
  const popInput = shadow.getElementById("ta-pop-input");
  const popCloseBtn = shadow.getElementById("ta-pop-close");
  const popMoreBtn = shadow.getElementById("ta-pop-more");
  const popDoneBtn = shadow.getElementById("ta-pop-done");

  let currentEl = null;
  let activePinEl = null;
  let activePinRect = null;
  let pinnedCount = 0;
  let committing = false;

  function buildSelector(el) {
    if (el.id && /^[A-Za-z_][\w-]*$/.test(el.id)) return `#${el.id}`;
    const parts = [];
    let cur = el;
    for (let depth = 0; cur && cur.nodeType === 1 && depth < 5; depth++) {
      let seg = cur.tagName.toLowerCase();
      if (cur.id && /^[A-Za-z_][\w-]*$/.test(cur.id)) {
        parts.unshift(`#${cur.id}`);
        break;
      }
      const cls = Array.from(cur.classList || [])
        .filter((c) => c && !/^[0-9]/.test(c) && c.length < 32)
        .slice(0, 2);
      if (cls.length) seg += "." + cls.join(".");
      else if (cur.parentElement) {
        const same = Array.from(cur.parentElement.children).filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) seg += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(seg);
      if (document.querySelectorAll(parts.join(" > ")).length === 1) break;
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  }

  function buildXPath(el) {
    const segs = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && segs.length < 10) {
      let idx = 1;
      let sib = cur.previousElementSibling;
      while (sib) {
        if (sib.tagName === cur.tagName) idx++;
        sib = sib.previousElementSibling;
      }
      segs.unshift(`${cur.tagName.toLowerCase()}[${idx}]`);
      cur = cur.parentElement;
    }
    return "/" + segs.join("/");
  }

  function shortLabel(el) {
    const tag = el.tagName.toLowerCase();
    if (el.id) return `${tag}#${el.id}`;
    const cls = Array.from(el.classList || []).slice(0, 2).join(".");
    return cls ? `${tag}.${cls}` : tag;
  }

  function pickTarget(raw) {
    if (!raw || raw.nodeType !== 1) return null;
    if (raw.id === HOST_ID || raw.closest?.(`#${HOST_ID}`)) return null;
    if (raw instanceof SVGElement) {
      const parent = raw.closest("button, a, [role='button']");
      if (parent) return parent;
    }
    return raw;
  }

  function isEventInsideOverlay(e) {
    if (!e) return false;
    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    return path.includes(host) || e.target === host;
  }

  function placeBox(r, pinned) {
    box.style.display = "block";
    box.classList.toggle("is-pinned", Boolean(pinned));
    box.style.left = r.left + "px";
    box.style.top = r.top + "px";
    box.style.width = r.width + "px";
    box.style.height = r.height + "px";
  }

  function placeBadge(r, index) {
    activeBadge.textContent = `#${index}`;
    activeBadge.style.display = "inline-flex";
    activeBadge.style.left = Math.max(4, Math.min(window.innerWidth - 36, r.left - 8)) + "px";
    activeBadge.style.top = Math.max(4, r.top - 11) + "px";
  }

  function closePinPopover() {
    activePinEl = null;
    activePinRect = null;
    popover.style.display = "none";
    activeBadge.style.display = "none";
    box.classList.remove("is-pinned");
    box.style.display = "none";
    popInput.value = "";
  }

  function openPinPopover(el) {
    const r = el.getBoundingClientRect();
    activePinEl = el;
    activePinRect = {
      x: Math.round(r.left),
      y: Math.round(r.top),
      width: Math.round(r.width),
      height: Math.round(r.height),
    };
    tip.style.display = "none";
    placeBox(r, true);
    placeBadge(r, nextPinIndex);

    popNumEl.textContent = `#${nextPinIndex}`;
    popLabelEl.textContent = `${shortLabel(el)} · ${activePinRect.width}×${activePinRect.height}`;
    popInput.value = "";
    popover.style.display = "flex";

    const popW = 310;
    const popH = 124;
    const left = Math.max(10, Math.min(window.innerWidth - popW - 10, r.left));
    const preferBelow = r.bottom + 10 + popH <= window.innerHeight - 60;
    const top = preferBelow
      ? Math.max(10, r.bottom + 10)
      : Math.max(10, Math.min(window.innerHeight - popH - 64, r.top - popH - 10));
    popover.style.left = left + "px";
    popover.style.top = top + "px";

    setTimeout(() => popInput.focus(), 10);
  }

  function waitFrames() {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  async function commitActivePin(finishAfter) {
    if (!activePinEl || committing) return;
    committing = true;
    const el = activePinEl;
    const r = el.getBoundingClientRect();
    const pinIndex = nextPinIndex;
    const note = (popInput.value || "").trim();

    const pin = {
      pinIndex,
      selector: buildSelector(el),
      tag: el.tagName.toLowerCase(),
      label: shortLabel(el),
      text: (el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 160),
      html: (el.outerHTML || "").slice(0, 320),
      xpath: buildXPath(el),
      rect: {
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height),
      },
      note,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
      },
    };

    // Hide chrome popover + HUD while keeping the clean rust outline & #N badge for the screenshot crop
    popover.style.display = "none";
    tip.style.display = "none";
    hud.style.display = "none";
    placeBox(r, true);
    placeBadge(r, pinIndex);
    await waitFrames();

    await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "PIN_CAPTURED", pin, done: Boolean(finishAfter) }, () => {
          void chrome.runtime.lastError;
          resolve();
        });
      } catch {
        resolve();
      }
    });

    pinnedCount += 1;
    nextPinIndex += 1;
    committing = false;

    if (finishAfter) {
      cleanup();
      return;
    }

    // Leave a quiet numbered dot on the pinned element and continue pinning
    const marker = document.createElement("div");
    marker.className = "ta-saved-pin";
    marker.textContent = `#${pinIndex}`;
    marker.style.left = Math.max(4, Math.min(window.innerWidth - 36, r.left - 6)) + "px";
    marker.style.top = Math.max(4, r.top - 10) + "px";
    savedLayer.appendChild(marker);

    if (hudCountEl) hudCountEl.textContent = `${pinnedCount} pinned`;
    hud.style.display = "inline-flex";
    closePinPopover();
  }

  function onMove(e) {
    if (activePinEl || committing) return;
    if (isEventInsideOverlay(e)) {
      tip.style.display = "none";
      return;
    }
    const el = pickTarget(document.elementFromPoint(e.clientX, e.clientY));
    if (!el) return;
    currentEl = el;
    const r = el.getBoundingClientRect();
    placeBox(r, false);

    tip.textContent =
      mode === "pin"
        ? `#${nextPinIndex} ${shortLabel(el)} · ${Math.round(r.width)}×${Math.round(r.height)} (Click to pin)`
        : `${shortLabel(el)} · ${Math.round(r.width)}×${Math.round(r.height)} (Esc cancel)`;
    tip.style.display = "block";
    tip.style.left = Math.max(6, Math.min(window.innerWidth - 280, r.left)) + "px";
    tip.style.top = (r.top > 30 ? r.top - 26 : r.bottom + 6) + "px";
  }

  function onClick(e) {
    if (isEventInsideOverlay(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (committing) return;
    const el = currentEl || pickTarget(e.target);
    if (!el) return;

    if (mode === "pin") {
      openPinPopover(el);
      return;
    }

    cleanup();
    const r = el.getBoundingClientRect();
    const chip = {
      selector: buildSelector(el),
      tag: el.tagName.toLowerCase(),
      label: shortLabel(el),
      text: (el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 160),
      html: (el.outerHTML || "").slice(0, 320),
      xpath: buildXPath(el),
      rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
    };
    chrome.runtime.sendMessage({ type: "ELEMENT_PICKED", chip });
  }

  function onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (mode === "pin" && activePinEl) {
        closePinPopover();
        return;
      }
      cleanup();
      chrome.runtime.sendMessage({ type: "PICKER_CANCELLED" });
    }
  }

  hudDoneBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    cleanup();
    chrome.runtime.sendMessage({ type: "PICKER_CANCELLED" });
  });
  popCloseBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    closePinPopover();
  });
  popDoneBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    commitActivePin(true);
  });
  popMoreBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    commitActivePin(false);
  });
  popInput?.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      closePinPopover();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const addMore = Boolean(e.metaKey || e.ctrlKey || e.shiftKey);
      commitActivePin(!addMore);
    }
  });

  function cleanup() {
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
    document.documentElement.style.cursor = "";
    host.remove();
    delete window.__TAB_AGENT_PICKER_CLEANUP__;
  }

  window.__TAB_AGENT_PICKER_CLEANUP__ = cleanup;
  document.documentElement.style.cursor = "crosshair";
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKey, true);
})();
