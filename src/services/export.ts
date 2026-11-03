import { readFile } from "node:fs/promises";
import yazl from "yazl";
import type { Db } from "../db/index.js";
import { errors } from "../http/errors.js";
import { publicUrlFor } from "../http/serialize.js";
import { buildFrontmatter } from "../lib/frontmatter.js";
import { extractAssetIds } from "../lib/markdown.js";
import { sanitizeFileName } from "../lib/mime.js";
import { getArticleRow } from "./articles.js";
import { getFileRow } from "./files.js";
import { storedPath } from "./storage.js";
import { getContext } from "../context.js";
import type { ContentRes } from "../db/types.js";

export interface ExportFile {
  filename: string;
  contentType: string;
  body: Buffer;
}

interface ExportAsset {
  id: string;
  name: string;
  kind: string;
  size: number;
  usage: "working" | "published";
  bytes: Buffer | null;
}

function uniqueName(used: Map<string, number>, raw: string): string {
  const base = sanitizeFileName(raw);
  const count = used.get(base) ?? 0;
  used.set(base, count + 1);
  if (count === 0) return base;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return `${base}-${count + 1}`;
  return `${base.slice(0, dot)}-${count + 1}${base.slice(dot)}`;
}

async function loadAsset(
  db: Db,
  fileId: string,
  usage: "working" | "published"
): Promise<ExportAsset | null> {
  const row = await db
    .selectFrom("files")
    .selectAll()
    .where("id", "=", fileId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!row) return null;
  let bytes: Buffer | null = null;
  try {
    bytes = await readFile(storedPath(getContext().config, row.visibility, row.storage_key));
  } catch {
    bytes = null;
  }
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    size: Number(row.size),
    usage,
    bytes
  };
}

/**
 * 导出单篇：md 只含 frontmatter + 正文；zip 额外带 assets/ 与 README.txt。
 * 正文里的 `asset:<id>`（工作稿）或 /uploads/public/... （发布快照）都会改写成
 * 相对路径 `./assets/<文件名>`，导出的 md 才可能被重新导入。
 */
export async function exportArticle(
  db: Db,
  res: ContentRes,
  id: string,
  options: { source: "working" | "published"; format: "md" | "zip" }
): Promise<ExportFile> {
  const row = await getArticleRow(db, res, id);

  let title = row.title;
  let summary = row.summary;
  let category = row.category;
  let tags = row.tags;
  let date: string | null = row.date;
  let updated: string | null = row.updated;
  let mood: string | null = row.mood;
  let place: string | null = row.place;
  let rawBody = row.body;
  let usage: "working" | "published" = "working";
  let sourceLabel = "工作稿";

  if (options.source === "published") {
    if (row.status !== "published") throw errors.notPublished();
    const snapshot = await db
      .selectFrom("published_article_snapshots")
      .selectAll()
      .where("article_id", "=", id)
      .executeTakeFirst();
    if (!snapshot) throw errors.notPublished();
    const meta = (snapshot.public_meta ?? {}) as Record<string, unknown>;
    title = snapshot.public_title;
    summary = snapshot.public_summary;
    rawBody = snapshot.public_body;
    category = (meta.category as string | null) ?? null;
    tags = (meta.tags as string[] | null) ?? null;
    date = (meta.date as string | null) ?? null;
    updated = (meta.updated as string | null) ?? null;
    mood = (meta.mood as string | null) ?? null;
    place = (meta.place as string | null) ?? null;
    usage = "published";
    sourceLabel = "发布快照";
  }

  const used = new Map<string, number>();
  const assets: ExportAsset[] = [];
  const byFileId = new Map<string, ExportAsset>();
  const byUrl = new Map<string, ExportAsset>();

  const candidateIds = usage === "working" ? extractAssetIds(rawBody) : [];
  if (usage === "published") {
    const urlPattern = /\/uploads\/public\/([A-Za-z0-9_-]+)\.([A-Za-z0-9]+)/g;
    let match: RegExpExecArray | null;
    while ((match = urlPattern.exec(rawBody)) !== null) {
      const fileId = match[1];
      if (fileId && !candidateIds.includes(fileId)) candidateIds.push(fileId);
    }
  }

  for (const fileId of candidateIds) {
    const asset = await loadAsset(db, fileId, usage);
    if (!asset) continue;
    asset.name = uniqueName(used, asset.name || `asset-${asset.id}`);
    assets.push(asset);
    byFileId.set(asset.id, asset);
    byUrl.set(publicUrlFor({ id: asset.id, ext: asset.name.split(".").pop() ?? "" }), asset);
  }

  const frontmatter = buildFrontmatter({
    id: row.id,
    title,
    summary,
    category,
    tags,
    date,
    updated,
    ...(res === "essays" ? { mood, place } : {})
  });

  // 单文件 md 不带资源，此时把引用改写成 ./assets/ 只会得到一堆断链：
  // 工作稿保留 asset: 引用、已发布稿保留公开 URL，两种都能被编辑器与再导入识别。
  if (options.format === "md") {
    const body = rawBody.replace(/\r\n/g, "\n").trimEnd();
    return {
      filename: `${row.id}.md`,
      contentType: "text/markdown; charset=utf-8",
      body: Buffer.from(`${frontmatter}\n${body}\n`, "utf8")
    };
  }

  // 只有 zip 会同时打包 assets/，因此引用要换成包内相对路径。
  let body = rawBody;
  if (usage === "working") {
    body = body.replace(/!?\[([^\]]*)\]\(\s*<?asset:([A-Za-z0-9_-]+)>?\s*\)/g, (whole, _label: string, fileId: string) => {
      const asset = byFileId.get(fileId);
      if (!asset) return whole;
      const isImage = whole.startsWith("!");
      return isImage ? `![${_label}](./assets/${asset.name})` : `[${_label}](./assets/${asset.name})`;
    });
  } else {
    for (const [url, asset] of byUrl) {
      body = body.split(url).join(`./assets/${asset.name}`);
    }
  }
  const markdown = `${frontmatter}\n${body.replace(/\r\n/g, "\n").trimEnd()}\n`;

  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(markdown, "utf8"), `${row.id}.md`);
  const manifest: string[] = [
    "ENTROAXIOM 导出包",
    "",
    `内容：${res} / ${row.id}`,
    `标题：${title}`,
    `来源：${sourceLabel}`,
    `导出时间：${new Date().toISOString()}`,
    "",
    "文件：",
    `- ${row.id}.md  正文（含 frontmatter）`
  ];
  for (const asset of assets) {
    const entryName = `assets/${asset.name}`;
    if (asset.bytes) {
      zip.addBuffer(asset.bytes, entryName);
      manifest.push(`- ${entryName}  文件 ID=${asset.id}  类型=${asset.kind}  大小=${asset.size} 字节`);
    } else {
      manifest.push(`- ${entryName}  （物理文件缺失，未打包）文件 ID=${asset.id}`);
    }
  }
  manifest.push(
    "",
    "恢复说明：",
    "1. 把 assets/ 与 .md 放在同一目录后，正文里的 ./assets/ 引用即可正常显示；",
    "2. 重新导入时，正文的相对路径会按文件名匹配到压缩包里的资源；",
    "3. 导入只会生成工作稿，不会自动发布。"
  );
  zip.addBuffer(Buffer.from(`${manifest.join("\n")}\n`, "utf8"), "README.txt");
  zip.end();

  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as Uint8Array));
  }

  return {
    filename: `${row.id}.zip`,
    contentType: "application/zip",
    body: Buffer.concat(chunks)
  };
}
