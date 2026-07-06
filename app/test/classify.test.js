/**
 * AI 부정보도 분류(classifyTitles / parseClassificationResponse) 단위 테스트.
 * Workers AI(env.AI.run)를 가벼운 목으로 대체해 응답 파싱을 방어적으로 검증한다.
 * node 내장 테스트 러너(node:test)로 실행.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTitles, parseClassificationResponse } from "../src/collector.js";

/**
 * env.AI.run이 고정 텍스트를 반환하는 최소 AI 목을 만든다.
 * @param {string} responseText run()이 반환할 response 문자열
 */
function makeMockAiEnv(responseText) {
  return {
    AI: {
      async run() {
        return { response: responseText };
      },
    },
  };
}

test("parseClassificationResponse: 정상 JSON 배열을 0/1로 파싱한다", () => {
  assert.deepEqual(parseClassificationResponse("[1,0,0,1]"), [1, 0, 0, 1]);
});

test("parseClassificationResponse: 코드블록으로 감싼 JSON도 배열만 추출한다", () => {
  const wrapped = "```json\n[1, 0, 1]\n```";
  assert.deepEqual(parseClassificationResponse(wrapped), [1, 0, 1]);
});

test("parseClassificationResponse: 설명 문장이 섞여도 대괄호 배열만 파싱한다", () => {
  const text = "분류 결과는 다음과 같습니다: [0, 1, 0] 입니다.";
  assert.deepEqual(parseClassificationResponse(text), [0, 1, 0]);
});

test("parseClassificationResponse: 문자열 '1'/'0'도 숫자로 정규화한다", () => {
  assert.deepEqual(parseClassificationResponse('["1","0","1"]'), [1, 0, 1]);
});

test("parseClassificationResponse: 1 이외의 숫자는 0으로 정규화한다", () => {
  assert.deepEqual(parseClassificationResponse("[2, 1, -1]"), [0, 1, 0]);
});

test("parseClassificationResponse: 불량 응답(배열 없음)은 null을 반환한다", () => {
  assert.equal(parseClassificationResponse("죄송합니다 판단할 수 없습니다"), null);
  assert.equal(parseClassificationResponse(""), null);
  assert.equal(parseClassificationResponse(null), null);
});

test("parseClassificationResponse: 객체 요소가 섞이면 신뢰 불가로 null을 반환한다", () => {
  assert.equal(parseClassificationResponse('[1, {"x":1}, 0]'), null);
});

test("classifyTitles: env.AI가 없으면 null을 반환한다(수집 흐름을 막지 않음)", async () => {
  const result = await classifyTitles({}, ["제목1", "제목2"]);
  assert.equal(result, null);
});

test("classifyTitles: 빈 제목 배열이면 null을 반환한다", async () => {
  const env = makeMockAiEnv("[1]");
  assert.equal(await classifyTitles(env, []), null);
});

test("classifyTitles: 정상 응답이면 제목과 같은 길이의 0/1 배열을 반환한다", async () => {
  const env = makeMockAiEnv("[1,0,1]");
  const result = await classifyTitles(env, ["오염 심각", "복원 성공", "불법 매립"]);
  assert.deepEqual(result, [1, 0, 1]);
});

test("classifyTitles: 응답 길이가 제목 수와 다르면 null을 반환한다(미판정 처리)", async () => {
  const env = makeMockAiEnv("[1,0]");
  const result = await classifyTitles(env, ["a", "b", "c"]);
  assert.equal(result, null);
});

test("classifyTitles: AI 호출이 예외를 던져도 null을 반환한다(수집 실패시키지 않음)", async () => {
  const env = {
    AI: {
      async run() {
        throw new Error("AI unavailable");
      },
    },
  };
  const result = await classifyTitles(env, ["a", "b"]);
  assert.equal(result, null);
});
