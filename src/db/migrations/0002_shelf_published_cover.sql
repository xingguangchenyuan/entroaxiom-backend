-- 书架发布时的封面地址快照：公开接口只读发布结果，不再回头解析 asset: 引用。
alter table shelf_items add column if not exists published_cover text;
