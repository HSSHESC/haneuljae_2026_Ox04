// src/input.js — Gamepad(Xbox 표준 매핑) 폴링 + 키보드 폴백 + edge 검출 + 리매핑 + rumble.
// 메뉴(타이틀/결과 화면) 조작용 4방향 + 확인/취소 edge도 여기서 만든다(getMenuInput()).
// CONTRACTS.md 명세를 따른다. 다른 모듈을 import하지 않는다.

const DEADZONE = 0.15;

// 표준 Gamepad 매핑(Xbox) 기본 버튼/축 인덱스.
// steerAxis: 좌스틱 X, throttle/brake: RT/LT(버튼 value 0..1), useItem: X, pause: Menu(Start)
// useItem은 계약상 "X 또는 LB"도 허용하므로 대체 버튼을 별도로 고정 확인한다.
// (v5) 드리프트는 게임에서 완전히 제거되었다 — drift 매핑/필드는 이 파일 어디에도 존재하지 않는다.
function defaultMapping() {
  return {
    steerAxis: 0,
    throttle: 7, // RT
    brake: 6,    // LT
    useItem: 2,  // X
    pause: 9,    // Menu/Start
  };
}

const ALT_USEITEM_BUTTON = 4; // LB
const START_ALT_BUTTON = 0;   // A (anyStartPressed에서 "Menu/A" 허용용. 메뉴 confirm과 같은 소스)
const BACK_BUTTON = 1;        // B (뒤로/취소 — 결과 화면에서 타이틀 복귀. 메뉴 cancel과 같은 소스)

// 메뉴(타이틀/결과) 조작 상수 — §B-5.
const DPAD = { up: 12, down: 13, left: 14, right: 15 };
const MENU_REPEAT_DELAY = 0.35; // 최초 눌림 후 첫 반복까지
const MENU_REPEAT_RATE = 0.13;  // 이후 반복 간격
const MENU_STICK_ON = 0.55;     // 좌스틱 눌림 판정
const MENU_STICK_OFF = 0.30;    // 좌스틱 해제 판정(히스테리시스)

function applyDeadzone(v, dz = DEADZONE) {
  return Math.abs(v) < dz ? 0 : v;
}

function emptyInput() {
  return { throttle: 0, brake: 0, steer: 0, useItem: false, pause: false };
}

function emptyMenuInput() {
  return { up: false, down: false, left: false, right: false, confirm: false, cancel: false };
}

// 좌스틱 히스테리시스 래치 갱신: 켜짐 임계 넘으면 true, 꺼짐 임계 밑돌면 false, 그 사이는 유지.
function updateStickLatch(latched, magnitude) {
  if (!latched && magnitude > MENU_STICK_ON) return true;
  if (latched && magnitude < MENU_STICK_OFF) return false;
  return latched;
}

export class InputManager {
  constructor() {
    this.mapping = defaultMapping();

    // 키보드 상태
    this._keys = Object.create(null);
    this._onKeyDown = (e) => {
      this._keys[e.code] = true;
      // 게임 화면에서의 Backspace는 '뒤로' 입력이다 — 브라우저 기본 동작만 막는다.
      // Space는 어떤 액션에도 매핑되지 않지만(v5, 드리프트 제거) 브라우저 스크롤 방지 목적으로 계속 막는다.
      const tag = e.target && e.target.tagName;
      if ((e.code === 'Backspace' || e.code === 'Space') && tag !== 'INPUT' && tag !== 'TEXTAREA') {
        e.preventDefault();
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
    this._anyStartEdge = false;

    // listenForButton: 게임패드 버튼별 이전 눌림 상태 (padIndex -> [bool,...])
    this._prevGamepadButtons = [];
    this._listenCallback = null;

    // getPlayerInput()이 반환할 캐시 (poll()마다 갱신)
    this._cache = [emptyInput(), emptyInput()];

    // getMenuInput() 캐시 + 방향별 리피트 상태기계
    this._menuCache = emptyMenuInput();
    this._menuDirState = {
      up: { held: false, timer: 0, phase: 'delay' },
      down: { held: false, timer: 0, phase: 'delay' },
      left: { held: false, timer: 0, phase: 'delay' },
      right: { held: false, timer: 0, phase: 'delay' },
    };
    this._stickLatch = { up: false, down: false, left: false, right: false };

    this._connectedCount = 0;

    // poll(dt) 미전달 시 내부 시계로 dt를 계산하기 위한 마지막 폴 시각
    this._lastPollTime = null;
  }

  // dt: 초 단위 프레임 시간(선택). 미전달 시 내부 performance.now() 차분으로 대체한다.
  poll(dt) {
    let deltaSeconds;
    if (typeof dt === 'number' && isFinite(dt)) {
      deltaSeconds = dt;
    } else {
      const now = (typeof performance !== 'undefined' && typeof performance.now === 'function')
        ? performance.now() : Date.now();
      deltaSeconds = this._lastPollTime == null ? 0 : (now - this._lastPollTime) / 1000;
      this._lastPollTime = now;
    }

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
    // (메뉴 confirm과 동일 소스 — §B-5)
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
    // (메뉴 cancel과 동일 소스 — §B-5)
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

    // 플레이어별 입력 계산 (주행용 — drift 필드 없음)
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
        useItem: useItemEdge,
        pause: pauseEdge,
      };
    }

    // 메뉴 입력 (WASD ∪ 방향키 ∪ 모든 패드 십자키 ∪ 모든 패드 좌스틱) — §B-5
    this._pollMenuInput(pads, deltaSeconds);
  }

