// src/hud.js
// DOM 오버레이 HUD: 랩/순위/아이템/속도/타임, 카운트다운, 타이틀, 결과 패널.
// 계약(CONTRACTS.md)에 명시된 export만 제공. 다른 모듈은 import하지 않음.

const ITEM_ICONS = {
  mushroom: '🍄',
  shell: '🐢',
  banana: '🍌',
  star: '⭐',
};

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
  font-size: 20px;
}
.hud-corner .drift-bar {
  width: 100%;
  height: 5px;
  border-radius: 3px;
  background: rgba(255,255,255,0.15);
  overflow: hidden;
}
.hud-corner .drift-fill {
  height: 100%;
  width: 0%;
  background: linear-gradient(90deg,#ffe066,#ff8c00,#ff2d55);
  transition: width 0.1s linear;
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
.hud-results .restart {
  margin-top: 20px;
  font-size: 15px;
  font-weight: 700;
  opacity: 0.85;
}
`;

export class HUD {
  constructor() {
    this.root = el('div', 'hud-root');
    document.head.appendChild(Object.assign(document.createElement('style'), { textContent: STYLE }));
    document.body.appendChild(this.root);

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
    const mapSelect = el('div', 'map-select', this.titleEl);
    const arrowLeft = el('span', 'arrow', mapSelect);
    arrowLeft.textContent = '◀';
    this.titleMapName = el('span', 'map-name', mapSelect);
    this.titleMapName.textContent = '';
    const arrowRight = el('span', 'arrow', mapSelect);
    arrowRight.textContent = '▶';
    this.mapHintEl = el('div', 'map-hint', this.titleEl);
    this.mapHintEl.textContent = '◀ ▶ 맵 선택';
    const prompt = el('div', 'prompt', this.titleEl);
    prompt.textContent = 'Start 버튼 또는 Enter로 시작';
    const controls = el('div', 'controls', this.titleEl);
    controls.innerHTML =
      'P0(빨강): WASD 이동 · Space 드리프트 · 왼쪽 Shift 아이템<br>' +
      'P1(파랑): 방향키 이동 · 0(메인) 드리프트 · 오른쪽 Shift 아이템<br>' +
      '게임패드: RT 가속 · LT 브레이크 · 좌스틱 조향 · A/RB 드리프트 · X/LB 아이템 · Start 일시정지';
    this.padCountEl = el('div', 'pad-count', this.titleEl);
    this.padCountEl.textContent = '연결된 게임패드: 0';
    this.titleEl.style.display = 'none';

    // Results panel
    this.resultsEl = el('div', 'hud-results', this.root);
    const panel = el('div', 'panel', this.resultsEl);
    this.resultsTitle = el('h2', null, panel);
    this.resultsTitle.textContent = 'RESULTS';
    this.resultsList = el('div', 'results-list', panel);
    this.resultsRestart = el('div', 'restart', panel);
    this.resultsRestart.innerHTML =
      'Start 또는 Enter로 같은 맵 재시작<br>B 또는 Backspace로 타이틀(맵 선택)';
    this.resultsEl.style.display = 'none';
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
    const driftBar = el('div', 'drift-bar', panelEl);
    const driftFill = el('div', 'drift-fill', driftBar);
    return { el: panelEl, dot, nameSpan, rank, lap, speed, itemSlot, driftFill };
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
      panel.itemSlot.textContent = p.item ? (ITEM_ICONS[p.item] || '❓') : '';
      const driftPct = Math.max(0, Math.min(3, p.driftLevel || 0)) / 3 * 100;
      panel.driftFill.style.width = `${driftPct}%`;

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

  showTitle(visible) {
    this.titleEl.style.display = visible ? 'flex' : 'none';
  }

  setPadCount(n) {
    this.padCountEl.textContent = `연결된 게임패드: ${n}`;
  }

  setMapInfo({ name } = {}) {
    this._mapName = name || '';
    this.titleMapName.textContent = this._mapName;
    this.mapBadgeEl.textContent = this._mapName;
  }
}
