// src/input.js — Gamepad(Xbox 표준 매핑) 폴링 + 키보드 폴백 + edge 검출 + 리매핑 + rumble.
// CONTRACTS.md 명세를 따른다. 다른 모듈을 import하지 않는다.

const DEADZONE = 0.15;

// 표준 Gamepad 매핑(Xbox) 기본 버튼/축 인덱스.
// steerAxis: 좌스틱 X, throttle/brake: RT/LT(버튼 value 0..1), drift: A, useItem: X, pause: Menu(Start)
// drift/useItem은 계약상 "A 또는 RB", "X 또는 LB"도 허용하므로 대체 버튼을 별도로 고정 확인한다.
function defaultMapping() {
  return {
    steerAxis: 0,
    throttle: 7, // RT
    brake: 6,    // LT
    drift: 0,    // A
    useItem: 2,  // X
    pause: 9,    // Menu/Start
  };
}

const ALT_DRIFT_BUTTON = 5;   // RB
const ALT_USEITEM_BUTTON = 4; // LB
const START_ALT_BUTTON = 0;   // A (anyStartPressed에서 "Menu/A" 허용용)
const BACK_BUTTON = 1;        // B (뒤로/취소 — 결과 화면에서 타이틀 복귀)

function applyDeadzone(v, dz = DEADZONE) {
  return Math.abs(v) < dz ? 0 : v;
}

function emptyInput() {
  return { throttle: 0, brake: 0, steer: 0, drift: false, useItem: false, pause: false };
}

export class InputManager {
  constructor() {
    this.mapping = defaultMapping();

    // 키보드 상태
    this._keys = Object.create(null);
    this._onKeyDown = (e) => {
      this._keys[e.code] = true;
      // 게임 화면에서의 Backspace는 '뒤로' 입력이다 — 브라우저 기본 동작만 막는다.
      const tag = e.target && e.target.tagName;
      if ((e.code === 'Backspace' || e.code === 'Space') && tag !== 'INPUT' && tag !== 'TEXTAREA') {
        e.preventDefault();   // Backspace=뒤로, Space=드리프트 — 브라우저 기본 동작(뒤로가기/스크롤)만 막는다
      }
    };
    this._onKeyUp = (e) => {
      this._keys[e.code] = false;
    };
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);

    // edge 검출용 이전 프레임 상태
    this._prevUseItem = [false, false];
    this._prevPause = [false, false];
    this._prevKeyboardPause = false; // Esc 공용
    this._prevAnyStart = false;
    this._prevKeyboardEnter = false;
    this._prevAnyBack = false;
    this._prevKeyboardBack = false;
    this._backEdge = false;

    // listenForButton: 게임패드 버튼별 이전 눌림 상태 (padIndex -> [bool,...])
    this._prevGamepadButtons = [];
    this._listenCallback = null;

    // getPlayerInput()이 반환할 캐시 (poll()마다 갱신)
    this._cache = [emptyInput(), emptyInput()];

