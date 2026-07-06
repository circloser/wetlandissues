/**
 * 습지 이슈 맵 — 프론트엔드 (빌드 없는 Vanilla JS)
 * - Leaflet + OpenStreetMap 타일로 대한민국 습지 지도를 표시
 * - GET /api/wetlands 로 습지 목록/뉴스 건수를 불러와 마커로 표시
 * - 습지 클릭 시 GET /api/issues?wetland_id= 로 뉴스 목록을 불러와 사이드 패널에 표시
 * - [뉴스 수집] 버튼으로 POST /api/collect 호출 후 마커 갱신
 */

const STATUS_LABELS = {
  unreviewed: { text: "미점검", className: "status-badge--unreviewed" },
  confirmed: { text: "확인됨", className: "status-badge--confirmed" },
};

/**
 * 상태 뱃지 HTML을 생성한다 (표시할 라벨이 없는 상태면 빈 문자열).
 * @param {string} status
 * @returns {string}
 */
function statusBadgeHtml(status) {
  const info = STATUS_LABELS[status];
  return info ? `<span class="status-badge ${info.className}">${info.text}</span>` : "";
}

let map;
let markersLayer;
const markerByWetlandId = new Map();
let wetlandListCache = [];
let currentWetland = null;

/** 뉴스 패널 모드: "all"(전체 최신 뉴스) 또는 "wetland"(선택한 습지만). */
let viewMode = "all";

/** 뉴스 정렬 기준. newest(기본) | oldest | wetland | status. */
let currentSort = "newest";

const MOBILE_BREAKPOINT_PX = 480;

/** 화면 폭이 모바일 하단 시트 기준(~480px)인지 여부. */
function isMobileViewport() {
  return window.innerWidth <= MOBILE_BREAKPOINT_PX;
}

/** 날짜 기간 필터 전역 상태. from/to는 "YYYY-MM-DD" 또는 null. */
const filterState = {
  from: null,
  to: null,
};

/* ------------------------------------------------------------------ */
/* 분할선 드래그 (데스크톱: 지도/뉴스 패널 비율 조절)                        */
/* ------------------------------------------------------------------ */

const SPLIT_RATIO_STORAGE_KEY = "wetland-map-split-ratio";
const SPLIT_MIN_MAP_RATIO = 0.4;
const SPLIT_MAX_MAP_RATIO = 0.8; // 패널 최소 20% 보장
const DEFAULT_MAP_RATIO = 0.66;

let splitDragging = false;

const SEARCH_DEBOUNCE_MS = 150;
const SEARCH_MAX_RESULTS = 8;
let searchDebounceTimer = null;
let searchResultItems = [];

/** 뉴스 수집 진행률 폴링 간격(ms). */
const COLLECT_POLL_MS = 3000;
/** 수집 상태 폴링 타이머 핸들(중복 폴링 방지). */
let collectPollTimer = null;

/* ------------------------------------------------------------------ */
/* 지도 레이어 (일반/위성) 및 마커 클러스터링 관련 상수                        */
/* ------------------------------------------------------------------ */

/** 선택한 지도 종류(base layer)를 저장하는 localStorage 키. */
const MAP_LAYER_STORAGE_KEY = "wetland-map-base-layer";

/** 클러스터를 풀고 개별 마커를 보여줄 최소 줌 레벨(습지 검색 선택 시 이 값 이상으로 flyTo). */
const CLUSTER_DISABLE_ZOOM = 12;

init();

function init() {
  map = L.map("map").setView([36.3, 127.8], 7);

  initBaseLayers();

  markersLayer = L.markerClusterGroup({
    chunkedLoading: true,
    maxClusterRadius: 50,
    spiderfyOnMaxZoom: true,
    disableClusteringAtZoom: CLUSTER_DISABLE_ZOOM,
    iconCreateFunction: buildClusterIcon,
  }).addTo(map);

  loadWetlands();

  document.getElementById("panel-close-btn").addEventListener("click", closePanel);
  document.getElementById("panel-show-all-btn").addEventListener("click", showAllIssuesPanel);
  document.getElementById("issue-sort-select").addEventListener("change", onSortChange);
  document.getElementById("collect-btn").addEventListener("click", onCollectClick);

  initWetlandSearch();
  initDateFilter();
  initDateFilterToggle();
  initSplitHandle();

  // 모바일에서는 습지를 선택하기 전까지 하단 시트를 숨겨둔다(데스크톱은 상시 노출).
  if (isMobileViewport()) {
    document.getElementById("side-panel").hidden = true;
  } else {
    loadIssues();
  }

  // 페이지 로드 시 이미 수집 중이면(다른 직원이 돌리는 중이면) 자동으로 폴링 모드에 진입한다.
  resumeCollectionIfRunning();
}

