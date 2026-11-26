#!/usr/bin/env bun
/**
 * Zero-dependency stdio MCP server for Tab-Agent.
 * Spawned by Claude Code (--mcp-config) or AGY (registered `tab-agent` MCP server).
 * Routes browser inspection tools through the local Tab-Agent Bun daemon, which
 * enforces the per-tab "See Page" Inspect Gate before ever touching chrome.debugger.
 */

import readline from "node:readline";

const PORT = Number(process.env.TAB_AGENT_PORT || 7752);
const TOKEN = process.env.TAB_AGENT_TOKEN || "";
const SESSION_ID = process.env.TAB_AGENT_SESSION || "";

const TOOLS = [
  {
    name: "tab_info",
    description:
      "Get the bound browser tab's URL, title, linked repo, and whether live 'See Page' inspection is enabled. Always allowed even when See Page is OFF.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "tab_dom",
    description:
      "Read visible text or HTML of the bound browser tab (optionally scoped by CSS selector). Requires the user to click 'See Page' first.",
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["text", "html"], description: "text (default) or html" },
        selector: { type: "string", description: "Optional CSS selector" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "tab_console",
    description:
      "Return console logs, warnings, errors, and uncaught exceptions captured from the bound tab since 'See Page' attached.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "Max entries (default 100)" } },
      additionalProperties: false,
    },
  },
  {
    name: "tab_network",
    description:
      "Return recent network requests (URL, method, status, type, failed error) from the bound tab since 'See Page' attached.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max requests (default 80)" },
        errorsOnly: { type: "boolean", description: "Only status >= 400 or failed requests" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "tab_snapshot",
    description:
      "Return a compact accessibility-tree snapshot of interactive elements with @eN refs for clicking/typing/filling.",
    inputSchema: {
      type: "object",
      properties: {
        interactiveOnly: { type: "boolean", description: "Only interactive elements (default true)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "tab_screenshot",
    description: "Capture a PNG screenshot of the bound browser tab via CDP.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "tab_eval",
    description:
      "Evaluate a JavaScript expression in the bound tab's page context via DevTools Protocol and return its JSON value.",
    inputSchema: {
      type: "object",
      properties: { expression: { type: "string", description: "JS expression to evaluate" } },
      required: ["expression"],
      additionalProperties: false,
    },
  },
  {
    name: "tab_click",
    description: "Click an element in the bound tab by @ref (from tab_snapshot), CSS selector, or x/y.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        selector: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        double: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "tab_fill",
    description: "Set the value of an input/textarea/select in the bound tab (fires input + change).",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        selector: { type: "string" },
        value: { type: "string" },
      },
      required: ["value"],
      additionalProperties: false,
    },
  },
  {
    name: "tab_reload",
    description: "Reload the bound tab and wait for load event (helpful to capture fresh console/network logs).",
    inputSchema: {
      type: "object",
      properties: { hardReload: { type: "boolean" } },
      additionalProperties: false,
    },
  },
  {
    name: "pigeon_status",
    description:
      "Read the open Pigeon-Hole cubby's live status (state, model/effort, repo path, queued count, steer state, and last 6 messages) plus all active Pigeon-Hole cubbies. Works even when See Page is OFF.",
    inputSchema: {
      type: "object",
      properties: {
        targetSessionId: { type: "string", description: "Optional Pigeon-Hole cubby ID (defaults to active tab's #s=<id>)" },
        includeMessages: { type: "boolean", description: "Include last 6 messages of target cubby (default true)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "pigeon_send",
    description:
      "Send, queue, or steer a prompt into a Pigeon-Hole cubby upon the user's request. In Ask mode (default) or for Steer / idle cubbies, stages an editable Relay Card in the sidebar for the user to confirm; in Auto-Queue mode on a working cubby, injects straight into Pigeon-Hole's queue with an Undo receipt.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Prompt text to inject into the Pigeon-Hole cubby" },
        mode: {
          type: "string",
          enum: ["queue", "steer", "send"],
          description: "queue (default — add to queued tray), steer (interrupt/steer live turn), or send (start turn if idle, else queue)",
        },
        targetSessionId: { type: "string", description: "Optional Pigeon-Hole cubby ID (defaults to active tab's #s=<id>)" },
        reason: { type: "string", description: "Optional short note shown in the activity log" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "pigeon_watch",
    description:
      "Arm a one-shot /after watcher on a Pigeon-Hole cubby: the moment that cubby finishes its current turn, this Tab-Agent chat wakes automatically with the cubby's reply and runs the instruction. Works even with See Page OFF.",
    inputSchema: {
      type: "object",
      properties: {
        instruction: {
          type: "string",
          description: "What this Tab-Agent chat should do once the cubby finishes (e.g. check pass/kill bar and stage next prompt)",
        },
        targetSessionId: {
          type: "string",
          description: "Optional Pigeon-Hole cubby ID or name (defaults to active tab's #s=<id>)",
        },
      },
      required: ["instruction"],
      additionalProperties: false,
    },
  },
  {
    name: "peer_list",
    description:
      "List other active Tab-Agent tab sessions (and Pigeon-Hole cubbies) so you can find a session by repo name, title, or URL. Works with See Page OFF.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional repo name, session name, or URL fragment to filter by" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "peer_read",
    description:
      "Read recent messages and context from another Tab-Agent session by repo name, title, or session ID. Works with See Page OFF.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Repo name (e.g. Pigeon-Hole, demo-api), session name, or session ID" },
        last: { type: "number", description: "Number of recent messages to read (default 8)" },
      },
      required: ["target"],
      additionalProperties: false,
    },
  },
  {
    name: "peer_send",
    description:
      "Send a message directly to another Tab-Agent session (found by repo name or session ID) so agents talk directly without the user acting as middle-man. Waits for and returns the peer agent's reply by default.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Target repo name, session name, or session ID" },
        message: { type: "string", description: "Question or request for the peer agent" },
        wait: { type: "boolean", description: "Wait for the peer agent's reply (default true)" },
        timeoutSeconds: { type: "number", description: "Max seconds to wait for reply (default 120)" },
      },
      required: ["target", "message"],
      additionalProperties: false,
    },
  },
];

