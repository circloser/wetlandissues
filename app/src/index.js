/**
 * 습지 이슈 맵퍼 — Cloudflare Worker 엔트리 포인트
 * - /api/* : API 라우트 (D1 조회, 뉴스 수집 트리거)
 * - 그 외 : 정적 자산(ASSETS)으로 폴백
 * - scheduled : 매일 뉴스 스크랩 배치 (US-002)
 */
import { collectNewsForAllWetlands } from "./collector.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/wetlands" && request.method === "GET") {
      return handleGetWetlands(request, env);
    }

    if (url.pathname === "/api/issues" && request.method === "GET") {
      return handleGetIssues(request, env);
    }

    if (url.pathname === "/api/collect" && request.method === "POST") {
      return handleCollectNews(request, env);
    }

    const issuePatchMatch = url.pathname.match(/^\/api\/issues\/(\d+)$/);
    if (issuePatchMatch && request.method === "PATCH") {
      return handlePatchIssue(request, env, issuePatchMatch[1]);
    }

    // API 외 경로는 정적 자산으로 폴백
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    // 매일 습지별 Google News RSS를 수집하여 news_issues 테이블에 저장한다.
    console.log("scheduled 트리거 실행됨 — 뉴스 수집 시작", event.cron);
    const result = await collectNewsForAllWetlands(env);
    console.log("뉴스 수집 완료:", JSON.stringify(result));
  },
};

/**
 * JSON 응답 생성 헬퍼.
 * @param {*} data 직렬화할 데이터
 * @param {number} [status=200] HTTP 상태 코드
 * @returns {Response}
 */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * POST /api/collect
 * 전체 습지에 대해 뉴스 수집을 즉시 실행하고 결과를 JSON으로 반환한다.
 */
async function handleCollectNews(request, env) {
  try {
    return json(await collectNewsForAllWetlands(env));
  } catch (err) {
    return json({ error: "뉴스 수집 중 오류가 발생했습니다.", detail: String(err) }, 500);
  }
}

/**
 * "YYYY-MM-DD" 형식인지 검사한다.
 * @param {string} value
 * @returns {boolean}
 */
function isValidDateString(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime());
}

/**
 * 요청 URL에서 from/to 날짜 쿼리 파라미터를 읽어 검증한다.
 * 형식이 올바르지 않으면 해당 파라미터는 무시한다(무시 방식으로 일관 처리).
 * @param {URL} url
 * @returns {{ from: string|null, to: string|null }}
 */
function parseDateRangeParams(url) {
  const fromRaw = url.searchParams.get("from");
  const toRaw = url.searchParams.get("to");

  return {
    from: isValidDateString(fromRaw) ? fromRaw : null,
    to: isValidDateString(toRaw) ? toRaw : null,
  };
}

/**
 * GET /api/wetlands
 * D1에서 습지 목록을 이름순으로 조회하여 JSON으로 반환한다.
 * 습지별 issue_count(숨김 제외 뉴스 건수)를 서브쿼리로 함께 반환한다.
 * from/to 쿼리 파라미터(YYYY-MM-DD)가 있으면 해당 기간(published_at 기준, from 00:00:00 ~
 * to 23:59:59) 내 뉴스만 issue_count에 반영한다. 형식이 올바르지 않으면 무시한다.
 */
async function handleGetWetlands(request, env) {
  try {
    const url = new URL(request.url);
    const { from, to } = parseDateRangeParams(url);

    const dateConditions = [];
    const dateBindings = [];

    if (from) {
      dateConditions.push("n.published_at >= ?");
      dateBindings.push(`${from} 00:00:00`);
    }
    if (to) {
      dateConditions.push("n.published_at <= ?");
      dateBindings.push(`${to} 23:59:59`);
    }

    const dateWhereSql = dateConditions.length > 0 ? ` AND ${dateConditions.join(" AND ")}` : "";

    const { results } = await env.DB.prepare(
      `SELECT
         w.*,
         (SELECT COUNT(*) FROM news_issues n
            WHERE n.wetland_id = w.id AND n.status != 'hidden'${dateWhereSql}) AS issue_count
       FROM wetlands w
       ORDER BY w.name`
    )
      .bind(...dateBindings)
      .all();

    return json(results);
  } catch (err) {
    return json({ error: "습지 목록 조회 중 오류가 발생했습니다.", detail: String(err) }, 500);
  }
}

