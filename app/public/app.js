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

/**
 * 부정보도 뱃지 HTML을 생성한다. is_negative가 1일 때만 빨간 "부정" 뱃지를 반환한다.
 * @param {number|null} isNegative
 * @returns {string}
 */
function negativeBadgeHtml(isNegative) {
  return Number(isNegative) === 1
    ? `<span class="status-badge status-badge--negative">부정</span>`
    : "";
}

let map;
let markersLayer;
const markerByWetlandId = new Map();
let wetlandListCache = [];
let currentWetland = null;
/** 위치 수정 중 지도에 띄우는 드래그 가능한 임시 핀(Leaflet). 미사용 시 null. */
let locationEditMarker = null;

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

/** "부정보도만" 필터 활성화 여부. true면 GET /api/issues에 negative=1을 붙인다. */
let negativeOnly = false;

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

/**
 * 습지 클릭 시 백그라운드 단건 수집(POST /api/wetlands/{id}/collect) 재호출을 막기 위한
 * 세션 내 "습지 id → 마지막 수집 시각(ms)" 기록. 같은 습지를 짧은 시간에 반복 클릭해도
 * COLLECT_SINGLE_COOLDOWN_MS 이내면 다시 fetch하지 않는다.
 */
const wetlandLastCollectAt = new Map();
const COLLECT_SINGLE_COOLDOWN_MS = 10 * 60 * 1000; // 10분

/* ------------------------------------------------------------------ */
/* 지도 레이어 (일반/위성) 및 마커 클러스터링 관련 상수                        */
/* ------------------------------------------------------------------ */

/** 클러스터를 풀고 개별 마커를 보여줄 최소 줌 레벨(습지 검색 선택 시 이 값 이상으로 flyTo). */
const CLUSTER_DISABLE_ZOOM = 12;

/** 지도 기본 화면(대한민국 전역) — 초기 로드와 [전체 보기] 복귀에 사용. */
const DEFAULT_MAP_CENTER = [36.3, 127.8];
const DEFAULT_MAP_ZOOM = 7;

/**
 * 서버(GET /api/config)에서 불러온 지도 설정. vworld_key, kakao_key, google_key, naver_key를 쓴다.
 * 지도 JS 키는 원래 브라우저에 노출되는 도메인 제한 키라 클라이언트 보관이 정상이다.
 */
let mapConfig = {};

/** OSM 어댑터의 base 레이어 이름→레이어 맵({@link buildFreeBaseLayers} 결과, ensureLoaded에서 채움). */
let baseLayerMap = {};
/** 카카오 지도 SDK 로드 완료 여부(중복 로드 방지). */
let kakaoSdkReady = false;

/* ------------------------------------------------------------------ */
/* 지도 제공사 어댑터 아키텍처 (OSM 기본 / 구글 / 네이버 / 카카오)             */
/* ------------------------------------------------------------------ */

/** 선택한 지도 제공사를 저장하는 localStorage 키(새로고침 후에도 유지). */
const PROVIDER_STORAGE_KEY = "wetland-map-provider";
/** 제공사 공통 지도 종류를 저장하는 localStorage 키. */
const MAP_TYPE_STORAGE_KEY = "wetland-map-type";

/**
 * 제공사 전환 관련 전역 상태(gpsphoto State 패턴 이식).
 * - provider: 'osm'(기본) | 'google' | 'naver' | 'kakao'
 * - mapType: 'roadmap' | 'satellite' | 'hybrid' (제공사 공통)
 * - cadastral: 지적편집도 토글 on/off
 * - pendingView: 제공사 전환 시 이전 center/zoom을 보존해 새 어댑터에 적용하기 위한 임시값
 */
const State = {
  provider: "osm",
  mapType: "roadmap",
  cadastral: false,
  pendingView: null,
};

/** 키 없는 제공사를 선택했을 때 던지는 에러(오버레이 안내로 전환). */
class NoKeyError extends Error {
  constructor(provider) {
    super("No API key for " + provider);
    this.provider = provider;
  }
}

/** 제공사별 한글 표시명(오버레이 안내 문구용). */
function providerName(p) {
  return { osm: "무료(OpenStreetMap)", vworld: "VWorld", google: "구글", naver: "네이버", kakao: "카카오" }[p] || p;
}

/**
 * 제공사 전환 시 #map 내부를 새 엘리먼트로 교체해 깨끗한 컨테이너를 만든다.
 * (Leaflet은 한 번 init한 노드를 재사용하면 _leaflet_id 충돌로 재init을 거부하므로,
 * gpsphoto prepareContainer()처럼 매번 새 자식 엘리먼트를 준다.)
 * @returns {HTMLElement}
 */
function prepareMapContainer() {
  const host = document.getElementById("map");
  host.innerHTML = "";
  const inner = document.createElement("div");
  inner.style.width = "100%";
  inner.style.height = "100%";
  host.appendChild(inner);
  return inner;
}

/** 어댑터 레지스트리와 현재 어댑터 접근자. */
let Adapters = {};
function adapter() {
  return Adapters[State.provider];
}

init();

function init() {
  // 어댑터 레지스트리 구성(모듈 로드 순서상 함수 정의 이후 init에서 조립).
  Adapters = {
    osm: createLeafletAdapter("free"),
    vworld: createLeafletAdapter("vworld"),
    google: createGoogleAdapter(),
    naver: createNaverAdapter(),
    kakao: createKakaoAdapter(),
  };

  // 저장된 제공사/지도 종류 복원(기본은 OSM/일반).
  const storedProvider = localStorage.getItem(PROVIDER_STORAGE_KEY);
  if (["osm", "vworld", "google", "naver", "kakao"].includes(storedProvider)) {
    State.provider = storedProvider;
  }
  const storedType = localStorage.getItem(MAP_TYPE_STORAGE_KEY);
  if (["roadmap", "satellite", "hybrid"].includes(storedType)) {
    State.mapType = storedType;
  }

  applyDefaultDateFilterIfEmpty();

  document.getElementById("panel-close-btn").addEventListener("click", closePanel);
  document.getElementById("panel-show-all-btn").addEventListener("click", showAllIssuesPanel);
  document.getElementById("wetland-clear-btn").addEventListener("click", clearWetlandSelection);
  document.getElementById("wetland-edit-btn").addEventListener("click", startWetlandNameEdit);
  document.getElementById("wetland-loc-btn").addEventListener("click", startLocationEdit);
  document.getElementById("location-save-btn").addEventListener("click", saveLocation);
  document.getElementById("location-cancel-btn").addEventListener("click", cancelLocationEdit);
  document.getElementById("wetland-name-save-btn").addEventListener("click", saveWetlandName);
  document.getElementById("wetland-name-cancel-btn").addEventListener("click", cancelWetlandNameEdit);
  document.getElementById("wetland-name-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      saveWetlandName();
    } else if (event.key === "Escape") {
      cancelWetlandNameEdit();
    }
  });
  document.getElementById("issue-sort-select").addEventListener("change", onSortChange);
  document.getElementById("negative-filter-checkbox").addEventListener("change", onNegativeFilterChange);
  document.getElementById("collect-btn").addEventListener("click", onCollectClick);

  initWetlandSearch();
  initDateFilter();
  initDateFilterToggle();
  initSplitHandle();
  initMapSettingsPanel();
  initMapDropdown();
  initRoadview();

  // 서버에 저장된 지도 키를 불러와 VWorld 레이어/카카오 로드뷰 버튼/제공사 렌더를 초기 구성한다.
  // loadMapConfig 완료 후 현재 제공사로 지도를 준비하고 습지 데이터를 로드한다.
  loadMapConfig();

  // 모바일에서는 습지를 선택하기 전까지 하단 시트를 숨겨둔다(데스크톱은 상시 노출).
  if (isMobileViewport()) {
    document.getElementById("side-panel").hidden = true;
  } else {
    loadIssues();
  }

  // 페이지 로드 시 뉴스 신선도 확인: 최근 12시간 내 수집 완료면 아무것도 돌리지 않고
  // "최신 확인" 표시만, 오래됐으면 자동으로 한 바퀴만 돌고 멈춘다.
  ensureFreshNews();
}

/**
 * 현재 State.provider의 어댑터를 로드/전환하고 습지 데이터를 렌더링한다.
 * (gpsphoto ensureMapReady 이식) 이전 view(center/zoom)를 보존하고, 키가 없으면
 * NoKeyError를 잡아 오버레이 안내만 띄운 뒤 앱은 계속 살아 있게 한다.
 * @param {boolean} [fitDefault=false] 지도 준비 후 전국 화면으로 맞출지 여부(초기 로드)
 */
async function ensureMapReady(fitDefault = false) {
  const a = adapter();
  try {
    if (!a.ready) {
      // native 제공사(구글/네이버/카카오)는 SDK 로드에 시간이 걸리므로, "불러오는 중"을
      // 먼저 띄워 멈춘 것처럼 보이지 않게 한다(로드 완료/실패 시 아래에서 갱신).
      if (State.provider !== "osm") {
        showMapOverlay(`${providerName(State.provider)} 지도를 불러오는 중...`);
      }
      await a.ensureLoaded();
      a.onViewChange(() => {}); // 어댑터별 view 변경 훅(현재 OSM 라벨/클러스터는 자체 처리)
    }

    a.setMapType(State.mapType);
    a.setCadastral(State.cadastral && a.supportsCadastral());
    updateMapControls();

    // 이전 제공사의 center/zoom을 새 어댑터에 이어붙인다(전국 화면으로 튀지 않도록).
    let appliedView = false;
    if (State.pendingView) {
      a.applyView(State.pendingView);
      State.pendingView = null;
      appliedView = true;
    } else if (fitDefault) {
      a.fitKorea();
    }

    hideMapOverlay();
    // 습지 데이터가 이미 있으면 즉시 렌더, 없으면(초기 로드) loadWetlands로 가져와 렌더한다.
    if (wetlandListCache.length > 0) {
      renderMarkers(wetlandListCache);
    } else {
      loadWetlands();
    }
  } catch (err) {
    // 로드 실패(키 없음 포함) 시 이전 제공사의 지도 DOM이 남아 있으면 비워 깔끔한 안내만 남긴다.
    prepareMapContainer();
    if (err instanceof NoKeyError) {
      showMapOverlay(
        `${providerName(err.provider)} 지도 키가 필요합니다. ⚙ 설정에서 API 키를 입력하세요.`
      );
    } else {
      console.error("지도를 준비하지 못했습니다.", err);
      showMapOverlay("지도를 불러오지 못했습니다. API 키와 등록 도메인을 확인하세요.");
    }
  }
}