/**
 * 일반 지도(OSM)/위성 지도(Esri World Imagery) 두 종류의 베이스 레이어를 만들고
 * 좌상단에 펼쳐진 라디오 형태의 레이어 컨트롤을 추가한다. 마지막으로 선택한 종류는
 * localStorage에 저장해 새로고침 후에도 유지한다.
 */
function initBaseLayers() {
  const osmLayer = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
  });

  const satelliteLayer = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      maxZoom: 19,
      attribution: "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics",
    }
  );

  const baseLayers = {
    "일반 지도": osmLayer,
    "위성 지도": satelliteLayer,
  };

  const storedLayerName = localStorage.getItem(MAP_LAYER_STORAGE_KEY);
  const initialLayer = storedLayerName === "위성 지도" ? satelliteLayer : osmLayer;
  initialLayer.addTo(map);

  L.control
    .layers(baseLayers, null, { position: "topleft", collapsed: false })
    .addTo(map);

  map.on("baselayerchange", (event) => {
    localStorage.setItem(MAP_LAYER_STORAGE_KEY, event.name);
  });
}

/**
 * 마커 클러스터 배지 아이콘을 생성한다. 하위 마커들의 issue_count 합계를 배지에 표시하고,
 * 합계가 0이면 회색, 0보다 크면 파랑 계열로 개별 마커 색 체계와 통일한다.
 * @param {L.MarkerCluster} cluster
 * @returns {L.DivIcon}
 */
