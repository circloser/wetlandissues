/**
 * 습지 이슈 맵퍼 — 뉴스 자동 수집 모듈 (US-002 / 2차 배치화)
 * - D1에서 습지 목록을 읽어 각 습지명으로 Bing News RSS(우선)를 검색, 실패 시 Google News 폴백
 * - RSS(XML)를 외부 라이브러리 없이 정규식 기반으로 파싱 (Worker 호환)
 * - 제목/링크/출처/발행일만 저장하고 본문은 저장하지 않음 (저작권 이슈 회피)
 * - 2,986개 습지를 한 요청에서 다 돌면 Workers 무료 플랜의 subrequest(~50개/요청) 제한에
 *   걸리므로, collect_state 테이블에 커서를 두고 배치(BATCH_SIZE)로 나눠 수집한다.
 *   startCollection(초기화) → collectBatch(배치 1회, 커서 전진) 를 index.js가 체인으로 잇는다.
 */

const RSS_ITEM_LIMIT_PER_WETLAND = 10;

/**
 * HTML 엔티티를 일반 문자로 치환한다.
 * Google News RSS는 title/description 등에 &amp; &quot; &#39; 등을 사용한다.
 * @param {string} str
 * @returns {string}
 */
export function decodeHtmlEntities(str) {
  if (!str) return str;
  return str
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

/**
 * CDATA 래핑 또는 일반 텍스트에서 실제 텍스트 내용을 추출한다.
 * @param {string} raw
 * @returns {string}
 */
function extractText(raw) {
  if (raw == null) return "";
  const cdataMatch = raw.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  const text = cdataMatch ? cdataMatch[1] : raw;
  return decodeHtmlEntities(text.trim());
}

/**
 * RSS pubDate(RFC 2822 형식, 예: "Tue, 01 Jul 2026 05:00:00 GMT")를
 * ISO 8601 스타일 문자열 "YYYY-MM-DD HH:MM:SS" (UTC 기준)로 변환한다.
 * 파싱 실패 시 null을 반환한다.
 * @param {string} pubDate
 * @returns {string|null}
 */
export function parsePubDate(pubDate) {
  if (!pubDate) return null;
  const d = new Date(pubDate);
  if (isNaN(d.getTime())) return null;

  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

/**
 * 뉴스 제목에서 " - 언론사명" 꼬리표를 분리한다.
 * Google News는 보통 "기사 제목 - 언론사" 형식으로 title을 제공하므로,
 * source 태그가 이미 있더라도 title의 꼬리표는 항상 제거한다.
 * source는 기존 source 태그 값을 우선하고, 없으면 title에서 추출한 값을 사용한다.
 * @param {string} title
 * @param {string} existingSource
 * @returns {{ title: string, source: string|null }}
 */
export function splitTitleAndSource(title, existingSource) {
  const lastDashIndex = title.lastIndexOf(" - ");
  if (lastDashIndex === -1) {
    return { title, source: existingSource || null };
  }

  const cleanTitle = title.slice(0, lastDashIndex).trim();
  const titleSource = title.slice(lastDashIndex + 3).trim();

  return {
    title: cleanTitle,
    source: existingSource || titleSource,
  };
}

/**
 * RSS XML 문자열을 파싱하여 뉴스 아이템 배열을 반환하는 순수 함수.
 * 외부 XML 라이브러리 없이 정규식으로 <item>...</item> 블록과 그 내부 태그를 추출한다.
 * @param {string} xml
 * @returns {Array<{ title: string, link: string, pubDate: string|null, source: string|null }>}
 */
export function parseRssItems(xml) {
  if (!xml) return [];

  const items = [];
  const itemBlocks = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];

  for (const block of itemBlocks) {
    const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/);
    const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/);
    const pubDateMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    // Google News는 <source>, Bing News는 <News:Source> 태그를 사용한다.
    const sourceMatch = block.match(/<(?:News:)?[Ss]ource[^>]*>([\s\S]*?)<\/(?:News:)?[Ss]ource>/);

    if (!titleMatch || !linkMatch) continue;

    const rawTitle = extractText(titleMatch[1]);
    const link = unwrapBingLink(extractText(linkMatch[1]));
    const pubDate = pubDateMatch ? extractText(pubDateMatch[1]) : null;
    const sourceFromTag = sourceMatch ? extractText(sourceMatch[1]) : null;

    const { title, source } = splitTitleAndSource(rawTitle, sourceFromTag);

    items.push({
      title,
      link,
      pubDate: parsePubDate(pubDate),
      source,
    });
  }

  return items;
}

/**
 * 습지명으로 Google News RSS 검색 URL을 생성한다.
 * @param {string} wetlandName
 * @returns {string}
 */
export function buildNewsRssUrl(wetlandName) {
  const query = encodeURIComponent(`"${wetlandName}"`);
  return `https://news.google.com/rss/search?q=${query}&hl=ko&gl=KR&ceid=KR:ko`;
}

