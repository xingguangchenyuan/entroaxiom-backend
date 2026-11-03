-- 0001_init.sql
-- ENTROAXIOM 后端初始结构。所有时间列统一 timestamptz，日期列统一 date。
-- 约定：可写资源都带整数 revision 做乐观锁；软删除只用于文件（deleted_at）。

create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  username      text not null,
  password_hash text not null,
  nickname      text not null default '',
  avatar        text,
  roles         jsonb not null default '["admin"]'::jsonb,
  permissions   jsonb not null default '["*:*:*"]'::jsonb,
  disabled_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint users_username_unique unique (username)
);

create table if not exists sessions (
  id              uuid primary key default gen_random_uuid(),
  token_hash      text not null,
  user_id         uuid not null references users (id) on delete cascade,
  expires_at      timestamptz not null,
  last_seen_at    timestamptz not null default now(),
  revoked_at      timestamptz,
  created_ip_hash text,
  user_agent      text,
  created_at      timestamptz not null default now(),
  constraint sessions_token_hash_unique unique (token_hash)
);

create index if not exists sessions_user_idx on sessions (user_id);
create index if not exists sessions_expires_idx on sessions (expires_at);

create table if not exists audit_logs (
  id            uuid primary key default gen_random_uuid(),
  actor_user_id uuid references users (id) on delete set null,
  action        text not null,
  resource_type text not null,
  resource_id   text not null,
  before_json   jsonb,
  after_json    jsonb,
  ip_hash       text,
  created_at    timestamptz not null default now()
);

create index if not exists audit_logs_created_idx on audit_logs (created_at desc);
create index if not exists audit_logs_resource_idx on audit_logs (resource_type, resource_id);

-- ---------------------------------------------------------------- 文章

create table if not exists articles (
  id                 text primary key,
  resource_type      text not null check (resource_type in ('notes', 'essays')),
  title              text not null default '',
  body               text not null default '',
  summary            text,
  category           text,
  tags               text[],
  date               date,
  updated            date,
  mood               text,
  place              text,
  visibility         text not null default 'private' check (visibility in ('public', 'private')),
  status             text not null default 'draft' check (status in ('draft', 'published')),
  revision           integer not null default 1,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  published_at       timestamptz,
  published_revision integer,
  created_by         uuid references users (id) on delete set null
);

create index if not exists articles_type_updated_idx on articles (resource_type, updated_at desc);
create index if not exists articles_status_idx on articles (status, visibility);

create table if not exists article_versions (
  id         uuid primary key default gen_random_uuid(),
  article_id text not null references articles (id) on delete cascade,
  version    integer not null,
  source     text not null check (source in ('manual', 'publish', 'import', 'restore')),
  title      text not null default '',
  body       text not null default '',
  summary    text,
  category   text,
  tags       text[],
  date       date,
  updated    date,
  mood       text,
  place      text,
  size       integer not null default 0,
  created_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint article_versions_unique unique (article_id, version)
);

create index if not exists article_versions_article_idx on article_versions (article_id, version desc);