function buildClusterIcon(cluster) {
  const childMarkers = cluster.getAllChildMarkers();
  const totalIssues = childMarkers.reduce((sum, marker) => sum + (marker.options.issueCount || 0), 0);

  let sizeClass = "wetland-cluster--sm";
  let size = 36;
  if (totalIssues >= 50) {
    sizeClass = "wetland-cluster--lg";
    size = 52;
  } else if (totalIssues >= 10) {
    sizeClass = "wetland-cluster--md";
    size = 44;
  }

  const emptyClass = totalIssues === 0 ? " wetland-cluster--empty" : "";

  return L.divIcon({
    className: "",
    html: `<div class="wetland-cluster ${sizeClass}${emptyClass}">${totalIssues}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

/**
 * GET /api/wetlands 를 호출하여 습지 목록을 불러오고 지도에 마커를 그린다.
 * filterState.from/to가 설정되어 있으면 쿼리 파라미터로 함께 전달하여
 * issue_count가 해당 기간 기준으로 계산되도록 한다.
 */
async function loadWetlands() {
  try {
    const res = await fetch(`/api/wetlands${buildDateRangeQuery("?")}`);
    const wetlands = await res.json();
    wetlandListCache = wetlands;
    renderMarkers(wetlands);
  } catch (err) {
    console.error("습지 목록을 불러오는 중 오류가 발생했습니다.", err);
  }
}

/**
 * filterState.from/to를 기준으로 쿼리스트링을 만든다.
 * @param {string} prefix 파라미터가 있을 때 앞에 붙일 문자("?" 또는 "&")
 * @returns {string} 예: "?from=2026-07-01&to=2026-07-05" 또는 파라미터 없으면 ""
 */
function buildDateRangeQuery(prefix) {
  const params = new URLSearchParams();
  if (filterState.from) params.set("from", filterState.from);
  if (filterState.to) params.set("to", filterState.to);
  const qs = params.toString();
  return qs ? `${prefix}${qs}` : "";
}

/**
 * 습지 배열을 받아 지도 위 마커를 새로 그린다 (기존 마커는 모두 제거 후 재생성).
 * @param {Array<object>} wetlands
 */
function renderMarkers(wetlands) {
  markersLayer.clearLayers();
  markerByWetlandId.clear();

  for (const wetland of wetlands) {
    const issueCount = Number(wetland.issue_count) || 0;
    const marker = L.marker([wetland.lat, wetland.lng], {
      icon: buildWetlandIcon(issueCount),
      issueCount, // 클러스터 배지 합산용(buildClusterIcon에서 getAllChildMarkers로 합산)
    });

    marker.bindTooltip(wetland.name, {
      permanent: issueCount > 0,
      direction: "bottom",
      offset: [0, 4],
      className: "wetland-label",
    });

    marker.on("click", () => openPanel(wetland));
    marker.addTo(markersLayer);
    markerByWetlandId.set(wetland.id, marker);
  }
}

/**
 * 이슈 건수에 따라 커스텀 divIcon을 생성한다.
 * issue_count가 0이면 회색 작은 마커, 그 외에는 파란 원형 배지에 숫자를 표시한다.
 * 건수 구간별로 배지 크기를 키워 지도 위에서 이슈 밀집도를 직관적으로 파악할 수 있게 한다:
 * 1~4건 소형, 5~9건 중형, 10건 이상 대형.
 * @param {number} issueCount
 * @returns {L.DivIcon}
 */
function buildWetlandIcon(issueCount) {
  const count = Number(issueCount) || 0;

  if (count === 0) {
    return L.divIcon({
      className: "",
      html: '<div class="wetland-marker wetland-marker--empty"></div>',
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    });
  }

  let sizeClass = "wetland-marker--sm";
  let size = 26;
  if (count >= 10) {
    sizeClass = "wetland-marker--lg";
    size = 38;
  } else if (count >= 5) {
    sizeClass = "wetland-marker--md";
    size = 32;
  }

  return L.divIcon({
    className: "",
    html: `<div class="wetland-marker ${sizeClass}">${count}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

/**
 * 습지 클릭(또는 검색 선택) 시 뉴스 패널을 해당 습지 모드로 전환하고 목록을 불러온다.
 * @param {object} wetland
 */
async function openPanel(wetland) {
  currentWetland = wetland;
  viewMode = "wetland";

  if (isMobileViewport()) {
    document.getElementById("side-panel").hidden = false;
  }

  updatePanelHeader();
  await loadIssues();
}

/**
 * [전체 보기] 버튼 클릭 핸들러: 전체 최신 뉴스 모드로 되돌아간다.
 */
async function showAllIssuesPanel() {
  viewMode = "all";
  currentWetland = null;
  updatePanelHeader();
  await loadIssues();
}

/**
 * 정렬 select 변경 핸들러: 즉시 현재 모드로 목록을 재조회한다.
 */
async function onSortChange() {
  const select = document.getElementById("issue-sort-select");
  currentSort = select.value;
  await loadIssues();
}

/**
 * 패널 헤더(제목 + [전체 보기] 버튼 표시 여부)를 현재 viewMode에 맞게 갱신한다.
 */
function updatePanelHeader() {
  const titleEl = document.getElementById("panel-title");
  const showAllBtn = document.getElementById("panel-show-all-btn");

  if (viewMode === "wetland" && currentWetland) {
    titleEl.textContent = currentWetland.name;
    showAllBtn.hidden = false;
  } else {
    titleEl.textContent = "전체 최신 뉴스";
    showAllBtn.hidden = true;
  }
}

/**
 * 현재 viewMode/currentSort/filterState에 맞춰 GET /api/issues를 호출하고 패널에 렌더링한다.
 * "wetland" 모드면 wetland_id를 붙이고, "all" 모드면 붙이지 않는다(전체 조회).
 */
async function loadIssues() {
  const content = document.getElementById("panel-content");
  content.innerHTML = `<div class="panel-loading">뉴스를 불러오는 중...</div>`;

  const params = new URLSearchParams();
  if (viewMode === "wetland" && currentWetland) {
    params.set("wetland_id", currentWetland.id);
  }
  params.set("sort", currentSort);
  if (filterState.from) params.set("from", filterState.from);
  if (filterState.to) params.set("to", filterState.to);

  try {
    const res = await fetch(`/api/issues?${params.toString()}`);
    const issues = await res.json();
    renderIssueList(content, issues);
  } catch (err) {
    content.querySelector(".panel-loading").textContent = "뉴스를 불러오지 못했습니다.";
    console.error("뉴스 목록을 불러오는 중 오류가 발생했습니다.", err);
  }
}

/**
 * 뉴스 목록을 패널 콘텐츠 영역에 렌더링한다. "all" 모드에서는 각 항목에 습지명 뱃지를 붙인다.
 * @param {HTMLElement} content
 * @param {Array<object>} issues
 */
function renderIssueList(content, issues) {
  const loadingEl = content.querySelector(".panel-loading");

  if (!issues || issues.length === 0) {
    loadingEl.textContent = "등록된 뉴스가 없습니다.";
    loadingEl.className = "panel-empty";
    return;
  }

  const listEl = document.createElement("ul");
  listEl.className = "issue-list";

  for (const issue of issues) {
    listEl.appendChild(buildIssueListItem(issue));
  }

  loadingEl.replaceWith(listEl);
}

/**
 * 뉴스 항목 하나에 대한 <li> 엘리먼트를 생성한다 (상태뱃지 + 점검 버튼 3종 포함).
 * viewMode가 "all"이고 wetland_name이 있으면 습지명 뱃지를 붙인다(클릭 시 해당 습지로 필터 전환).
 * @param {object} issue
 * @returns {HTMLLIElement}
 */
function buildIssueListItem(issue) {
  const li = document.createElement("li");
  li.className = "issue-item";
  li.dataset.issueId = issue.id;

  const confirmBtnLabel = issue.status === "confirmed" ? "미점검으로" : "확인";
  const wetlandBadgeHtml =
    viewMode === "all" && issue.wetland_name
      ? `<span class="issue-wetland-badge" data-wetland-id="${escapeHtml(String(issue.wetland_id))}">${escapeHtml(issue.wetland_name)}</span>`
      : "";

  li.innerHTML = `
    <a class="issue-title-link" href="${escapeHtml(issue.link)}" target="_blank" rel="noopener">${escapeHtml(issue.title)}</a>
    <div class="issue-meta">
      ${wetlandBadgeHtml}
      <span>${escapeHtml(issue.source || "출처 미상")}</span>
      <span>·</span>
      <span>${escapeHtml(formatDate(issue.published_at))}</span>
      <span class="issue-status-badge">${statusBadgeHtml(issue.status)}</span>
    </div>
    <div class="issue-actions">
      <button type="button" class="issue-action-btn issue-action-confirm">${confirmBtnLabel}</button>
      <button type="button" class="issue-action-btn issue-action-reassign">습지 수정</button>
      <button type="button" class="issue-action-btn issue-action-hide">숨김</button>
    </div>
    <div class="issue-reassign-form" hidden>
      <select class="issue-reassign-select"></select>
      <button type="button" class="issue-action-btn issue-action-reassign-confirm">이동</button>
      <button type="button" class="issue-action-btn issue-action-reassign-cancel">취소</button>
    </div>
  `;

  li.querySelector(".issue-action-confirm").addEventListener("click", () => onConfirmToggleClick(issue, li));
  li.querySelector(".issue-action-hide").addEventListener("click", () => onHideClick(issue, li));
  li.querySelector(".issue-action-reassign").addEventListener("click", () => onReassignClick(issue, li));
  li.querySelector(".issue-action-reassign-cancel").addEventListener("click", () => toggleReassignForm(li, false));
  li.querySelector(".issue-action-reassign-confirm").addEventListener("click", () => onReassignConfirmClick(issue, li));

  const wetlandBadge = li.querySelector(".issue-wetland-badge");
  if (wetlandBadge) {
    wetlandBadge.addEventListener("click", () => onWetlandBadgeClick(issue));
  }

  return li;
}

/**
 * 전체 목록 모드의 뉴스 항목에서 습지명 뱃지 클릭 시: 지도를 해당 습지로 이동시키고
 * 패널을 해당 습지 필터 모드로 전환한다.
 * @param {object} issue
 */
function onWetlandBadgeClick(issue) {
  const wetland = wetlandListCache.find((w) => w.id === issue.wetland_id);
  if (!wetland) return;
  map.flyTo([wetland.lat, wetland.lng], CLUSTER_DISABLE_ZOOM);
  openPanel(wetland);
}

/**
 * [확인]/[미점검으로] 토글 버튼 클릭 핸들러: status를 confirmed <-> unreviewed 로 전환한다.
 * @param {object} issue
 * @param {HTMLLIElement} li
 */
async function onConfirmToggleClick(issue, li) {
  const nextStatus = issue.status === "confirmed" ? "unreviewed" : "confirmed";
  const btn = li.querySelector(".issue-action-confirm");
  btn.disabled = true;

  try {
    const updated = await patchIssue(issue.id, { status: nextStatus });
    issue.status = updated.status;

    li.querySelector(".issue-status-badge").innerHTML = statusBadgeHtml(updated.status);
    btn.textContent = updated.status === "confirmed" ? "미점검으로" : "확인";
  } catch (err) {
    showToast(`상태 변경에 실패했습니다: ${err.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

/**
 * [숨김] 버튼 클릭 핸들러: 확인 후 status를 hidden으로 바꾸고 목록에서 제거한다.
 * @param {object} issue
 * @param {HTMLLIElement} li
 */
async function onHideClick(issue, li) {
  if (!confirm("이 뉴스를 숨기시겠습니까?")) return;

  try {
    await patchIssue(issue.id, { status: "hidden" });
    li.remove();
    await loadWetlands();
    showToast("뉴스를 숨겼습니다.");
  } catch (err) {
    showToast(`숨김 처리에 실패했습니다: ${err.message}`, true);
  }
}

/**
 * [습지 수정] 버튼 클릭 핸들러: 인라인 드롭다운을 열고 습지 목록(이름순)을 채운다.
 * @param {object} issue
 * @param {HTMLLIElement} li
 */
function onReassignClick(issue, li) {
  const select = li.querySelector(".issue-reassign-select");
  select.innerHTML = "";

  const sortedWetlands = [...wetlandListCache].sort((a, b) => a.name.localeCompare(b.name, "ko"));
  for (const wetland of sortedWetlands) {
    const option = document.createElement("option");
    option.value = wetland.id;
    option.textContent = wetland.name;
    if (currentWetland && wetland.id === currentWetland.id) {
      option.selected = true;
    }
    select.appendChild(option);
  }

  toggleReassignForm(li, true);
}

/**
 * 습지 재지정 폼과 점검 버튼 줄의 표시를 서로 전환한다.
 * @param {HTMLLIElement} li
 * @param {boolean} open 재지정 폼을 열지 여부
 */
function toggleReassignForm(li, open) {
  li.querySelector(".issue-reassign-form").hidden = !open;
  li.querySelector(".issue-actions").hidden = open;
}

/**
 * 인라인 드롭다운의 [이동] 버튼 클릭 핸들러: 선택한 습지로 wetland_id를 갱신한다.
 * @param {object} issue
 * @param {HTMLLIElement} li
 */
async function onReassignConfirmClick(issue, li) {
  const select = li.querySelector(".issue-reassign-select");
  const newWetlandId = Number(select.value);

  if (currentWetland && newWetlandId === currentWetland.id) {
    toggleReassignForm(li, false);
    return;
  }

  const targetWetland = wetlandListCache.find((w) => w.id === newWetlandId);

  try {
    await patchIssue(issue.id, { wetland_id: newWetlandId });
    li.remove();
    await loadWetlands();
    showToast(`${targetWetland ? targetWetland.name : "다른 습지"}(으)로 이동됨`);
  } catch (err) {
    showToast(`습지 이동에 실패했습니다: ${err.message}`, true);
  }
}

/**
 * PATCH /api/issues/{id} 호출 헬퍼. 실패 시 에러를 throw 한다.
 * @param {number|string} issueId
 * @param {object} body
 * @returns {Promise<object>} 갱신된 이슈 행
 */
async function patchIssue(issueId, body) {
  const res = await fetch(`/api/issues/${encodeURIComponent(issueId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      if (data && data.error) message = data.error;
    } catch {
      // JSON 파싱 실패 시 기본 메시지 사용
    }
    throw new Error(message);
  }

  return res.json();
}

/**
 * 화면 하단에 토스트 메시지를 잠시 표시한다.
 * @param {string} message
 * @param {boolean} [isError=false]
 */
function showToast(message, isError = false) {
  let toastEl = document.getElementById("toast");
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.id = "toast";
    toastEl.className = "toast";
    document.body.appendChild(toastEl);
  }

  toastEl.textContent = message;
  toastEl.classList.toggle("toast--error", isError);
  toastEl.classList.add("toast--visible");

  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    toastEl.classList.remove("toast--visible");
  }, 2500);
}

/**
 * 패널 닫기 버튼 클릭 핸들러(모바일 하단 시트 전용 — 데스크톱에서는 버튼 자체가 숨겨짐).
 */
function closePanel() {
  document.getElementById("side-panel").hidden = true;
}

/**
 * [뉴스 수집] 버튼 클릭 핸들러.
 * POST /api/collect 로 배치 수집을 시작(서버는 즉시 응답)하고, 이후 3초 간격으로
 * GET /api/collect/status 를 폴링하며 버튼에 진행률을 표시한다.
 * 이미 수집 중(alreadyRunning)이면 그대로 폴링만 시작한다.
 */
async function onCollectClick() {
  const btn = document.getElementById("collect-btn");
  btn.disabled = true;
  setCollectButtonBusy(true);

  try {
    await fetch("/api/collect", { method: "POST" });
    // started/alreadyRunning 어느 쪽이든 폴링으로 진행 상황을 따라간다.
    startCollectPolling();
  } catch (err) {
    console.error("뉴스 수집 시작 중 오류가 발생했습니다.", err);
    setCollectButtonBusy(false);
    btn.disabled = false;
    showToast("뉴스 수집을 시작하지 못했습니다.", true);
  }
}

/**
 * 페이지 로드 시 서버가 이미 수집 중이면 자동으로 폴링 모드에 진입한다.
 * (다른 직원이 [뉴스 수집]을 눌러 진행 중일 때도 진행률이 보이도록.)
 */
async function resumeCollectionIfRunning() {
  try {
    const res = await fetch("/api/collect/status");
    const status = await res.json();
    if (status && status.running === 1) {
      document.getElementById("collect-btn").disabled = true;
      setCollectButtonBusy(true);
      updateCollectProgressLabel(status);
      startCollectPolling();
    }
  } catch (err) {
    // 상태 조회 실패는 무시(수집 안 하는 상태로 간주).
    console.error("수집 상태 확인 실패:", err);
  }
}

/**
 * 수집 상태 폴링을 시작한다(중복 시작 방지). 3초마다 status를 조회해 버튼 라벨을
 * 갱신하고, running=0이 되면 폴링을 멈추고 마커/버튼을 원상 복구한다.
 */
function startCollectPolling() {
  if (collectPollTimer) return; // 이미 폴링 중이면 중복 시작하지 않음

  collectPollTimer = setInterval(async () => {
    try {
      const res = await fetch("/api/collect/status");
      const status = await res.json();

      if (!status || status.running === 0) {
        stopCollectPolling();
        await loadWetlands();
        const collected = status ? status.collected : 0;
        showToast(`뉴스 ${collected.toLocaleString("ko-KR")}건 수집 완료`);
        return;
      }

      updateCollectProgressLabel(status);
    } catch (err) {
      console.error("수집 상태 폴링 실패:", err);
    }
  }, COLLECT_POLL_MS);
}

/**
 * 수집 폴링을 중단하고 버튼을 원래 상태로 되돌린다.
 */
function stopCollectPolling() {
  if (collectPollTimer) {
    clearInterval(collectPollTimer);
    collectPollTimer = null;
  }
  setCollectButtonBusy(false);
  document.getElementById("collect-btn").disabled = false;
}

/**
 * 수집 버튼의 진행 라벨을 "수집 중 processed / total" 형식으로 갱신한다.
 * @param {{ processed: number, total: number }} status
 */
function updateCollectProgressLabel(status) {
  const label = document.getElementById("collect-btn-label");
  const processed = Number(status.processed) || 0;
  const total = Number(status.total) || 0;
  label.textContent = `수집 중 ${processed.toLocaleString("ko-KR")} / ${total.toLocaleString("ko-KR")}`;
}

/**
 * 수집 버튼의 스피너/라벨을 진행 중 또는 평상시 상태로 전환한다.
 * @param {boolean} busy
 */
function setCollectButtonBusy(busy) {
  const label = document.getElementById("collect-btn-label");
  const spinner = document.getElementById("collect-spinner");
  spinner.hidden = !busy;
  if (busy) {
    label.textContent = "수집 중...";
  } else {
    label.textContent = "뉴스 수집";
  }
}

/**
 * 발행일 문자열("YYYY-MM-DD HH:MM:SS")에서 날짜 부분만 추출한다.
 * @param {string|null} publishedAt
 * @returns {string}
 */
function formatDate(publishedAt) {
  if (!publishedAt) return "날짜 미상";
  return publishedAt.split(" ")[0];
}

/* ------------------------------------------------------------------ */
/* 습지명 검색 (헤더)                                                   */
/* ------------------------------------------------------------------ */

/**
 * 습지명 검색 input/드롭다운의 이벤트를 초기화한다.
 */
function initWetlandSearch() {
  const input = document.getElementById("wetland-search-input");

  input.addEventListener("input", () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      renderWetlandSearchResults(input.value.trim());
    }, SEARCH_DEBOUNCE_MS);
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (searchResultItems.length > 0) {
        selectWetlandFromSearch(searchResultItems[0]);
      }
    } else if (event.key === "Escape") {
      closeWetlandSearchResults();
    }
  });

  document.addEventListener("click", (event) => {
    const searchWrap = document.getElementById("wetland-search");
    if (!searchWrap.contains(event.target)) {
      closeWetlandSearchResults();
    }
  });
}

