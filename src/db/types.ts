import type { ColumnType, Generated } from "kysely";

/**
 * 数据库行类型（snake_case，与迁移脚本一一对应）。
 * 约定：
 * - 时间戳在 JS 侧是 Date，序列化成 ISO 字符串返回给前端；
 * - date 列在 JS 侧是 `YYYY-MM-DD` 字符串（pg 默认就返回字符串）；
 * - jsonb 列写入时必须传 JSON 字符串（避免 node-pg 把数组当成 PG 数组字面量）；
 * - text[] 列可以直接传 JS 字符串数组。
 */

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type DateOnly = ColumnType<string, string | null | undefined, string | null>;
type JsonText = ColumnType<unknown, string | undefined, string>;

export interface UsersTable {
  id: Generated<string>;
  username: string;
  password_hash: string;
  nickname: Generated<string>;
  avatar: string | null;
  roles: JsonText;
  permissions: JsonText;
  disabled_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface SessionsTable {
  id: Generated<string>;
  token_hash: string;
  user_id: string;
  expires_at: Timestamp;
  last_seen_at: Timestamp;
  revoked_at: Timestamp | null;
  created_ip_hash: string | null;
  user_agent: string | null;
  created_at: Timestamp;
}

export interface AuditLogsTable {
  id: Generated<string>;
  actor_user_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string;
  before_json: JsonText | null;
  after_json: JsonText | null;
  ip_hash: string | null;
  created_at: Timestamp;
}

export interface ArticlesTable {
  id: string;
  resource_type: "notes" | "essays";
  title: Generated<string>;
  body: Generated<string>;
  summary: string | null;
  category: string | null;
  tags: ColumnType<string[] | null, string[] | null | undefined, string[] | null>;
  date: DateOnly;
  updated: DateOnly;
  mood: string | null;
  place: string | null;
  visibility: Generated<"public" | "private">;
  status: Generated<"draft" | "published">;
  revision: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
  published_at: Timestamp | null;
  published_revision: number | null;
  created_by: string | null;
}

export interface ArticleVersionsTable {
  id: Generated<string>;
  article_id: string;
  version: number;
  source: "manual" | "publish" | "import" | "restore";
  title: Generated<string>;
  body: Generated<string>;
  summary: string | null;
  category: string | null;
  tags: ColumnType<string[] | null, string[] | null | undefined, string[] | null>;
  date: DateOnly;
  updated: DateOnly;
  mood: string | null;
  place: string | null;
  size: Generated<number>;
  created_by: string | null;
  created_at: Timestamp;
}

export interface PublishedArticleSnapshotsTable {
  article_id: string;
  published_revision: number;
  public_title: string;
  public_summary: string | null;
  public_body: string;
  public_meta: JsonText;
  published_at: Timestamp;
}

export interface FilesTable {
  id: string;
  name: string;
  ext: Generated<string>;
  mime: string;
  kind: "image" | "pdf" | "archive" | "doc" | "other";
  size: ColumnType<number, number, number>;
  storage_key: string;
  visibility: Generated<"public" | "private">;
  status: Generated<"ready" | "processing" | "failed">;
  description: string | null;
  revision: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
  deleted_at: Timestamp | null;
  created_by: string | null;
}

export interface FileReferencesTable {
  id: Generated<number>;
  file_id: string;
  usage: "working" | "published" | "version" | "cover";
  owner: "notes" | "essays" | "shelf";
  target_id: string;
  target_version: Generated<number>;
  is_public: Generated<boolean>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ShelfItemsTable {
  id: string;
  kind: "book" | "film" | "music";
  title: Generated<string>;
  creator: string | null;
  year: number | null;
  rating: ColumnType<number | null, number | string | null, number | string | null>;
  status: Generated<"done" | "doing" | "want">;
  date: DateOnly;
  tags: ColumnType<string[] | null, string[] | null | undefined, string[] | null>;
  quote: string | null;
  review: string | null;
  cover: string | null;
  link: string | null;
  publication_status: Generated<"draft" | "published">;
  visibility: Generated<"public" | "private">;
  cover_visibility: "public" | "private" | null;
  published_cover: string | null;
  revision: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
  published_at: Timestamp | null;
  published_revision: number | null;
  created_by: string | null;
}

export interface GuestbookTable {
  id: string;
  name: string;
  email: string | null;
  site: string | null;
  body: string;
  sigil: string | null;
  status: Generated<"approved" | "blocked" | "hidden" | "pending">;
  ip_hash: string | null;
  revision: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface GuestbookRepliesTable {
  guestbook_id: string;
  body: string;
  created_at: Timestamp;
  updated_at: Timestamp | null;
  author_user_id: string | null;
}

export interface ModerationEvidenceTable {
  guestbook_id: string;
  rule_id: string | null;
  rule_text: string | null;
  field: "name" | "body";
  reason: string;
  policy_version: string | null;
  matched_at: Timestamp;
}

export interface ModerationRulesTable {
  id: string;
  text: string;
  normalized_text: string;
  match_mode: "contains" | "exact";
  fields: ColumnType<string[], string[] | undefined, string[]>;
  category: Generated<string>;
  enabled: Generated<boolean>;
  revision: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ImportsTable {
  id: string;
  user_id: string;
  resource_type: "notes" | "essays";
  original_name: string;
  archive_kind: "markdown" | "zip";
  temp_dir: string;
  selected_path: string | null;
  status: Generated<"open" | "committed" | "deleted">;
  expires_at: Timestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ImportAssetsTable {
  id: Generated<number>;
  import_id: string;
  path: string;
  name: string;
  kind: string;
  size: Generated<number>;
  file_id: string | null;
  referenced: Generated<boolean>;
  state: Generated<string>;
  note: string | null;
}

export interface PublicationChecksTable {
  id: string;
  user_id: string;
  subject_type: "article" | "shelf";
  subject_id: string;
  action: "publish" | "visibility";
  target_visibility: "public" | "private" | null;
  base_revision: number;
  private_asset_ids: ColumnType<string[], string[], string[]>;
  checks: JsonText;
  expires_at: Timestamp;
  consumed_at: Timestamp | null;
  created_at: Timestamp;
}

export interface SchemaMigrationsTable {
  version: string;
  checksum: string;
  applied_at: Timestamp;
}

export interface Database {
  users: UsersTable;
  sessions: SessionsTable;
  audit_logs: AuditLogsTable;
  articles: ArticlesTable;
  article_versions: ArticleVersionsTable;
  published_article_snapshots: PublishedArticleSnapshotsTable;
  files: FilesTable;
  file_references: FileReferencesTable;
  shelf_items: ShelfItemsTable;
  guestbook: GuestbookTable;
  guestbook_replies: GuestbookRepliesTable;
  moderation_evidence: ModerationEvidenceTable;
  moderation_rules: ModerationRulesTable;
  imports: ImportsTable;
  import_assets: ImportAssetsTable;
  publication_checks: PublicationChecksTable;
  schema_migrations: SchemaMigrationsTable;
}

export type ContentRes = "notes" | "essays";

