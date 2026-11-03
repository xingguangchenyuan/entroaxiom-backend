const ASSET_ID = "[A-Za-z0-9_-]{4,64}";
const LINK_RE = new RegExp(`(!?)\\[([^\\]\\n]*)\\]\\(\\s*asset:(${ASSET_ID})\\s*\\)`, "g");
const BARE_RE = new RegExp(`asset:(${ASSET_ID})`, "g");

/** 编辑器里私有资源的引用写法：`asset:<fileId>`。 */
export function extractAssetIds(text: string | null | undefined): string[] {
  if (!text) return [];
  const found = new Set<string>();
  for (const match of text.matchAll(new RegExp(`asset:(${ASSET_ID})`, "g"))) {
    found.add(match[1]);
  }
  return [...found];
}

export function hasAssetRefs(text: string | null | undefined): boolean {
  if (!text) return false;
  return new RegExp(`asset:(${ASSET_ID})`).test(text);
}

/**
 * 把正文里的 `asset:<id>` 引用改写成最终地址。
 * `resolve` 返回 `null` 表示该资源不公开：图片退化为 `*[图片未公开：alt]*`，
 * 普通链接退化为纯文本，绝不把 `asset:` 泄漏到公开响应里。
 */
export function replaceAssetRefs(text: string, resolve: (fileId: string) => string | null): string {
  const withLinks = text.replace(LINK_RE, (_match, bang: string, label: string, id: string) => {
    const url = resolve(id);
    if (url) return `${bang}[${label}](${url})`;
    if (bang) return `*[图片未公开：${label || id}]*`;
    return label || "*[附件未公开]*";
  });
  return withLinks.replace(BARE_RE, (_match, id: string) => resolve(id) ?? "");
}

/** 按 Unicode 码点计数，中文一个字算 1（后台的能力声明里也是这么写的）。 */
export function charCount(text: string | null | undefined): number {
  if (!text) return 0;
  return [...text].length;
}

/** 列表页摘要：去掉 Markdown 语法与图片，只留可读文字。 */
export function toPlainExcerpt(body: string | null | undefined, limit = 80): string {
  if (!body) return "";
  const text = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...text];
  if (chars.length <= limit) return text;
  return `${chars.slice(0, limit).join("")}…`;
}