/**
 * 검색어로 wetlandListCache를 부분일치(이름 기준) 필터링하여 드롭다운을 그린다.
 * @param {string} query
 */
function renderWetlandSearchResults(query) {
  const resultsEl = document.getElementById("wetland-search-results");

  if (!query) {
    closeWetlandSearchResults();
    return;
  }

  const lowerQuery = query.toLowerCase();
  const matches = wetlandListCache
    .filter((w) => w.name && w.name.toLowerCase().includes(lowerQuery))
    .slice(0, SEARCH_MAX_RESULTS);

  searchResultItems = matches;
  resultsEl.innerHTML = "";

  if (matches.length === 0) {
    const li = document.createElement("li");
    li.className = "wetland-search-empty";
    li.textContent = "일치하는 습지 없음";
    resultsEl.appendChild(li);
    resultsEl.hidden = false;
    return;
  }

  for (const wetland of matches) {
    const li = document.createElement("li");
    li.className = "wetland-search-item";
    li.innerHTML = `
      <span class="wetland-search-item-name">${escapeHtml(wetland.name)}</span>
      <span class="wetland-search-item-region">${escapeHtml(wetland.region || "-")}</span>
    `;
    li.addEventListener("click", () => selectWetlandFromSearch(wetland));
    resultsEl.appendChild(li);
  }

  resultsEl.hidden = false;
}

