import { describe, expect, test } from "bun:test";
import {
  buildTabContextEnvelope,
  createAgyStreamState,
  createClaudeStreamState,
  parseAgyStreamLine,
  parseClaudeStreamLine,
} from "../daemon/harnesses";
import type { SessionRecord } from "../daemon/db";

describe("Harness stream-json parsers & context envelope", () => {
  test("parses AGY init, text_delta, tool, and result events", () => {
    const st = createAgyStreamState();
    const r1 = parseAgyStreamLine(JSON.stringify({ event: "init", conversation_id: "agy-conv-123" }), st);
    expect(r1?.providerSessionId).toBe("agy-conv-123");

    const r2 = parseAgyStreamLine(
      JSON.stringify({ event: "step_update", step_update: { step_index: 1, step_type: "tool", tool_name: "read_file", tool_info: { parameters: { Path: "src/index.ts" } } } }),
      st
    );
    expect(r2?.events[0]?.summary).toContain("read_file: src/index.ts");

    const r3 = parseAgyStreamLine(
      JSON.stringify({ event: "step_update", step_update: { step_index: 2, step_type: "agent_response", text_delta: "Hello " } }),
      st
    );
    const r4 = parseAgyStreamLine(
      JSON.stringify({ event: "step_update", step_update: { step_index: 2, step_type: "agent_response", text_delta: "world" } }),
      st
    );
    expect(r3?.fullText).toBe("Hello ");
    expect(r4?.fullText).toBe("Hello world");

    const r5 = parseAgyStreamLine(
      JSON.stringify({ event: "result", result: { conversation_id: "agy-conv-123", response: "Hello world!", usage: { total_tokens: 420 } } }),
      st
    );
    expect(r5?.fullText).toBe("Hello world!");
    expect(r5?.events.some((e) => e.summary.includes("420 tok"))).toBe(true);
  });

  test("parses Claude Code stream-json partial deltas, tool uses, and session_id", () => {
    const st = createClaudeStreamState();
    const r1 = parseClaudeStreamLine(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-sess-77" }), st);
    expect(r1?.providerSessionId).toBe("claude-sess-77");

    const r2 = parseClaudeStreamLine(
      JSON.stringify({
        type: "stream_event",
        session_id: "claude-sess-77",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "Patched " } },
      }),
      st
    );
    expect(r2?.fullText).toBe("Patched ");

    const r3 = parseClaudeStreamLine(
      JSON.stringify({
        type: "assistant",
        session_id: "claude-sess-77",
        message: {
          content: [
            { type: "tool_use", id: "tu-1", name: "mcp__tab-agent__tab_console", input: { limit: 50 } },
            { type: "text", text: "Patched cleanly." },
          ],
        },
      }),
      st
    );
    expect(r3?.fullText).toBe("Patched cleanly.");
    expect(r3?.events.some((e) => e.summary.includes("tab_console"))).toBe(true);
  });

  test("context envelope reflects passive URL, See Page gate, and element chips", () => {
    const sess: SessionRecord = {
      id: "tab-1",
      name: "Fix button",
      repoPath: "/tmp/demo-repos/acme-web",
      repoName: "acme-web",
      repoSource: "pinned",
      initialUrl: "https://acme-web.example/kits",
      lastUrl: "https://acme-web.example/kits",
      origin: "https://acme-web.example",
      pageTitle: "Kits",
      state: "idle",
      family: "AGY",
      model: "NEON",
      effort: "low",
      harnessId: "agy-neon",
      providerSessionId: null,
      pageAccess: false,
      questionSnippet: "",
      archived: false,
      createdAt: 1,
      updatedAt: 1,
    };

    const offEnv = buildTabContextEnvelope(sess, "Check spacing", []);
    expect(offEnv).toContain("https://acme-web.example/kits");
    expect(offEnv).toContain("Page Inspection (See Page): OFF");

    const onEnv = buildTabContextEnvelope(
      { ...sess, pageAccess: true },
      "",
      [{ selector: "button.cta-buy", tag: "button", label: "button.cta-buy", text: "Buy now" }],
      {
        urlChanged: true,
        attachments: [
          {
            id: "img1",
            name: "demo-shot.png",
            mimeType: "image/png",
            size: 1200,
            path: "/tmp/demo-shot.png",
            url: "/api/attachments/tab-1/img1-demo-shot.png",
          },
        ],
      }
    );
    expect(onEnv).toContain("Page Inspection (See Page): ENABLED");
    expect(onEnv).toContain("button.cta-buy");
    expect(onEnv).toContain("navigated to this URL");
    expect(onEnv).toContain("/tmp/demo-shot.png");
    expect(onEnv).toContain("inspect them with read_file");
    expect(onEnv).toContain("Please inspect the attached image(s).");
  });
});