/**
 * 습지명으로 Bing News RSS 검색 URL을 생성한다.
 * Google News가 Cloudflare Workers 등 데이터센터 IP를 차단(503)하는 경우의 대체 소스.
 * @param {string} wetlandName
 * @returns {string}
 */
export function buildBingRssUrl(wetlandName) {
  const query = encodeURIComponent(`"${wetlandName}"`);
  return `https://www.bing.com/news/search?q=${query}&format=RSS&setmkt=ko-KR`;
}

/**
 * Bing News RSS의 link는 bing.com/news/apiclick 중계 주소이므로,
 * url= 파라미터에 인코딩된 실제 기사 주소를 꺼내 반환한다.
 * 중계 주소가 아니거나 해석에 실패하면 원본을 그대로 반환한다.
 * @param {string} link
 * @returns {string}
 */
export function unwrapBingLink(link) {
  if (!link || !link.includes("bing.com/news/apiclick")) return link;
  const match = link.match(/[?&]url=([^&]+)/);
  if (!match) return link;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return link;
  }
}

/**
 * RSS 소스 우선순위: Bing News 먼저, 실패 시 Google News.
 * 배포(Cloudflare Workers) 환경에서 Google News는 데이터센터 IP를 503으로 차단하므로
 * 실질 소스는 Bing이다. Google을 앞에 두면 습지마다 Google fetch가 매번 실패한 뒤
 * Bing으로 넘어가 subrequest를 2배로 소모한다(무료 플랜 요청당 약 50개 제한).
 * 따라서 Bing을 먼저 시도해 습지당 fetch를 1회로 줄이고, Bing 실패 시에만 Google로 폴백한다.
 */
const FEED_URL_BUILDERS = [buildBingRssUrl, buildNewsRssUrl];

/**
 * 한 invocation(요청)에서 처리할 습지 수.
 * Cloudflare Workers 무료 플랜은 요청당 외부 subrequest가 약 50개로 제한된다.
 * 습지당 RSS fetch 1회(Bing 우선) + D1 insert는 env.DB.batch()로 한 번에 묶으므로,
 * 35개 습지를 처리해도 (RSS fetch 35회 + collect_state 조회/갱신 등 소수의 D1 호출)로
 * 50개 제한 안에 안전하게 들어온다. 배치가 끝나면 다음 invocation으로 체인 연결된다.
 */
export const BATCH_SIZE = 35;

/**
 * 현재 UTC 시각을 "YYYY-MM-DD HH:MM:SS" 문자열로 반환한다(collect_state 타임스탬프용).
 * @returns {string}
 */
function nowUtc() {
  return parsePubDate(new Date().toUTCString());
}

/**
 * RSS fetch 1건의 최대 대기 시간(ms).
 * Bing/Google이 반복 요청을 스로틀링하면 응답이 무한정 지연될 수 있는데, 배치는 습지를
 * 순차 fetch하므로 한 건이라도 매달리면 배치 전체(나아가 체인)가 멈춰 Worker 실행 시간
 * 한도를 초과한다. 타임아웃을 두면 매달린 소스는 빠르게 실패로 처리되고(습지 단위 예외 격리),
 * 폴백 소스 또는 다음 습지로 넘어가 배치가 계속 전진한다.
 */
const FETCH_TIMEOUT_MS = 8000;

/**
 * 우선순위에 따라 RSS를 가져온다. 앞선 소스가 실패(또는 타임아웃)하면 다음 소스를 시도하고,
 * 전부 실패하면 마지막 오류를 던진다.
 * @param {string} wetlandName
 * @returns {Promise<string>} RSS XML
 */
