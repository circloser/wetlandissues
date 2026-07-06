/**
 * 습지 이슈 맵퍼 — Cloudflare Worker 엔트리 포인트
 * - /api/* : API 라우트 (D1 조회, 뉴스 수집 트리거)
 * - 그 외 : 정적 자산(ASSETS)으로 폴백
 * - scheduled : 매일 뉴스 스크랩 배치 (US-002)
 */
import { startCollection, collectBatch } from "./collector.js";

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
      return handleCollectStart(request, env, ctx, url.origin);
    }

    if (url.pathname === "/api/collect/continue" && request.method === "POST") {
      return handleCollectContinue(request, env, ctx, url.origin);
    }

    if (url.pathname === "/api/collect/status" && request.method === "GET") {
      return handleCollectStatus(request, env);
    }

    const issuePatchMatch = url.pathname.match(/^\/api\/issues\/(\d+)$/);
    if (issuePatchMatch && request.method === "PATCH") {
      return handlePatchIssue(request, env, issuePatchMatch[1]);
    }

    // API 외 경로는 정적 자산으로 폴백
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    // 매일 뉴스 수집을 시작하고, 배치 체인으로 전체 습지를 순회한다.
    // scheduled에는 request가 없으므로 self URL로 env.SELF_URL(배포 주소)을 사용한다.
    console.log("scheduled 트리거 실행됨 — 뉴스 수집 시작", event.cron);
    const result = await startCollection(env);
    console.log("수집 시작 결과:", JSON.stringify(result));
    if (result.started && env.SELF_URL) {
      runChain(env, ctx, env.SELF_URL);
    }
  },
};

/**
 * 배치 체인의 한 고리: collectBatch를 1회 실행하고, 아직 끝나지 않았으면
 * self의 /api/collect/continue를 fetch로 호출해 다음 invocation으로 이어간다.
 * (한 요청에서 전체를 순회하지 않고 invocation을 나눠 subrequest 제한을 회피한다.)
 * ctx.waitUntil로 응답 반환 후에도 백그라운드에서 계속 실행되게 한다.
 * @param {*} env
 * @param {*} ctx - ExecutionContext (waitUntil 제공)
 * @param {string} selfOrigin - self의 origin (예: https://...workers.dev 또는 http://localhost:8788)
 */
function runChain(env, ctx, selfOrigin) {
  ctx.waitUntil(
    (async () => {
      try {
        const result = await collectBatch(env);
        if (!result.done) {
          // 다음 배치는 새 invocation에서 처리(subrequest 카운터 리셋).
          await fetchSelfContinue(env, selfOrigin);
        }
      } catch (err) {
        console.error("배치 수집 체인 오류:", err);
      }
    })()
  );
}

/**
 * self의 /api/collect/continue 를 호출해 체인의 다음 고리를 잇는다.
 * 배포된 Worker는 자기 자신의 hostname으로 일반 fetch를 보낼 수 없으므로(Cloudflare 제약,
 * 로컬 dev에서는 허용돼 로컬 검증만으로는 드러나지 않음) SELF 서비스 바인딩을 우선 사용하고,
 * 바인딩이 없거나 실패하면(구버전 설정·로컬 특이 케이스) 일반 fetch로 폴백한다.
 * @param {*} env
 * @param {string} selfOrigin - 요청 origin 또는 env.SELF_URL (URL 형식만 필요)
 */
async function fetchSelfContinue(env, selfOrigin) {
  const url = `${selfOrigin || env.SELF_URL || "https://self.internal"}/api/collect/continue`;

  if (env.SELF) {
    try {
      await env.SELF.fetch(url, { method: "POST" });
      return;
    } catch (err) {
      console.error("SELF 바인딩 호출 실패 — 일반 fetch로 폴백:", err);
    }
  }

  await fetch(url, { method: "POST" });
}

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
 * 뉴스 수집을 시작하고 즉시 응답한다(무한 로딩 방지의 핵심).
 * 실제 수집은 ctx.waitUntil로 등록된 배치 체인이 백그라운드에서 이어서 진행한다.
 * 응답: { started|alreadyRunning, total }
 */
async function handleCollectStart(request, env, ctx, origin) {
  try {
    const result = await startCollection(env);
    // 새로 시작한 경우에만 체인을 건다(이미 돌고 있으면 기존 체인이 진행 중).
    if (result.started) {
      runChain(env, ctx, origin);
    }
    return json(result);
  } catch (err) {
    return json({ error: "뉴스 수집 시작 중 오류가 발생했습니다.", detail: String(err) }, 500);
  }
}

/**
 * POST /api/collect/continue
 * 배치 체인의 다음 고리. running=1일 때만 배치 1회 + 다음 체인 등록.
 * running=0이면 204(할 일 없음). 외부에서 눌러도 running이 아니면 아무 일도 하지 않는다.
 */