/**
 * 지도 위 안내 오버레이를 표시한다(키 없음/로드 실패 시). 앱은 죽지 않는다.
 * @param {string} message
 */
function showMapOverlay(message) {
  const el = document.getElementById("map-overlay");
  el.textContent = message;
  el.hidden = false;
}

function hideMapOverlay() {
  document.getElementById("map-overlay").hidden = true;
}

/**
 * 키가 필요 없는 기본 3종 베이스 레이어를 만들어 {이름: 레이어} 객체로 반환한다.
 * OSM 어댑터가 공통 "지도 종류" select(State.mapType)에 맞춰 이 중 하나를 교체 장착한다.
 * - 일반 지도: OpenStreetMap
 * - 위성 지도: Esri World Imagery
 * - 하이브리드: Esri 위성 + ArcGIS 라벨/경계 오버레이(layerGroup으로 하나의 base처럼 동작)
 * @returns {Object<string, L.Layer>}
 */
function buildFreeBaseLayers() {
  const osmLayer = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
  });

  const esriImagery = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      maxZoom: 19,
      attribution: "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics",
    }
  );

  const satelliteLayer = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      maxZoom: 19,
      attribution: "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics",
    }
  );

  // 하이브리드: 위성 위에 지명/경계 라벨 오버레이를 얹어 하나의 base 레이어로 묶는다.
  const boundariesOverlay = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
    {
      maxZoom: 19,
      attribution: "Labels &copy; Esri",
    }
  );
  const hybridLayer = L.layerGroup([esriImagery, boundariesOverlay]);

  return {
    "일반 지도": osmLayer,
    "위성 지도": satelliteLayer,
    "하이브리드": hybridLayer,
  };
}

/**
 * 마커 클러스터 배지 아이콘을 생성한다. 하위 마커들의 issue_count 합계를 배지에 표시하고,
 * 합계가 0이면 숫자 없이 작은 회색 점(개별 회색 마커와 톤은 같되, 클러스터임을 알 수 있도록
 * 살짝 더 크게)으로 표시한다. 합계>0이면 기존대로 파랑 계열 배지 + 숫자를 표시한다.
 * @param {L.MarkerCluster} cluster
 * @returns {L.DivIcon}
 */
function buildClusterIcon(cluster) {
  const childMarkers = cluster.getAllChildMarkers();
  const totalIssues = childMarkers.reduce((sum, marker) => sum + (marker.options.issueCount || 0), 0);
  const totalNegative = childMarkers.reduce((sum, marker) => sum + (marker.options.negativeCount || 0), 0);

  if (totalIssues === 0) {
    // 개별 회색 마커(wetland-marker--empty, 14px)보다 살짝 크게 하여 클러스터임을 구분한다.
    return L.divIcon({
      className: "",
      html: '<div class="wetland-cluster wetland-cluster--empty-dot"></div>',
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    });
  }

  let sizeClass = "wetland-cluster--sm";
  let size = 36;
  if (totalIssues >= 50) {
    sizeClass = "wetland-cluster--lg";
    size = 52;
  } else if (totalIssues >= 10) {
    sizeClass = "wetland-cluster--md";
    size = 44;
  }

  // 하위에 부정보도 습지가 하나라도 있으면 빨간 테두리로 강조한다(집계 배지 색은 유지).
  const negativeClass = totalNegative > 0 ? " wetland-cluster--negative" : "";

  return L.divIcon({
    className: "",
    html: `<div class="wetland-cluster ${sizeClass}${negativeClass}">${totalIssues}</div>`,
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
  // 지도 데이터가 갱신되는 시점마다 전체 뉴스 현황 인포도 함께 갱신한다.
  loadStats();
}

/**
 * 전체 뉴스 현황(건수 + 수집 기간)을 조회해 패널 상단 인포에 표시한다.
 * 기간 필터와 무관한 전체(숨김 제외) 통계다.
 */
async function loadStats() {
  const el = document.getElementById("news-info");

  // 현재 보기(습지/전체)·기간·부정 필터에 따라 라벨 앞머리를 정한다.
  const scope = viewMode === "wetland" && currentWetland ? "이 습지 " : "";
  const kind = negativeOnly ? "부정보도" : "뉴스";
  const prefix = `${scope}${kind}`;

  try {
    const params = buildIssueFilterParams();
    const qs = params.toString();
    const res = await fetch(`/api/stats${qs ? `?${qs}` : ""}`);
    const s = await res.json();

    if (!s || !s.total) {
      el.textContent = `${prefix} 0건`;
      el.hidden = false;
      return;
    }

    const parts = [`${prefix} ${Number(s.total).toLocaleString("ko-KR")}건`];
    if (s.oldest && s.newest) {
      parts.push(`${formatDotDate(s.oldest)} ~ ${formatDotDate(s.newest)}`);
    }
    el.textContent = parts.join("  ·  ");
    el.hidden = false;
  } catch (err) {
    console.error("뉴스 현황 조회 실패:", err);
    el.hidden = true;
  }
}

/**
 * "YYYY-MM-DD HH:MM:SS"(또는 "YYYY-MM-DD")를 "YYYY.M.D" 형식으로 변환한다.
 * @param {string|null} dt
 * @returns {string}
 */
function formatDotDate(dt) {
  if (!dt) return "";
  const datePart = String(dt).split(" ")[0];
  const p = datePart.split("-");
  if (p.length !== 3) return datePart;
  return `${Number(p[0])}.${Number(p[1])}.${Number(p[2])}`;
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
 * 습지 배열을 받아 현재 제공사 어댑터로 마커를 새로 그린다.
 * (OSM은 기존 Leaflet 군집 렌더, 구글/네이버/카카오는 native 배지 렌더로 위임한다.)
 * @param {Array<object>} wetlands
 */
function renderMarkers(wetlands) {
  const a = adapter();
  if (!a || !a.ready) return;
  a.renderWetlands(wetlands, openPanel);
}

/**
 * 습지 하나로 지도를 이동한다(제공사 공통). 검색 선택/뱃지 클릭에서 호출.
 * @param {object} wetland
 */
function flyToWetland(wetland) {
  const a = adapter();
  if (a && a.ready) a.flyToWetland(wetland, CLUSTER_DISABLE_ZOOM);
}

/** 지도를 대한민국 전역 화면으로 되돌린다(제공사 공통). [전체 보기] 복귀에 사용. */
function fitKorea() {
  const a = adapter();
  if (a && a.ready) a.fitKorea();
}

/**
 * OSM(Leaflet) 전용 마커 렌더 — 기존 동작 그대로(군집/라벨/3색 배지/클릭→패널).
 * osm 어댑터의 renderWetlands가 이 함수를 호출한다.
 * @param {Array<object>} wetlands
 */
function renderMarkersOsm(wetlands) {
  markersLayer.clearLayers();
  markerByWetlandId.clear();

  for (const wetland of wetlands) {
    const issueCount = Number(wetland.issue_count) || 0;
    const negativeCount = Number(wetland.negative_count) || 0;
    const marker = L.marker([wetland.lat, wetland.lng], {
      icon: buildWetlandIcon(issueCount, negativeCount),
      issueCount, // 클러스터 배지 합산용(buildClusterIcon에서 getAllChildMarkers로 합산)
      negativeCount, // 클러스터에 부정 습지 포함 여부 표시용(합산)
    });

    // 습지명 라벨을 상시 표시한다. 이슈 있는 습지뿐 아니라 회색 점(이슈 없는 습지)도
    // 개별로 풀려 있으면(클러스터 안 됨) 이름이 보이게 한다. 클러스터에 묶이면 그 마커는
    // 지도에서 빠지므로 라벨도 자동으로 사라져(성능/시야 정리), 화면에 보이는 개별 점만 라벨이 붙는다.
    // 회색 점은 라벨을 살짝 옅게(wetland-label--muted) 표시해 이슈 습지와 구분한다.
    marker.bindTooltip(wetland.name, {
      permanent: true,
      direction: "bottom",
      offset: [0, 4],
      className: issueCount > 0 ? "wetland-label" : "wetland-label wetland-label--muted",
    });

    marker.on("click", () => openPanel(wetland));
    marker.addTo(markersLayer);
    markerByWetlandId.set(wetland.id, marker);
  }
}

/**
 * 이슈 건수에 따라 커스텀 divIcon을 생성한다. 3색 체계:
 *  - issue_count가 0이면 회색 작은 마커,
 *  - negative_count>0(부정보도 포함)이면 빨간 원형 배지,
 *  - 그 외(일반 이슈만)이면 파란 원형 배지에 숫자를 표시한다.
 * 건수 구간별로 배지 크기를 키워 지도 위에서 이슈 밀집도를 직관적으로 파악할 수 있게 한다:
 * 1~4건 소형, 5~9건 중형, 10건 이상 대형(크기 3단계는 색과 무관하게 유지).
 * @param {number} issueCount
 * @param {number} [negativeCount=0]
 * @returns {L.DivIcon}
 */
function buildWetlandIcon(issueCount, negativeCount = 0) {
  const count = Number(issueCount) || 0;
  const negative = Number(negativeCount) || 0;

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

  const negativeClass = negative > 0 ? " wetland-marker--negative" : "";

  return L.divIcon({
    className: "",
    html: `<div class="wetland-marker ${sizeClass}${negativeClass}">${count}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

/**
 * 습지 클릭(또는 검색 선택) 시 뉴스 패널을 해당 습지 모드로 전환하고 목록을 불러온다.
 * 패널을 먼저 열고 기존 뉴스를 표시한 뒤, 백그라운드로 해당 습지만 즉시 재수집을 시도한다
 * (완료 후 신규 뉴스가 있으면 목록/마커를 갱신하고 작은 안내를 띄운다).
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

  collectSingleWetlandInBackground(wetland);
}

/**
 * 습지 하나만 백그라운드로 즉시 재수집한다(POST /api/wetlands/{id}/collect).
 * 같은 습지를 COLLECT_SINGLE_COOLDOWN_MS(10분) 이내에 반복 클릭하면 스킵한다.
 * 완료 후 신규 수집(collected>0)이 있고 여전히 같은 습지를 보고 있으면 목록/마커를
 * 갱신하고 작은 토스트로 안내한다. collected=0이거나 실패하면 조용히 무시한다.
 * @param {object} wetland
 */
async function collectSingleWetlandInBackground(wetland) {
  const now = Date.now();
  const lastAt = wetlandLastCollectAt.get(wetland.id);
  if (lastAt && now - lastAt < COLLECT_SINGLE_COOLDOWN_MS) {
    return;
  }
  wetlandLastCollectAt.set(wetland.id, now);

  setPanelCollectingIndicator(true);

  try {
    const res = await fetch(`/api/wetlands/${encodeURIComponent(wetland.id)}/collect`, { method: "POST" });
    const result = await res.json();

    if (result && result.collected > 0) {
      await loadWetlands();
      // 사용자가 그 사이 다른 습지/모드로 이동하지 않았을 때만 목록을 새로고침한다.
      if (viewMode === "wetland" && currentWetland && currentWetland.id === wetland.id) {
        await loadIssues();
        showToast(`새 뉴스 ${result.collected.toLocaleString("ko-KR")}건`);
      }
    }
  } catch (err) {
    // 백그라운드 수집 실패는 조용히 무시한다(기존 목록은 그대로 유지).
    console.error("습지 단건 수집 실패:", err);
  } finally {
    setPanelCollectingIndicator(false);
  }
}

/**
 * 패널 제목 옆에 "최신 뉴스 확인 중..." 표시를 켜거나 끈다.
 * @param {boolean} collecting
 */
function setPanelCollectingIndicator(collecting) {
  const indicator = document.getElementById("panel-collecting-indicator");
  if (!indicator) return;
  indicator.hidden = !collecting;
}

/**
 * [전체 보기] 버튼 클릭 핸들러: 전체 최신 뉴스 모드로 되돌아간다.
 */
async function showAllIssuesPanel() {
  viewMode = "all";
  currentWetland = null;
  updatePanelHeader();
  // 전체 보기로 돌아올 때 지도도 전국 화면으로 복귀한다.
  fitKorea();
  await loadIssues();
}

/**
 * 습지 선택 해제(제목 옆 X 버튼): 목록만 전체 뉴스로 되돌리고 지도는 현재 위치·배율 그대로
 * 둔다(전국 화면으로 되돌아가지 않음 — 사용자 요청).
 */
async function clearWetlandSelection() {
  viewMode = "all";
  currentWetland = null;
  updatePanelHeader();
  await loadIssues();
}

/**
 * 습지 이름 수정 시작(제목 옆 ✏️): 제목/버튼을 감추고 현재 이름이 채워진 입력칸을 연다.
 */
function startWetlandNameEdit() {
  if (!currentWetland) return;
  const input = document.getElementById("wetland-name-input");
  input.value = currentWetland.name;
  setWetlandNameEditing(true);
  input.focus();
  input.select();
}

/**
 * 습지 이름 수정 취소: 입력칸을 닫고 제목을 원래대로 보여준다.
 */
function cancelWetlandNameEdit() {
  setWetlandNameEditing(false);
}

/**
 * 습지 이름 저장: PATCH /api/wetlands/{id}로 서버(전 직원 공유)에 반영하고,
 * 성공 시 제목·지도 마커/라벨·검색 캐시를 모두 갱신한다.
 */
async function saveWetlandName() {
  if (!currentWetland) return;
  const input = document.getElementById("wetland-name-input");
  const newName = input.value.trim();

  if (!newName) {
    showToast("습지 이름을 입력해 주세요.", true);
    return;
  }
  if (newName === currentWetland.name) {
    setWetlandNameEditing(false);
    return;
  }

  const saveBtn = document.getElementById("wetland-name-save-btn");
  saveBtn.disabled = true;
  try {
    const res = await fetch(`/api/wetlands/${encodeURIComponent(currentWetland.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: newName }),
    });
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const data = await res.json();
        if (data && data.error) message = data.error;
      } catch {
        /* 기본 메시지 사용 */
      }
      throw new Error(message);
    }

    currentWetland.name = newName;
    setWetlandNameEditing(false);
    updatePanelHeader(); // 제목 갱신
    await loadWetlands(); // 지도 마커/라벨·검색 캐시 갱신(서버 최신 이름 반영)
    showToast("습지 이름을 수정했습니다.");
  } catch (err) {
    showToast(`이름 수정에 실패했습니다: ${err.message}`, true);
  } finally {
    saveBtn.disabled = false;
  }
}

