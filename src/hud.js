// src/hud.js
// DOM 오버레이 HUD: 랩/순위/아이템/속도/타임, 카운트다운, 타이틀, 결과 패널.
// 계약(CONTRACTS.md)에 명시된 export만 제공. 다른 모듈은 import하지 않음.
//
// v5 변경점
//  - 드리프트 게이지 제거. kart.cornerCharge(0..3) / kart.chargeRatio(0..1) 기반 '코너 차지' 게이지로 교체.
//  - 아이템 아이콘: 이모지 → 인라인 SVG(itemIconSVG). 폰트 의존/로드 실패 경로가 없다.
//  - 메뉴 포커스 박스: setTitleFocus / setResultsFocus (WASD 4키 조작에 대응하는 시각 표시).
//
// v6 변경점
//  - 아이템전 전용화: 게임 모드 UI(setGameMode / 모드 행 / 모드 CSS) 제거. 타이틀 포커스 항목은 맵 하나뿐이다.
//  - 결과 화면 자동 복귀 잔여시간 표시: setResultsTimeout(sec) 추가(RESULTS 제목과 기록 목록 사이).

// 아이템 아이콘 — 24×24 viewBox 인라인 SVG. fill="currentColor"라 부모의 color가 그대로 주 색이 된다.
// 이모지를 쓰지 않는 이유: 폰트마다 모양이 달라지고, 크기/정렬을 CSS로 제어할 수 없다.
function itemIconSVG(key, size = 24) {
  const s = Math.round(size);
  const open = `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="currentColor" aria-hidden="true" focusable="false">`;
  let body;
  switch (key) {
    case 'mushroom':
      body = '<path d="M2,13 A10,9 0 0 1 22,13 Z"/>' +
             '<rect x="9" y="13" width="6" height="8" rx="2" fill="#f2e8d5"/>';
      break;
    case 'shell':
      body = '<path d="M3,15 A9,8 0 0 1 21,15 Z"/>' +
             '<rect x="3" y="15" width="18" height="4" rx="2" fill="#e8d9a0"/>' +
             '<g stroke="rgba(0,0,0,.25)" stroke-width="1" fill="none">' +
             '<path d="M12,7 L12,15"/><path d="M6.2,11.2 L12,12.4"/><path d="M17.8,11.2 L12,12.4"/></g>';
      break;
    case 'banana':
      body = '<path d="M4,18 C6,8 14,3 20,5 C16,6 9,11 8,19 Z"/>' +
             '<rect x="19" y="3.5" width="2.4" height="2.4" rx="1" fill="#6b4a1e"/>';
      break;
    case 'star':
      body = '<polygon points="12,2 15,9 22,9.5 16.5,14 18.5,21 12,17.2 5.5,21 7.5,14 2,9.5 9,9"/>';
      break;
    case 'balloon':
      body = '<path d="M12,3 C16,9 19,12 19,15.5 A7,7 0 0 1 5,15.5 C5,12 8,9 12,3 Z"/>' +
             '<ellipse cx="9.5" cy="14" rx="1.6" ry="2.4" fill="rgba(255,255,255,.55)"/>';
      break;
    default:
      // 미지의 키: '?' 대신 빈 사각 테두리. 레이아웃이 흔들리지 않는다.
      body = '<rect x="3" y="3" width="18" height="18" rx="4" fill="none" stroke="currentColor" stroke-width="2" opacity="0.6"/>';
      break;
  }
  return open + body + '</svg>';
}

// 아이템 설명 — 타이틀 가이드와 사용 토스트가 같은 출처를 쓴다.
// desc는 확정 문구(그대로 유지). short는 수치 요약 pill.
// 주의: 스타의 "부딪힌 쪽이 튕겨 나간다"는 코드상 상대 kart.spin()(1초 스핀)이다. 문구는 확정본이라 그대로 둔다.
const ITEM_INFO = {
  mushroom: { name: '버섯',   color: '#e8593a', short: '1.2초',      desc: '짧고 강한 가속' },
  shell:    { name: '등껍질', color: '#3fa85a', short: '전방 발사',  desc: '정면으로 날아가 상대를 돌려세운다' },
  banana:   { name: '바나나', color: '#e8b23a', short: '설치',      desc: '뒤에 놓아 추격자를 노린다' },
  star:     { name: '스타',   color: '#f2d14b', short: '5초',       desc: '잠시 무적. 부딪힌 쪽이 튕겨 나간다' },
  balloon:  { name: '물풍선', color: '#3fb6e8', short: '8초 웅덩이', desc: '바닥을 적신다. 밟으면 접지를 잃는다' },
};
const ITEM_ORDER = ['mushroom', 'shell', 'banana', 'star', 'balloon'];