/**
 * 검색 결과에서 습지를 선택했을 때: 지도 이동 + 패널 오픈 + 드롭다운 닫기.
 * @param {object} wetland
 */
function selectWetlandFromSearch(wetland) {
  map.flyTo([wetland.lat, wetland.lng], CLUSTER_DISABLE_ZOOM);
  openPanel(wetland);
  closeWetlandSearchResults();

  const input = document.getElementById("wetland-search-input");
  input.value = wetland.name;
}

/**
 * 습지 검색 드롭다운을 닫는다.
 */
function closeWetlandSearchResults() {
  const resultsEl = document.getElementById("wetland-search-results");
  resultsEl.hidden = true;
  resultsEl.innerHTML = "";
  searchResultItems = [];
}

/* ------------------------------------------------------------------ */
/* 날짜 기간 필터                                                       */
/* ------------------------------------------------------------------ */

/**
 * 날짜 기간 필터 컨트롤([적용]/[해제])의 이벤트를 초기화한다.
 */
function initDateFilter() {
  const applyBtn = document.getElementById("date-filter-apply-btn");
  const clearBtn = document.getElementById("date-filter-clear-btn");

  applyBtn.addEventListener("click", onDateFilterApplyClick);
  clearBtn.addEventListener("click", onDateFilterClearClick);
}