/**
 * 이름 수정 모드 On/Off — 제목·✏️·✕는 감추고 입력칸을 보이거나 그 반대로 전환한다.
 * @param {boolean} editing
 */
function setWetlandNameEditing(editing) {
  document.getElementById("panel-title").hidden = editing;
  document.getElementById("wetland-edit-btn").hidden = editing;
  document.getElementById("wetland-loc-btn").hidden = editing;
  document.getElementById("wetland-clear-btn").hidden = editing;
  document.getElementById("wetland-name-edit").hidden = !editing;
}

/**
 * 습지 위치 수정 시작(📍): 무료(OSM)/VWorld 지도에서만 가능. 해당 습지로 확대한 뒤
 * 드래그 가능한 임시 핀을 띄우고, 지도 하단에 저장/취소 바를 보여준다.
 */
function startLocationEdit() {
  if (!currentWetland) return;

  // 위치 수정은 Leaflet 기반 지도(무료/VWorld)에서만 지원한다(핀 드래그).
  if (!(State.provider === "osm" || State.provider === "vworld") || !map) {
    showToast("위치 수정은 무료 지도나 VWorld에서 가능해요. 좌상단 '지도'에서 전환하세요.", true);
    return;
  }
  if (locationEditMarker) return; // 이미 수정 중

  // 해당 습지로 확대해 핀을 정확히 놓기 쉽게 한다.
  map.setView([currentWetland.lat, currentWetland.lng], 15, { animate: true });

  locationEditMarker = L.marker([currentWetland.lat, currentWetland.lng], {
    draggable: true,
    autoPan: true,
    zIndexOffset: 2000,
    icon: L.divIcon({
      className: "",
      html: '<div class="location-pin" title="드래그해서 옮기세요">📍</div>',
      iconSize: [34, 34],
      iconAnchor: [17, 32],
    }),
  }).addTo(map);

  document.getElementById("location-edit-bar").hidden = false;
}

/**
 * 위치 저장: 드래그한 핀의 좌표를 PATCH /api/wetlands/{id}로 서버(전 직원 공유)에 반영하고,
 * 성공 시 지도 마커/라벨·검색 캐시를 갱신한다.
 */
