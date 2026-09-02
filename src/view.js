// src/view.js — 동적 분할화면 (SplitView)
// 체이스캠 2개 + 두 카트를 모두 담는 합체 카메라.
// auto 모드는 거리 히스테리시스(26m/34m)로 합체↔세로분할을 전환하고,
// 전환 0.5s 동안 분할 화면이 좌우 화면 밖에서 미끄러져 들어온다(scissor wipe).
import * as THREE from 'three';

const MERGE_DIST = 26;        // 이하 → 합체
const SPLIT_DIST = 34;        // 이상 → 분할 (사이 구간은 직전 상태 유지)
const TRANSITION_TIME = 0.5;  // s

// 오버패스(2층 교차) 층 분리 임계. 두 카트의 고도차가 이 값을 넘으면 서로 다른
// 노면(상판 / 그 아래 도로) 위에 있다는 뜻이라, 3D 거리가 아무리 가까워도 한 화면에
// 담을 수 없다 — 합체 카메라는 두 위치의 중점을 보므로 중점 y가 두 층의 중간(harbor
// 6.50m)이 되고, 카메라 높이 = mid.y + CHASE_UP + 1.2 + spread*0.26 이 spread=0에서도
// 12.70m로 상판 밑면(12.45m)을 넘어 하단 카트가 상판 슬래브에 완전히 가려진다.
// (거리만 보던 기존 판정에서는 층간 XZ 거리가 0.3m뿐이라 3D 거리 = 고도차 13~15m
//  < MERGE_DIST(26) → 반드시 합체로 오판했다. 계약이 적어 둔 차폐 임계 spread
//  24.1m 는 두 카트가 모두 하단, 즉 mid.y = 0 을 암묵 가정한 값이다.)
// 임계값 근거 — 5맵 노면 **전 주행폭**(중심선 ±0.95·반폭) 전수 조사, 3D 26m 이내인
// 두 노면 점의 최대 고도차:
//   green/sunset/night 0.00m · harbor-viaduct 6.49m · ravine-crossover 6.11m
//   ↔ 층이 갈린 쌍은 13.00m(harbor) / 15.00m(ravine).
// ★ 중심선만 재면 4.04/4.29m 가 나오지만 그건 과소평가다 — 스위치백 램프에서 두 카트가
//   도로 **반대쪽 가장자리**에 붙으면 3D 거리가 줄어들면서 같은 층인데도 6.49m 까지 벌어진다.
//   6.0 으로 잡으면 그 배치(같은층 배치의 0.0026%)가 거짓 분할된다 → 8.0 으로 올려
//   같은 층 최대(6.49) 위, 층간 최소(13.00) 아래의 빈 구간 한가운데에 둔다.
// 평면 맵은 노면 y가 전부 0이라 dy === 0 → 두 분기 모두 무발동(값 수준 항등).
const LEVEL_SPLIT_DY = 8.0;   // 초과 → 강제 분할 (거리 판정보다 우선)
const LEVEL_HOLD_DY = 6.5;    // 층에서 내려오는 동안 재합체를 지연시키는 히스테리시스

// GLB 카트 실측 전고 2.79m(assets.js KART_SCALE 2.1 × bbox 1.329m) 기준으로
// 시야선이 카트 최상단(약 2.79m)보다 위를 지나도록 뒤/위/시선높이를 올렸다.
// (뒤 8.5, 위 5.0, 시선+2.0 → 카트 위치에서의 시선 높이 ≈ 3.04m, 여유 약 0.25m)
const CHASE_BACK = 8.5;       // 카트 뒤 (m)
const CHASE_UP = 5.0;         // 카트 위 (m)
const CHASE_LOOK_AHEAD = 4.5; // 시선 전방 오프셋 (m)
const CHASE_LOOK_UP = 2.0;

// 경사 트랙: 카메라가 노면/지형 아래로 내려가지 않도록 하는 최후 방어선.
// kart.roadGrade가 없거나 0인 카트(평면 맵, 구버전 kart.js)에서는 절대 발동하지 않는다
// (CHASE_UP 5.0 / 3.7 > CAM_MIN_ABOVE_KART 이므로 무발동 — 기존 동작과 완전히 동일).
const CAM_MIN_ABOVE_KART = 2.2;
const ROAD_GRADE_CLAMP = 0.45; // ±24° — 급경사에서 카메라 리그가 뒤집히지 않도록

