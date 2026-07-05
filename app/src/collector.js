/**
 * 습지 이슈 맵퍼 — 뉴스 자동 수집 모듈 (US-002)
 * - D1에서 습지 목록을 읽어 각 습지명으로 Google News RSS를 검색
 * - RSS(XML)를 외부 라이브러리 없이 정규식 기반으로 파싱 (Worker 호환)
 * - 제목/링크/출처/발행일만 저장하고 본문은 저장하지 않음 (저작권 이슈 회피)
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
    const sourceMatch = block.match(/<source[^>]*>([\s\S]*?)<\/source>/);

    if (!titleMatch || !linkMatch) continue;

    const rawTitle = extractText(titleMatch[1]);
    const link = extractText(linkMatch[1]);
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
 * 습지 하나에 대해 뉴스를 수집하여 D1에 저장한다.
 * 실패해도 예외를 던지지 않고 0건으로 처리한다 (호출부에서 습지 단위 격리).
 * @param {*} env - Worker 환경 (DB 바인딩 포함)
 * @param {{ id: number, name: string }} wetland
 * @returns {Promise<number>} 신규 저장된 건수
 */
async function collectForWetland(env, wetland) {
  const url = buildNewsRssUrl(wetland.name);
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; WetlandIssuesMapper/1.0)" },
  });

  if (!res.ok) {
    throw new Error(`RSS fetch 실패 (status=${res.status}): ${wetland.name}`);
  }

  const xml = await res.text();
  const items = parseRssItems(xml).slice(0, RSS_ITEM_LIMIT_PER_WETLAND);

  let savedCount = 0;
  for (const item of items) {
    if (!item.link || !item.title) continue;

    const result = await env.DB.prepare(
      `INSERT OR IGNORE INTO news_issues (wetland_id, title, link, source, published_at)
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind(wetland.id, item.title, item.link, item.source, item.pubDate)
      .run();

    if (result.meta && result.meta.changes > 0) {
      savedCount += 1;
    }
  }

  return savedCount;
}

/**
 * 전체 습지에 대해 뉴스 수집을 실행한다.
 * 습지 단위로 예외를 격리하여 하나가 실패해도 나머지는 계속 진행한다.
 * @param {*} env - Worker 환경 (DB 바인딩 포함)
 * @returns {Promise<{ collected: number, byWetland: Record<string, number> }>}
 */
export async function collectNewsForAllWetlands(env) {
  const { results: wetlands } = await env.DB.prepare(
    "SELECT id, name FROM wetlands ORDER BY name"
  ).all();

  let collected = 0;
  const byWetland = {};

  for (const wetland of wetlands) {
    try {
      const count = await collectForWetland(env, wetland);
      if (count > 0) {
        byWetland[wetland.name] = count;
      }
      collected += count;
    } catch (err) {
      // 한 습지 수집 실패는 전체 수집을 막지 않는다.
      console.error(`습지 "${wetland.name}" 뉴스 수집 실패:`, err);
    }
  }

  return { collected, byWetland };
}