async function saveLocation() {
  if (!currentWetland || !locationEditMarker) return;

  const pos = locationEditMarker.getLatLng();
  const saveBtn = document.getElementById("location-save-btn");
  saveBtn.disabled = true;
  try {
    const res = await fetch(`/api/wetlands/${encodeURIComponent(currentWetland.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lat: pos.lat, lng: pos.lng }),
    });
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const data = await res.json();
        if (data && data.error) message = data.error;
      } catch {
        /* 기본 메시지 사용 */
      }
      throw new Error(message);
    }

    currentWetland.lat = pos.lat;
    currentWetland.lng = pos.lng;
    endLocationEdit();
    await loadWetlands(); // 지도 마커/라벨·검색 캐시를 새 위치로 갱신
    showToast("습지 위치를 수정했습니다.");
  } catch (err) {
    showToast(`위치 수정에 실패했습니다: ${err.message}`, true);
  } finally {
    saveBtn.disabled = false;
  }
}

/** 위치 수정 취소: 임시 핀과 안내 바를 정리한다(좌표 변경 없음). */
function cancelLocationEdit() {
  endLocationEdit();
}

/** 위치 수정 임시 핀·안내 바를 제거한다(저장/취소 공통 정리). */
function endLocationEdit() {
  if (locationEditMarker && map) {
    try {
      map.removeLayer(locationEditMarker);
    } catch (e) {
      /* 이미 제거됨 */
    }
  }
  locationEditMarker = null;
  document.getElementById("location-edit-bar").hidden = true;
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
 * "부정보도만" 체크박스 변경 핸들러: negativeOnly 상태를 갱신하고 현재 모드로 재조회한다.
 * 전체/습지 두 모드 모두에서 동작한다(loadIssues가 negativeOnly면 negative=1을 붙인다).
 */
async function onNegativeFilterChange() {
  const checkbox = document.getElementById("negative-filter-checkbox");
  negativeOnly = checkbox.checked;
  await loadIssues();
}

/**
 * 패널 헤더(제목 + [전체 보기] 버튼 표시 여부)를 현재 viewMode에 맞게 갱신한다.
 */
function updatePanelHeader() {
  const titleEl = document.getElementById("panel-title");
  const showAllBtn = document.getElementById("panel-show-all-btn");
  const clearBtn = document.getElementById("wetland-clear-btn");
  const editBtn = document.getElementById("wetland-edit-btn");
  const locBtn = document.getElementById("wetland-loc-btn");

  // 헤더를 다시 그릴 때 이름/위치 수정 모드는 항상 종료 상태로 되돌린다.
  document.getElementById("wetland-name-edit").hidden = true;
  titleEl.hidden = false;
  endLocationEdit();

  if (viewMode === "wetland" && currentWetland) {
    titleEl.textContent = currentWetland.name;
    clearBtn.hidden = false;
    editBtn.hidden = false; // 습지 모드에서만 이름(✏️)/위치(📍) 수정 가능
    locBtn.hidden = false;
  } else {
    titleEl.textContent = "전체 최신 뉴스";
    clearBtn.hidden = true;
    editBtn.hidden = true;
    locBtn.hidden = true;
  }

  // [전체 보기]는 항상 노출한다 — 어느 상태(습지 선택/✕로 해제 후 확대된 지도 등)에서든
  // 지도를 전국 화면으로 되돌리고 전체 뉴스로 볼 수 있게 한다.
  showAllBtn.hidden = false;

  // 로드뷰 버튼은 카카오 키가 있고 습지 모드일 때만 노출된다(모드 전환마다 재평가).
  updateRoadviewButtonVisibility();
}

/**
 * 현재 viewMode/currentSort/filterState에 맞춰 GET /api/issues를 호출하고 패널에 렌더링한다.
 * "wetland" 모드면 wetland_id를 붙이고, "all" 모드면 붙이지 않는다(전체 조회).
 */
async function loadIssues() {
  const content = document.getElementById("panel-content");
  content.innerHTML = `<div class="panel-loading">뉴스를 불러오는 중...</div>`;

  const params = buildIssueFilterParams();
  params.set("sort", currentSort);

  try {
    const res = await fetch(`/api/issues?${params.toString()}`);
    const issues = await res.json();
    renderIssueList(content, issues);
  } catch (err) {
    content.querySelector(".panel-loading").textContent = "뉴스를 불러오지 못했습니다.";
    console.error("뉴스 목록을 불러오는 중 오류가 발생했습니다.", err);
  }

  // 목록과 동일한 조건으로 현황 인포(개수 + 기간)도 함께 갱신한다.
  loadStats();
}

/**
 * 현재 보기(습지/전체)·기간·부정 필터에 해당하는 뉴스 조회 파라미터를 만든다(정렬 제외).
 * loadIssues(목록)와 loadStats(현황 인포)가 같은 필터를 쓰도록 공용화한다.
 * @returns {URLSearchParams}
 */
function buildIssueFilterParams() {
  const params = new URLSearchParams();
  if (viewMode === "wetland" && currentWetland) {
    params.set("wetland_id", currentWetland.id);
  }
  if (filterState.from) params.set("from", filterState.from);
  if (filterState.to) params.set("to", filterState.to);
  if (negativeOnly) params.set("negative", "1");
  return params;
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
  const negativeBtnLabel = Number(issue.is_negative) === 1 ? "부정 해제" : "부정 지정";
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
      <span class="issue-negative-badge">${negativeBadgeHtml(issue.is_negative)}</span>
      <span class="issue-status-badge">${statusBadgeHtml(issue.status)}</span>
    </div>
    <div class="issue-actions">
      <button type="button" class="issue-action-btn issue-action-confirm">${confirmBtnLabel}</button>
      <button type="button" class="issue-action-btn issue-action-negative">${negativeBtnLabel}</button>
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
  li.querySelector(".issue-action-negative").addEventListener("click", () => onNegativeToggleClick(issue, li));
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
  flyToWetland(wetland);
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
 * [부정 지정]/[부정 해제] 토글 버튼 클릭 핸들러: is_negative를 1 <-> 0 으로 전환한다.
 * 성공 시 뱃지/버튼 라벨을 즉시 갱신하고, loadWetlands()로 마커의 부정 건수도 다시 반영한다.
 * @param {object} issue
 * @param {HTMLLIElement} li
 */
async function onNegativeToggleClick(issue, li) {
  const nextNegative = Number(issue.is_negative) === 1 ? 0 : 1;
  const btn = li.querySelector(".issue-action-negative");
  btn.disabled = true;

  try {
    const updated = await patchIssue(issue.id, { is_negative: nextNegative });
    issue.is_negative = updated.is_negative;
    issue.negative_source = updated.negative_source;

    li.querySelector(".issue-negative-badge").innerHTML = negativeBadgeHtml(updated.is_negative);
    btn.textContent = Number(updated.is_negative) === 1 ? "부정 해제" : "부정 지정";
    await loadWetlands();
  } catch (err) {
    showToast(`부정 지정 변경에 실패했습니다: ${err.message}`, true);
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
  hideFreshnessLabel();

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

/** 수집 완료 후 이 시간(12시간)이 지나기 전에는 접속 시 자동 수집을 돌리지 않는다. */
const FRESHNESS_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * 페이지 로드 시 뉴스 신선도를 확인한다.
 * - 이미 수집이 돌고 있으면: 진행률 폴링에 합류한다(다른 직원이 돌린 것도 보임).
 * - 마지막 수집 완료가 12시간 이내면: 아무것도 돌리지 않고 "최신 확인" 표시만 남긴다.
 * - 12시간이 지났으면: 자동으로 한 바퀴만 수집하고, 끝나면 스스로 멈춘다.
 */
async function ensureFreshNews() {
  try {
    const res = await fetch("/api/collect/status");
    const status = await res.json();

    if (status && status.running === 1) {
      enterCollectingMode(status);
      return;
    }

    const lastMs = parseUtcDbTime(status && status.updated_at);
    if (lastMs && Date.now() - lastMs < FRESHNESS_MAX_AGE_MS) {
      // 충분히 최신 — 수집을 돌리지 않고 확인 시각만 표시한다.
      setFreshnessLabel(lastMs);
      return;
    }

    // 오래됐으면 자동으로 한 바퀴 수집(완료되면 스스로 멈추고 확인 완료 표시로 전환).
    await fetch("/api/collect", { method: "POST" });
    enterCollectingMode(null);
  } catch (err) {
    // 상태 조회 실패는 무시(수집 안 하는 상태로 간주).
    console.error("수집 상태 확인 실패:", err);
  }
}

/**
 * 수집 진행 UI로 전환하고 폴링을 시작한다.
 * @param {object|null} status 이미 알고 있는 진행 상태(없으면 폴링이 곧 채움)
 */
function enterCollectingMode(status) {
  document.getElementById("collect-btn").disabled = true;
  setCollectButtonBusy(true);
  if (status) updateCollectProgressLabel(status);
  hideFreshnessLabel();
  startCollectPolling();
}

/**
 * DB의 UTC "YYYY-MM-DD HH:MM:SS" 문자열을 ms 타임스탬프로 변환한다(실패 시 null).
 * @param {string|null|undefined} value
 * @returns {number|null}
 */
function parseUtcDbTime(value) {
  if (!value) return null;
  const ms = Date.parse(`${value.replace(" ", "T")}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * 버튼 옆 "최신 확인: ..." 안심 표시를 갱신한다 — 지금은 수집이 돌고 있지 않고,
 * 언제 마지막으로 확인했는지를 보여준다.
 * @param {number} lastMs 마지막 수집 완료 시각(ms)
 */
function setFreshnessLabel(lastMs) {
  const el = document.getElementById("collect-freshness");
  const diffMin = Math.floor((Date.now() - lastMs) / 60000);

  let when;
  if (diffMin < 1) when = "방금 전";
  else if (diffMin < 60) when = `${diffMin}분 전`;
  else if (diffMin < 24 * 60) when = `${Math.floor(diffMin / 60)}시간 전`;
  else {
    const d = new Date(lastMs);
    when = `${d.getMonth() + 1}월 ${d.getDate()}일`;
  }

  el.textContent = `최신 확인: ${when}`;
  el.hidden = false;
}

function hideFreshnessLabel() {
  document.getElementById("collect-freshness").hidden = true;
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
        setFreshnessLabel(Date.now()); // 방금 확인 완료 — 더 이상 돌지 않음을 표시
        await loadWetlands();
        const collected = status ? status.collected : 0;
        showToast(`뉴스 ${collected.toLocaleString("ko-KR")}건 수집 완료`);
        return;
      }

      updateCollectProgressLabel(status);

      // 브라우저가 릴레이의 '다음 배치'를 직접 깨운다. 서버 내부 자기연쇄는 중첩 깊이
      // 제한으로 끊길 수 있지만(5분 cron이 재개), 브라우저에서 보내는 이 요청은 매번
      // 새로운 최상위 요청이라 제한이 없어 수집이 끊김 없이 이어진다.
      // 서버는 running=1일 때만 배치를 실행하고(아니면 204), 커서 낙관적 잠금이 있어
      // cron·체인과 겹쳐도 안전하다. 실패는 무시(다음 폴링 틱이 다시 시도).
      fetch("/api/collect/continue", { method: "POST" }).catch(() => {});
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
  flyToWetland(wetland);
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
 * 접속 시 filterState가 비어 있으면 기본으로 "최근 7일"(오늘-6일 ~ 오늘, 로컬 날짜 기준)을
 * 적용한다. 날짜 input에도 값을 채우고 상태 배지를 갱신한다. loadWetlands()/loadIssues()는
 * filterState를 그대로 참조하므로 이후 호출부터 자연히 7일 범위로 동작한다.
 * (이미 filterState에 값이 있으면 — 예: 향후 URL 파라미터 등으로 설정된 경우 — 건드리지 않는다.)
 */
function applyDefaultDateFilterIfEmpty() {
  if (filterState.from || filterState.to) return;

  const today = new Date();
  const sixDaysAgo = new Date(today);
  sixDaysAgo.setDate(today.getDate() - 6);

  filterState.from = toLocalDateString(sixDaysAgo);
  filterState.to = toLocalDateString(today);

  document.getElementById("date-filter-from").value = filterState.from;
  document.getElementById("date-filter-to").value = filterState.to;

  updateDateFilterStatus();
}

/**
 * Date 객체를 로컬 시간대 기준 "YYYY-MM-DD" 문자열로 변환한다.
 * (Date.prototype.toISOString()은 UTC 기준이라 자정 근처에 날짜가 하루 어긋날 수 있어 미사용.)
 * @param {Date} date
 * @returns {string}
 */
function toLocalDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * 날짜 기간 필터 컨트롤([적용]/[해제])의 이벤트를 초기화한다.
 */
function initDateFilter() {
  const applyBtn = document.getElementById("date-filter-apply-btn");
  const clearBtn = document.getElementById("date-filter-clear-btn");

  applyBtn.addEventListener("click", onDateFilterApplyClick);
  clearBtn.addEventListener("click", onDateFilterClearClick);

  // 빠른 기간 버튼([1일]/[3일]/[1주]/[1달]): 누르면 즉시 해당 기간을 적용한다.
  for (const btn of document.querySelectorAll(".date-filter-preset-btn")) {
    btn.addEventListener("click", () => applyPresetRange(Number(btn.dataset.days)));
  }
}

/**
 * 오늘까지 최근 N일을 기간으로 설정하고 즉시 적용한다(빠른 기간 버튼용).
 * @param {number} days 1(오늘만)/3/7/30 등
 */
async function applyPresetRange(days) {
  const today = new Date();
  const from = new Date();
  from.setDate(today.getDate() - (days - 1));

  document.getElementById("date-filter-from").value = toLocalDateString(from);
  document.getElementById("date-filter-to").value = toLocalDateString(today);

  await onDateFilterApplyClick();
}

/**
 * 현재 filterState가 빠른 기간 버튼 중 하나와 정확히 일치하면 해당 버튼을 강조한다.
 * (기본 7일 필터로 시작하면 [1주]가 자동으로 강조된다.)
 */
function updatePresetHighlight() {
  const todayStr = toLocalDateString(new Date());

  for (const btn of document.querySelectorAll(".date-filter-preset-btn")) {
    const days = Number(btn.dataset.days);
    const from = new Date();
    from.setDate(from.getDate() - (days - 1));
    const matches = filterState.to === todayStr && filterState.from === toLocalDateString(from);
    btn.classList.toggle("date-filter-preset-btn--active", matches);
  }
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

  updatePresetHighlight();

  if (!filterState.from && !filterState.to) {
    statusEl.hidden = true;
    statusEl.textContent = "";
    statusEl.title = "";
    dateFilterEl.classList.remove("date-filter--active");
    return;
  }

  // 헤더 안 인라인 표시라 공간이 좁으므로 짧은 형식(M/D)을 쓰고,
  // 마우스를 올리면 전체 날짜(연도 포함)를 툴팁으로 보여준다.
  const fromShort = filterState.from ? formatShortDate(filterState.from) : "처음";
  const toShort = filterState.to ? formatShortDate(filterState.to) : "현재";
  const fromFull = filterState.from ? formatFullDate(filterState.from) : "처음";
  const toFull = filterState.to ? formatFullDate(filterState.to) : "현재";

  statusEl.textContent = `${fromShort}~${toShort} 적용 중`;
  statusEl.title = `${fromFull} ~ ${toFull} 적용 중`;
  statusEl.hidden = false;
  dateFilterEl.classList.add("date-filter--active");
}

/**
 * "YYYY-MM-DD"를 짧은 "M/D" 형식으로 변환한다(올해가 아니면 "YYYY.M.D").
 * @param {string} dateStr
 * @returns {string}
 */
function formatShortDate(dateStr) {
  const parts = dateStr.split("-");
  if (parts.length !== 3) return dateStr;
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (year !== new Date().getFullYear()) return `${year}.${month}.${day}`;
  return `${month}/${day}`;
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

/* ------------------------------------------------------------------ */
/* 지도 설정 (서버 저장 키) · VWorld 레이어 · 카카오 로드뷰                   */
/* ------------------------------------------------------------------ */

/**
 * 앱 시작 시 GET /api/config로 저장된 지도 키를 불러와 mapConfig에 반영하고,
 * VWorld 레이어/카카오 로드뷰 버튼을 초기 구성한다. 실패해도 무료 3레이어는
 * 그대로 동작하므로 조용히 무시한다(콘솔 로그만 남김).
 */
async function loadMapConfig() {
  try {
    const res = await fetch("/api/config");
    mapConfig = (await res.json()) || {};
  } catch (err) {
    console.error("지도 설정을 불러오지 못했습니다.", err);
    mapConfig = {};
  }
  applyMapConfig();
}

/**
 * 현재 mapConfig에 맞춰 지도(현재 제공사 준비/재렌더)·로드뷰 버튼·설정 표시를 일괄 갱신한다.
 * loadMapConfig(초기)와 설정 저장 후 모두 이 함수를 호출해 새로고침 없이 반영한다.
 * (VWorld 키 유무는 OSM 어댑터의 supportsCadastral()이 그때그때 조회하므로 별도 레이어
 * 재구성 없이 ensureMapReady → updateMapControls만으로 지적편집도 버튼 활성 상태가 갱신된다.)
 */
function applyMapConfig() {
  updateRoadviewButtonVisibility();
  updateSettingsStatusLabels();
  // 현재 제공사로 지도를 준비/재렌더한다(키 저장 후 즉시 반영, 초기 로드 포함).
  ensureMapReady(!adapter().ready);
}

/**
 * 설정 패널(⚙) 열기/닫기 및 저장 버튼 이벤트를 초기화한다.
 * 지도 제공자 선택은 "🗺 지도" 드롭다운(initMapDropdown)이 정본이며, 이 모달은 API 키
 * 입력만 담당한다.
 */
function initMapSettingsPanel() {
  document.getElementById("map-settings-btn").addEventListener("click", openMapSettings);
  document.getElementById("map-settings-close-btn").addEventListener("click", closeMapSettings);
  document.getElementById("map-settings-overlay").addEventListener("click", (event) => {
    // 오버레이 배경(모달 바깥) 클릭 시 닫기.
    if (event.target === event.currentTarget) closeMapSettings();
  });

  document
    .getElementById("settings-vworld-save-btn")
    .addEventListener("click", () => saveConfigKey("vworld_key", "settings-vworld-key"));
  document
    .getElementById("settings-kakao-save-btn")
    .addEventListener("click", () => saveConfigKey("kakao_key", "settings-kakao-key"));
  document
    .getElementById("settings-google-save-btn")
    .addEventListener("click", () => saveConfigKey("google_key", "settings-google-key"));
  document
    .getElementById("settings-naver-save-btn")
    .addEventListener("click", () => saveConfigKey("naver_key", "settings-naver-key"));
}

/**
 * 설정 패널을 연다. 현재 저장된 키를 입력칸에 채우고 저장 여부 표시를 갱신한다.
 */
function openMapSettings() {
  document.getElementById("settings-vworld-key").value = mapConfig.vworld_key || "";
  document.getElementById("settings-kakao-key").value = mapConfig.kakao_key || "";
  document.getElementById("settings-google-key").value = mapConfig.google_key || "";
  document.getElementById("settings-naver-key").value = mapConfig.naver_key || "";
  updateSettingsStatusLabels();
  document.getElementById("map-settings-overlay").hidden = false;
}

function closeMapSettings() {
  document.getElementById("map-settings-overlay").hidden = true;
}

/**
 * 각 키의 "설정됨/미설정" 표시를 갱신한다.
 */
function updateSettingsStatusLabels() {
  setSettingsStatus("settings-vworld-status", Boolean((mapConfig.vworld_key || "").trim()));
  setSettingsStatus("settings-kakao-status", Boolean((mapConfig.kakao_key || "").trim()));
  setSettingsStatus("settings-google-status", Boolean((mapConfig.google_key || "").trim()));
  setSettingsStatus("settings-naver-status", Boolean((mapConfig.naver_key || "").trim()));
}

/**
 * 지도 제공자 select("🗺 지도" 드롭다운) 변경 핸들러: 현재 view(center/zoom)를 보존하고
 * 새 제공사로 전환한다. 이전 어댑터를 reset하고 State.provider를 갱신·localStorage 저장 후
 * ensureMapReady로 전환.
 */
async function onProviderChange() {
  const nextProvider = document.getElementById("map-dd-provider-select").value;
  if (nextProvider === State.provider) return;

  const prevAdapter = adapter();
  // 현재 center/zoom을 캡처해 새 제공사가 같은 위치로 열리게 한다.
  // 인증 실패 등으로 이전 지도(특히 네이버)가 깨져 있으면 getView()/reset()이 예외를
  // 던질 수 있는데, 그 예외가 전환 자체를 중단시켜 "다른 지도를 눌러도 안 바뀌는" 문제가
  // 생긴다. 따라서 이전 지도 정리는 실패해도 전환을 계속하도록 try/catch로 격리한다.
  try {
    State.pendingView = prevAdapter && prevAdapter.ready ? prevAdapter.getView() : null;
  } catch (e) {
    State.pendingView = null;
  }
  try {
    if (prevAdapter && prevAdapter.ready) prevAdapter.reset();
  } catch (e) {
    console.error("이전 지도 정리 중 오류(무시하고 전환 계속):", e);
  }

  State.provider = nextProvider;
  localStorage.setItem(PROVIDER_STORAGE_KEY, nextProvider);

  await ensureMapReady(false);
}

/**
 * @param {string} elementId 상태 표시 span id
 * @param {boolean} isSet 저장 여부
 */
function setSettingsStatus(elementId, isSet) {
  const el = document.getElementById(elementId);
  el.textContent = isSet ? "설정됨" : "미설정";
  el.classList.toggle("settings-status--on", isSet);
}

/**
 * 입력칸 값을 PUT /api/config로 저장하고, 성공 시 mapConfig를 갱신해 레이어/버튼을
 * 즉시 반영한다(페이지 새로고침 없음). 빈 값으로 저장하면 해당 키가 해제된다.
 * 실패는 토스트로 안내한다.
 * @param {string} key "vworld_key" 또는 "kakao_key"
 * @param {string} inputId 입력칸 id
 */
async function saveConfigKey(key, inputId) {
  const value = document.getElementById(inputId).value.trim();

  try {
    const res = await fetch("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ [key]: value }),
    });

    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const data = await res.json();
        if (data && data.error) message = data.error;
      } catch {
        // 기본 메시지 사용
      }
      throw new Error(message);
    }

    mapConfig = (await res.json()) || {};
    applyMapConfig();
    showToast(value ? "저장했습니다." : "해제했습니다.");
  } catch (err) {
    showToast(`저장에 실패했습니다: ${err.message}`, true);
  }
}

/**
 * geophoto 스타일 "🗺 지도 ▾" 드롭다운을 초기화한다. 지도 제공자 / 지도 종류 / 지적편집도
 * 토글 / API 키 설정 링크를 하나의 패널에 모아, 열기·닫기(바깥 클릭·ESC)와 각 컨트롤의
 * change/click 핸들러를 연결한다.
 */
function initMapDropdown() {
  const dd = document.getElementById("map-dd");
  const btn = document.getElementById("map-dd-btn");
  const panel = document.getElementById("map-dd-panel");

  function openDd() {
    panel.hidden = false;
    dd.classList.add("map-dd--open");
    btn.setAttribute("aria-expanded", "true");
  }
  function closeDd() {
    panel.hidden = true;
    dd.classList.remove("map-dd--open");
    btn.setAttribute("aria-expanded", "false");
  }

  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    if (panel.hidden) openDd();
    else closeDd();
  });
  document.addEventListener("click", (event) => {
    if (!panel.hidden && !dd.contains(event.target)) closeDd();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden) closeDd();
  });

  // 지도 제공자: 이 select가 정본(설정 모달의 옛 select는 제거됨). 변경 시 즉시 전환.
  const providerSelect = document.getElementById("map-dd-provider-select");
  providerSelect.value = State.provider;
  providerSelect.addEventListener("change", onProviderChange);

  // 지도 종류(모든 제공자 공통).
  const typeSelect = document.getElementById("map-type-select");
  typeSelect.value = State.mapType;
  typeSelect.addEventListener("change", () => {
    State.mapType = typeSelect.value;
    localStorage.setItem(MAP_TYPE_STORAGE_KEY, State.mapType);
    const a = adapter();
    if (a && a.ready) a.setMapType(State.mapType);
  });

  // 지적편집도 토글(지원 제공사만 활성 — updateMapControls가 disabled 상태를 관리).
  document.getElementById("cadastral-btn").addEventListener("click", () => {
    const a = adapter();
    if (!a || !a.ready || !a.supportsCadastral()) return;
    State.cadastral = !State.cadastral;
    a.setCadastral(State.cadastral);
    updateMapControls();
  });

  // 드롭다운 맨 아래 "⚙ API 키 설정" 링크 — 기존 설정 모달을 그대로 재사용해 연다.
  document.getElementById("map-dd-settings-btn").addEventListener("click", () => {
    closeDd();
    openMapSettings();
  });
}