    this._connectedCount = 0;
  }

  poll() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];

    // listenForButton 처리: 어떤 패드든 새로 눌린 버튼을 1회 감지
    if (this._listenCallback) {
      for (let p = 0; p < pads.length; p++) {
        const gp = pads[p];
        if (!gp) continue;
        const prev = this._prevGamepadButtons[p] || [];
        for (let b = 0; b < gp.buttons.length; b++) {
          const pressed = !!gp.buttons[b] && gp.buttons[b].pressed;
          if (pressed && !prev[b]) {
            const cb = this._listenCallback;
            this._listenCallback = null;
            cb(b);
            break;
          }
        }
        if (!this._listenCallback) break;
      }
    }

    // 다음 프레임 비교를 위해 모든 패드의 버튼 상태 스냅샷 저장
    let connected = 0;
    for (let p = 0; p < pads.length; p++) {
      const gp = pads[p];
      if (!gp) {
        this._prevGamepadButtons[p] = [];
        continue;
      }
      connected++;
      const snap = [];
      for (let b = 0; b < gp.buttons.length; b++) {
        snap[b] = !!gp.buttons[b] && gp.buttons[b].pressed;
      }
      this._prevGamepadButtons[p] = snap;
    }
    this._connectedCount = connected;

    // anyStartPressed 용 edge: 어떤 패드든 Menu(Start) 또는 A, 혹은 키보드 Enter
    let anyStartRaw = false;
    for (let p = 0; p < pads.length; p++) {
      const gp = pads[p];
      if (!gp) continue;
      const startBtn = gp.buttons[this.mapping.pause];
      const aBtn = gp.buttons[START_ALT_BUTTON];
      if ((startBtn && startBtn.pressed) || (aBtn && aBtn.pressed)) {
        anyStartRaw = true;
        break;
      }
    }
    const enterPressed = !!this._keys['Enter'];
    const anyStartEdge = (anyStartRaw && !this._prevAnyStart) || (enterPressed && !this._prevKeyboardEnter);
    this._prevAnyStart = anyStartRaw;
    this._prevKeyboardEnter = enterPressed;
    this._anyStartEdge = anyStartEdge;

    // 뒤로가기 edge: 어떤 패드든 B, 혹은 키보드 Backspace.
    // (Esc는 pause 전용이므로 여기 포함하지 않는다 — 두 동작이 섞이면 안 된다)
    let anyBackRaw = false;
    for (let p = 0; p < pads.length; p++) {
      const gp = pads[p];
      if (!gp) continue;
      const bBtn = gp.buttons[BACK_BUTTON];
      if (bBtn && bBtn.pressed) { anyBackRaw = true; break; }
    }
    const backspacePressed = !!this._keys['Backspace'];
    this._backEdge = (anyBackRaw && !this._prevAnyBack) || (backspacePressed && !this._prevKeyboardBack);
    this._prevAnyBack = anyBackRaw;
    this._prevKeyboardBack = backspacePressed;

    // Esc 공용 pause edge (키보드)
    const escPressed = !!this._keys['Escape'];
    const escEdge = escPressed && !this._prevKeyboardPause;
    this._prevKeyboardPause = escPressed;

    // 플레이어별 입력 계산
    for (let i = 0; i < 2; i++) {
      const gp = pads[i];
      let out;
      if (gp) {
        out = this._readGamepad(gp);
      } else {
        out = this._readKeyboard(i);
      }

      // useItem/pause는 edge(이번 프레임 눌림)
      const useItemEdge = out.useItem && !this._prevUseItem[i];
      this._prevUseItem[i] = out.useItem;

      // 키보드 Esc는 이미 edge 계산됨(공용, escEdge)
      const pauseEdge = gp ? (out.pause && !this._prevPause[i]) || escEdge : escEdge;
      this._prevPause[i] = out.pause;

      this._cache[i] = {
        throttle: out.throttle,
        brake: out.brake,
        steer: out.steer,
        drift: out.drift,
        useItem: useItemEdge,
        pause: pauseEdge,
      };
    }
  }

  _readGamepad(gp) {
    const m = this.mapping;
    const axisVal = gp.axes[m.steerAxis] || 0;
    const steer = applyDeadzone(axisVal);

    const throttleBtn = gp.buttons[m.throttle];
    const brakeBtn = gp.buttons[m.brake];
    const throttle = throttleBtn ? throttleBtn.value : 0;
    const brake = brakeBtn ? brakeBtn.value : 0;

    const driftBtn = gp.buttons[m.drift];
    const driftAlt = gp.buttons[ALT_DRIFT_BUTTON];
    const drift = !!((driftBtn && driftBtn.pressed) || (driftAlt && driftAlt.pressed));

    const useItemBtn = gp.buttons[m.useItem];
    const useItemAlt = gp.buttons[ALT_USEITEM_BUTTON];
    const useItem = !!((useItemBtn && useItemBtn.pressed) || (useItemAlt && useItemAlt.pressed));

    const pauseBtn = gp.buttons[m.pause];
    const pause = !!(pauseBtn && pauseBtn.pressed);

    return { throttle, brake, steer, drift, useItem, pause };
  }

  _readKeyboard(i) {
    const k = this._keys;
    if (i === 0) {
      const throttle = k['KeyW'] ? 1 : 0;
      const brake = k['KeyS'] ? 1 : 0;
      let steer = 0;
      if (k['KeyA']) steer -= 1;
      if (k['KeyD']) steer += 1;
      const drift = !!(k['Space'] || k['KeyE']);   // Shift를 아이템에 내주고 Space로 이동(E는 구 배치 호환)
      const useItem = !!k['ShiftLeft'];
      return { throttle, brake, steer, drift, useItem, pause: false };
    } else {
      const throttle = k['ArrowUp'] ? 1 : 0;
      const brake = k['ArrowDown'] ? 1 : 0;
      let steer = 0;
      if (k['ArrowLeft']) steer -= 1;
      if (k['ArrowRight']) steer += 1;
      const drift = !!k['Digit0'];
      const useItem = !!(k['ShiftRight'] || k['Period']);   // 오른쪽 Shift(구 배치 '.'도 허용)
      return { throttle, brake, steer, drift, useItem, pause: false };
    }
  }

  getPlayerInput(i) {
    return this._cache[i] || emptyInput();
  }

  getMapping() {
    return { ...this.mapping };
  }

  setMapping(mapping) {
    this.mapping = { ...this.mapping, ...mapping };
  }

  listenForButton(callback) {
    this._listenCallback = callback;
  }

  rumble(i, strong, weak, ms) {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = pads[i];
    if (!gp) return;
    const actuator = gp.vibrationActuator;
    if (actuator && typeof actuator.playEffect === 'function') {
      try {
        actuator.playEffect('dual-rumble', {
          duration: ms,
          strongMagnitude: strong,
          weakMagnitude: weak,
        });
      } catch (e) {
        // 미지원 시 무시
      }
    }
  }

  connectedCount() {
    return this._connectedCount;
  }

  anyStartPressed() {
    return !!this._anyStartEdge;
  }

  // 뒤로/취소 edge (패드 B 또는 키보드 Backspace). 결과 화면 → 타이틀 복귀용.
  backPressed() {
    return !!this._backEdge;
  }
}
