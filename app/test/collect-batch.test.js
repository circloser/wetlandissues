/**
 * 배치 수집 로직(startCollection / collectBatch / BATCH_SIZE) 단위 테스트.
 * 네트워크(fetch)와 D1(env.DB)을 가벼운 목(mock)으로 대체해 순수 로직을 검증한다.
 * node 내장 테스트 러너(node:test)로 실행.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { startCollection, collectBatch, BATCH_SIZE } from "../src/collector.js";

/**
 * collect_state 1행과 wetlands 목록을 흉내 내는 최소 D1 목.
 * prepare(sql).bind(...).first()/all()/run() 및 batch()를 지원한다.
 */
function makeMockDb({ state, wetlands }) {
  const db = {
    state,
    wetlands,
    batchCalls: 0,
    batchStmtCounts: [],
  };

  db.prepare = (sql) => {
    let bound = [];
    const stmt = {
      bind(...args) {
        bound = args;
        return stmt;
      },
      async first() {
        if (/FROM collect_state/.test(sql)) return db.state;
        if (/COUNT\(\*\) AS total FROM wetlands/.test(sql)) {
          return { total: db.wetlands.length };
        }
        return null;
      },
      async all() {
        // 점진 백필 조회: SELECT link,title FROM news_issues WHERE is_negative IS NULL ...
        // 목 DB에는 저장된 뉴스가 없으므로 빈 결과를 돌려준다(백필 대상 없음).
        if (/FROM news_issues/.test(sql)) {
          return { results: [] };
        }
        // SELECT id,name FROM wetlands ... LIMIT ? OFFSET ?
        const limit = bound[0];
        const offset = bound[1];
        return { results: db.wetlands.slice(offset, offset + limit) };
      },
      async run() {
        // UPDATE collect_state ... — SET 절 순서대로 상태에 반영(테스트에 필요한 필드만)
        if (/UPDATE collect_state/.test(sql)) {
          if (/cursor_pos = 0/.test(sql)) {
            // startCollection 초기화: bind = [total, now, now]
            db.state.total = bound[0];
            db.state.cursor_pos = 0;
            db.state.processed = 0;
            db.state.collected = 0;
            db.state.running = 1;
            db.state.updated_at = bound[2];
            return { meta: { changes: 1 } };
          } else if (/running = 0, updated_at/.test(sql)) {
            // 빈 배치 종료 처리
            db.state.running = 0;
            db.state.updated_at = bound[0];
            return { meta: { changes: 1 } };
          } else {
            // 배치 전진: bind = [cursor, processed, collected, doneFlag, now, expectedCursor]
            // 실제 SQL: running = CASE WHEN doneFlag = 1 THEN 0 ELSE running END
            //           WHERE id = 1 AND cursor_pos = expectedCursor (낙관적 잠금)
            // 잠금 조건이 안 맞으면(다른 invocation이 먼저 전진) 아무것도 반영하지 않는다.
            if (bound[5] !== db.state.cursor_pos) {
              return { meta: { changes: 0 } };
            }
            db.state.cursor_pos = bound[0];
            db.state.processed = bound[1];
            db.state.collected = bound[2];
            if (bound[3] === 1) {
              db.state.running = 0;
            }
            db.state.updated_at = bound[4];
            return { meta: { changes: 1 } };
          }
        }
        return { meta: { changes: 0 } };
      },
    };
    // 목의 마지막 prepare된 INSERT 문을 batch에서 재사용할 수 있도록 표시
    stmt._isInsert = /INSERT OR IGNORE INTO news_issues/.test(sql);
    return stmt;
  };

  db.batch = async (statements) => {
    db.batchCalls += 1;
    db.batchStmtCounts.push(statements.length);
    // 모든 INSERT가 신규(changes=1)라고 가정
    return statements.map(() => ({ meta: { changes: 1 } }));
  };

  return db;
}

test("BATCH_SIZE는 50개 subrequest 제한 안에 드는 35이다", () => {
  assert.equal(BATCH_SIZE, 35);
});

test("collectBatch: running=0이면 아무것도 하지 않고 {done:true}를 반환한다", async () => {
  const db = makeMockDb({
    state: { id: 1, cursor_pos: 0, running: 0, processed: 0, total: 0, collected: 0, updated_at: null },
    wetlands: [],
  });
  const result = await collectBatch({ DB: db });
  assert.deepEqual(result, { done: true });
  assert.equal(db.batchCalls, 0);
});

test("startCollection: 최근 10분 내 running=1이면 alreadyRunning을 반환한다", async () => {
  const recent = new Date().toISOString().slice(0, 19).replace("T", " ");
  const db = makeMockDb({
    state: { id: 1, cursor_pos: 0, running: 1, processed: 0, total: 100, collected: 0, updated_at: recent },
    wetlands: new Array(100).fill(0).map((_, i) => ({ id: i + 1, name: `습지${i}` })),
  });
  const result = await startCollection({ DB: db });
  assert.equal(result.alreadyRunning, true);
  assert.equal(result.total, 100);
});

