export type FileKind = "image" | "pdf" | "archive" | "doc" | "other";

interface TypeInfo {
  mime: string;
  kind: FileKind;
}

const TABLE: Record<string, TypeInfo> = {
  jpg: { mime: "image/jpeg", kind: "image" },
  jpeg: { mime: "image/jpeg", kind: "image" },
  png: { mime: "image/png", kind: "image" },
  webp: { mime: "image/webp", kind: "image" },
  gif: { mime: "image/gif", kind: "image" },
  avif: { mime: "image/avif", kind: "image" },
  svg: { mime: "image/svg+xml", kind: "image" },
  ico: { mime: "image/x-icon", kind: "image" },
  pdf: { mime: "application/pdf", kind: "pdf" },
  zip: { mime: "application/zip", kind: "archive" },
  "7z": { mime: "application/x-7z-compressed", kind: "archive" },
  rar: { mime: "application/vnd.rar", kind: "archive" },
  gz: { mime: "application/gzip", kind: "archive" },
  tar: { mime: "application/x-tar", kind: "archive" },
  md: { mime: "text/markdown; charset=utf-8", kind: "doc" },
  markdown: { mime: "text/markdown; charset=utf-8", kind: "doc" },
  txt: { mime: "text/plain; charset=utf-8", kind: "doc" },
  doc: { mime: "application/msword", kind: "doc" },
  docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: "doc" },
  epub: { mime: "application/epub+zip", kind: "doc" }
};

export const ARCHIVE_EXTENSIONS = new Set(["zip", "7z", "rar", "tar", "gz", "tgz", "bz2", "xz", "zst", "tar.gz"]);

export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const index = base.lastIndexOf(".");
  if (index <= 0) return "";
  return base.slice(index + 1).toLowerCase();
}

export function describeExtension(extension: string): TypeInfo {
  const ext = extension.toLowerCase().replace(/^\./, "");
  return TABLE[ext] ?? { mime: "application/octet-stream", kind: "other" };
}

export function isAllowedExtension(extension: string, allowed: string[]): boolean {
  const ext = extension.toLowerCase().replace(/^\./, "");
  return allowed.includes(ext);
}

/** 落盘时只使用服务端生成的 ID 作为文件名，客户端名字只作展示与扩展名来源。 */
export function sanitizeFileName(raw: string): string {
  const base = (raw.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  const cleaned = base.replace(/^\.+/, "").trim();
  const name = cleaned.length > 0 ? cleaned : "未命名文件";
  return [...name].slice(0, 120).join("");
}

export function contentDispositionAttachment(fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export function contentDispositionInline(fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `inline; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/**
 * 本版本不接受 SVG：SVG 是可以直接执行的同源主动内容（脚本、外链、XSLT），
 * 在没有经过维护的清洗/栅格化流水线之前一律拒绝。这份名单在业务校验里强制生效，
 * 即使部署者误把 `svg` 写进 ALLOWED_EXTENSIONS 也仍然拒绝。
 */
export const BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set(["svg", "svgz"]);

/** 内容开头是不是 HTML/SVG/XML 这类"可被当作文档执行"的标记文本。 */
export function looksLikeMarkup(data: Buffer): boolean {
  const head = data
    .subarray(0, 512)
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .trimStart()
    .toLowerCase();
  return (
    head.startsWith("<!doctype html") ||
    head.startsWith("<html") ||
    head.startsWith("<svg") ||
    head.startsWith("<?xml")
  );
}

const MAGIC: Record<string, (data: Buffer) => boolean> = {
  png: data => data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpg: data => data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff,
  jpeg: data => data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff,
  gif: data => data.subarray(0, 4).toString("latin1") === "GIF8",
  webp: data =>
    data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP",
  avif: data => data.subarray(4, 8).toString("latin1") === "ftyp",
  pdf: data => data.subarray(0, 5).toString("latin1") === "%PDF-"
};

/**
 * 内容嗅探：只做"能确定不符就拒绝"的保守判断，认不出来的一律按扩展名放行，
 * 避免误杀合法文件。返回拒绝理由；通过时返回 null。
 */
export function sniffContentMismatch(extension: string, data: Buffer): string | null {
  const ext = extension.toLowerCase();
  if (looksLikeMarkup(data)) {
    return "文件内容看起来是 HTML/SVG 标记文档，与扩展名不符（这类文件可能被当作同源文档执行）";
  }
  const expected = MAGIC[ext];
  if (!expected) return null;
  if (expected(data)) return null;
  const actual = Object.keys(MAGIC).find(key => MAGIC[key](data));
  if (actual) {
    const actualName = actual === "jpeg" ? "jpg" : actual;
    return `文件内容实际是 .${actualName}，与扩展名 .${ext} 不符`;
  }
  return null;
}
