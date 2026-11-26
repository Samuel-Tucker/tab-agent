import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { RepoSource, TabAgentStore, UrlRepoRule } from "./db";

export interface RepoCandidate {
  repoPath: string;
  repoName: string;
  source: RepoSource;
  confidence: "high" | "suggested" | "fallback";
  matchedPattern?: string;
  reason: string;
}

export interface RepoMapEntry {
  id: string;
  host: string;
  name: string;
  path: string;
  summary: string;
  aliases: string[];
}

const HOME = homedir();
const DEFAULT_SCRATCH_DIR = join(HOME, ".tab-agent", "scratch");
const DEFAULT_REPO_MAP_PATH =
  process.env.TAB_AGENT_REPO_MAP || join(HOME, ".tab-agent", "repo-map.json");
const DEFAULT_REPO_ROOTS = (
  process.env.TAB_AGENT_REPOS_DIR ||
  [join(HOME, "Projects"), join(HOME, "repos"), join(HOME, "code"), join(HOME, "Developer")].join(":")
)
  .split(":")
  .map((s) => s.trim())
  .filter(Boolean);

let cachedRepoMap: { mtime: number; loadedAt: number; entries: RepoMapEntry[] } | null = null;

export function ensureScratchDir(dir = DEFAULT_SCRATCH_DIR): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function toTildePath(p: string): string {
  if (p === HOME) return "~";
  if (p.startsWith(HOME + "/")) return "~" + p.slice(HOME.length);
  return p;
}

export function expandTildePath(p: string): string {
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return join(HOME, p.slice(2));
  return p;
}

function scanLocalGitRepos(roots = DEFAULT_REPO_ROOTS, maxDepth = 2): RepoMapEntry[] {
  const entries: RepoMapEntry[] = [];
  const seen = new Set<string>();
  const skip = new Set(["node_modules", ".git", "dist", "build", "Archive", ".venv", "venv"]);

  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth || !existsSync(dir)) return;
    let items: string[];
    try {
      items = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of items) {
      if (name.startsWith(".") || skip.has(name)) continue;
      const full = join(dir, name);
      if (seen.has(full)) continue;
      if (existsSync(join(full, ".git"))) {
        seen.add(full);
        entries.push({
          id: name.toLowerCase(),
          host: "local",
          name,
          path: full,
          summary: `Local git repository (${toTildePath(full)})`,
          aliases: [name.toLowerCase(), name.toLowerCase().replace(/[-_]+/g, " ")],
        });
      } else if (depth < maxDepth) {
        walk(full, depth + 1);
      }
    }
  };

  for (const r of roots) walk(expandTildePath(r), 0);
  return entries;
}

export function loadRepoMap(indexPath = DEFAULT_REPO_MAP_PATH): RepoMapEntry[] {
  const now = Date.now();
  if (cachedRepoMap && now - cachedRepoMap.loadedAt < 60_000) {
    return cachedRepoMap.entries;
  }
  if (existsSync(indexPath)) {
    try {
      const raw = JSON.parse(readFileSync(indexPath, "utf-8"));
      const projects = Array.isArray(raw?.projects) ? raw.projects : [];
      const entries: RepoMapEntry[] = [];
      for (const p of projects) {
        if (!p || typeof p.path !== "string") continue;
        if (p.path.includes("/Archive/")) continue;
        entries.push({
          id: String(p.id || p.name || ""),
          host: String(p.host || "local"),
          name: String(p.name || basename(p.path)),
          path: p.path,
          summary: String(p.summary || ""),
          aliases: Array.isArray(p.aliases) ? p.aliases.map(String) : [],
        });
      }
      if (entries.length > 0) {
        cachedRepoMap = { mtime: now, loadedAt: now, entries };
        return entries;
      }
    } catch {}
  }
  const scanned = scanLocalGitRepos();
  cachedRepoMap = { mtime: now, loadedAt: now, entries: scanned };
  return scanned;
}

