-- 습지 이슈 맵퍼 D1 스키마

-- 습지(습지보호지역/람사르 등록 습지) 마스터 테이블
CREATE TABLE IF NOT EXISTS wetlands (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  region TEXT,
  designation TEXT
);

-- 습지별 뉴스 이슈 테이블 (뉴스 본문은 저장하지 않고 링크만 보관 — 저작권)
-- status: 'unreviewed' | 'confirmed' | 'hidden'
CREATE TABLE IF NOT EXISTS news_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wetland_id INTEGER REFERENCES wetlands(id),
  title TEXT NOT NULL,
  link TEXT NOT NULL UNIQUE,
  source TEXT,
  published_at TEXT,
  status TEXT NOT NULL DEFAULT 'unreviewed',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_news_issues_wetland_id ON news_issues(wetland_id);
CREATE INDEX IF NOT EXISTS idx_news_issues_published_at ON news_issues(published_at);
CREATE INDEX IF NOT EXISTS idx_news_issues_status ON news_issues(status);