/**
 * 모바일 화면에서 기간 필터를 접기/펼치기 토글하는 버튼을 초기화한다.
 * 데스크톱 폭에서는 CSS로 토글 버튼 자체가 숨겨지고 필터가 항상 노출된다.
 */
function initDateFilterToggle() {
  const toggleBtn = document.getElementById("date-filter-toggle-btn");
  const dateFilterEl = document.getElementById("date-filter");

  toggleBtn.addEventListener("click", () => {
    const isOpen = dateFilterEl.classList.toggle("date-filter--open");
    toggleBtn.setAttribute("aria-expanded", String(isOpen));
  });
}

/**
 * [적용] 버튼 클릭 핸들러: filterState를 갱신하고 습지 목록/열린 패널을 새로고침한다.
 */
async function onDateFilterApplyClick() {
  const fromInput = document.getElementById("date-filter-from");
  const toInput = document.getElementById("date-filter-to");

  filterState.from = fromInput.value || null;
  filterState.to = toInput.value || null;

  await refreshAfterFilterChange();
}

/**
 * [해제] 버튼 클릭 핸들러: filterState를 초기화하고 입력값도 비운 뒤 새로고침한다.
 */
async function onDateFilterClearClick() {
  filterState.from = null;
  filterState.to = null;
  document.getElementById("date-filter-from").value = "";
  document.getElementById("date-filter-to").value = "";

  await refreshAfterFilterChange();
}