async function fetchRssXml(wetlandName) {
  let lastError = null;

  for (const buildUrl of FEED_URL_BUILDERS) {
    try {
      const res = await fetch(buildUrl(wetlandName), {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; WetlandIssuesMapper/1.0)" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`RSS fetch 실패 (status=${res.status}): ${wetlandName}`);
      }
      return await res.text();
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError;
}

/**
 * 습지 하나의 RSS를 가져와 저장할 뉴스 아이템 배열만 반환한다(D1 저장은 하지 않음).
 * 배치 수집에서 여러 습지의 아이템을 모아 env.DB.batch()로 한 번에 넣기 위한 헬퍼.
 * @param {{ id: number, name: string }} wetland
 * @returns {Promise<Array<{ wetlandId: number, title: string, link: string, source: string|null, pubDate: string|null }>>}
 */
async function fetchItemsForWetland(wetland) {
  const xml = await fetchRssXml(wetland.name);
  const items = parseRssItems(xml).slice(0, RSS_ITEM_LIMIT_PER_WETLAND);

  const rows = [];
  for (const item of items) {
    if (!item.link || !item.title) continue;
    rows.push({
      wetlandId: wetland.id,
      title: item.title,
      link: item.link,
      source: item.source,
      pubDate: item.pubDate,
    });
  }
  return rows;
}

/**
 * 뉴스 수집을 시작한다(커서/진행률 초기화).
 * 이미 running=1이고 마지막 갱신이 10분 이내면 중복 시작으로 보고 아무 것도 하지 않는다.
 * 그렇지 않으면(멈춘 지 오래됐거나 처음이면) collect_state를 초기화하고 running=1로 켠다.
 * @param {*} env - Worker 환경 (DB 바인딩 포함)
 * @returns {Promise<{ started?: boolean, alreadyRunning?: boolean, total: number }>}
 */
export async function startCollection(env) {
  const state = await env.DB.prepare("SELECT * FROM collect_state WHERE id = 1").first();
  const now = nowUtc();

  // 이미 돌고 있고 최근 10분 이내에 진행된 흔적이 있으면 중복 시작을 막는다.
  if (state && state.running === 1 && state.updated_at) {
    const lastMs = Date.parse(`${state.updated_at.replace(" ", "T")}Z`);
    if (!Number.isNaN(lastMs) && Date.now() - lastMs < 10 * 60 * 1000) {
      return { alreadyRunning: true, total: state.total };
    }
  }

  const totalRow = await env.DB.prepare("SELECT COUNT(*) AS total FROM wetlands").first();
  const total = totalRow ? totalRow.total : 0;

  await env.DB.prepare(
    `UPDATE collect_state
       SET cursor_pos = 0, processed = 0, collected = 0, total = ?,
           running = 1, started_at = ?, updated_at = ?
     WHERE id = 1`
  )
    .bind(total, now, now)
    .run();

  return { started: true, total };
}

/**
 * 배치 하나를 수집한다: collect_state 커서 위치부터 batchSize개 습지를 처리하고
 * 커서/진행률을 전진시킨다. running=0이면 아무 것도 하지 않고 done을 반환한다.
 *
 * D1 subrequest 절약을 위해 습지별 개별 insert 대신 배치 전체 아이템을 모아
 * env.DB.batch()로 한 번에 INSERT OR IGNORE 한다. 신규 건수는 batch 결과 각
 * 문장의 meta.changes 합으로 계산한다(link UNIQUE라 중복은 changes=0).
 *
 * @param {*} env - Worker 환경 (DB 바인딩 포함)
 * @param {number} [batchSize=BATCH_SIZE]
 * @returns {Promise<{ done: boolean, processed?: number, total?: number, collected?: number }>}
 */
export async function collectBatch(env, batchSize = BATCH_SIZE) {
  const state = await env.DB.prepare("SELECT * FROM collect_state WHERE id = 1").first();

  if (!state || state.running !== 1) {
    return { done: true };
  }

  const { results: wetlands } = await env.DB.prepare(
    "SELECT id, name FROM wetlands ORDER BY priority DESC, id LIMIT ? OFFSET ?"
  )
    .bind(batchSize, state.cursor_pos)
    .all();

  const now = nowUtc();

  // 배치가 비면 전체 순회 완료 — running=0으로 종료 처리한다.
  if (!wetlands || wetlands.length === 0) {
    await env.DB.prepare(
      "UPDATE collect_state SET running = 0, updated_at = ? WHERE id = 1"
    )
      .bind(now)
      .run();
    return {
      done: true,
      processed: state.processed,
      total: state.total,
      collected: state.collected,
    };
  }

  // 습지 단위 예외를 격리하며 저장할 아이템을 한 번에 모은다(fetch만, D1 저장은 아래에서 일괄).
  const rowsToInsert = [];
  for (const wetland of wetlands) {
    try {
      const rows = await fetchItemsForWetland(wetland);
      rowsToInsert.push(...rows);
    } catch (err) {
      // 한 습지 수집 실패는 배치 전체를 막지 않는다.
      console.error(`습지 "${wetland.name}" 뉴스 수집 실패:`, err);
    }
  }

  // 모은 아이템을 D1 batch()로 한 번에 저장(subrequest 절약). meta.changes 합=신규 건수.
  let newCount = 0;
  if (rowsToInsert.length > 0) {
    const insertStmt = env.DB.prepare(
      `INSERT OR IGNORE INTO news_issues (wetland_id, title, link, source, published_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    const batch = rowsToInsert.map((r) =>
      insertStmt.bind(r.wetlandId, r.title, r.link, r.source, r.pubDate)
    );
    const batchResults = await env.DB.batch(batch);
    for (const res of batchResults) {
      if (res.meta && res.meta.changes > 0) {
        newCount += res.meta.changes;
      }
    }
  }

  const nextCursor = state.cursor_pos + batchSize;
  const processed = state.processed + wetlands.length;
  const collected = state.collected + newCount;
  const done = nextCursor >= state.total;

  await env.DB.prepare(
    `UPDATE collect_state
       SET cursor_pos = ?, processed = ?, collected = ?,
           running = ?, updated_at = ?
     WHERE id = 1`
  )
    .bind(nextCursor, processed, collected, done ? 0 : 1, now)
    .run();

  return { done, processed, total: state.total, collected };
}