  _pollMenuInput(pads, deltaSeconds) {
    const keys = this._keys;
    const digitalUp = !!(keys['KeyW'] || keys['ArrowUp']);
    const digitalDown = !!(keys['KeyS'] || keys['ArrowDown']);
    const digitalLeft = !!(keys['KeyA'] || keys['ArrowLeft']);
    const digitalRight = !!(keys['KeyD'] || keys['ArrowRight']);

    let dpadUp = false, dpadDown = false, dpadLeft = false, dpadRight = false;
    let stickUpMag = 0, stickDownMag = 0, stickLeftMag = 0, stickRightMag = 0;
    for (let p = 0; p < pads.length; p++) {
      const gp = pads[p];
      if (!gp) continue;
      const bU = gp.buttons[DPAD.up], bD = gp.buttons[DPAD.down];
      const bL = gp.buttons[DPAD.left], bR = gp.buttons[DPAD.right];
      if (bU && bU.pressed) dpadUp = true;
      if (bD && bD.pressed) dpadDown = true;
      if (bL && bL.pressed) dpadLeft = true;
      if (bR && bR.pressed) dpadRight = true;

      const ax0 = gp.axes[0] || 0; // 좌우
      const ax1 = gp.axes[1] || 0; // 상하 (표준 매핑: 위쪽이 -)
      if (-ax0 > stickLeftMag) stickLeftMag = -ax0;
      if (ax0 > stickRightMag) stickRightMag = ax0;
      if (-ax1 > stickUpMag) stickUpMag = -ax1;
      if (ax1 > stickDownMag) stickDownMag = ax1;
    }

    const latch = this._stickLatch;
    latch.up = updateStickLatch(latch.up, stickUpMag);
    latch.down = updateStickLatch(latch.down, stickDownMag);
    latch.left = updateStickLatch(latch.left, stickLeftMag);
    latch.right = updateStickLatch(latch.right, stickRightMag);

    const held = {
      up: digitalUp || dpadUp || latch.up,
      down: digitalDown || dpadDown || latch.down,
      left: digitalLeft || dpadLeft || latch.left,
      right: digitalRight || dpadRight || latch.right,
    };

    const edges = {};
    for (const dir of ['up', 'down', 'left', 'right']) {
      const st = this._menuDirState[dir];
      const isHeld = held[dir];
      let edge = false;
      if (isHeld) {
        if (!st.held) {
          // 최초 눌림 — 즉시 1회 엣지
          edge = true;
          st.timer = 0;
          st.phase = 'delay';
        } else {
          st.timer += deltaSeconds;
          if (st.phase === 'delay') {
            if (st.timer >= MENU_REPEAT_DELAY) {
              edge = true;
              st.timer -= MENU_REPEAT_DELAY;
              st.phase = 'repeat';
            }
          } else if (st.timer >= MENU_REPEAT_RATE) {
            edge = true;
            st.timer -= MENU_REPEAT_RATE;
          }
        }
      } else {
        st.timer = 0;
        st.phase = 'delay';
      }
      st.held = isHeld;
      edges[dir] = edge;
    }

    this._menuCache = {
      up: edges.up,
      down: edges.down,
      left: edges.left,
      right: edges.right,
      confirm: !!this._anyStartEdge,
      cancel: !!this._backEdge,
    };
  }

  _readGamepad(gp) {
    const m = this.mapping;
    const axisVal = gp.axes[m.steerAxis] || 0;
    const steer = applyDeadzone(axisVal);

    const throttleBtn = gp.buttons[m.throttle];
    const brakeBtn = gp.buttons[m.brake];
    const throttle = throttleBtn ? throttleBtn.value : 0;
    const brake = brakeBtn ? brakeBtn.value : 0;

    const useItemBtn = gp.buttons[m.useItem];
    const useItemAlt = gp.buttons[ALT_USEITEM_BUTTON];
    const useItem = !!((useItemBtn && useItemBtn.pressed) || (useItemAlt && useItemAlt.pressed));

    const pauseBtn = gp.buttons[m.pause];
    const pause = !!(pauseBtn && pauseBtn.pressed);

    return { throttle, brake, steer, useItem, pause };
  }

  _readKeyboard(i) {
    const k = this._keys;
    if (i === 0) {
      const throttle = k['KeyW'] ? 1 : 0;
      const brake = k['KeyS'] ? 1 : 0;
      let steer = 0;
      if (k['KeyA']) steer -= 1;
      if (k['KeyD']) steer += 1;
      const useItem = !!k['ShiftLeft'];
      return { throttle, brake, steer, useItem, pause: false };
    } else {
      const throttle = k['ArrowUp'] ? 1 : 0;
      const brake = k['ArrowDown'] ? 1 : 0;
      let steer = 0;
      if (k['ArrowLeft']) steer -= 1;
      if (k['ArrowRight']) steer += 1;
      const useItem = !!(k['ShiftRight'] || k['Period']);   // 오른쪽 Shift(구 배치 '.'도 허용)
      return { throttle, brake, steer, useItem, pause: false };
    }
  }

  getPlayerInput(i) {
    return this._cache[i] || emptyInput();
  }

  // 메뉴(타이틀/결과 화면) 조작 입력 — 전부 이번 프레임 엣지.
  // { up, down, left, right, confirm, cancel }
  // up/down/left/right: WASD ∪ 방향키 ∪ 모든 패드 십자키(12-15) ∪ 모든 패드 좌스틱(축0/1, 히스테리시스
  //   0.55 on / 0.30 off) — 최초 눌림 즉시 1회 + 0.35s 후 0.13s 간격 리피트.
  // confirm/cancel: anyStartPressed()/backPressed()와 동일 소스(리피트 없음, 순수 상승 엣지).
  getMenuInput() {
    return this._menuCache;
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