const TOOL_TO_OP = {
  tab_info: "info",
  tab_dom: "dom",
  tab_console: "console",
  tab_network: "network",
  tab_snapshot: "snapshot",
  tab_screenshot: "screenshot",
  tab_eval: "eval",
  tab_click: "click",
  tab_fill: "fill",
  tab_reload: "reload",
  pigeon_status: "pigeon_status",
  pigeon_send: "pigeon_send",
  pigeon_watch: "pigeon_watch",
  peer_list: "peer_list",
  peer_read: "peer_read",
  peer_send: "peer_send",
};

function writeMsg(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function callDaemon(op, args) {
  if (!SESSION_ID) {
    return {
      ok: false,
      error: "Not running inside an active Tab-Agent sidebar session (TAB_AGENT_SESSION unset).",
    };
  }
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/mcp/call`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(TOKEN ? { "X-Tab-Agent-Token": TOKEN } : {}),
      },
      body: JSON.stringify({ sessionId: SESSION_ID, op, args: args || {} }),
    });
    const data = await res.json();
    return data;
  } catch (err) {
    return { ok: false, error: `Could not reach Tab-Agent daemon on 127.0.0.1:${PORT}: ${err?.message || err}` };
  }
}

async function handleRequest(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return writeMsg({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "tab-agent", version: "0.1.0" },
      },
    });
  }
  if (method === "notifications/initialized" || method === "ping") {
    if (id !== undefined) writeMsg({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "tools/list") {
    return writeMsg({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  }
  if (method === "tools/call") {
    const name = params?.name;
    const op = TOOL_TO_OP[name];
    if (!op) {
      return writeMsg({
        jsonrpc: "2.0",
        id,
        result: { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] },
      });
    }
    const resp = await callDaemon(op, params?.arguments || {});
    if (!resp.ok) {
      return writeMsg({
        jsonrpc: "2.0",
        id,
        result: { isError: true, content: [{ type: "text", text: String(resp.error || "Tool failed") }] },
      });
    }
    if (op === "screenshot" && resp.data?.dataUrl?.startsWith("data:image/png;base64,")) {
      const b64 = resp.data.dataUrl.slice("data:image/png;base64,".length);
      return writeMsg({
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            { type: "image", data: b64, mimeType: "image/png" },
            { type: "text", text: `Captured PNG screenshot of bound tab.` },
          ],
        },
      });
    }
    return writeMsg({
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: JSON.stringify(resp.data, null, 2) }],
      },
    });
  }
  if (id !== undefined) {
    writeMsg({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  handleRequest(msg).catch((err) => {
    if (msg?.id !== undefined) {
      writeMsg({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: String(err?.message || err) } });
    }
  });
});