export function matchRulePattern(pattern: string, rawUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const hostPort = u.port ? `${host}:${u.port}` : host;
  const fullNoProto = `${hostPort}${u.pathname}`.toLowerCase();

  const p = pattern
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "");
  if (!p) return false;

  // Glob support (e.g. "app.example.com/*" or "*.example.org")
  if (p.includes("*")) {
    const escaped = p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    const re = new RegExp(`^${escaped}$`, "i");
    return re.test(fullNoProto) || re.test(hostPort) || re.test(host);
  }

  // Exact host / subdomain match or host+path prefix
  if (p.includes("/")) {
    return fullNoProto === p || fullNoProto.startsWith(p.endsWith("/") ? p : `${p}/`);
  }
  return hostPort === p || host === p || host.endsWith(`.${p}`);
}

function findGitRoot(startDir: string): string {
  let cur = startDir;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(cur, ".git"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return startDir;
}

export function resolveLocalhostPortCwd(port: number): string | null {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  try {
    const lsofPid = Bun.spawnSync(
      ["/usr/sbin/lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { stdout: "pipe", stderr: "ignore" }
    );
    if (lsofPid.exitCode !== 0) return null;
    const pid = new TextDecoder().decode(lsofPid.stdout).trim().split(/\s+/)[0];
    if (!pid || !/^\d+$/.test(pid)) return null;

    const lsofCwd = Bun.spawnSync(["/usr/sbin/lsof", "-a", "-d", "cwd", "-p", pid, "-Fn"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (lsofCwd.exitCode !== 0) return null;
    const lines = new TextDecoder().decode(lsofCwd.stdout).split("\n");
    const nLine = lines.find((l) => l.startsWith("n/"));
    if (!nLine) return null;
    const cwd = nLine.slice(1).trim();
    if (!cwd || cwd === "/" || cwd === HOME || !existsSync(cwd)) return null;
    return findGitRoot(cwd);
  } catch {
    return null;
  }
}

const GENERIC_HOSTS = new Set([
  "google",
  "github",
  "youtube",
  "x",
  "twitter",
  "reddit",
  "amazon",
  "ebay",
  "gmail",
  "mail",
  "docs",
  "claude",
  "chatgpt",
  "openai",
  "stackoverflow",
  "npmjs",
  "developer",
  "chrome",
  "newtab",
  "localhost",
]);

function normalizeToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function matchRepoMap(
  rawUrl: string,
  pageTitle = "",
  entries?: RepoMapEntry[]
): RepoCandidate | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  const hostParts = u.hostname
    .toLowerCase()
    .replace(/^www\./, "")
    .split(".")
    .filter(Boolean);
  if (hostParts.length === 0) return null;

  // Pick meaningful domain stem(s) (e.g. acme-web.example -> "acme-web"; hub.acme.example -> ["hub", "acme"])
  const tlds = new Set(["com", "co", "uk", "org", "net", "io", "ai", "dev", "app", "help", "gg", "example"]);
  const stems = hostParts.filter((p) => !tlds.has(p) && p.length >= 3);
  if (stems.length === 0 || stems.every((s) => GENERIC_HOSTS.has(s))) return null;

  const list = entries ?? loadRepoMap();
  const fullHost = u.hostname.toLowerCase().replace(/^www\./, "");
  const titleNorm = normalizeToken(pageTitle);

  let best: { entry: RepoMapEntry; score: number; reason: string } | null = null;

  for (const entry of list) {
    const nameNorm = normalizeToken(entry.name);
    const aliasNorms = entry.aliases.map(normalizeToken).filter(Boolean);
    const summaryLow = entry.summary.toLowerCase();

    let score = 0;
    let reason = "";

    // Direct domain mention in summary or aliases (e.g. "acme-shop.example" or "acme-web")
    if (summaryLow.includes(fullHost)) {
      score += 120;
      reason = `summary mentions ${fullHost}`;
    }

    for (const rawStem of stems) {
      if (GENERIC_HOSTS.has(rawStem)) continue;
      const stem = normalizeToken(rawStem);
      if (!stem || GENERIC_HOSTS.has(stem)) continue;
      if (nameNorm === stem) {
        score += 100;
        reason = reason || `repo name matches "${rawStem}"`;
      } else if (aliasNorms.includes(stem)) {
        score += 95;
        reason = reason || `repo-map alias matches "${rawStem}"`;
      } else if (nameNorm.includes(stem) && stem.length >= 4) {
        score += 65;
        reason = reason || `repo name contains "${rawStem}"`;
      } else if (aliasNorms.some((a) => a.includes(stem)) && stem.length >= 4) {
        score += 60;
        reason = reason || `alias contains "${rawStem}"`;
      } else if (summaryLow.includes(rawStem) && rawStem.length >= 5) {
        score += 40;
        reason = reason || `summary mentions "${rawStem}"`;
      }
    }

    if (score > 0 && titleNorm && nameNorm.length >= 5 && titleNorm.includes(nameNorm)) {
      score += 20;
    }

    if (score >= 60 && (!best || score > best.score)) {
      best = { entry, score, reason };
    }
  }

  if (!best) return null;
  return {
    repoPath: best.entry.path,
    repoName: best.entry.name,
    source: "repo-map",
    confidence: "suggested",
    matchedPattern: fullHost,
    reason: best.reason,
  };
}

export function resolveUrlToRepo(
  rawUrl: string,
  opts: {
    pageTitle?: string;
    rules?: UrlRepoRule[];
    store?: TabAgentStore;
    repoMapEntries?: RepoMapEntry[];
    localhostResolver?: (port: number) => string | null;
    scratchDir?: string;
  } = {}
): RepoCandidate {
  const scratchPath = ensureScratchDir(opts.scratchDir);
  const rules = opts.rules ?? opts.store?.listRules() ?? [];

  // Tier 1: Pinned rules (SQLite url_repo_rules)
  for (const rule of rules) {
    if (matchRulePattern(rule.pattern, rawUrl)) {
      return {
        repoPath: expandTildePath(rule.repoPath),
        repoName: rule.repoName,
        source: "pinned",
        confidence: "high",
        matchedPattern: rule.pattern,
        reason: `pinned rule (${rule.pattern})`,
      };
    }
  }

  // Tier 2: Localhost port introspection
  try {
    const u = new URL(rawUrl);
    if (
      (u.hostname === "localhost" || u.hostname === "127.0.0.1") &&
      u.port
    ) {
      const port = Number(u.port);
      const resolver = opts.localhostResolver ?? resolveLocalhostPortCwd;
      const cwd = resolver(port);
      if (cwd) {
        return {
          repoPath: cwd,
          repoName: basename(cwd),
          source: "localhost",
          confidence: "high",
          matchedPattern: `${u.hostname}:${port}`,
          reason: `local server listening on :${port}`,
        };
      }
    }
  } catch {}

  // Tier 3: repo-map suggestion
  const mapHit = matchRepoMap(rawUrl, opts.pageTitle || "", opts.repoMapEntries);
  if (mapHit) {
    return mapHit;
  }

  // Tier 4: Safe scratch fallback
  return {
    repoPath: scratchPath,
    repoName: "Browser Scratch",
    source: "scratch",
    confidence: "fallback",
    reason: "unmapped URL — safe scratch workspace",
  };
}

export function searchRepoCatalogue(queryStr = "", limit = 25): Array<{
  name: string;
  path: string;
  displayPath: string;
  summary: string;
}> {
  const entries = loadRepoMap();
  const q = queryStr.trim().toLowerCase();
  const scored: Array<{ entry: RepoMapEntry; score: number }> = [];
  for (const e of entries) {
    if (!q) {
      scored.push({ entry: e, score: 1 });
      continue;
    }
    const nameLow = e.name.toLowerCase();
    const pathLow = e.path.toLowerCase();
    const sumLow = e.summary.toLowerCase();
    const aliasHit = e.aliases.some((a) => a.toLowerCase().includes(q));
    let score = 0;
    if (nameLow === q) score = 100;
    else if (nameLow.startsWith(q)) score = 80;
    else if (nameLow.includes(q)) score = 60;
    else if (aliasHit) score = 50;
    else if (pathLow.includes(q)) score = 35;
    else if (sumLow.includes(q)) score = 20;
    if (score > 0) scored.push({ entry: e, score });
  }
  scored.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
  return scored.slice(0, limit).map(({ entry }) => ({
    name: entry.name,
    path: entry.path,
    displayPath: toTildePath(entry.path),
    summary: entry.summary,
  }));
}