test("startCollection: 멈춘 상태면 초기화하고 {started:true, total}을 반환한다", async () => {
  const db = makeMockDb({
    state: { id: 1, cursor_pos: 500, running: 0, processed: 500, total: 500, collected: 42, updated_at: "2020-01-01 00:00:00" },
    wetlands: new Array(70).fill(0).map((_, i) => ({ id: i + 1, name: `습지${i}` })),
  });
  const result = await startCollection({ DB: db });
  assert.equal(result.started, true);
  assert.equal(result.total, 70);
  assert.equal(db.state.running, 1);
  assert.equal(db.state.cursor_pos, 0);
  assert.equal(db.state.collected, 0);
});

test("collectBatch: 배치를 fetch→batch()로 모아 저장하고 커서/진행률을 전진시킨다", async () => {
  // 습지당 RSS item 2개를 반환하는 fetch 목
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      `<item><title>기사A - 언론</title><link>https://ex.com/${Math.random()}</link><pubDate>Tue, 01 Jul 2026 05:00:00 GMT</pubDate></item>
       <item><title>기사B - 언론</title><link>https://ex.com/${Math.random()}</link><pubDate>Tue, 01 Jul 2026 05:00:00 GMT</pubDate></item>`
    );

  try {
    const total = 100;
    const db = makeMockDb({
      state: { id: 1, cursor_pos: 0, running: 1, processed: 0, total, collected: 0, updated_at: "2020-01-01 00:00:00" },
      wetlands: new Array(total).fill(0).map((_, i) => ({ id: i + 1, name: `습지${i}` })),
    });

    const result = await collectBatch({ DB: db }, BATCH_SIZE);

    // 아직 전체를 다 돌지 않았으므로 done=false, running 유지
    assert.equal(result.done, false);
    assert.equal(result.processed, BATCH_SIZE);
    assert.equal(result.total, total);
    assert.equal(db.state.cursor_pos, BATCH_SIZE);
    assert.equal(db.state.running, 1);
    // D1 batch()는 습지별 개별 insert가 아니라 한 번만 호출되어야 한다(subrequest 절약)
    assert.equal(db.batchCalls, 1);
    // 습지 35개 × item 2개 = 70개 insert가 한 batch에 묶임
    assert.equal(db.batchStmtCounts[0], BATCH_SIZE * 2);
    // 전부 신규(changes=1) 가정 → collected = 70
    assert.equal(result.collected, BATCH_SIZE * 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("collectBatch: env.AI가 있으면 신규 저장분을 분류해 is_negative UPDATE batch를 추가로 호출한다", async () => {
  const originalFetch = globalThis.fetch;
  // 습지당 item 1개 반환
  globalThis.fetch = async () =>
    new Response(
      `<item><title>불법 매립 적발 - 언론</title><link>https://ex.com/${Math.random()}</link><pubDate>Tue, 01 Jul 2026 05:00:00 GMT</pubDate></item>`
    );

  try {
    const total = 3;
    const db = makeMockDb({
      state: { id: 1, cursor_pos: 0, running: 1, processed: 0, total, collected: 0, updated_at: "2020-01-01 00:00:00" },
      wetlands: new Array(total).fill(0).map((_, i) => ({ id: i + 1, name: `습지${i}` })),
    });

    // 신규 저장분 수(3) 길이에 맞춘 분류 배열을 반환하는 AI 목.
    const env = {
      DB: db,
      AI: {
        async run() {
          return { response: "[1,0,1]" };
        },
      },
    };

    const result = await collectBatch(env, BATCH_SIZE);

    // insert batch 1회 + 신규 분류 UPDATE batch 1회 = 총 2회.
    // (백필 SELECT는 목에서 빈 결과라 추가 UPDATE batch 없음)
    assert.equal(db.batchCalls, 2);
    // 첫 batch = insert 3건, 두 번째 batch = UPDATE 3건.
    assert.deepEqual(db.batchStmtCounts, [3, 3]);
    assert.equal(result.collected, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("collectBatch: 마지막 배치를 넘어 커서가 total 이상이면 done=true, running=0", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(`<item><title>x - y</title><link>https://ex.com/a</link></item>`);

  try {
    const total = 40;
    // cursor_pos=35에서 시작 → 남은 5개 처리 후 커서 70 >= 40 이므로 done
    const db = makeMockDb({
      state: { id: 1, cursor_pos: 35, running: 1, processed: 35, total, collected: 10, updated_at: "2020-01-01 00:00:00" },
      wetlands: new Array(total).fill(0).map((_, i) => ({ id: i + 1, name: `습지${i}` })),
    });

    const result = await collectBatch({ DB: db }, BATCH_SIZE);
    assert.equal(result.done, true);
    assert.equal(db.state.running, 0);
    assert.equal(result.processed, 40);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