/**
 * 지도 종류 select 값과 지적편집도 버튼(지원 여부/ON·OFF 상태)을 현재 State/어댑터에 맞춘다.
 */
function updateMapControls() {
  const typeSelect = document.getElementById("map-type-select");
  typeSelect.value = State.mapType;

  const btn = document.getElementById("cadastral-btn");
  const stateLabel = document.getElementById("cadastral-state");
  const a = adapter();
  const supported = Boolean(a && a.supportsCadastral());
  const on = supported && State.cadastral;

  btn.disabled = !supported;
  btn.setAttribute("aria-pressed", String(on));
  btn.classList.toggle("map-dd-item--on", on);
  if (stateLabel) stateLabel.textContent = on ? "ON" : "OFF";
}

/**
 * 로드뷰 버튼/모달 이벤트를 초기화한다.
 */
function initRoadview() {
  document.getElementById("roadview-btn").addEventListener("click", openRoadview);
  document.getElementById("roadview-close-btn").addEventListener("click", closeRoadview);
  document.getElementById("roadview-overlay").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeRoadview();
  });
}

/**
 * 로드뷰 버튼 표시 여부를 갱신한다.
 * 습지 모드(currentWetland 존재)면 항상 표시한다. 카카오 키가 있으면 앱 안 모달로,
 * 없으면 외부 카카오 지도 로드뷰(새 탭)로 열리므로 키가 없어도 동작한다.
 */