async function handleCollectContinue(request, env, ctx, origin) {
  try {
    const state = await env.DB.prepare("SELECT running FROM collect_state WHERE id = 1").first();
    if (!state || state.running !== 1) {
      return new Response(null, { status: 204 });
    }
    runChain(env, ctx, origin);
    return new Response(null, { status: 202 });
  } catch (err) {
    return json({ error: "배치 이어가기 중 오류가 발생했습니다.", detail: String(err) }, 500);
  }
}

/**
 * GET /api/collect/status
 * 현재 수집 진행 상태를 반환한다: { running, processed, total, collected, updated_at }
 * 페이지 로드 시 이미 수집 중인지 판별하는 용도로도 사용한다.
 */
async function handleCollectStatus(request, env) {
  try {
    const state = await env.DB.prepare(
      "SELECT running, processed, total, collected, updated_at FROM collect_state WHERE id = 1"
    ).first();

    if (!state) {
      return json({ running: 0, processed: 0, total: 0, collected: 0, updated_at: null });
    }

    return json({
      running: state.running,
      processed: state.processed,
      total: state.total,
      collected: state.collected,
      updated_at: state.updated_at,
    });
  } catch (err) {
    return json({ error: "수집 상태 조회 중 오류가 발생했습니다.", detail: String(err) }, 500);
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

const VALID_ISSUE_SORTS = ["newest", "oldest", "wetland", "status"];
const DEFAULT_ISSUE_LIMIT = 100;
const MAX_ISSUE_LIMIT = 300;

/**
 * sort 쿼리 파라미터를 검증하여 ORDER BY 절 문자열로 변환한다.
 * 화이트리스트에 없는 값(이상값)은 newest로 취급한다.
 * @param {string|null} sortRaw
 * @returns {string} ORDER BY 뒤에 붙일 절 (예: "n.published_at DESC")
 */
function resolveIssueSortClause(sortRaw) {
  const sort = VALID_ISSUE_SORTS.includes(sortRaw) ? sortRaw : "newest";

  switch (sort) {
    case "oldest":
      return "n.published_at ASC";
    case "wetland":
      return "w.name ASC, n.published_at DESC";
    case "status":
      // 미점검(unreviewed) 먼저, 그 안에서는 최신순. confirmed/hidden은 그 뒤(현재 hidden은 필터로 제외됨).
      return "CASE WHEN n.status = 'unreviewed' THEN 0 ELSE 1 END ASC, n.published_at DESC";
    case "newest":
    default:
      return "n.published_at DESC";
  }
}

/**
 * limit 쿼리 파라미터를 검증한다. 지정 안 하면 기본값, 범위를 벗어나거나 숫자가 아니면
 * 기본값으로 보정한다(최대값 초과 시 최대값으로 clamp).
 * @param {string|null} limitRaw
 * @returns {number}
 */
function resolveIssueLimit(limitRaw) {
  const parsed = Number(limitRaw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_ISSUE_LIMIT;
  }
  return Math.min(parsed, MAX_ISSUE_LIMIT);
}

/**
 * GET /api/issues?wetland_id=&from=&to=&sort=&limit=
 * 뉴스 목록을 반환한다 (숨김 상태 제외). wetland_id는 선택 파라미터로, 지정하면 해당
 * 습지의 뉴스만, 없으면 전체 습지의 뉴스를 반환한다(이 경우 wetland_name 포함).
 * - sort: newest(기본, 최신순) | oldest(오래된순) | wetland(습지명 가나다순, 같은 습지 내 최신순)
 *   | status(미점검 먼저, 그 안에서 최신순). 화이트리스트 외 값은 newest로 처리.
 * - limit: 기본 100, 최대 300.
 * from/to 쿼리 파라미터(YYYY-MM-DD)가 있으면 published_at 기준으로 기간을 제한한다
 * (from 00:00:00 ~ to 23:59:59 포함). 형식이 올바르지 않으면 무시한다.
 */
async function handleGetIssues(request, env) {
  try {
    const url = new URL(request.url);
    const wetlandId = url.searchParams.get("wetland_id");
    const { from, to } = parseDateRangeParams(url);
    const orderByClause = resolveIssueSortClause(url.searchParams.get("sort"));
    const limit = resolveIssueLimit(url.searchParams.get("limit"));

    const conditions = ["n.status != 'hidden'"];
    const bindings = [];

    if (wetlandId) {
      conditions.push("n.wetland_id = ?");
      bindings.push(wetlandId);
    }
    if (from) {
      conditions.push("n.published_at >= ?");
      bindings.push(`${from} 00:00:00`);
    }
    if (to) {
      conditions.push("n.published_at <= ?");
      bindings.push(`${to} 23:59:59`);
    }

    bindings.push(limit);

    const { results } = await env.DB.prepare(
      `SELECT n.id, n.wetland_id, n.title, n.link, n.source, n.published_at, n.status, w.name AS wetland_name
       FROM news_issues n
       JOIN wetlands w ON w.id = n.wetland_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY ${orderByClause}
       LIMIT ?`
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
