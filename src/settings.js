// src/settings.js
// 설정 모달: 화면분할/볼륨/감도/랩수/품질 + 아이템 버튼 리매핑 요청.
// DOM + localStorage('kart-settings'). 마우스 조작.

const STORAGE_KEY = 'kart-settings';

const DEFAULTS = {
  splitMode: 'auto',
  volume: 0.7,
  sensitivity: 1.0,
  laps: 3,
  quality: 'high',
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return {
      splitMode: ['auto', 'split', 'single'].includes(parsed.splitMode) ? parsed.splitMode : DEFAULTS.splitMode,
      volume: clamp(num(parsed.volume, DEFAULTS.volume), 0, 1),
      sensitivity: clamp(num(parsed.sensitivity, DEFAULTS.sensitivity), 0.5, 1.5),
      laps: clamp(Math.round(num(parsed.laps, DEFAULTS.laps)), 1, 5),
      quality: ['high', 'low'].includes(parsed.quality) ? parsed.quality : DEFAULTS.quality,
    };
  } catch (e) {
    return { ...DEFAULTS };
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (e) {
    // 저장 실패(프라이빗 모드 등)는 무시
  }
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

const STYLE_ID = 'kart-settings-style';
const STYLE_CSS = `
.kart-settings-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  font-family: 'Segoe UI', Arial, sans-serif;
}
.kart-settings-panel {
  background: #1e2230;
  color: #f0f0f5;
  border-radius: 12px;
  padding: 24px 28px;
  width: 380px;
  max-width: 90vw;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
  border: 1px solid #3a3f55;
}
.kart-settings-panel h2 {
  margin: 0 0 16px;
  font-size: 20px;
  text-align: center;
  letter-spacing: 1px;
}
.kart-settings-row {
  display: flex;
  flex-direction: column;
  margin-bottom: 16px;
  gap: 6px;
}
.kart-settings-row label {
  font-size: 13px;
  color: #b8bcd0;
}
.kart-settings-row .kart-settings-value {
  font-size: 12px;
  color: #8890b0;
  float: right;
}
.kart-settings-segmented {
  display: flex;
  gap: 6px;
}
.kart-settings-segmented button {
  flex: 1;
  padding: 6px 4px;
  background: #2a2f42;
  border: 1px solid #3a3f55;
  color: #d8dae8;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
}
.kart-settings-segmented button.active {
  background: #4a6ef0;
  border-color: #4a6ef0;
  color: #fff;
}
.kart-settings-row input[type="range"] {
  width: 100%;
}
.kart-settings-remap-btn {
  width: 100%;
  padding: 8px;
  background: #2a2f42;
  border: 1px solid #3a3f55;
  color: #d8dae8;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  margin-top: 4px;
}
.kart-settings-remap-btn.listening {
  background: #f0a54a;
  color: #1e2230;
  border-color: #f0a54a;
}
.kart-settings-close {
  width: 100%;
  padding: 10px;
  margin-top: 8px;
  background: #4a6ef0;
  border: none;
  color: #fff;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 600;
}
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE_CSS;
  document.head.appendChild(style);
}

export class SettingsMenu {
  constructor({ onChange, onRemapRequest } = {}) {
    this._onChange = typeof onChange === 'function' ? onChange : () => {};
    this._onRemapRequest = typeof onRemapRequest === 'function' ? onRemapRequest : null;

    this.settings = loadSettings();
    this.isOpen = false;
    this._remapListening = false;
    this._remapToken = 0;
    this._remapTimeoutId = null;

    ensureStyle();
    this._buildDom();
    this._syncDomFromSettings();
  }

  _buildDom() {
    const overlay = document.createElement('div');
    overlay.className = 'kart-settings-overlay';
    overlay.style.display = 'none';

    const panel = document.createElement('div');
    panel.className = 'kart-settings-panel';
    overlay.appendChild(panel);

    const title = document.createElement('h2');
    title.textContent = 'SETTINGS';
    panel.appendChild(title);

    // 화면 분할 모드
    const splitRow = document.createElement('div');
    splitRow.className = 'kart-settings-row';
    const splitLabel = document.createElement('label');
    splitLabel.textContent = '화면 분할';
    splitRow.appendChild(splitLabel);
    const splitSeg = document.createElement('div');
    splitSeg.className = 'kart-settings-segmented';
    const splitOptions = [
      ['auto', '자동'],
      ['split', '항상 분할'],
      ['single', '항상 합체'],
    ];
    this._splitButtons = {};
    for (const [value, label] of splitOptions) {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.addEventListener('click', () => this._setValue('splitMode', value));
      splitSeg.appendChild(btn);
      this._splitButtons[value] = btn;
    }
    splitRow.appendChild(splitSeg);
    panel.appendChild(splitRow);

    // 볼륨
    const volumeRow = this._buildSliderRow('볼륨', 0, 1, 0.01, (v) => this._setValue('volume', v));
    panel.appendChild(volumeRow.row);
    this._volumeInput = volumeRow.input;
    this._volumeValue = volumeRow.valueLabel;

    // 조향 감도
    const sensRow = this._buildSliderRow('조향 감도', 0.5, 1.5, 0.01, (v) => this._setValue('sensitivity', v));
    panel.appendChild(sensRow.row);
    this._sensInput = sensRow.input;
    this._sensValue = sensRow.valueLabel;

    // 랩 수
    const lapsRow = this._buildSliderRow('랩 수', 1, 5, 1, (v) => this._setValue('laps', Math.round(v)));
    panel.appendChild(lapsRow.row);
    this._lapsInput = lapsRow.input;
    this._lapsValue = lapsRow.valueLabel;

    // 그래픽 품질
    const qualRow = document.createElement('div');
    qualRow.className = 'kart-settings-row';
    const qualLabel = document.createElement('label');
    qualLabel.textContent = '그래픽 품질';
    qualRow.appendChild(qualLabel);
    const qualSeg = document.createElement('div');
    qualSeg.className = 'kart-settings-segmented';
    this._qualButtons = {};
    for (const [value, label] of [['high', '고품질'], ['low', '저품질']]) {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.addEventListener('click', () => this._setValue('quality', value));
      qualSeg.appendChild(btn);
      this._qualButtons[value] = btn;
    }
    qualRow.appendChild(qualSeg);
    panel.appendChild(qualRow);

    // 아이템 버튼 리매핑
    const remapRow = document.createElement('div');
    remapRow.className = 'kart-settings-row';
    const remapLabel = document.createElement('label');
    remapLabel.textContent = '컨트롤러 리매핑';
    remapRow.appendChild(remapLabel);
    const remapBtn = document.createElement('button');
    remapBtn.className = 'kart-settings-remap-btn';
    remapBtn.textContent = '아이템 버튼 변경';
    remapBtn.addEventListener('click', () => this._handleRemapClick(remapBtn));
    remapRow.appendChild(remapBtn);
    panel.appendChild(remapRow);
    this._remapBtn = remapBtn;

    // 닫기
    const closeBtn = document.createElement('button');
    closeBtn.className = 'kart-settings-close';
    closeBtn.textContent = '닫기';
    closeBtn.addEventListener('click', () => this.close());
    panel.appendChild(closeBtn);

    // 배경 클릭으로 닫기 (패널 클릭은 전파 차단)
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.close();
    });
    panel.addEventListener('click', (e) => e.stopPropagation());

    document.body.appendChild(overlay);
    this._overlay = overlay;
  }

  _buildSliderRow(labelText, min, max, step, onInput) {
    const row = document.createElement('div');
    row.className = 'kart-settings-row';
    const label = document.createElement('label');
    label.textContent = labelText;
    const valueLabel = document.createElement('span');
    valueLabel.className = 'kart-settings-value';
    label.appendChild(valueLabel);
    row.appendChild(label);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.addEventListener('input', () => {
      onInput(Number(input.value));
    });
    row.appendChild(input);

    return { row, input, valueLabel };
  }

  _handleRemapClick(btn) {
    if (this._remapListening) {
      // 리스닝 중 재클릭 → 취소. 토큰을 무효화해 늦게 오는 onDone을 무시한다.
      this._remapToken += 1;
      this._resetRemapUI(btn);
      return;
    }
    if (!this._onRemapRequest) return;
    this._remapListening = true;
    const token = (this._remapToken += 1);
    btn.classList.add('listening');
    btn.textContent = '버튼을 누르세요... (클릭 시 취소)';
    this._remapTimeoutId = setTimeout(() => {
      if (token !== this._remapToken) return; // 이미 취소/완료됨
      this._remapToken += 1; // 이후 늦게 오는 onDone을 무효화
      this._resetRemapUI(btn);
    }, 8000);
    // onDone은 "이 리매핑이 아직 유효한가"를 boolean으로 돌려준다.
    // false면 호출측(main)이 실제 매핑 변경을 적용하지 않는다.
    this._onRemapRequest((buttonIndex) => {
      if (token !== this._remapToken) return false; // 취소/타임아웃 이후 늦게 온 콜백은 무시
      this._resetRemapUI(btn);
      return true;
    });
  }

  _resetRemapUI(btn) {
    if (this._remapTimeoutId !== null) {
      clearTimeout(this._remapTimeoutId);
      this._remapTimeoutId = null;
    }
    this._remapListening = false;
    btn.classList.remove('listening');
    btn.textContent = '아이템 버튼 변경';
  }

  _setValue(key, value) {
    this.settings = { ...this.settings, [key]: value };
    saveSettings(this.settings);
    this._syncDomFromSettings();
    this._onChange(this.settings);
  }

  _syncDomFromSettings() {
    const s = this.settings;

    for (const [value, btn] of Object.entries(this._splitButtons)) {
      btn.classList.toggle('active', value === s.splitMode);
    }
    for (const [value, btn] of Object.entries(this._qualButtons)) {
      btn.classList.toggle('active', value === s.quality);
    }

    this._volumeInput.value = String(s.volume);
    this._volumeValue.textContent = `${Math.round(s.volume * 100)}%`;

    this._sensInput.value = String(s.sensitivity);
    this._sensValue.textContent = s.sensitivity.toFixed(2);

    this._lapsInput.value = String(s.laps);
    this._lapsValue.textContent = String(s.laps);
  }

  open() {
    this.isOpen = true;
    this._overlay.style.display = 'flex';
  }

  close() {
    this.isOpen = false;
    this._overlay.style.display = 'none';
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }
}