function updateRoadviewButtonVisibility() {
  const btn = document.getElementById("roadview-btn");
  btn.hidden = !(viewMode === "wetland" && currentWetland);
}

/**
 * 카카오 지도 SDK를 키가 있을 때만 동적으로 로드한다(이미 로드됐으면 재로드 금지).
 * @returns {Promise<void>} kakao.maps 준비 완료 시 resolve
 */
function loadKakaoSdk() {
  return new Promise((resolve, reject) => {
    if (kakaoSdkReady && window.kakao && window.kakao.maps) {
      resolve();
      return;
    }

    const key = (mapConfig.kakao_key || "").trim();
    if (!key) {
      reject(new Error("카카오 키가 설정되지 않았습니다."));
      return;
    }

    // 이미 스크립트 태그가 있으면(이전 로드 시도) 새로 추가하지 않고 load만 재호출.
    if (window.kakao && window.kakao.maps && typeof window.kakao.maps.load === "function") {
      window.kakao.maps.load(() => {
        kakaoSdkReady = true;
        resolve();
      });
      return;
    }

    const script = document.createElement("script");
    script.src = `//dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(key)}&libraries=&autoload=false`;
    script.onload = () => {
      window.kakao.maps.load(() => {
        kakaoSdkReady = true;
        resolve();
      });
    };
    script.onerror = () => reject(new Error("카카오 SDK 로드에 실패했습니다."));
    document.head.appendChild(script);
  });
}

/**
 * [로드뷰] 버튼 클릭 핸들러: 현재 선택된 습지 위치의 가장 가까운 파노라마를 조회해
 * 모달에 표시한다. 파노라마가 없으면 안내 후 모달을 닫는다. 전체 모드(currentWetland
 * 없음)면 아무것도 하지 않는다(버튼도 숨겨져 있음).
 */
async function openRoadview() {
  if (!currentWetland) return;

  // 카카오 키가 없으면 외부 카카오 지도 로드뷰를 새 탭으로 연다(API 키 불필요, 항상 동작).
  const hasKey = Boolean((mapConfig.kakao_key || "").trim());
  if (!hasKey) {
    window.open(
      `https://map.kakao.com/link/roadview/${currentWetland.lat},${currentWetland.lng}`,
      "_blank",
      "noopener"
    );
    return;
  }

  const overlay = document.getElementById("roadview-overlay");
  const container = document.getElementById("roadview-container");
  document.getElementById("roadview-title").textContent = `${currentWetland.name} 로드뷰`;

  try {
    await loadKakaoSdk();
  } catch (err) {
    // 임베드 로드뷰 실패 시 외부 로드뷰로 폴백.
    window.open(
      `https://map.kakao.com/link/roadview/${currentWetland.lat},${currentWetland.lng}`,
      "_blank",
      "noopener"
    );
    console.error("카카오 SDK 로드 실패 — 외부 로드뷰로 대체:", err);
    return;
  }

  overlay.hidden = false;
  container.innerHTML = "";

  const position = new window.kakao.maps.LatLng(currentWetland.lat, currentWetland.lng);
  const roadview = new window.kakao.maps.Roadview(container);
  const roadviewClient = new window.kakao.maps.RoadviewClient();

  // 가장 가까운 파노라마를 반경 50m 내에서 찾는다.
  roadviewClient.getNearestPanoId(position, 50, (panoId) => {
    if (panoId === null) {
      closeRoadview();
      showToast("이 위치는 로드뷰가 제공되지 않습니다.");
      return;
    }
    roadview.setPanoId(panoId, position);
    // 모달이 표시된 뒤 컨테이너 크기를 인식하도록 릴레이아웃.
    window.kakao.maps.event.addListener(roadview, "init", () => {
      roadview.relayout();
    });
  });
}

function closeRoadview() {
  const overlay = document.getElementById("roadview-overlay");
  overlay.hidden = true;
  document.getElementById("roadview-container").innerHTML = "";
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

/* ================================================================== */
/* 지도 제공사 어댑터 (gpsphoto 표준 시그니처 이식)                          */
/* 공통 인터페이스:                                                        */
/*   get ready, async ensureLoaded(), setMapType(type),                 */
/*   supportsCadastral(), setCadastral(on), fitKorea(),                 */
/*   flyToWetland(w, zoom), getView(), applyView(v), onViewChange(cb),  */
/*   clearWetlands(), renderWetlands(wetlands, onWetlandClick), reset() */
/* ================================================================== */

/**
 * 외부 지도 SDK 스크립트를 동적으로 로드한다(구글/네이버/카카오 전용, 불가피).
 * @param {string} src
 * @returns {Promise<void>}
 */
function loadMapScript(src, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    let settled = false;
    // 타임아웃: 잘못된 키·미등록 도메인 등으로 SDK 로드가 응답 없이 멈추면(프리즈) 무한
    // 대기하지 않고 실패 처리해, 호출부가 안내 오버레이를 띄우고 다른 지도로 전환할 수 있게 한다.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("지도 SDK 로드 시간 초과: " + src));
    }, timeoutMs);
    s.src = src;
    s.async = true;
    s.onload = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    s.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("스크립트 로드 실패: " + src));
    };
    document.head.appendChild(s);
  });
}

// 네이버 지도 SDK는 키/도메인 인증 실패 시 이 전역 콜백을 비동기로(때로는 반복) 호출한다.
// 이 콜백이 사용자가 다른 지도로 전환한 뒤에 뒤늦게 실행되면 OSM/VWorld/구글 지도 위에
// "네이버 인증 실패" 오버레이를 다시 덮어 "다른 지도가 로드되지 않는" 것처럼 보인다.
// 따라서 현재 제공사가 네이버일 때만 안내하고, 아니면 무시한다.
window.navermap_authFailure = function () {
  try {
    if (typeof State !== "undefined" && State.provider !== "naver") return;
    showMapOverlay("네이버 지도 인증 실패 — 키(ncpKeyId)와 등록 도메인을 확인하세요.");
  } catch (e) {
    /* showMapOverlay 준비 전이면 무시 */
  }
};