/**
 * 필터 변경 후 상태 표시·마커·뉴스 패널을 일괄 새로고침한다.
 * 데스크톱은 패널이 상시 노출이므로 모드(전체/습지)와 무관하게 항상 다시 불러오고,
 * 모바일은 하단 시트가 열려 있을 때(습지 모드)만 새로고침한다.
 */
async function refreshAfterFilterChange() {
  updateDateFilterStatus();
  await loadWetlands();

  const panel = document.getElementById("side-panel");
  if (!panel.hidden) {
    await loadIssues();
  }
}

/**
 * 필터 적용 상태를 헤더 하단 표시 영역에 반영한다.
 */
function updateDateFilterStatus() {
  const statusEl = document.getElementById("date-filter-status");
  const dateFilterEl = document.getElementById("date-filter");

  if (!filterState.from && !filterState.to) {
    statusEl.hidden = true;
    statusEl.textContent = "";
    dateFilterEl.classList.remove("date-filter--active");
    return;
  }

  const fromLabel = filterState.from ? formatFullDate(filterState.from) : "처음";
  const toLabel = filterState.to ? formatFullDate(filterState.to) : "현재";

  statusEl.textContent = `${fromLabel} ~ ${toLabel} 적용 중`;
  statusEl.hidden = false;
  dateFilterEl.classList.add("date-filter--active");
}

