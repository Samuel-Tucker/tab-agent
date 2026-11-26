import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AttachmentRecord } from "./db";
import { expandTildePath } from "./url-repo";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export const ALLOWED_IMAGE_EXTS: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

const MIME_TO_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/bmp": ".bmp",
  "image/x-ms-bmp": ".bmp",
  "image/avif": ".avif",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/tiff": ".tiff",
  "image/x-tiff": ".tiff",
};

const CONVERT_TO_PNG_EXTS = new Set([".tif", ".tiff", ".heic", ".heif"]);
const SIPS_BIN = "/usr/bin/sips";

export function getAttachmentsDir(customDir?: string): string {
  return resolve(
    customDir ||
      process.env.TAB_AGENT_ATTACHMENTS_DIR ||
      join(import.meta.dir, "..", "data", "attachments")
  );
}

export function isSafeSegment(seg: string): boolean {
  if (!seg || seg === "." || seg === "..") return false;
  return !/[\\/\0]/.test(seg) && !seg.includes("..");
}

function resolveImageMeta(
  rawName: string,
  rawMime: string
): { ext: string; mimeType: string; displayName: string } | null {
  const cleanMime = (rawMime || "").toLowerCase().split(";")[0].trim();
  const extFromMime = MIME_TO_EXT[cleanMime] || "";
  const rawExt = extname(rawName || "").toLowerCase();
  const extFromName = ALLOWED_IMAGE_EXTS[rawExt] ? rawExt : "";

  if (cleanMime && cleanMime !== "application/octet-stream" && !extFromMime) {
    return null;
  }
  const ext = extFromName || extFromMime;
  if (!ext) return null;

  const base = basename((rawName || "image").replace(/\\/g, "/")).trim();
  const stemRaw =
    rawExt && base.toLowerCase().endsWith(rawExt) ? base.slice(0, -rawExt.length) : base;
  const stem =
    stemRaw
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .replace(/^[._-]+|[._-]+$/g, "")
      .slice(0, 64) || "image";
  const displayName = `${stem}${ext}`;
  const mimeType = extFromMime ? cleanMime : ALLOWED_IMAGE_EXTS[ext];
  return { ext, mimeType, displayName };
}

function maybeConvertToPng(
  ext: string,
  displayName: string,
  mimeType: string,
  bytes: Uint8Array
): { displayName: string; mimeType: string; bytes: Uint8Array } {
  if (!CONVERT_TO_PNG_EXTS.has(ext) || !existsSync(SIPS_BIN)) {
    return { displayName, mimeType, bytes };
  }
  const tmpIn = join(tmpdir(), `ta-sips-in-${randomUUID()}${ext}`);
  const tmpOut = join(tmpdir(), `ta-sips-out-${randomUUID()}.png`);
  try {
    writeFileSync(tmpIn, bytes);
    const res = Bun.spawnSync([SIPS_BIN, "-s", "format", "png", tmpIn, "--out", tmpOut], {
      stdout: "ignore",
      stderr: "ignore",
    });
    if (res.exitCode === 0 && existsSync(tmpOut)) {
      const pngBytes = new Uint8Array(readFileSync(tmpOut));
      if (pngBytes.byteLength > 0 && pngBytes.byteLength <= MAX_ATTACHMENT_BYTES) {
        const stem = displayName.slice(0, -ext.length) || "image";
        return {
          displayName: `${stem}.png`,
          mimeType: "image/png",
          bytes: pngBytes,
        };
      }
    }
  } catch {
    // Fall back to original bytes
  } finally {
    try { rmSync(tmpIn, { force: true }); } catch {}
    try { rmSync(tmpOut, { force: true }); } catch {}
  }
  return { displayName, mimeType, bytes };
}