/**
 * GET /api/issues?wetland_id={id}&from=&to=
 * 특정 습지의 뉴스 목록을 최신순으로 반환한다 (숨김 상태 제외).
 * from/to 쿼리 파라미터(YYYY-MM-DD)가 있으면 published_at 기준으로 기간을 제한한다
 * (from 00:00:00 ~ to 23:59:59 포함). 형식이 올바르지 않으면 무시한다.
 */
async function handleGetIssues(request, env) {
  try {
    const url = new URL(request.url);
    const wetlandId = url.searchParams.get("wetland_id");

    if (!wetlandId) {
      return json({ error: "wetland_id 쿼리 파라미터가 필요합니다." }, 400);
    }

    const { from, to } = parseDateRangeParams(url);
    const conditions = ["wetland_id = ?", "status != 'hidden'"];
    const bindings = [wetlandId];

    if (from) {
      conditions.push("published_at >= ?");
      bindings.push(`${from} 00:00:00`);
    }
    if (to) {
      conditions.push("published_at <= ?");
      bindings.push(`${to} 23:59:59`);
    }

    const { results } = await env.DB.prepare(
      `SELECT id, wetland_id, title, link, source, published_at, status
       FROM news_issues
       WHERE ${conditions.join(" AND ")}
       ORDER BY published_at DESC`
    )
      .bind(...bindings)
      .all();

    return json(results);
  } catch (err) {
    return json({ error: "뉴스 목록 조회 중 오류가 발생했습니다.", detail: String(err) }, 500);
  }
}

const VALID_ISSUE_STATUSES = ["confirmed", "hidden", "unreviewed"];

/**
 * PATCH /api/issues/{id}
 * 뉴스 이슈의 점검 상태(status) 또는 소속 습지(wetland_id)를 갱신한다.
 * body: { "status": "confirmed"|"hidden"|"unreviewed" } 와/또는 { "wetland_id": <id> }
 */
async function handlePatchIssue(request, env, issueId) {
  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "요청 본문이 올바른 JSON이 아닙니다." }, 400);
    }

    const { status, wetland_id } = body || {};

    if (status === undefined && wetland_id === undefined) {
      return json({ error: "status 또는 wetland_id 중 하나 이상이 필요합니다." }, 400);
    }

    if (status !== undefined && !VALID_ISSUE_STATUSES.includes(status)) {
      return json({ error: "status는 'confirmed', 'hidden', 'unreviewed' 중 하나여야 합니다." }, 400);
    }

    if (wetland_id !== undefined) {
      const wetlandRow = await env.DB.prepare("SELECT id FROM wetlands WHERE id = ?")
        .bind(wetland_id)
        .first();

      if (!wetlandRow) {
        return json({ error: "존재하지 않는 습지입니다." }, 400);
      }
    }

    const setClauses = [];
    const bindings = [];

    if (status !== undefined) {
      setClauses.push("status = ?");
      bindings.push(status);
    }

    if (wetland_id !== undefined) {
      setClauses.push("wetland_id = ?");
      bindings.push(wetland_id);
    }

    bindings.push(issueId);

    const updateResult = await env.DB.prepare(
      `UPDATE news_issues SET ${setClauses.join(", ")} WHERE id = ?`
    )
      .bind(...bindings)
      .run();

    if (!updateResult.meta || updateResult.meta.changes === 0) {
      return json({ error: "해당 이슈를 찾을 수 없습니다." }, 404);
    }

    const updatedRow = await env.DB.prepare(
      `SELECT id, wetland_id, title, link, source, published_at, status
       FROM news_issues WHERE id = ?`
    )
      .bind(issueId)
      .first();

    return json(updatedRow);
  } catch (err) {
    return json({ error: "이슈 갱신 중 오류가 발생했습니다.", detail: String(err) }, 500);
  }
}