/**
 * "YYYY-MM-DD" 문자열을 "YYYY년 N월 N일" 형식으로 변환한다.
 * @param {string} dateStr
 * @returns {string}
 */
function formatFullDate(dateStr) {
  const parts = dateStr.split("-");
  if (parts.length !== 3) return dateStr;
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  return `${year}년 ${month}월 ${day}일`;
}

/* ------------------------------------------------------------------ */
/* 분할선 드래그 (지도 vs 뉴스 패널 비율 조절)                              */
/* ------------------------------------------------------------------ */

/**
 * 분할선 드래그 이벤트를 초기화하고, localStorage에 저장된 비율(또는 기본값)을 적용한다.
 * 모바일(하단 시트 레이아웃)에서는 분할선이 CSS로 숨겨져 있으므로 드래그가 사실상 발생하지 않지만,
 * 안전을 위해 핸들러 내부에서도 모바일이면 조기 반환한다.
 */
function initSplitHandle() {
  const handle = document.getElementById("split-handle");
  const mapPane = document.getElementById("map-pane");

  applyMapRatio(loadStoredMapRatio());

  handle.addEventListener("mousedown", (event) => {
    if (isMobileViewport()) return;
    event.preventDefault();
    splitDragging = true;
    handle.classList.add("split-handle--dragging");
    document.body.style.userSelect = "none";
  });

  document.addEventListener("mousemove", (event) => {
    if (!splitDragging) return;
    const mainEl = document.querySelector(".app-main");
    const rect = mainEl.getBoundingClientRect();
    let ratio = (event.clientX - rect.left) / rect.width;
    ratio = Math.min(Math.max(ratio, SPLIT_MIN_MAP_RATIO), SPLIT_MAX_MAP_RATIO);
    applyMapRatio(ratio);
  });

  document.addEventListener("mouseup", () => {
    if (!splitDragging) return;
    splitDragging = false;
    handle.classList.remove("split-handle--dragging");
    document.body.style.userSelect = "";

    const mainEl = document.querySelector(".app-main");
    const ratio = mapPane.getBoundingClientRect().width / mainEl.getBoundingClientRect().width;
    localStorage.setItem(SPLIT_RATIO_STORAGE_KEY, String(ratio));

    if (map) map.invalidateSize();
  });
}

/**
 * localStorage에 저장된 지도 비율을 읽어온다. 없거나 유효 범위를 벗어나면 기본값을 반환한다.
 * @returns {number}
 */
function loadStoredMapRatio() {
  const stored = Number(localStorage.getItem(SPLIT_RATIO_STORAGE_KEY));
  if (!Number.isFinite(stored) || stored < SPLIT_MIN_MAP_RATIO || stored > SPLIT_MAX_MAP_RATIO) {
    return DEFAULT_MAP_RATIO;
  }
  return stored;
}

/**
 * 뉴스 패널의 flex-basis를 지도 비율의 나머지(1 - ratio)로 설정한다.
 * 지도 영역(.map-pane)은 flex:1 1 auto로 항상 나머지 공간을 채우므로 side-panel 너비만
 * 고정하면 분할 비율이 그대로 반영된다.
 * @param {number} ratio 지도 영역이 차지할 비율(0.4~0.8)
 */
function applyMapRatio(ratio) {
  const sidePanel = document.getElementById("side-panel");
  const panelRatio = 1 - ratio;
  sidePanel.style.flexBasis = `${panelRatio * 100}%`;
}

/**
 * XSS 방지를 위한 최소한의 HTML 이스케이프.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