/**
 * native 제공사(구글/네이버/카카오)에서 습지 배지 마커에 쓸 HTML 엘리먼트를 만든다.
 * 기존 .wetland-marker 계열 CSS를 재사용해 OSM과 시각적 톤을 맞춘다.
 * issue_count>0인 습지만 배지(숫자)로, 0건은 회색 점(작게)으로 표시한다.
 * @param {number} issueCount
 * @param {number} negativeCount
 * @returns {{ el: HTMLElement, size: number }}
 */
function buildNativeBadgeEl(issueCount, negativeCount) {
  const count = Number(issueCount) || 0;
  const negative = Number(negativeCount) || 0;
  const el = document.createElement("div");

  if (count === 0) {
    el.className = "wetland-marker wetland-marker--empty";
    return { el, size: 14 };
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
  el.className = "wetland-marker " + sizeClass + (negative > 0 ? " wetland-marker--negative" : "");
  el.textContent = String(count);
  return { el, size };
}

/**
 * native 제공사에서 렌더할 습지를 추린다(사용자 합의: 상용 지도는 단순 표시).
 * issue_count>0 습지는 전부, 0건 습지는 성능/시야 정리를 위해 표시하지 않는다.
 * @param {Array<object>} wetlands
 * @returns {Array<object>}
 */
function selectNativeWetlands(wetlands) {
  return wetlands.filter((w) => (Number(w.issue_count) || 0) > 0);
}

/**
 * VWorld 지적편집도 WMS 오버레이 레이어를 만든다(필지 경계). OSM 어댑터가 지적편집도
 * 토글 ON일 때 현재 base 레이어 위에 얹는다.
 * @param {string} key VWorld API 키
 * @returns {L.TileLayer.WMS}
 */
function buildVworldCadastralLayer(key) {
  return L.tileLayer.wms("https://api.vworld.kr/req/wms", {
    layers: "lp_pa_cbnd_bubun",
    styles: "lp_pa_cbnd_bubun",
    format: "image/png",
    transparent: true,
    version: "1.3.0",
    uppercase: true,
    key,
    domain: window.location.origin,
    attribution: "&copy; VWorld, 국토교통부",
  });
}

/**
 * VWorld 배경지도 base 레이어(일반/위성/하이브리드)를 만든다. VWorld WMTS 타일은
 * 웹 메르카토르(EPSG:3857)라 Leaflet에 그대로 얹혀, OSM과 동일한 군집/라벨/검색 기능을
 * 그대로 쓴다. 반환 키는 buildFreeBaseLayers와 동일해 setMapType 로직을 공유한다.
 * @param {string} key VWorld API 키
 * @returns {Object<string, L.Layer>}
 */
function buildVworldBaseLayers(key) {
  const attribution = "&copy; VWorld, 국토교통부";
  const wmts = (layer, ext) =>
    L.tileLayer(`https://api.vworld.kr/req/wmts/1.0.0/${key}/${layer}/{z}/{y}/{x}.${ext}`, {
      maxZoom: 19,
      attribution,
    });

  const base = wmts("Base", "png");
  const satellite = wmts("Satellite", "jpeg");
  // 하이브리드: 위성 위에 지명/경계(Hybrid) 라벨 오버레이를 얹어 하나의 base로 묶는다.
  const hybrid = L.layerGroup([wmts("Satellite", "jpeg"), wmts("Hybrid", "png")]);

  return { "일반 지도": base, "위성 지도": satellite, "하이브리드": hybrid };
}

/* --- OSM(Leaflet) 어댑터 ---
 * 지도 종류(일반/위성/하이브리드)는 공통 select(State.mapType)로 buildFreeBaseLayers()의
 * 3개 base 레이어 중 하나를 교체 장착한다(제공사 공통 UX). 지적편집도는 VWorld 키가 있을
 * 때만 지원되며, 현재 base 레이어 위에 WMS 필지 경계 오버레이를 얹고 벗기는 방식으로 동작한다. */
function createLeafletAdapter(kind) {
  /** 현재 지도에 붙어 있는 base 레이어(일반/위성/하이브리드 중 하나). */
  let activeBaseLayer = null;
  /** 지적편집도 WMS 오버레이(지연 생성, VWorld 키 있을 때만). */
  let cadastralLayer = null;

  return {
    get ready() {
      return !!map;
    },
    async ensureLoaded() {
      // VWorld 제공자는 VWorld 키가 있어야 base 타일을 받을 수 있다(키 없으면 안내 오버레이).
      let baseLayers;
      if (kind === "vworld") {
        const key = (mapConfig.vworld_key || "").trim();
        if (!key) throw new NoKeyError("vworld");
        baseLayers = buildVworldBaseLayers(key);
      } else {
        baseLayers = buildFreeBaseLayers();
      }

      // #map 안에 깨끗한 컨테이너를 만들고 그 위에 Leaflet 지도를 생성한다.
      // 지도에 maxZoom을 직접 지정해, base 레이어 부착 타이밍과 무관하게
      // L.markerClusterGroup 생성 시 항상 maxZoom을 알 수 있게 한다
      // ("Map has no maxZoom specified" 오류 방지).
      const el = prepareMapContainer();
      map = L.map(el, { maxZoom: 19, minZoom: 3 }).setView(DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM);

      baseLayerMap = baseLayers;
      activeBaseLayer = null;
      cadastralLayer = null;

      // L.markerClusterGroup은 생성 시 map.getMaxZoom()을 읽으므로, base 타일 레이어를
      // 먼저 붙여 지도가 maxZoom을 알 수 있게 한 뒤에 클러스터 그룹을 만든다("Map has no
      // maxZoom specified" 오류 방지). ensureMapReady가 뒤이어 setMapType을 다시 호출해도
      // 같은 레이어면 조기 반환하므로 중복 부작용은 없다.
      this.setMapType(State.mapType);

      markersLayer = L.markerClusterGroup({
        chunkedLoading: true,
        maxClusterRadius: 50,
        spiderfyOnMaxZoom: true,
        disableClusteringAtZoom: CLUSTER_DISABLE_ZOOM,
        iconCreateFunction: buildClusterIcon,
      }).addTo(map);

      setTimeout(() => {
        if (map) map.invalidateSize();
      }, 0);
    },
    setMapType(t) {
      if (!map) return;
      const layerName = { roadmap: "일반 지도", satellite: "위성 지도", hybrid: "하이브리드" }[t] || "일반 지도";
      const nextLayer = baseLayerMap[layerName];
      if (!nextLayer || nextLayer === activeBaseLayer) return;

      if (activeBaseLayer && map.hasLayer(activeBaseLayer)) map.removeLayer(activeBaseLayer);
      nextLayer.addTo(map);
      activeBaseLayer = nextLayer;

      // 새 base 레이어가 나중에 추가되며 지적편집도 오버레이를 덮을 수 있으므로 다시 맨 위로.
      if (cadastralLayer && map.hasLayer(cadastralLayer)) cadastralLayer.bringToFront();
    },
    supportsCadastral() {
      // VWorld 제공자는 항상, 무료(OSM)는 VWorld 키가 있을 때만 지적편집도 오버레이를 지원한다.
      return kind === "vworld" || Boolean((mapConfig.vworld_key || "").trim());
    },
    setCadastral(on) {
      if (!map) return;
      const key = (mapConfig.vworld_key || "").trim();
      if (!key) return;

      if (on) {
        if (!cadastralLayer) cadastralLayer = buildVworldCadastralLayer(key);
        if (!map.hasLayer(cadastralLayer)) cadastralLayer.addTo(map);
        cadastralLayer.bringToFront();
      } else if (cadastralLayer && map.hasLayer(cadastralLayer)) {
        map.removeLayer(cadastralLayer);
      }
    },
    fitKorea() {
      if (map) map.flyTo(DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM);
    },
    flyToWetland(w, zoom) {
      if (map) map.flyTo([w.lat, w.lng], zoom || CLUSTER_DISABLE_ZOOM);
    },
    getView() {
      if (!map) return null;
      const c = map.getCenter();
      return { lat: c.lat, lng: c.lng, zoom: map.getZoom() };
    },
    applyView(v) {
      if (map && v) map.setView([v.lat, v.lng], Math.round(v.zoom), { animate: false });
    },
    onViewChange() {},
    clearWetlands() {
      if (markersLayer) markersLayer.clearLayers();
    },
    renderWetlands(wetlands) {
      renderMarkersOsm(wetlands);
    },
    reset() {
      // 다른 제공사로 전환 시 Leaflet 인스턴스를 완전히 파기한다(컨테이너는 전환 시 교체됨).
      if (map) {
        try {
          map.remove();
        } catch (e) {
          /* 이미 제거된 경우 무시 */
        }
      }
      map = null;
      markersLayer = null;
      baseLayerMap = {};
      activeBaseLayer = null;
      cadastralLayer = null;
      markerByWetlandId.clear();
    },
  };
}

/* --- 구글 어댑터 --- */
function createGoogleAdapter() {
  let gmap = null;
  let loaded = false;
  let markers = [];
  return {
    get ready() {
      return !!gmap;
    },
    async ensureLoaded() {
      const key = (mapConfig.google_key || "").trim();
      if (!key) throw new NoKeyError("google");
      if (!loaded) {
        await new Promise((res, rej) => {
          window.__wetlandGmapReady = () => res();
          loadMapScript(
            `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&callback=__wetlandGmapReady`
          ).catch(rej);
        });
        loaded = true;
      }
      const el = prepareMapContainer();
      gmap = new google.maps.Map(el, {
        center: { lat: DEFAULT_MAP_CENTER[0], lng: DEFAULT_MAP_CENTER[1] },
        zoom: DEFAULT_MAP_ZOOM,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: false,
      });
    },
    setMapType(t) {
      if (gmap) gmap.setMapTypeId({ roadmap: "roadmap", satellite: "satellite", hybrid: "hybrid" }[t] || "roadmap");
    },
    supportsCadastral() {
      return false; // 구글은 지적편집도 미지원
    },
    setCadastral() {},
    fitKorea() {
      if (gmap) {
        gmap.setCenter({ lat: DEFAULT_MAP_CENTER[0], lng: DEFAULT_MAP_CENTER[1] });
        gmap.setZoom(DEFAULT_MAP_ZOOM);
      }
    },
    flyToWetland(w, zoom) {
      if (gmap) {
        gmap.panTo({ lat: w.lat, lng: w.lng });
        gmap.setZoom(zoom || CLUSTER_DISABLE_ZOOM);
      }
    },
    getView() {
      if (!gmap) return null;
      const c = gmap.getCenter();
      return { lat: c.lat(), lng: c.lng(), zoom: gmap.getZoom() };
    },
    applyView(v) {
      if (gmap && v) {
        gmap.setCenter({ lat: v.lat, lng: v.lng });
        gmap.setZoom(Math.round(v.zoom));
      }
    },
    onViewChange() {},
    clearWetlands() {
      markers.forEach((m) => m.setMap(null));
      markers = [];
    },
    renderWetlands(wetlands, onWetlandClick) {
      this.clearWetlands();
      for (const w of selectNativeWetlands(wetlands)) {
        const { el } = buildNativeBadgeEl(w.issue_count, w.negative_count);
        // 구글 AdvancedMarkerElement 없이도 동작하도록 OverlayView 대신 표준 Marker + label 사용은
        // 스타일 제약이 있어, HTML 배지는 커스텀 오버레이로 렌더한다.
        const overlay = makeGoogleHtmlMarker(gmap, w, el, () => onWetlandClick(w));
        markers.push(overlay);
      }
    },
    reset() {
      this.clearWetlands();
      gmap = null;
    },
  };
}

/**
 * 구글 지도에 HTML 콘텐츠(배지) 마커를 올리기 위한 OverlayView 팩토리.
 * (구글 기본 Marker는 임의 HTML/CSS 배지를 지원하지 않으므로 OverlayView로 직접 배치한다.)
 * @param {google.maps.Map} gmap
 * @param {object} w 습지
 * @param {HTMLElement} el 배지 엘리먼트
 * @param {Function} onClick
 * @returns {google.maps.OverlayView}
 */
function makeGoogleHtmlMarker(gmap, w, el, onClick) {
  const overlay = new google.maps.OverlayView();
  el.style.position = "absolute";
  el.style.transform = "translate(-50%, -50%)";
  el.style.cursor = "pointer";
  el.addEventListener("click", onClick);
  overlay.onAdd = function () {
    this.getPanes().overlayMouseTarget.appendChild(el);
  };
  overlay.draw = function () {
    const proj = this.getProjection();
    if (!proj) return;
    const pos = proj.fromLatLngToDivPixel(new google.maps.LatLng(w.lat, w.lng));
    if (pos) {
      el.style.left = pos.x + "px";
      el.style.top = pos.y + "px";
    }
  };
  overlay.onRemove = function () {
    if (el.parentNode) el.parentNode.removeChild(el);
  };
  overlay.setMap(gmap);
  return overlay;
}

/* --- 네이버 어댑터 --- */
function createNaverAdapter() {
  let nmap = null;
  let loaded = false;
  let markers = [];
  let cadastralLayer = null;
  return {
    get ready() {
      return !!nmap;
    },
    async ensureLoaded() {
      const key = (mapConfig.naver_key || "").trim();
      if (!key) throw new NoKeyError("naver");
      if (!loaded) {
        // 신규 NCP 콘솔(2024+) 키는 ncpKeyId 파라미터로 인증한다(gpsphoto와 동일 방식).
        await loadMapScript(`https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${encodeURIComponent(key)}`);
        loaded = true;
      }
      if (!(window.naver && naver.maps)) {
        // 다음 시도(키 수정 후)에서 재로드하도록 상태를 되돌린다.
        loaded = false;
        throw new Error("네이버 지도 SDK 로드 실패 — 키(ncpKeyId)와 등록 도메인을 확인하세요.");
      }
      const el = prepareMapContainer();
      nmap = new naver.maps.Map(el, {
        center: new naver.maps.LatLng(DEFAULT_MAP_CENTER[0], DEFAULT_MAP_CENTER[1]),
        zoom: DEFAULT_MAP_ZOOM,
      });
    },
    setMapType(t) {
      if (!nmap) return;
      const M = naver.maps.MapTypeId;
      nmap.setMapTypeId({ roadmap: M.NORMAL, satellite: M.SATELLITE, hybrid: M.HYBRID }[t] || M.NORMAL);
    },
    supportsCadastral() {
      return true;
    },
    setCadastral(on) {
      if (!nmap) return;
      if (on) {
        if (!cadastralLayer) cadastralLayer = new naver.maps.CadastralLayer();
        cadastralLayer.setMap(nmap);
      } else if (cadastralLayer) {
        cadastralLayer.setMap(null);
      }
    },
    fitKorea() {
      if (nmap) {
        nmap.setCenter(new naver.maps.LatLng(DEFAULT_MAP_CENTER[0], DEFAULT_MAP_CENTER[1]));
        nmap.setZoom(DEFAULT_MAP_ZOOM);
      }
    },
    flyToWetland(w, zoom) {
      if (nmap) {
        nmap.panTo(new naver.maps.LatLng(w.lat, w.lng));
        nmap.setZoom(zoom || CLUSTER_DISABLE_ZOOM);
      }
    },
    getView() {
      if (!nmap) return null;
      const c = nmap.getCenter();
      return { lat: c.lat(), lng: c.lng(), zoom: nmap.getZoom() };
    },
    applyView(v) {
      if (nmap && v) {
        nmap.setCenter(new naver.maps.LatLng(v.lat, v.lng));
        nmap.setZoom(Math.round(v.zoom));
      }
    },
    onViewChange() {},
    clearWetlands() {
      markers.forEach((m) => m.setMap(null));
      markers = [];
    },
    renderWetlands(wetlands, onWetlandClick) {
      this.clearWetlands();
      for (const w of selectNativeWetlands(wetlands)) {
        const { el, size } = buildNativeBadgeEl(w.issue_count, w.negative_count);
        el.style.cursor = "pointer";
        const m = new naver.maps.Marker({
          position: new naver.maps.LatLng(w.lat, w.lng),
          map: nmap,
          icon: { content: el, anchor: new naver.maps.Point(size / 2, size / 2) },
        });
        naver.maps.Event.addListener(m, "click", () => onWetlandClick(w));
        markers.push(m);
      }
    },
    reset() {
      this.clearWetlands();
      cadastralLayer = null;
      nmap = null;
    },
  };
}

/* --- 카카오 어댑터 --- */
function createKakaoAdapter() {
  let kmap = null;
  let loaded = false;
  let markers = [];
  return {
    get ready() {
      return !!kmap;
    },
    async ensureLoaded() {
      const key = (mapConfig.kakao_key || "").trim();
      if (!key) throw new NoKeyError("kakao");
      if (!loaded) {
        await loadMapScript(`https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(key)}&autoload=false`);
        await new Promise((res) => kakao.maps.load(res));
        loaded = true;
      }
      const el = prepareMapContainer();
      // 카카오 level은 값이 클수록 축소 — 전국 뷰는 level 12 정도.
      kmap = new kakao.maps.Map(el, {
        center: new kakao.maps.LatLng(DEFAULT_MAP_CENTER[0], DEFAULT_MAP_CENTER[1]),
        level: 12,
      });
      setTimeout(() => {
        if (kmap) kmap.relayout();
      }, 0);
    },
    setMapType(t) {
      if (!kmap) return;
      const M = kakao.maps.MapTypeId;
      kmap.setMapTypeId({ roadmap: M.ROADMAP, satellite: M.SKYVIEW, hybrid: M.HYBRID }[t] || M.ROADMAP);
    },
    supportsCadastral() {
      return true;
    },
    setCadastral(on) {
      if (!kmap) return;
      const T = kakao.maps.MapTypeId.USE_DISTRICT; // 지적편집도
      if (on) kmap.addOverlayMapTypeId(T);
      else kmap.removeOverlayMapTypeId(T);
    },
    fitKorea() {
      if (kmap) {
        kmap.setCenter(new kakao.maps.LatLng(DEFAULT_MAP_CENTER[0], DEFAULT_MAP_CENTER[1]));
        kmap.setLevel(12);
      }
    },
    flyToWetland(w, zoom) {
      if (kmap) {
        // 공통 zoom(레플릿 기준 12 부근)을 카카오 level로 근사 변환(21 - zoom).
        const level = Math.max(1, Math.min(14, Math.round(21 - (zoom || CLUSTER_DISABLE_ZOOM))));
        kmap.setLevel(level);
        kmap.panTo(new kakao.maps.LatLng(w.lat, w.lng));
      }
    },
    getView() {
      if (!kmap) return null;
      const c = kmap.getCenter();
      return { lat: c.getLat(), lng: c.getLng(), zoom: 21 - kmap.getLevel() };
    },
    applyView(v) {
      if (kmap && v) {
        kmap.setLevel(Math.max(1, Math.min(14, Math.round(21 - v.zoom))));
        kmap.setCenter(new kakao.maps.LatLng(v.lat, v.lng));
      }
    },
    onViewChange() {},
    clearWetlands() {
      markers.forEach((m) => m.setMap(null));
      markers = [];
    },
    renderWetlands(wetlands, onWetlandClick) {
      this.clearWetlands();
      for (const w of selectNativeWetlands(wetlands)) {
        const { el } = buildNativeBadgeEl(w.issue_count, w.negative_count);
        el.style.cursor = "pointer";
        el.addEventListener("click", () => onWetlandClick(w));
        const ov = new kakao.maps.CustomOverlay({
          position: new kakao.maps.LatLng(w.lat, w.lng),
          content: el,
          xAnchor: 0.5,
          yAnchor: 0.5,
          zIndex: 10,
        });
        ov.setMap(kmap);
        markers.push(ov);
      }
    },
    reset() {
      this.clearWetlands();
      kmap = null;
    },
  };
}