export function saveAttachmentBytes(
  sessionId: string,
  rawName: string,
  rawMime: string,
  bytes: Uint8Array,
  attachmentsDir?: string
): AttachmentRecord | { error: string } {
  if (!isSafeSegment(sessionId)) return { error: "Invalid session id" };
  if (bytes.byteLength === 0) return { error: "Image file is empty" };
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) return { error: "Image exceeds 20 MB limit" };

  const meta = resolveImageMeta(rawName, rawMime);
  if (!meta) return { error: "Unsupported image format" };

  const finalFile = maybeConvertToPng(meta.ext, meta.displayName, meta.mimeType, bytes);
  const rootDir = getAttachmentsDir(attachmentsDir);
  const sessionDir = resolve(rootDir, sessionId);
  const relDir = relative(rootDir, sessionDir);
  if (!relDir || relDir.startsWith("..") || isAbsolute(relDir)) {
    return { error: "Invalid attachment directory" };
  }
  mkdirSync(sessionDir, { recursive: true });

  const id = randomUUID().slice(0, 12);
  const storedName = `${id}-${finalFile.displayName}`;
  const destPath = resolve(sessionDir, storedName);
  writeFileSync(destPath, finalFile.bytes);

  return {
    id,
    name: finalFile.displayName,
    mimeType: finalFile.mimeType,
    size: finalFile.bytes.byteLength,
    path: destPath,
    url: `/api/attachments/${encodeURIComponent(sessionId)}/${encodeURIComponent(storedName)}`,
  };
}

export function saveAttachmentFromLocalPath(
  sessionId: string,
  rawLocal: string,
  attachmentsDir?: string
): AttachmentRecord | { error: string } {
  const trimmed = rawLocal.trim();
  if (!trimmed) return { error: "Empty localPath" };

  let fsPath = "";
  if (trimmed.toLowerCase().startsWith("file://")) {
    try {
      fsPath = fileURLToPath(trimmed);
    } catch {
      return { error: "Invalid file:// URI" };
    }
  } else {
    fsPath = expandTildePath(trimmed);
  }

  const resolvedLocal = resolve(fsPath);
  const ext = extname(resolvedLocal).toLowerCase();
  if (!ALLOWED_IMAGE_EXTS[ext]) {
    return { error: `Unsupported image file extension: ${ext || "(none)"}` };
  }
  if (!existsSync(resolvedLocal)) {
    return { error: "Local image file not found" };
  }
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(resolvedLocal);
  } catch {
    return { error: "Unable to read local image file" };
  }
  if (!st.isFile() || st.size <= 0) return { error: "Local path is not a valid image file" };
  if (st.size > MAX_ATTACHMENT_BYTES) return { error: "Image exceeds 20 MB limit" };

  const bytes = new Uint8Array(readFileSync(resolvedLocal));
  return saveAttachmentBytes(
    sessionId,
    basename(resolvedLocal),
    ALLOWED_IMAGE_EXTS[ext],
    bytes,
    attachmentsDir
  );
}

export function sanitizeMessageAttachments(
  rawList: unknown,
  sessionId: string,
  attachmentsDir?: string
): AttachmentRecord[] | null {
  if (rawList === undefined) return [];
  if (!Array.isArray(rawList)) return null;
  if (!isSafeSegment(sessionId)) return null;

  const rootDir = getAttachmentsDir(attachmentsDir);
  const sessionDir = resolve(rootDir, sessionId);
  const out: AttachmentRecord[] = [];
  for (const item of rawList) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const rec = item as Record<string, unknown>;
    if (typeof rec.path !== "string" || typeof rec.name !== "string") return null;

    const resolvedPath = resolve(rec.path);
    const rel = relative(sessionDir, resolvedPath);
    if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.includes("/") || rel.includes("\\")) {
      return null;
    }
    if (!existsSync(resolvedPath)) return null;
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(resolvedPath);
    } catch {
      return null;
    }
    if (!st.isFile() || st.size <= 0 || st.size > MAX_ATTACHMENT_BYTES) return null;
    const ext = extname(resolvedPath).toLowerCase();
    const mime = ALLOWED_IMAGE_EXTS[ext];
    if (!mime) return null;
    const storedName = basename(resolvedPath);
    out.push({
      id: typeof rec.id === "string" && rec.id ? rec.id : storedName,
      name: rec.name.slice(0, 180) || storedName,
      mimeType: mime,
      size: st.size,
      path: resolvedPath,
      url: `/api/attachments/${encodeURIComponent(sessionId)}/${encodeURIComponent(storedName)}`,
    });
  }
  return out;
}
