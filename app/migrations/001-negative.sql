-- 마이그레이션 001: 부정보도 분류 컬럼 추가
-- 라이브 D1에는 이미 실데이터(습지 2,986곳 + 뉴스 수백 건)가 있으므로
-- schema.sql(DROP 방식)을 다시 적용하면 데이터가 지워진다.
-- 따라서 기존 DB에는 이 ALTER TABLE 마이그레이션만 적용한다.
--
-- 로컬 적용:  wrangler d1 execute wetland-db --local  --file=migrations/001-negative.sql
-- 라이브 적용: wrangler d1 execute wetland-db --remote --file=migrations/001-negative.sql
--
-- is_negative:     NULL=미판정, 0=일반, 1=부정보도
-- negative_source: NULL | 'ai'(자동 분류) | 'manual'(직원 수동 지정)

ALTER TABLE news_issues ADD COLUMN is_negative INTEGER;
ALTER TABLE news_issues ADD COLUMN negative_source TEXT;

-- 미판정(is_negative IS NULL) 뉴스를 점진 백필할 때 자주 조회하므로 인덱스를 둔다.
CREATE INDEX IF NOT EXISTS idx_news_issues_is_negative ON news_issues(is_negative);
