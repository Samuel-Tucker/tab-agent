(function (root) {
  "use strict";

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatInline(text) {
    const codes = [];
    let s = String(text || "").replace(/`([^`\n]+)`/g, (_, code) => {
      const idx = codes.length;
      codes.push(`<code>${escapeHtml(code)}</code>`);
      return `\uE000C${idx}\uE001`;
    });

    const links = [];
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) => {
      const idx = links.length;
      links.push(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`);
      return `\uE000L${idx}\uE001`;
    });

    s = escapeHtml(s)
      .replace(/\*\*([^\n*]+?)\*\*/g, "<strong>$1</strong>")
      .replace(/(?<!\*)\*([^\n*]+?)\*(?!\*)/g, "<em>$1</em>");

    s = s.replace(/\uE000L(\d+)\uE001/g, (_, i) => links[Number(i)] || "");
    s = s.replace(/\uE000C(\d+)\uE001/g, (_, i) => codes[Number(i)] || "");
    return s;
  }

  function renderMarkdown(raw) {
    const text = String(raw ?? "").replace(/\r\n/g, "\n");
    if (!text.trim()) return "";

    const blocks = [];
    const fenceRe = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
    let last = 0;
    let m;
    while ((m = fenceRe.exec(text)) !== null) {
      if (m.index > last) blocks.push({ type: "text", content: text.slice(last, m.index) });
      blocks.push({ type: "code", lang: m[1] || "", content: m[2] });
      last = m.index + m[0].length;
    }
    if (last < text.length) blocks.push({ type: "text", content: text.slice(last) });

    const out = [];
    let codeIdx = 0;
    for (const blk of blocks) {
      if (blk.type === "code") {
        const lang = String(blk.lang || "").trim();
        const isRunnable = !lang || /^(bash|sh|zsh|shell|console|fish|cmd|terminal)$/i.test(lang);
        const runBtn = isRunnable
          ? `<button type="button" class="copy-btn run-code-btn" data-run-code title="Run in the linked workspace">▶ Run</button>`
          : "";
        const langLbl = lang ? escapeHtml(lang) : "cmd";
        out.push(
          `<div class="md-code" data-code-idx="${codeIdx++}">` +
            `<div class="code-bar"><span class="code-lang">${langLbl}</span><div class="code-actions">` +
            `<button type="button" class="copy-btn pigeon-queue-btn" data-queue-code title="Queue this block into Pigeon-Hole">Queue ↗</button>` +
            `${runBtn}` +
            `<button type="button" class="copy-btn" data-copy-code title="Copy to clipboard">Copy</button>` +
            `</div></div>` +
            `<pre class="md-pre"><code>${escapeHtml(blk.content.replace(/\n$/, ""))}</code></pre></div>`
        );
        continue;
      }
      const lines = blk.content.split("\n");
      let inUl = false;
      let inOl = false;
      const closeLists = () => {
        if (inUl) { out.push("</ul>"); inUl = false; }
        if (inOl) { out.push("</ol>"); inOl = false; }
      };

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          closeLists();
          continue;
        }
        const hMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
        if (hMatch) {
          closeLists();
          const lvl = Math.min(4, hMatch[1].length);
          out.push(`<h${lvl + 2} class="md-h">${formatInline(hMatch[2])}</h${lvl + 2}>`);
          continue;
        }
        const ulMatch = line.match(/^\s*[-*+]\s+(.+)$/);
        if (ulMatch) {
          if (inOl) { out.push("</ol>"); inOl = false; }
          if (!inUl) { out.push("<ul class=\"md-list\">"); inUl = true; }
          out.push(`<li>${formatInline(ulMatch[1])}</li>`);
          continue;
        }
        const olMatch = line.match(/^\s*\d+[.)]\s+(.+)$/);
        if (olMatch) {
          if (inUl) { out.push("</ul>"); inUl = false; }
          if (!inOl) { out.push("<ol class=\"md-list\">"); inOl = true; }
          out.push(`<li>${formatInline(olMatch[1])}</li>`);
          continue;
        }
        closeLists();
        out.push(`<p class="md-p">${formatInline(trimmed)}</p>`);
      }
      closeLists();
    }
    return out.join("");
  }

  root.TabAgentFormat = { escapeHtml, renderMarkdown };
})(typeof globalThis !== "undefined" ? globalThis : window);
