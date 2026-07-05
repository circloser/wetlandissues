/**
 * collector.js 순수 파싱 함수 단위 테스트
 * node 내장 테스트 러너(node:test)로 실행: node --test test/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRssItems,
  parsePubDate,
  splitTitleAndSource,
  decodeHtmlEntities,
} from "../src/collector.js";

test("parseRssItems: 기본 CDATA + source 태그가 있는 아이템을 파싱한다", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title><![CDATA[우포늪 생태 복원 사업 착수 - 경남신문]]></title>
      <link>https://example.com/news/1</link>
      <pubDate>Tue, 01 Jul 2026 05:00:00 GMT</pubDate>
      <source url="https://www.knnews.co.kr">경남신문</source>
    </item>
  </channel>
</rss>`;

  const items = parseRssItems(xml);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "우포늪 생태 복원 사업 착수");
  assert.equal(items[0].link, "https://example.com/news/1");
  assert.equal(items[0].source, "경남신문");
  assert.equal(items[0].pubDate, "2026-07-01 05:00:00");
});

test("parseRssItems: source 태그가 없으면 title의 ' - 언론사명' 꼬리표에서 분리한다", () => {
  const xml = `<item>
    <title>순천만 갯벌 습지 보호구역 확대 - 전남일보</title>
    <link>https://example.com/news/2</link>
    <pubDate>Wed, 02 Jul 2026 10:30:00 GMT</pubDate>
  </item>`;

  const items = parseRssItems(xml);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "순천만 갯벌 습지 보호구역 확대");
  assert.equal(items[0].source, "전남일보");
});

test("parseRssItems: HTML 엔티티(&amp; 등)를 디코딩한다", () => {
  const xml = `<item>
    <title><![CDATA[습지 &amp; 생태계 &quot;보호&quot; 대책 발표 - 환경일보]]></title>
    <link>https://example.com/news/3?a=1&amp;b=2</link>
    <pubDate>Thu, 03 Jul 2026 00:00:00 GMT</pubDate>
  </item>`;

  const items = parseRssItems(xml);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, '습지 & 생태계 "보호" 대책 발표');
  assert.equal(items[0].link, "https://example.com/news/3?a=1&b=2");
  assert.equal(items[0].source, "환경일보");
});

test("parseRssItems: title/link 없는 아이템은 건너뛴다", () => {
  const xml = `<item>
    <pubDate>Thu, 03 Jul 2026 00:00:00 GMT</pubDate>
  </item>
  <item>
    <title>정상 기사 - 정상언론</title>
    <link>https://example.com/news/4</link>
  </item>`;

  const items = parseRssItems(xml);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "정상 기사");
});

test("parseRssItems: 여러 개의 item을 순서대로 파싱한다", () => {
  const xml = `
  <item><title>첫번째 기사 - A뉴스</title><link>https://example.com/1</link><pubDate>Mon, 01 Jun 2026 01:00:00 GMT</pubDate></item>
  <item><title>두번째 기사 - B뉴스</title><link>https://example.com/2</link><pubDate>Tue, 02 Jun 2026 02:00:00 GMT</pubDate></item>
  `;

  const items = parseRssItems(xml);
  assert.equal(items.length, 2);
  assert.equal(items[0].source, "A뉴스");
  assert.equal(items[1].source, "B뉴스");
});

test("parseRssItems: 빈 문자열/undefined 입력에 빈 배열을 반환한다", () => {
  assert.deepEqual(parseRssItems(""), []);
  assert.deepEqual(parseRssItems(undefined), []);
});

test("parsePubDate: RFC 2822 형식을 'YYYY-MM-DD HH:MM:SS'로 변환한다", () => {
  assert.equal(parsePubDate("Tue, 01 Jul 2026 05:00:00 GMT"), "2026-07-01 05:00:00");
});

test("parsePubDate: 파싱 불가능한 값은 null을 반환한다", () => {
  assert.equal(parsePubDate("not-a-date"), null);
  assert.equal(parsePubDate(""), null);
  assert.equal(parsePubDate(null), null);
});

test("splitTitleAndSource: source 태그가 이미 있어도 title의 꼬리표는 제거하고, source는 태그 값을 우선한다", () => {
  const result = splitTitleAndSource("기사 제목 - 언론사", "실제출처");
  assert.equal(result.title, "기사 제목");
  assert.equal(result.source, "실제출처");
});

test("splitTitleAndSource: ' - '가 없으면 source는 null이다", () => {
  const result = splitTitleAndSource("꼬리표 없는 제목", null);
  assert.equal(result.title, "꼬리표 없는 제목");
  assert.equal(result.source, null);
});

test("decodeHtmlEntities: 주요 엔티티를 디코딩한다", () => {
  assert.equal(decodeHtmlEntities("A &amp; B"), "A & B");
  assert.equal(decodeHtmlEntities("&quot;인용&quot;"), '"인용"');
  assert.equal(decodeHtmlEntities("it&#39;s"), "it's");
});
