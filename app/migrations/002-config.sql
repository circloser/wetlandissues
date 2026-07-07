-- 마이그레이션 002: 앱 설정(app_config) 테이블 추가
-- 전 직원이 공유하는 서버 저장 설정(지도 API 키 등)을 key-value로 보관한다.
-- 라이브 D1에는 실데이터가 있으므로 schema.sql(DROP 방식)이 아니라 이 마이그레이션만 적용한다.
--
-- 로컬 적용:  wrangler d1 execute wetland-db --local  --file=migrations/002-config.sql
-- 라이브 적용: wrangler d1 execute wetland-db --remote --file=migrations/002-config.sql
--
-- 사용 키(최소): vworld_key(VWorld API 키), kakao_key(카카오 JavaScript 키)
-- ※ 이 키들은 원래 브라우저에 노출되는 도메인 제한 키라 D1 저장·클라이언트 전달이 정상이다.

CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT
);