const BASE_FOV = 70;
const BOOST_FOV = 80;
const COMBINED_FOV = 62;

const NEAR = 0.3;
const FAR = 2000;

const DIVIDER_WIDTH = 2;      // px
const DIVIDER_COLOR = 0x0b0d12;

// 스크래치 (프레임마다 할당하지 않기 위함)
const _fwd = new THREE.Vector3();
const _fwdB = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _look = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _size = new THREE.Vector2();
const _clearColor = new THREE.Color();

// 프레임레이트 독립 감쇠 보간 계수
function damp(lambda, dt) {
  return 1 - Math.exp(-lambda * dt);
}

function smoothstep(x) {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

// 카트의 전방 단위벡터. kart.heading(=object3d.rotation.y, -Z 전방) 우선.
function kartForward(kart, out) {
  const h = kart && kart.heading;
  if (typeof h === 'number' && Number.isFinite(h)) {
    return out.set(-Math.sin(h), 0, -Math.cos(h));
  }
  if (kart && kart.object3d) {
    kart.object3d.getWorldDirection(out);
    out.y = 0;
    if (out.lengthSq() < 1e-6) out.set(0, 0, -1);
    return out.normalize();
  }
  return out.set(0, 0, -1);
}

// kartForward + 노면 기울기(kart.roadGrade)를 반영한 3D 전방 단위벡터.
// roadGrade가 없거나(구버전 kart.js) 유한하지 않은 값이면(평면 맵) y=0 → kartForward와 완전히 동일.
function kartForward3(kart, out) {
  kartForward(kart, out);
  const g = kart && typeof kart.roadGrade === 'number' && Number.isFinite(kart.roadGrade)
    ? Math.min(ROAD_GRADE_CLAMP, Math.max(-ROAD_GRADE_CLAMP, kart.roadGrade))
    : 0;
  out.y = g;
  return out.normalize();
}

function kartPosition(kart, out) {
  if (kart && kart.position) return out.copy(kart.position);
  if (kart && kart.object3d) return out.copy(kart.object3d.position);
  return out.set(0, 0, 0);
}

export class SplitView {
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;

    this.mode = 'auto';           // 'auto' | 'split' | 'single'
    this._splitActive = false;    // auto 히스테리시스의 현재 상태
    this._blend = 0;              // 0 = 합체, 1 = 분할 (전환 애니메이션)

    this.width = 1;
    this.height = 1;

    // 플레이어별 체이스캠
    this.cameras = [0, 1].map(() => {
      const cam = new THREE.PerspectiveCamera(BASE_FOV, 1, NEAR, FAR);
      cam.position.set(0, CHASE_UP, CHASE_BACK);
      return cam;
    });
    // 두 카트를 모두 담는 합체 카메라
    this.combinedCamera = new THREE.PerspectiveCamera(COMBINED_FOV, 1, NEAR, FAR);

    this._camInit = [false, false];
    this._combinedInit = false;
    this._camLook = [new THREE.Vector3(), new THREE.Vector3()];
    this._combinedLook = new THREE.Vector3();

    this._onResize = () => this._resize();
    window.addEventListener('resize', this._onResize);
    this._resize();
  }

  // ── 공개 API ────────────────────────────────────────────────────────────
  setMode(mode) {
    if (mode !== 'auto' && mode !== 'split' && mode !== 'single') return;
    this.mode = mode;
    if (mode === 'split') this._splitActive = true;
    else if (mode === 'single') this._splitActive = false;
  }

  // 현재 화면 레이아웃 ('single' | 'split') — HUD의 splitLayout 용
  get layout() {
    return this._blend > 0.5 ? 'split' : 'single';
  }

  render(dt, karts) {
    const step = Math.min(Math.max(dt || 0, 0), 0.1);
    const a = karts && karts[0];
    const b = karts && karts[1];

    this._updateLayoutTarget(a, b);
    this._advanceBlend(step);

    if (a) this._updateChase(0, a, step);
    if (b) this._updateChase(1, b, step);
    this._updateCombined(a, b, step);

    this._draw();
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.renderer.setScissorTest(false);
  }

  // ── 내부 ────────────────────────────────────────────────────────────────
  _resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w > 0 && h > 0) this.renderer.setSize(w, h, false);
    this.renderer.getSize(_size);
    this.width = Math.max(1, _size.x);
    this.height = Math.max(1, _size.y);
  }

  _updateLayoutTarget(a, b) {
    if (this.mode === 'split') { this._splitActive = true; return; }
    if (this.mode === 'single') { this._splitActive = false; return; }
    if (!a || !b) { this._splitActive = false; return; }

    kartPosition(a, _pos);
    kartPosition(b, _tmp);

    // ① 층 분리 판정 — 3D 거리보다 먼저 본다. 오버패스 상판과 그 아래 도로처럼
    // 고도가 갈린 두 카트는 다리 구조물이 사이를 가로막아 합체 화면에 함께 담기지
    // 않는다(3D 거리는 26m 미만이라 거리 판정만으로는 항상 '가깝다'가 나온다).
    // 평면 맵에서는 dy === 0 이라 아래 두 줄 모두 무발동이다.
    const dy = Math.abs(_pos.y - _tmp.y);
    if (dy > LEVEL_SPLIT_DY) { this._splitActive = true; return; }
    if (dy > LEVEL_HOLD_DY && this._splitActive) return;

    // ② 같은 층일 때의 거리 히스테리시스
    const d = _pos.distanceTo(_tmp);
    if (d > SPLIT_DIST) this._splitActive = true;
    else if (d < MERGE_DIST) this._splitActive = false;
    // 26~34m 사이는 직전 상태 유지 (히스테리시스)
  }

  _advanceBlend(dt) {
    const target = this._splitActive ? 1 : 0;
    const rate = dt / TRANSITION_TIME;
    if (this._blend < target) this._blend = Math.min(target, this._blend + rate);
    else if (this._blend > target) this._blend = Math.max(target, this._blend - rate);
  }

  _updateChase(i, kart, dt) {
    const cam = this.cameras[i];
    kartPosition(kart, _pos);
    kartForward3(kart, _fwd);

    // 카트 뒤 CHASE_BACK(8.5m) · 위 CHASE_UP(5.0m) — GLB 카트 전고 2.79m를 넘기려 올린 값
    _desired.copy(_pos).addScaledVector(_fwd, -CHASE_BACK);
    _desired.y += CHASE_UP;
    // 경사 최후 방어선: 카트 바로 위 CAM_MIN_ABOVE_KART(2.2m) 아래로는 내려가지 않는다.
    // 평면 맵(_fwd.y===0)에서는 CHASE_UP(5.0) > CAM_MIN_ABOVE_KART(2.2)라 항상 무발동.
    _desired.y = Math.max(_desired.y, _pos.y + CAM_MIN_ABOVE_KART);
    _look.copy(_pos).addScaledVector(_fwd, CHASE_LOOK_AHEAD);
    _look.y += CHASE_LOOK_UP;

    if (!this._camInit[i]) {
      cam.position.copy(_desired);
      this._camLook[i].copy(_look);
      this._camInit[i] = true;
    } else {
      const speed = Math.abs(kart.speed || 0);
      // 빠를수록 조금 더 단단하게 따라붙는다
      const kPos = damp(5 + speed * 0.08, dt);
      cam.position.lerp(_desired, kPos);
      this._camLook[i].lerp(_look, damp(9, dt));
    }
    cam.up.set(0, 1, 0);
    cam.lookAt(this._camLook[i]);

    // 부스트/고속 시 FOV 살짝 증가
    const boosting = (kart.boostTimer || 0) > 0 ? 1 : 0;
    const speedT = Math.min(1, Math.abs(kart.speed || 0) / 55);
    const targetFov = BASE_FOV + (BOOST_FOV - BASE_FOV) * Math.min(1, boosting * 0.75 + speedT * 0.35);
    cam.fov += (targetFov - cam.fov) * damp(6, dt);
  }

  _updateCombined(a, b, dt) {
    const cam = this.combinedCamera;
    if (!a && !b) return;

    let spread = 0;
    if (a && b) {
      kartPosition(a, _pos);
      kartPosition(b, _tmp);
      _mid.copy(_pos).add(_tmp).multiplyScalar(0.5);
      kartForward3(a, _fwd);
      kartForward3(b, _fwdB);
      _fwd.add(_fwdB);
      if (_fwd.lengthSq() < 1e-4) kartForward3(a, _fwd); // 서로 반대 방향이면 P0 기준
      else _fwd.normalize();
      spread = _pos.distanceTo(_tmp);
    } else {
      const k = a || b;
      kartPosition(k, _mid);
      kartForward3(k, _fwd);
      spread = 0;
    }

    // 두 카트가 화면에 모두 들어오도록 거리/고도를 벌린다
    const back = CHASE_BACK + 2.5 + spread * 0.62;
    const up = CHASE_UP + 1.2 + spread * 0.26;

    _desired.copy(_mid).addScaledVector(_fwd, -back);
    _desired.y += up;
    // 경사 최후 방어선(체이스캠과 동일 기준, 두 카트 중점 기준)
    _desired.y = Math.max(_desired.y, _mid.y + CAM_MIN_ABOVE_KART);
    _look.copy(_mid).addScaledVector(_fwd, 2.0);
    _look.y += 1.0;

    if (!this._combinedInit) {
      cam.position.copy(_desired);
      this._combinedLook.copy(_look);
      this._combinedInit = true;
    } else {
      cam.position.lerp(_desired, damp(4.5, dt));
      this._combinedLook.lerp(_look, damp(7, dt));
    }
    cam.up.set(0, 1, 0);
    cam.lookAt(this._combinedLook);

    const boosting = ((a && a.boostTimer > 0) || (b && b.boostTimer > 0)) ? 1 : 0;
    const targetFov = COMBINED_FOV + boosting * 5 + Math.min(10, spread * 0.12);
    cam.fov += (targetFov - cam.fov) * damp(5, dt);
  }

  _setCamera(cam, aspect) {
    if (cam.aspect !== aspect) {
      cam.aspect = aspect;
      cam.updateProjectionMatrix();
    } else {
      cam.updateProjectionMatrix();
    }
  }

  // viewport는 패널 전체, scissor는 실제로 드러난 부분 → 화면 밖에서 미끄러져 들어오는 연출
  _renderPanel(cam, vx, vw, sx, sw) {
    if (sw <= 0.5) return;
    const r = this.renderer;
    const h = this.height;
    this._setCamera(cam, vw / h);
    r.setViewport(vx, 0, vw, h);
    r.setScissor(sx, 0, sw, h);
    r.setScissorTest(true);
    r.render(this.scene, cam);
  }

  _drawDivider(x) {
    const r = this.renderer;
    const w = DIVIDER_WIDTH;
    const px = Math.round(Math.min(this.width - w, Math.max(0, x)));
    r.getClearColor(_clearColor);
    const prevAlpha = r.getClearAlpha();
    r.setScissor(px, 0, w, this.height);
    r.setScissorTest(true);
    r.setClearColor(DIVIDER_COLOR, 1);
    r.clear(true, false, false);
    r.setClearColor(_clearColor, prevAlpha);
  }

  _draw() {
    const r = this.renderer;
    const W = this.width;
    const H = this.height;
    const half = W / 2;
    const p = smoothstep(this._blend);

    if (p <= 0.001) {
      // 완전 합체
      r.setScissorTest(false);
      r.setViewport(0, 0, W, H);
      this._setCamera(this.combinedCamera, W / H);
      r.render(this.scene, this.combinedCamera);
      return;
    }

    if (p < 0.999) {
      // 전환 중: 합체 화면을 먼저 깔고, 좌우 분할 패널이 바깥에서 미끄러져 들어온다
      r.setScissorTest(false);
      r.setViewport(0, 0, W, H);
      this._setCamera(this.combinedCamera, W / H);
      r.render(this.scene, this.combinedCamera);
    }

    const reveal = half * p;               // 각 패널이 드러난 폭
    // 좌: 패널 [0, half), 왼쪽 가장자리부터 드러남
    this._renderPanel(this.cameras[0], 0, half, 0, reveal);
    // 우: 패널 [half, W), 오른쪽 가장자리부터 드러남
    this._renderPanel(this.cameras[1], half, half, W - reveal, reveal);

    if (p >= 0.999) {
      this._drawDivider(half - DIVIDER_WIDTH / 2);
    } else {
      this._drawDivider(reveal - DIVIDER_WIDTH);
      this._drawDivider(W - reveal);
    }

    r.setScissorTest(false);
    r.setViewport(0, 0, W, H);
  }
}
