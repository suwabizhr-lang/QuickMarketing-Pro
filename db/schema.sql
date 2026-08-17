-- 買取店マーケティングシステム Postgres スキーマ（Supabase）。
-- SQLite版(src/db.js)からの移植。JSON列は TEXT のまま維持（db.jsがJSON文字列で読み書きするため）。
-- boolean的用途(active/auto_publish/enabled)は INTEGER(0/1) 維持。日時は TEXT(ISO文字列) 維持。
-- 前方参照があるため、FK制約はテーブル作成後に ALTER で後付け（冪等）。
-- 冪等: CREATE TABLE IF NOT EXISTS + FKは存在チェックしてから追加。

CREATE TABLE IF NOT EXISTS business_type (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  required_licenses TEXT NOT NULL DEFAULT '[]',
  cta_default_label TEXT NOT NULL DEFAULT 'この店に今すぐ査定',
  form_kind_default TEXT NOT NULL DEFAULT 'assessment'
);

CREATE TABLE IF NOT EXISTS store (
  id TEXT PRIMARY KEY,
  owner_id TEXT,
  business_type_id TEXT NOT NULL,
  name TEXT NOT NULL,
  license_values TEXT NOT NULL DEFAULT '{}',
  address TEXT, tel TEXT, area TEXT,
  logo_url TEXT,
  brand_color TEXT DEFAULT '#FFE600',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lead_form (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '査定フォーム',
  kind TEXT NOT NULL DEFAULT 'assessment',
  fields TEXT NOT NULL DEFAULT '{}',
  public_slug TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaign (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL,
  lead_form_id TEXT,
  title TEXT NOT NULL,
  detail TEXT,
  discount_type TEXT,
  valid_from TEXT, valid_to TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lead_submission (
  id TEXT PRIMARY KEY,
  lead_form_id TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  utm TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS asset (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL,
  campaign_id TEXT,
  kind TEXT NOT NULL,
  url TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS post (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL,
  campaign_id TEXT,
  channel TEXT NOT NULL,
  body TEXT,
  video_asset_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  external_ref TEXT,
  scheduled_at TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_connection (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  label TEXT,
  auto_config TEXT NOT NULL DEFAULT '{}',
  manual_config TEXT NOT NULL DEFAULT '{}',
  auto_publish INTEGER NOT NULL DEFAULT 0,
  access_token TEXT,
  account_ref TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS article (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL,
  title TEXT,
  body TEXT NOT NULL DEFAULT '',
  theme TEXT,
  source TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS article_schedule (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL,
  theme TEXT NOT NULL,
  frequency TEXT NOT NULL DEFAULT 'daily',
  at_time TEXT NOT NULL DEFAULT '09:00',
  weekday INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS post_publication (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS store_setting (
  store_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (store_id, key)
);

-- FK制約を後付け（存在しなければ追加）。前方参照/循環を回避するため全テーブル作成後にまとめて。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_store_bt') THEN
    ALTER TABLE store ADD CONSTRAINT fk_store_bt FOREIGN KEY (business_type_id) REFERENCES business_type(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_leadform_store') THEN
    ALTER TABLE lead_form ADD CONSTRAINT fk_leadform_store FOREIGN KEY (store_id) REFERENCES store(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_campaign_store') THEN
    ALTER TABLE campaign ADD CONSTRAINT fk_campaign_store FOREIGN KEY (store_id) REFERENCES store(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_campaign_leadform') THEN
    ALTER TABLE campaign ADD CONSTRAINT fk_campaign_leadform FOREIGN KEY (lead_form_id) REFERENCES lead_form(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_submission_leadform') THEN
    ALTER TABLE lead_submission ADD CONSTRAINT fk_submission_leadform FOREIGN KEY (lead_form_id) REFERENCES lead_form(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_asset_store') THEN
    ALTER TABLE asset ADD CONSTRAINT fk_asset_store FOREIGN KEY (store_id) REFERENCES store(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_asset_campaign') THEN
    ALTER TABLE asset ADD CONSTRAINT fk_asset_campaign FOREIGN KEY (campaign_id) REFERENCES campaign(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_post_store') THEN
    ALTER TABLE post ADD CONSTRAINT fk_post_store FOREIGN KEY (store_id) REFERENCES store(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_post_campaign') THEN
    ALTER TABLE post ADD CONSTRAINT fk_post_campaign FOREIGN KEY (campaign_id) REFERENCES campaign(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_conn_store') THEN
    ALTER TABLE channel_connection ADD CONSTRAINT fk_conn_store FOREIGN KEY (store_id) REFERENCES store(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_article_store') THEN
    ALTER TABLE article ADD CONSTRAINT fk_article_store FOREIGN KEY (store_id) REFERENCES store(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_schedule_store') THEN
    ALTER TABLE article_schedule ADD CONSTRAINT fk_schedule_store FOREIGN KEY (store_id) REFERENCES store(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_pub_post') THEN
    ALTER TABLE post_publication ADD CONSTRAINT fk_pub_post FOREIGN KEY (post_id) REFERENCES post(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_pub_conn') THEN
    ALTER TABLE post_publication ADD CONSTRAINT fk_pub_conn FOREIGN KEY (connection_id) REFERENCES channel_connection(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_setting_store') THEN
    ALTER TABLE store_setting ADD CONSTRAINT fk_setting_store FOREIGN KEY (store_id) REFERENCES store(id);
  END IF;
END $$;
