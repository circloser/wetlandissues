-- 습지 이슈 맵퍼 D1 스키마
-- 주의: 이 파일을 실행하면 기존 테이블과 데이터가 초기화됩니다 (시드 재적용 전제).

DROP TABLE IF EXISTS news_issues;
DROP TABLE IF EXISTS wetlands;

-- 습지 마스터 테이블 (내륙습지 목록 2,986개소 + 보호지역 지정 정보)
-- priority: 1 = 습지보호지역(뉴스 수집 우선), 0 = 일반
CREATE TABLE wetlands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  region TEXT,
  designation TEXT,
  type TEXT,
  priority INTEGER NOT NULL DEFAULT 0
);

-- 습지별 뉴스 이슈 테이블 (뉴스 본문은 저장하지 않고 링크만 보관 — 저작권)
-- status: 'unreviewed' | 'confirmed' | 'hidden'
-- is_negative: NULL=미판정, 0=일반, 1=부정보도(오염·훼손·불법행위·개발위협 등)
-- negative_source: NULL | 'ai'(AI 자동 분류) | 'manual'(직원 수동 지정)
-- ※ 기존 라이브 DB에는 이 스키마 대신 migrations/001-negative.sql만 적용할 것(데이터 보존).
CREATE TABLE news_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wetland_id INTEGER REFERENCES wetlands(id),
  title TEXT NOT NULL,
  link TEXT NOT NULL UNIQUE,
  source TEXT,
  published_at TEXT,
  status TEXT NOT NULL DEFAULT 'unreviewed',
  is_negative INTEGER,
  negative_source TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_news_issues_wetland_id ON news_issues(wetland_id);
CREATE INDEX idx_news_issues_published_at ON news_issues(published_at);
CREATE INDEX idx_news_issues_status ON news_issues(status);
CREATE INDEX idx_news_issues_is_negative ON news_issues(is_negative);
CREATE INDEX idx_wetlands_priority ON wetlands(priority);

-- 뉴스 수집 진행 상태 (배치 수집 커서/진행률 — 항상 1행만 사용)
DROP TABLE IF EXISTS collect_state;
CREATE TABLE collect_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cursor_pos INTEGER NOT NULL DEFAULT 0,
  running INTEGER NOT NULL DEFAULT 0,
  processed INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  collected INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  updated_at TEXT
);
INSERT INTO collect_state (id) VALUES (1);

-- 앱 설정 (전 직원 공유) — 지도 API 키 등을 key-value로 저장 (migrations/002-config.sql 동기화)
-- 사용 키(최소): vworld_key(VWorld API 키), kakao_key(카카오 JavaScript 키)
-- ※ 라이브 DB에는 이 스키마 대신 migrations/002-config.sql만 적용할 것(데이터 보존).
CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT
);
