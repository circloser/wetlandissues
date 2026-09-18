-- 마이그레이션 003: 배치 수집 커서를 OFFSET 대신 (priority, id) 키로
--
-- 예전 수집 쿼리(ORDER BY priority DESC, id LIMIT ? OFFSET ?)는 인덱스를 못 타서
-- 배치마다 습지 표 전체를 읽었고, D1 무료 한도(계정 전체 하루 500만 행 읽기)를
-- 혼자 소진해 같은 계정의 다른 서비스까지 멈췄다. 이 인덱스와 커서 칸으로
-- 배치당 읽기가 배치 크기(35행) 수준으로 줄어든다. (src/collector.js nextWetlands)
--
-- 라이브 적용: wrangler d1 execute wetland-db --remote --file=migrations/003-collect-cursor.sql
-- ※ 코드 배포보다 먼저 적용할 것 (새 코드가 cursor_priority/cursor_id 칸을 쓴다).

CREATE INDEX IF NOT EXISTS idx_wetlands_priority_id ON wetlands(priority DESC, id);
ALTER TABLE collect_state ADD COLUMN cursor_priority INTEGER;
ALTER TABLE collect_state ADD COLUMN cursor_id INTEGER;