create table if not exists published_article_snapshots (
  article_id         text primary key references articles (id) on delete cascade,
  published_revision integer not null,
  public_title       text not null,
  public_summary     text,
  public_body        text not null,
  public_meta        jsonb not null default '{}'::jsonb,
  published_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------- 文件

create table if not exists files (
  id          text primary key,
  name        text not null,
  ext         text not null default '',
  mime        text not null,
  kind        text not null check (kind in ('image', 'pdf', 'archive', 'doc', 'other')),
  size        bigint not null,
  storage_key text not null,
  visibility  text not null default 'private' check (visibility in ('public', 'private')),
  status      text not null default 'ready' check (status in ('ready', 'processing', 'failed')),
  description text,
  revision    integer not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  created_by  uuid references users (id) on delete set null,
  constraint files_storage_key_unique unique (storage_key)
);

create index if not exists files_created_idx on files (created_at desc);
create index if not exists files_kind_idx on files (kind);
create index if not exists files_visibility_idx on files (visibility);

create table if not exists file_references (
  id             bigserial primary key,
  file_id        text not null references files (id) on delete cascade,
  usage          text not null check (usage in ('working', 'published', 'version', 'cover')),
  owner          text not null check (owner in ('notes', 'essays', 'shelf')),
  target_id      text not null,
  target_version integer not null default 0,
  is_public      boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint file_references_unique unique (file_id, usage, owner, target_id, target_version)
);

create index if not exists file_references_file_idx on file_references (file_id);
create index if not exists file_references_target_idx on file_references (owner, target_id);

-- ---------------------------------------------------------------- 书架

create table if not exists shelf_items (
  id                 text primary key,
  kind               text not null check (kind in ('book', 'film', 'music')),
  title              text not null default '',
  creator            text,
  year               integer,
  rating             numeric(2, 1),
  status             text not null default 'want' check (status in ('done', 'doing', 'want')),
  date               date,
  tags               text[],
  quote              text,
  review             text,
  cover              text,
  link               text,
  publication_status text not null default 'draft' check (publication_status in ('draft', 'published')),
  visibility         text not null default 'private' check (visibility in ('public', 'private')),
  cover_visibility   text check (cover_visibility in ('public', 'private')),
  revision           integer not null default 1,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  published_at       timestamptz,
  published_revision integer,
  created_by         uuid references users (id) on delete set null
);

create index if not exists shelf_items_status_idx on shelf_items (publication_status, visibility);

-- ---------------------------------------------------------------- 留言板

create table if not exists guestbook (
  id         text primary key,
  name       text not null,
  email      text,
  site       text,
  body       text not null,
  sigil      text,
  status     text not null default 'pending' check (status in ('approved', 'blocked', 'hidden', 'pending')),
  ip_hash    text,
  revision   integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists guestbook_status_created_idx on guestbook (status, created_at desc);
create index if not exists guestbook_created_idx on guestbook (created_at desc);

create table if not exists guestbook_replies (
  guestbook_id   text primary key references guestbook (id) on delete cascade,
  body           text not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz,
  author_user_id uuid references users (id) on delete set null
);

create table if not exists moderation_evidence (
  guestbook_id   text primary key references guestbook (id) on delete cascade,
  rule_id        text,
  rule_text      text,
  field          text not null check (field in ('name', 'body')),
  reason         text not null,
  policy_version text,
  matched_at     timestamptz not null default now()
);

create table if not exists moderation_rules (
  id              text primary key,
  text            text not null,
  normalized_text text not null,
  match_mode      text not null check (match_mode in ('contains', 'exact')),
  fields          text[] not null default array['name', 'body'],
  category        text not null default 'general',
  enabled         boolean not null default true,
  revision        integer not null default 1,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index if not exists moderation_rules_unique
  on moderation_rules (normalized_text, match_mode, fields);

-- ---------------------------------------------------------------- 导入

create table if not exists imports (
  id            text primary key,
  user_id       uuid not null references users (id) on delete cascade,
  resource_type text not null check (resource_type in ('notes', 'essays')),
  original_name text not null,
  archive_kind  text not null check (archive_kind in ('markdown', 'zip')),
  temp_dir      text not null,
  selected_path text,
  status        text not null default 'open' check (status in ('open', 'committed', 'deleted')),
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists imports_user_idx on imports (user_id, created_at desc);

create table if not exists import_assets (
  id         bigserial primary key,
  import_id  text not null references imports (id) on delete cascade,
  path       text not null,
  name       text not null,
  kind       text not null,
  size       bigint not null default 0,
  file_id    text references files (id) on delete set null,
  referenced boolean not null default false,
  state      text not null default 'unreferenced',
  note       text,
  constraint import_assets_unique unique (import_id, path)
);

-- ---------------------------------------------------------------- 发布预检

create table if not exists publication_checks (
  id                text primary key,
  user_id           uuid not null references users (id) on delete cascade,
  subject_type      text not null check (subject_type in ('article', 'shelf')),
  subject_id        text not null,
  action            text not null check (action in ('publish', 'visibility')),
  target_visibility text check (target_visibility in ('public', 'private')),
  base_revision     integer not null,
  private_asset_ids text[] not null default array[]::text[],
  checks            jsonb not null default '[]'::jsonb,
  expires_at        timestamptz not null,
  consumed_at       timestamptz,
  created_at        timestamptz not null default now()
);

create index if not exists publication_checks_subject_idx
  on publication_checks (subject_type, subject_id, created_at desc);

-- 供 migrator 记录版本；业务代码不写这张表
create table if not exists schema_migrations (
  version    text primary key,
  checksum   text not null,
  applied_at timestamptz not null default now()
);