// 코너 차지 티어별 게이지 색(1/2/3).
const CHARGE_COLORS = ['#ffe066', '#ff8c00', '#ff2d55'];

function el(tag, className, parent) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (parent) parent.appendChild(e);
  return e;
}

function fmtTime(sec) {
  if (sec == null || !isFinite(sec)) return '--:--.--';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

const STYLE = `
.hud-root {
  position: fixed;
  inset: 0;
  pointer-events: none;
  font-family: 'Segoe UI', Arial, sans-serif;
  color: #fff;
  z-index: 100;
  user-select: none;
}
.hud-corner {
  position: absolute;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 16px;
  background: rgba(10, 12, 20, 0.45);
  backdrop-filter: blur(4px);
  border-radius: 12px;
  border: 1px solid rgba(255,255,255,0.12);
  box-shadow: 0 4px 18px rgba(0,0,0,0.35);
  min-width: 150px;
  transition: left 0.3s ease, right 0.3s ease, top 0.3s ease;
}
.hud-corner .name-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 700;
  font-size: 15px;
}
.hud-corner .color-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  box-shadow: 0 0 6px currentColor;
}
.hud-corner .rank {
  font-size: 22px;
  font-weight: 900;
  letter-spacing: 0.5px;
  text-shadow: 0 2px 6px rgba(0,0,0,0.6);
  font-family: 'Kenney Future', 'Segoe UI', Arial, sans-serif;
}
.hud-corner .lap {
  font-size: 13px;
  opacity: 0.85;
  font-family: 'Kenney Future', 'Segoe UI', Arial, sans-serif;
}
.hud-corner .stat-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
  gap: 10px;
}
.hud-corner .speed {
  font-size: 20px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  font-family: 'Kenney Future', 'Segoe UI', Arial, sans-serif;
}
.hud-corner .item-slot {
  width: 34px;
  height: 34px;
  border-radius: 8px;
  background: rgba(255,255,255,0.08);
  border: 1px solid rgba(255,255,255,0.2);
  display: flex;
  align-items: center;
  justify-content: center;
}
.hud-corner .item-slot svg { display: block; }
.hud-corner .charge-bar {
  width: 100%;
  height: 5px;
  border-radius: 3px;
  background: rgba(255,255,255,0.15);
  overflow: hidden;
}
.hud-corner .charge-fill {
  height: 100%;
  width: 0%;
  background: rgba(255,255,255,0.35);
  border-radius: 3px;
  transition: width 0.1s linear, background 0.12s ease;
}
.hud-timer {
  position: absolute;
  top: 14px;
  left: 50%;
  transform: translateX(-50%);
  padding: 8px 22px;
  background: rgba(10,12,20,0.45);
  backdrop-filter: blur(4px);
  border-radius: 10px;
  border: 1px solid rgba(255,255,255,0.12);
  font-size: 20px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  letter-spacing: 1px;
  font-family: 'Kenney Future', 'Segoe UI', Arial, sans-serif;
}
.hud-map-badge {
  position: absolute;
  top: 58px;
  left: 50%;
  transform: translateX(-50%);
  padding: 3px 14px;
  background: rgba(10,12,20,0.35);
  border-radius: 8px;
  font-size: 12px;
  font-weight: 600;
  opacity: 0.85;
  letter-spacing: 0.5px;
  font-family: 'Kenney Future', 'Segoe UI', Arial, sans-serif;
}
.hud-countdown {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
.hud-countdown .num {
  font-size: 180px;
  font-weight: 900;
  color: #fff;
  text-shadow: 0 0 40px rgba(255,140,0,0.8), 0 6px 16px rgba(0,0,0,0.6);
  animation: hud-pop 0.5s ease-out;
  font-family: 'Kenney Future', 'Segoe UI', Arial, sans-serif;
}
.hud-countdown .go {
  color: #4dff88;
  text-shadow: 0 0 50px rgba(77,255,136,0.9), 0 6px 16px rgba(0,0,0,0.6);
}
@keyframes hud-pop {
  0% { transform: scale(0.4); opacity: 0; }
  60% { transform: scale(1.15); opacity: 1; }
  100% { transform: scale(1); opacity: 1; }
}
.hud-split-line {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 2px;
  background: rgba(255,255,255,0.5);
  box-shadow: 0 0 8px rgba(0,0,0,0.6);
  transform: translateX(-50%);
}

/* ── 메뉴 포커스 박스 ──
   border가 아니라 outline을 쓴다: 박스 크기에 영향이 없어 포커스가 옮겨 다녀도 형제가 밀리지 않는다. */
.hud-focus {
  position: relative;
  outline: 2px solid var(--focus-color, #4dd0ff);
  outline-offset: 6px;
  border-radius: 10px;
  animation: hud-focus-breathe 1.6s ease-in-out infinite;
}
@keyframes hud-focus-breathe {
  0%,100% { box-shadow: 0 0 0 6px rgba(77,208,255,0.12), 0 0 18px rgba(77,208,255,0.35); }
  50%     { box-shadow: 0 0 0 6px rgba(77,208,255,0.20), 0 0 26px rgba(77,208,255,0.55); }
}
/* 이동 순간 팝 1회 + 숨쉬기 유지(두 애니메이션을 같이 건다 — 하나만 쓰면 상시 애니메이션이 죽는다) */
.hud-focus.hud-focus-pop {
  animation: hud-focus-pop 0.14s ease-out, hud-focus-breathe 1.6s ease-in-out infinite;
}
@keyframes hud-focus-pop {
  from { transform: scale(0.97); }
  to   { transform: scale(1); }
}

.hud-title {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 22px;
  background: radial-gradient(ellipse at center, rgba(20,24,40,0.55) 0%, rgba(5,6,12,0.75) 100%);
  text-align: center;
  pointer-events: none;
}
.hud-title h1 {
  font-size: 64px;
  margin: 0;
  font-weight: 900;
  letter-spacing: 2px;
  background: linear-gradient(90deg,#ff5e5e,#ffce54,#4dd0ff,#7c5cff);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  text-shadow: 0 6px 30px rgba(0,0,0,0.5);
  font-family: 'Kenney Future', 'Segoe UI', Arial, sans-serif;
}
.hud-title .map-select {
  display: flex;
  align-items: center;
  gap: 14px;
  font-size: 20px;
  font-weight: 800;
  font-family: 'Kenney Future', 'Segoe UI', Arial, sans-serif;
}
.hud-title .map-select .arrow {
  opacity: 0.7;
  font-size: 22px;
}
.hud-title .map-select .map-name {
  min-width: 220px;
  text-align: center;
}
.hud-title .map-hint {
  margin-top: -14px;
  font-size: 13px;
  opacity: 0.7;
}
.hud-title .map-difficulty {
  margin-top: -10px;
  font-size: 18px;
  letter-spacing: 3px;
  color: #ffce54;
  text-shadow: 0 2px 6px rgba(0,0,0,0.5);
}
.hud-title .mode-select {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 16px;
  font-weight: 700;
  margin-top: -6px;
}
.hud-title .mode-select .mode-option {
  opacity: 0.5;
  padding: 3px 10px;
  border-radius: 999px;
  transition: opacity 0.15s ease, background 0.15s ease, color 0.15s ease;
}
.hud-title .mode-select .mode-option.active {
  opacity: 1;
  background: rgba(255,255,255,0.15);
  color: #4dd0ff;
}
.hud-title .mode-select .mode-sep {
  opacity: 0.4;
}
.hud-title .mode-hint {
  margin-top: -14px;
  font-size: 12px;
  opacity: 0.65;
}
.hud-title .prompt {
  font-size: 22px;
  font-weight: 700;
  animation: hud-blink 1.4s ease-in-out infinite;
}
@keyframes hud-blink {
  0%,100% { opacity: 1; }
  50% { opacity: 0.35; }
}
.hud-title .controls {
  font-size: 14px;
  opacity: 0.85;
  line-height: 1.6;
  background: rgba(10,12,20,0.4);
  padding: 14px 22px;
  border-radius: 10px;
  border: 1px solid rgba(255,255,255,0.12);
  max-width: 640px;
}
.hud-title .pad-count {
  font-size: 13px;
  opacity: 0.75;
}
.hud-results {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0,0,0,0.55);
  pointer-events: none;
}
.hud-results .panel {
  background: rgba(15,18,30,0.85);
  border: 1px solid rgba(255,255,255,0.15);
  border-radius: 16px;
  padding: 30px 40px;
  min-width: 340px;
  box-shadow: 0 12px 40px rgba(0,0,0,0.5);
  text-align: center;
}
.hud-results h2 {
  margin: 0 0 18px 0;
  font-size: 30px;
  font-weight: 900;
  letter-spacing: 1px;
}
.hud-results .row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 6px;
  border-bottom: 1px solid rgba(255,255,255,0.08);
  font-size: 18px;
}
.hud-results .row:last-of-type {
  border-bottom: none;
}
.hud-results .row .rank-badge {
  font-weight: 900;
  font-size: 20px;
  width: 40px;
}
.hud-results .row .dot {
  width: 14px;
  height: 14px;
  border-radius: 50%;
}
.hud-results .row .name {
  flex: 1;
  text-align: left;
  font-weight: 700;
}
.hud-results .row .time {
  font-variant-numeric: tabular-nums;
  opacity: 0.9;
}
.hud-results .row .medal {
  height: 64px;
  width: auto;
  flex-shrink: 0;
  display: block;
  object-fit: contain;
}
.hud-results .result-actions {
  margin-top: 24px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  align-items: stretch;
}
.hud-results .result-action {
  font-size: 16px;
  font-weight: 800;
  padding: 8px 18px;
  border-radius: 10px;
  background: rgba(255,255,255,0.07);
  border: 1px solid rgba(255,255,255,0.14);
  opacity: 0.72;
  transition: opacity 0.15s ease, background 0.15s ease;
}
.hud-results .result-action.hud-focus {
  opacity: 1;
  background: rgba(255,255,255,0.14);
}
.hud-results .result-hint {
  margin-top: 14px;
  font-size: 12px;
  opacity: 0.6;
}

/* ── 타이틀: 아이템 효과 안내 ── */
.hud-title .item-guide {
  display: flex;
  gap: 10px;
  margin-top: 18px;
  flex-wrap: wrap;
  justify-content: center;
  max-width: 760px;
}
.hud-title .item-guide .card {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  width: 350px;
  box-sizing: border-box;
  padding: 9px 12px;
  border-radius: 12px;
  background: rgba(0, 0, 0, 0.42);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-left-width: 4px;
  text-align: left;
}
.hud-title .item-guide .icon {
  width: 26px;
  height: 26px;
  display: block;
  flex-shrink: 0;
}
.hud-title .item-guide .body { display: flex; flex-direction: column; gap: 2px; }
.hud-title .item-guide .head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 15px;
  font-weight: 800;
}
.hud-title .item-guide .tag {
  font-size: 11px;
  font-weight: 700;
  padding: 1px 7px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.15);
  white-space: nowrap;
}
.hud-title .item-guide .desc {
  font-size: 12.5px;
  line-height: 1.45;
  opacity: 0.82;
}

/* ── 레이스: 획득/사용 토스트 ── */
.hud-toast {
  position: absolute;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 15px;
  border-radius: 12px;
  background: rgba(0, 0, 0, 0.62);
  border: 2px solid rgba(255, 255, 255, 0.28);
  border-left-width: 5px;
  font-size: 15px;
  font-weight: 800;
  white-space: nowrap;
  opacity: 0;
  transform: translateY(-6px) scale(0.96);
  transition: opacity 0.16s ease, transform 0.16s ease;
  pointer-events: none;
}
.hud-toast.show { opacity: 1; transform: translateY(0) scale(1); }
.hud-toast .t-icon { width: 21px; height: 21px; display: block; flex-shrink: 0; }
.hud-toast .t-sub { font-size: 12.5px; font-weight: 700; opacity: 0.78; }
`;

export class HUD {
  constructor() {
    this.root = el('div', 'hud-root');
    document.head.appendChild(Object.assign(document.createElement('style'), { textContent: STYLE }));
    document.body.appendChild(this.root);

    // 메뉴 포커스 항목 수(main이 % 연산에 쓴다). 읽기 전용.
    this.TITLE_ITEMS = 2;   // 0 = 맵, 1 = 모드
    this.RESULT_ITEMS = 2;  // 0 = 재시작, 1 = 타이틀로

    // Player corner panels (index 0/1)
    this.playerPanels = [this._buildPlayerPanel(), this._buildPlayerPanel()];
    this.playerPanels.forEach((p) => this.root.appendChild(p.el));

    // Race timer
    this.timerEl = el('div', 'hud-timer', this.root);
    this.timerEl.textContent = fmtTime(0);
    this.timerEl.style.display = 'none';

    // Small map name badge shown during race (top center, below timer)
    this.mapBadgeEl = el('div', 'hud-map-badge', this.root);
    this.mapBadgeEl.style.display = 'none';
    this._mapName = '';

    // Split divider line
    this.splitLine = el('div', 'hud-split-line', this.root);
    this.splitLine.style.display = 'none';

    // Countdown overlay
    this.countdownEl = el('div', 'hud-countdown', this.root);
    this.countdownNum = el('div', 'num', this.countdownEl);
    this.countdownEl.style.display = 'none';

    // Title screen
    this.titleEl = el('div', 'hud-title', this.root);
    const h1 = el('h1', null, this.titleEl);
    h1.textContent = '한어울제 카트';

    // 포커스 항목 0 — 맵 선택. A/D로 값 변경.
    const mapSelect = el('div', 'map-select', this.titleEl);
    this.mapSelectEl = mapSelect;
    const arrowLeft = el('span', 'arrow', mapSelect);
    arrowLeft.textContent = '◀';
    this.titleMapName = el('span', 'map-name', mapSelect);
    this.titleMapName.textContent = '';
    const arrowRight = el('span', 'arrow', mapSelect);
    arrowRight.textContent = '▶';
    this.mapDifficultyEl = el('div', 'map-difficulty', this.titleEl);
    this.mapDifficultyEl.textContent = '★☆☆';
    this.mapHintEl = el('div', 'map-hint', this.titleEl);
    this.mapHintEl.textContent = 'A / D 로 변경';

    // 포커스 항목 1 — 게임 모드(아이템전 / 스피드전). A/D 어느 쪽이든 토글.
    const modeRow = el('div', 'mode-select', this.titleEl);
    this.modeSelectEl = modeRow;
    this.modeItemsEl = el('span', 'mode-option', modeRow);
    this.modeItemsEl.textContent = '아이템전';
    const modeSep = el('span', 'mode-sep', modeRow);
    modeSep.textContent = '/';
    this.modeSpeedEl = el('span', 'mode-option', modeRow);
    this.modeSpeedEl.textContent = '스피드전';
    this.modeHintEl = el('div', 'mode-hint', this.titleEl);
    this.modeHintEl.textContent = 'A / D 로 변경';
    this._gameMode = 'items';

    // '시작'은 포커스 항목이 아니다 — Enter는 포커스와 무관하게 항상 시작 하나를 뜻한다.
    const prompt = el('div', 'prompt', this.titleEl);
    prompt.textContent = 'Start 버튼 또는 Enter로 시작';
    const controls = el('div', 'controls', this.titleEl);
    controls.innerHTML =
      'P1(빨강): WASD 주행 · 왼쪽 Shift 아이템<br>' +
      'P2(파랑): 방향키 주행 · 오른쪽 Shift 아이템<br>' +
      '게임패드: RT 가속 · LT 브레이크 · 좌스틱 조향 · X/LB 아이템 · Start 일시정지<br>' +
      '메뉴: W/S 항목 · A/D 값 · Enter(A) 결정 · Backspace(B) 취소';
    // 아이템 효과 안내 — 아이템이 무엇을 하는지 보여줄 곳이 없어 조작이 '먹통'처럼 느껴졌다.
    // speed 모드에서는 아이템이 없으므로 이 카드 전체를 숨긴다(setGameMode).
    this.itemGuideEl = el('div', 'item-guide', this.titleEl);
    for (const key of ITEM_ORDER) {
      const info = ITEM_INFO[key];
      const card = el('div', 'card', this.itemGuideEl);
      card.style.borderLeftColor = info.color;
      const icon = el('div', 'icon', card);
      icon.style.color = info.color;
      icon.innerHTML = itemIconSVG(key, 26);
      const body = el('div', 'body', card);
      const head = el('div', 'head', body);
      const nm = el('span', null, head);
      nm.textContent = info.name;
      nm.style.color = info.color;
      const tag = el('span', 'tag', head);
      tag.textContent = info.short;
      const desc = el('div', 'desc', body);
      desc.textContent = info.desc;
    }

    this.padCountEl = el('div', 'pad-count', this.titleEl);
    this.padCountEl.textContent = '연결된 게임패드: 0';
    this.titleEl.style.display = 'none';

    // 타이틀 포커스 대상(순서 = index)
    this._titleFocusEls = [this.mapSelectEl, this.modeSelectEl];
    this._titleFocus = 0;

    // 획득/사용 토스트: 플레이어별 1개. main을 거치지 않고 players[].item 변화로 직접 감지한다.
    this.toasts = [0, 1].map(() => {
      const t = el('div', 'hud-toast', this.root);
      const ic = el('span', 't-icon', t);
      const tx = el('span', 't-text', t);
      const sb = el('span', 't-sub', t);
      return { el: t, icon: ic, text: tx, sub: sb, until: 0 };
    });
    this._prevItems = [null, null];

    // Results panel
    this.resultsEl = el('div', 'hud-results', this.root);
    const panel = el('div', 'panel', this.resultsEl);
    this.resultsTitle = el('h2', null, panel);
    this.resultsTitle.textContent = 'RESULTS';
    this.resultsList = el('div', 'results-list', panel);
    // 결과 화면 포커스 항목 2개(W/S 이동, Enter 결정).
    this.resultsActionsEl = el('div', 'result-actions', panel);
    this.resultsRestartEl = el('div', 'result-action', this.resultsActionsEl);
    this.resultsRestartEl.textContent = '같은 맵 재시작';
    this.resultsTitleBtnEl = el('div', 'result-action', this.resultsActionsEl);
    this.resultsTitleBtnEl.textContent = '타이틀로 (맵 선택)';
    this.resultsHintEl = el('div', 'result-hint', panel);
    this.resultsHintEl.textContent = 'W / S 이동 · Enter(A) 결정 · Backspace(B) 타이틀로';
    // 이전 이름 호환(외부에서 참조하지는 않지만 구조를 잃지 않게 남긴다)
    this.resultsRestart = this.resultsActionsEl;
    this.resultsEl.style.display = 'none';

    this._resultFocusEls = [this.resultsRestartEl, this.resultsTitleBtnEl];
    this._resultFocus = 0;

    // 초기 모드 표시(아이템전) + 초기 포커스 반영
    this.setGameMode(this._gameMode);
    this.setTitleFocus(0);
    this.setResultsFocus(0);
  }

  _buildPlayerPanel() {
    const panelEl = el('div', 'hud-corner');
    const nameRow = el('div', 'name-row', panelEl);
    const dot = el('div', 'color-dot', nameRow);
    const nameSpan = el('span', null, nameRow);
    const rank = el('div', 'rank', panelEl);
    const lap = el('div', 'lap', panelEl);
    const statRow = el('div', 'stat-row', panelEl);
    const speed = el('div', 'speed', statRow);
    const itemSlot = el('div', 'item-slot', statRow);
    const chargeBar = el('div', 'charge-bar', panelEl);
    const chargeFill = el('div', 'charge-fill', chargeBar);
    return { el: panelEl, dot, nameSpan, rank, lap, speed, itemSlot, chargeFill, itemKey: undefined };
  }

  // 포커스 박스를 목록 중 하나에 옮겨 붙인다. 이동 순간 팝 애니메이션을 재시작한다.
  _applyFocus(list, index, color) {
    if (!Array.isArray(list) || list.length === 0) return 0;
    const i = ((Math.round(index) || 0) % list.length + list.length) % list.length;
    list.forEach((node, n) => {
      if (!node) return;
      if (n === i) {
        node.style.setProperty('--focus-color', color);
        node.classList.remove('hud-focus-pop');
        node.classList.add('hud-focus');
        // 리플로우로 애니메이션 재시작(연속 이동에서도 매번 팝이 보이게)
        void node.offsetWidth;
        node.classList.add('hud-focus-pop');
      } else {
        node.classList.remove('hud-focus', 'hud-focus-pop');
      }
    });
    return i;
  }

  // i: 0 = 맵, 1 = 모드
  setTitleFocus(i) {
    this._titleFocus = this._applyFocus(this._titleFocusEls, i, '#4dd0ff');
    return this._titleFocus;
  }

  // i: 0 = 재시작, 1 = 타이틀로
  setResultsFocus(i) {
    this._resultFocus = this._applyFocus(this._resultFocusEls, i, '#ffce54');
    return this._resultFocus;
  }

  update({ players = [], state = 'menu', countdown = null, raceTime = 0, splitLayout = 'single' } = {}) {
    // Toggle major screens
    this.titleEl.style.display = state === 'menu' ? 'flex' : 'none';
    this.countdownEl.style.display = state === 'countdown' ? 'flex' : 'none';
    const showHudChrome = state === 'race' || state === 'finished' || state === 'countdown';
    this.timerEl.style.display = showHudChrome ? 'block' : 'none';
    this.playerPanels.forEach((p) => {
      p.el.style.display = showHudChrome ? 'flex' : 'none';
    });

    if (state === 'countdown' && countdown != null) {
      if (countdown === 0) {
        this.countdownNum.textContent = 'GO!';
        this.countdownNum.className = 'num go';
      } else {
        this.countdownNum.textContent = String(countdown);
        this.countdownNum.className = 'num';
      }
    }

    this.timerEl.textContent = fmtTime(raceTime);
    this.mapBadgeEl.style.display = state === 'race' ? 'block' : 'none';

    // Layout: split vs single
    const isSplit = splitLayout === 'split';
    this.splitLine.style.display = isSplit ? 'block' : 'none';

    players.forEach((p, i) => {
      const panel = this.playerPanels[i];
      if (!panel) return;
      const colorHex = typeof p.color === 'number' ? `#${p.color.toString(16).padStart(6, '0')}` : (p.color || '#fff');
      panel.dot.style.background = colorHex;
      panel.dot.style.color = colorHex;
      panel.nameSpan.textContent = p.name || `P${i}`;
      panel.rank.textContent = p.rank === 1 ? '1st' : p.rank === 2 ? '2nd' : `${p.rank}th`;
      panel.lap.textContent = `LAP ${Math.min(p.lap, p.totalLaps)}/${p.totalLaps}`;
      panel.speed.textContent = `${Math.round((p.speed || 0) * 3.6)} km/h`;
      // 아이콘 SVG는 키가 바뀔 때만 다시 그린다(매 프레임 innerHTML 재파싱 방지).
      const itemKey = p.item || null;
      if (panel.itemKey !== itemKey) {
        panel.itemKey = itemKey;
        if (itemKey) {
          const info = ITEM_INFO[itemKey];
          panel.itemSlot.style.color = info ? info.color : '#fff';
          panel.itemSlot.innerHTML = itemIconSVG(itemKey, 22);
        } else {
          panel.itemSlot.innerHTML = '';
        }
      }
      // 스피드전에는 아이템이 없다 — 슬롯 자체를 숨긴다.
      panel.itemSlot.style.display = this._gameMode === 'speed' ? 'none' : '';

      // 아이템 변화 감지: null→X = 획득, X→null = 사용. 레이스 중, 아이템전에서만 띄운다.
      const prev = this._prevItems[i] || null;
      const cur = itemKey;
      if (cur !== prev && state === 'race' && this._gameMode === 'items') {
        if (cur) this._showToast(i, cur, '획득');
        else if (prev) this._showToast(i, prev, '사용');
      }
      this._prevItems[i] = cur;

      // 코너 차지 게이지: 폭은 연속값(chargeRatio), 색은 티어(charge 0..3).
      const ratio = Math.max(0, Math.min(1, Number(p.chargeRatio) || 0));
      const tier = Math.max(0, Math.min(3, Math.round(Number(p.charge) || 0)));
      panel.chargeFill.style.width = `${ratio * 100}%`;
      panel.chargeFill.style.background = tier > 0 ? CHARGE_COLORS[tier - 1] : 'rgba(255,255,255,0.35)';

      // Positioning based on splitLayout
      panel.el.style.top = '';
      panel.el.style.left = '';
      panel.el.style.right = '';
      panel.el.style.bottom = '';
      if (isSplit) {
        // each player's HUD stays in their own half's near corner
        panel.el.style.top = '14px';
        if (i === 0) panel.el.style.left = '14px';
        else panel.el.style.right = '14px';
      } else {
        // single: opposite ends of the screen
        panel.el.style.top = '14px';
        if (i === 0) panel.el.style.left = '14px';
        else panel.el.style.right = '14px';
      }
    });

    this._updateToasts(isSplit, state === 'race');
  }

  showResults(results = []) {
    this.resultsEl.style.display = 'flex';
    this.resultsList.innerHTML = '';
    const sorted = [...results].sort((a, b) => a.rank - b.rank);
    sorted.forEach((r) => {
      const row = el('div', 'row', this.resultsList);
      const badge = el('div', 'rank-badge', row);
      badge.textContent = r.rank === 1 ? '1st' : r.rank === 2 ? '2nd' : `${r.rank}th`;
      const isDNF = r.finishTime == null;
      if (!isDNF && (r.rank === 1 || r.rank === 2)) {
        const medal = el('img', 'medal', row);
        medal.src = r.rank === 1 ? 'assets/ui/medal-1st.png' : 'assets/ui/medal-2nd.png';
        medal.alt = r.rank === 1 ? '1st place medal' : '2nd place medal';
        // Load failure must not break the row layout — just hide the broken image.
        medal.onerror = () => {
          medal.onerror = null;
          medal.style.display = 'none';
        };
      }
      const colorHex = typeof r.color === 'number' ? `#${r.color.toString(16).padStart(6, '0')}` : (r.color || '#fff');
      const dot = el('div', 'dot', row);
      dot.style.background = colorHex;
      const name = el('div', 'name', row);
      name.textContent = r.name;
      const time = el('div', 'time', row);
      time.textContent = r.finishTime != null ? fmtTime(r.finishTime) : 'DNF';
    });
  }

  hideResults() {
    this.resultsEl.style.display = 'none';
  }

  // 토스트 표시(2.0초). kind: '획득' | '사용'
  _showToast(i, itemKey, kind) {
    const t = this.toasts && this.toasts[i];
    const info = ITEM_INFO[itemKey];
    if (!t || !info) return;
    t.icon.style.color = info.color;
    t.icon.innerHTML = itemIconSVG(itemKey, 21);
    t.text.textContent = `${info.name} ${kind}`;
    t.sub.textContent = kind === '사용' ? info.short : '';
    t.el.style.borderLeftColor = info.color;
    t.text.style.color = info.color;
    t.el.classList.add('show');
    t.until = (typeof performance !== 'undefined' ? performance.now() : Date.now()) + 2000;
  }

  // 토스트 위치(분할 여부에 따라 좌/우 절반 안쪽)와 만료를 갱신한다.
  _updateToasts(isSplit, visible) {
    if (!this.toasts) return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.toasts.forEach((t, i) => {
      if (!visible || now > t.until) t.el.classList.remove('show');
      t.el.style.top = '86px';
      if (isSplit) {
        // 각 반쪽의 가운데 위. 25% / 75% 지점에서 자기 폭의 절반만큼 당긴다.
        t.el.style.left = i === 0 ? '25%' : '75%';
        t.el.style.right = 'auto';
        t.el.style.transform = t.el.classList.contains('show')
          ? 'translateX(-50%)' : 'translateX(-50%) translateY(-6px) scale(0.96)';
      } else {
        // 한 화면일 때는 각자 자기 쪽 가장자리에 붙인다(HUD 패널과 같은 편).
        t.el.style.left = i === 0 ? '18px' : 'auto';
        t.el.style.right = i === 0 ? 'auto' : '18px';
        t.el.style.transform = t.el.classList.contains('show')
          ? 'none' : 'translateY(-6px) scale(0.96)';
      }
    });
  }

  showTitle(visible) {
    this.titleEl.style.display = visible ? 'flex' : 'none';
  }

  setPadCount(n) {
    this.padCountEl.textContent = `연결된 게임패드: ${n}`;
  }

  setMapInfo({ name, difficulty } = {}) {
    this._mapName = name || '';
    this.titleMapName.textContent = this._mapName;
    const d = Math.max(1, Math.min(3, Math.round(difficulty) || 1));
    if (this.mapDifficultyEl) this.mapDifficultyEl.textContent = '★'.repeat(d) + '☆'.repeat(3 - d);
    this._renderMapBadge();
  }

  // 'items' | 'speed'. 타이틀 모드 강조 표시, 레이스 중 배지 병기, 아이템 가이드 노출을 갱신한다.
  setGameMode(mode) {
    this._gameMode = mode === 'speed' ? 'speed' : 'items';
    const isSpeed = this._gameMode === 'speed';
    if (this.modeItemsEl) this.modeItemsEl.classList.toggle('active', !isSpeed);
    if (this.modeSpeedEl) this.modeSpeedEl.classList.toggle('active', isSpeed);
    if (this.itemGuideEl) this.itemGuideEl.style.display = isSpeed ? 'none' : 'flex';
    this._renderMapBadge();
  }

  // 상단 맵 배지: 스피드전이면 '맵명 · 스피드전'으로 병기한다.
  _renderMapBadge() {
    this.mapBadgeEl.textContent = this._gameMode === 'speed' ? `${this._mapName} · 스피드전` : this._mapName;
  }
}
