import { describe, expect, test } from "bun:test";
import { matchRulePattern, resolveUrlToRepo, type RepoMapEntry } from "../daemon/url-repo";

const MOCK_ENTRIES: RepoMapEntry[] = [
  {
    id: "acme-web",
    host: "local",
    name: "acme-web",
    path: "/tmp/demo-repos/acme-web",
    summary: "Acme Web homepage concept with kit records.",
    aliases: ["acme web", "acme-web", "acme web"],
  },
  {
    id: "acme-shop",
    host: "local",
    name: "acme-shop",
    path: "/tmp/demo-repos/acme-shop",
    summary: "Repository for acme-shop.example soccer card store.",
    aliases: ["acme shop", "acme-shop"],
  },
];

describe("URL -> Repo 4-tier resolver", () => {
  test("pattern matching supports exact host, subdomain, path prefix, and globs", () => {
    expect(matchRulePattern("acme-web.example", "https://www.acme-web.example/kits")).toBe(true);
    expect(matchRulePattern("acme-web.example", "https://docs.acme-web.example/a")).toBe(true);
    expect(matchRulePattern("acme-web.example/kits", "https://acme-web.example/kits/g5")).toBe(true);
    expect(matchRulePattern("acme-web.example/kits", "https://acme-web.example/about")).toBe(false);
    expect(matchRulePattern("*.acme.example", "https://hub.acme.example/margin")).toBe(true);
  });

  test("Tier 1 pinned rule wins over everything", () => {
    const hit = resolveUrlToRepo("https://acme-web.example/kits", {
      rules: [
        {
          id: 1,
          pattern: "acme-web.example",
          repoPath: "/tmp/demo-repos/acme-pinned",
          repoName: "Acme-Pinned",
          createdAt: Date.now(),
        },
      ],
      repoMapEntries: MOCK_ENTRIES,
      scratchDir: "/tmp/tab-agent-test-scratch",
    });
    expect(hit.source).toBe("pinned");
    expect(hit.confidence).toBe("high");
    expect(hit.repoName).toBe("Acme-Pinned");
  });

  test("Tier 2 localhost port resolves active server cwd", () => {
    const hit = resolveUrlToRepo("http://127.0.0.1:7742/board", {
      rules: [],
      repoMapEntries: MOCK_ENTRIES,
      localhostResolver: (port) => (port === 7742 ? "/tmp/demo-repos/Pigeon-Hole" : null),
      scratchDir: "/tmp/tab-agent-test-scratch",
    });
    expect(hit.source).toBe("localhost");
    expect(hit.repoName).toBe("Pigeon-Hole");
  });

  test("Tier 3 suggests matching repo from repo-map aliases and summaries", () => {
    const h1 = resolveUrlToRepo("https://acme-web.example/kits/g5-01", {
      rules: [],
      repoMapEntries: MOCK_ENTRIES,
      scratchDir: "/tmp/tab-agent-test-scratch",
    });
    expect(h1.source).toBe("repo-map");
    expect(h1.repoName).toBe("acme-web");

    const h2 = resolveUrlToRepo("https://acme-shop.example/cards", {
      rules: [],
      repoMapEntries: MOCK_ENTRIES,
      scratchDir: "/tmp/tab-agent-test-scratch",
    });
    expect(h2.source).toBe("repo-map");
    expect(h2.repoName).toBe("acme-shop");
  });

  test("Tier 4 unmapped generic URL falls back safely to scratch workspace", () => {
    const hit = resolveUrlToRepo("https://github.com/lizard-build/lizard-studio", {
      rules: [],
      repoMapEntries: MOCK_ENTRIES,
      scratchDir: "/tmp/tab-agent-test-scratch",
    });
    expect(hit.source).toBe("scratch");
    expect(hit.confidence).toBe("fallback");
  });
});
