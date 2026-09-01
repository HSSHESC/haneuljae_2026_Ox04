// src/kart.js — 아케이드 카트: 물리 + 드리프트 미니터보 + 랩/진행도 + 저폴리 메시
import * as THREE from 'three';

// ---- 튜닝 상수 ----
const MAX_SPEED = 38;          // m/s 일반 최고속
const BOOST_SPEED = 55;        // m/s 부스트 시 최고속
const ACCEL = 26;              // 기본 가속(저속에서 큼, 커브로 감쇠)
const BRAKE_DECEL = 42;
const COAST_DECEL = 7;         // 스로틀 놓았을 때 자연 감속
const REVERSE_MAX = -10;
const STEER_RATE = 2.6;        // rad/s 기본 조향 속도
const DRIFT_STEER_BONUS = 1.15;
const OFFROAD_FACTOR = 0.4;    // 잔디에서 최고속 40%
const WALL_MARGIN = 1.5;       // halfWidth + 1.5 넘으면 벽
const WALL_ALIGN_RATE = 3.0;   // rad/s 접촉 중 heading을 벽 접선으로 정렬하는 최대 각속도
const WALL_SCRAPE_KEEP = 0.88; // 스치는 동안 초당 잔존 속도 비율(≈ -12%/s)
const WALL_IMPACT_MAX = 0.15;  // 접촉 순간 1회 충격 감속 상한(법선 성분 비례)
const WALL_RUMBLE_DUR = 0.25;  // wallHitImpulse가 0으로 감쇠하는 시간(초)
const DRIFT_CHARGE_T = [0.8, 1.6, 2.4];   // 미니터보 단계 차지 시간
const DRIFT_BOOST_DUR = [0.6, 1.0, 1.4];  // 단계별 부스트 지속
const KART_RADIUS = 1.2;
const CATCHUP_LERP = 2.0;         // 견인 배율이 목표로 수렴하는 속도(초당) — 급변 방지
const CATCHUP_BOOST_SHARE = 0.4;  // 부스트 중에는 견인 효과를 40%만 적용(과속 방지)

// ---- 경사 주행(3D 트랙) ----
// 평면 맵(모든 노면 y=0)에서는 roadGrade가 항상 0이라 아래 상수들이 모두 항등으로 접힌다.
const SLOPE_GRAVITY = 14;      // m/s² 경사 성분 가속(아케이드 과장 ≈1.43g). 15% 경사에서 ±2.07
const SLOPE_TOP_K = 1.2;       // 최고속 보정: 1 - K·grade
const SLOPE_TOP_MIN = 0.75;    // 오르막 최고속 하한(15% 오르막 ×0.82)
const SLOPE_TOP_MAX = 1.15;    // 내리막 최고속 상한
const PITCH_LERP = 8;          // 초당 피치 수렴 속도(노면 y 미세 변동을 흡수)
const SPEED_ABS_MAX = BOOST_SPEED * 1.2;  // 긴 내리막에서 속도 발산 방지 상한

const PROC_WHEEL_RADIUS = 0.32;   // 절차 생성 바퀴 반지름
const MODEL_WHEEL_RADIUS = 0.44;  // GLB 바퀴 0.21m × 스케일 2.1

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _spinQ = new THREE.Quaternion();
const _AXIS_X = new THREE.Vector3(1, 0, 0);

function buildKartMesh(color) {
  const g = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ color });
  const dark = new THREE.MeshLambertMaterial({ color: 0x222222 });
  const grey = new THREE.MeshLambertMaterial({ color: 0x888888 });

  // 바디: 메인 박스 + 노즈(테이퍼)
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.45, 2.2), mat);
  body.position.y = 0.45;
  body.castShadow = true;
  g.add(body);
  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.3, 0.7), mat);
  nose.position.set(0, 0.42, -1.35);
  nose.castShadow = true;
  g.add(nose);
  // 리어 스포일러
  const wing = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.08, 0.35), mat);
  wing.position.set(0, 0.95, 1.15);
  g.add(wing);
  const wingPostL = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.3, 0.08), grey);
  wingPostL.position.set(-0.45, 0.78, 1.15);
  g.add(wingPostL);
  const wingPostR = wingPostL.clone();
  wingPostR.position.x = 0.45;
  g.add(wingPostR);

  // 드라이버: 몸통 + 머리 + 헬멧띠
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.5, 0.45), dark);
  torso.position.set(0, 0.9, 0.25);
  torso.castShadow = true;
  g.add(torso);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 8), mat);
  head.position.set(0, 1.32, 0.25);
  head.castShadow = true;
  g.add(head);

  // 바퀴 4개 (앞 2개는 조향 피벗용 그룹)
  const wheelGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.28, 10);
  wheelGeo.rotateZ(Math.PI / 2);
  const wheels = [];       // 회전(굴림)용 메시
  const frontPivots = [];  // 조향용 그룹
  const pos = [
    [-0.72, 0.32, -0.85], [0.72, 0.32, -0.85],  // 앞
    [-0.72, 0.32, 0.85], [0.72, 0.32, 0.85],    // 뒤
  ];
  for (let i = 0; i < 4; i++) {
    const w = new THREE.Mesh(wheelGeo, dark);
    w.castShadow = true;
    if (i < 2) {
      const pivot = new THREE.Group();
      pivot.position.set(...pos[i]);
      pivot.add(w);
      g.add(pivot);
      frontPivots.push(pivot);
    } else {
      w.position.set(...pos[i]);
      g.add(w);
    }
    wheels.push(w);
  }
  return { group: g, wheels, wheelBases: wheels.map(() => null), frontPivots };
}

// GLB 카트 모델을 시각 메시로 준비한다.
// - 원본 template은 건드리지 않는다: clone(true)한 사본에서만 노드를 재배치.
// - 바퀴 노드는 로컬 X 스핀, 앞바퀴는 조향 피벗 Group으로 감싸 스핀·조향을 동시 적용.
function prepareKartModel(model) {
  const g = model.clone(true);

  // 바퀴 노드 수집 (이름 기준). 이미 수집된 노드의 자손은 중복 처리하지 않는다.
  const found = [];
  g.traverse((o) => {
    if (!o.name || !/wheel/i.test(o.name)) return;
    for (const f of found) {
      let p = o.parent;
      while (p) { if (p === f) return; p = p.parent; }
    }
    found.push(o);
  });

  const wheels = [];
  const wheelBases = [];
  const frontPivots = [];
  for (const w of found) {
    if (!w.parent) continue;
    if (/front/i.test(w.name)) {
      // 피벗은 위치만 넘겨받고 회전/스케일은 항등 → steer=0일 때 원래 변환과 동일.
      const pivot = new THREE.Group();
      pivot.name = w.name + '-steer';
      pivot.position.copy(w.position);
      w.parent.add(pivot);
      pivot.add(w);                 // 이전 부모에서 자동 제거
      w.position.set(0, 0, 0);
      frontPivots.push(pivot);
    }
    wheels.push(w);
    wheelBases.push(w.quaternion.clone());  // 스핀은 원래 자세 위에 누적
  }

  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });

  return { group: g, wheels, wheelBases, frontPivots };
}

export class Kart {
  constructor({ color, spawn, name, model }) {
    this.name = name;
    this.color = color;

    // model이 있으면 GLB 사본을 시각 메시로 쓰고 절차 생성은 생략.
    const built = model ? prepareKartModel(model) : buildKartMesh(color);
    this._wheels = built.wheels;
    this._wheelBases = built.wheelBases;
    this._frontPivots = built.frontPivots;
    this._wheelRadius = model ? MODEL_WHEEL_RADIUS : PROC_WHEEL_RADIUS;
    this._wheelSpin = 0;

    // 틸트(드리프트 기울임)용 내부 그룹으로 재구성.
    // 모델 경로에서는 clone 루트(스케일·전방 보정 포함)를 통째로 틸트 그룹에 넣는다.
    this._tiltGroup = new THREE.Group();
    if (model) {
      this.object3d = new THREE.Group();
      this._tiltGroup.add(built.group);
    } else {
      this.object3d = built.group;
      while (built.group.children.length) this._tiltGroup.add(built.group.children[0]);
    }
    this.object3d.add(this._tiltGroup);

    // 노면 피치를 얹기 위해 오일러 순서를 'YXZ'로 고정한다: R = Ry(yaw)·Rx(pitch)·Rz.
    // quaternion.copy() 보다 반드시 앞에 와야 spawn 자세가 같은 순서로 역해석된다.
    // pitch=0(평면 맵)이면 순수 yaw라 기존 'XYZ'와 완전히 동일한 회전이다.
    this.object3d.rotation.order = 'YXZ';
    this.object3d.position.copy(spawn.position);
    this.object3d.quaternion.copy(spawn.quaternion);
    this.position = this.object3d.position;

    // heading: spawn quaternion에서 추출 (-Z 전방)
    _v1.set(0, 0, -1).applyQuaternion(spawn.quaternion);
    this.heading = Math.atan2(-_v1.x, -_v1.z);

    this.speed = 0;
    this.driftLevel = 0;
    this.boostTimer = 0;
    this.spinTimer = 0;
    this.starTimer = 0;

    // 노면 경사(읽기 전용 공개 필드). 평면 맵에서는 둘 다 항상 0.
    this.roadGrade = 0;   // 카트 heading 기준 노면 기울기 dy/d(수평). + = 오르막
    this.roadY = 0;       // 현재 노면 높이(m)

    // 견인(러버밴딩): 선두와 벌어질수록 최고속/가속이 올라간다.
    // 격차 판정은 두 카트를 다 아는 main이 하고, 여기는 배율만 받아 부드럽게 수렴시킨다.
    this.catchup = 1;        // 현재 적용 중인 배율(읽기 전용, 1 = 견인 없음)
    this._catchupTarget = 1;

    // 벽 슬라이드 상태(외부에서 읽기 전용으로 사용: 럼블/사운드/이펙트)
    this.wallContact = false;   // 이번 프레임에 벽을 긁고 있는가
    this.wallHitImpulse = 0;    // 접촉 순간의 법선 성분 크기(0..1), WALL_RUMBLE_DUR 동안 감쇠

    this.lap = 1;
    this.progress = 1;
    this.finished = false;
    this.finishTime = null;

    // 내부 상태
    this._driftActive = false;
    this._driftDir = 0;        // -1 | 1
    this._driftCharge = 0;
    this._slip = 0;            // 횡 슬립 각(시각/미끄러짐)
    this._boostPower = 1;
    this._prevT = null;
    this._crossedStartOnce = false;  // 스폰(출발선 뒤) → 첫 출발선 통과는 랩 증가 없음
    this._spinAngle = 0;
    this._sampleHint = undefined;
    this._pitch = 0;                 // 시각 피치(rad). roadGrade를 PITCH_LERP로 추종
  }

  // 견인 목표 배율 설정(1 = 없음). 즉시 반영이 아니라 update()에서 CATCHUP_LERP로 수렴한다.
  setCatchup(factor) {
    const f = Number(factor);
    this._catchupTarget = Number.isFinite(f) ? Math.max(1, f) : 1;
  }

  applyBoost(power, duration) {
    this._boostPower = Math.max(power, this.boostTimer > 0 ? this._boostPower : 0) || power;
    this.boostTimer = Math.max(this.boostTimer, duration);
  }

  spin() {
    if (this.starTimer > 0) return;
    this.spinTimer = 1;
    this._spinAngle = 0;
    this.speed *= 0.3;
    this._endDrift(false);
  }

  setStar(duration) {
    this.starTimer = Math.max(this.starTimer, duration);
  }

  _endDrift(release) {
    if (release && this.driftLevel > 0) {
      this.applyBoost(1, DRIFT_BOOST_DUR[this.driftLevel - 1]);
    }
    this._driftActive = false;
    this._driftDir = 0;
    this._driftCharge = 0;
    this.driftLevel = 0;
  }

  update(dt, input, track, raceTime) {
    dt = Math.min(dt, 0.05);

    // 타이머
    if (this.boostTimer > 0) this.boostTimer = Math.max(0, this.boostTimer - dt);
    if (this.starTimer > 0) this.starTimer = Math.max(0, this.starTimer - dt);
    if (this.wallHitImpulse > 0) this.wallHitImpulse = Math.max(0, this.wallHitImpulse - dt / WALL_RUMBLE_DUR);

    const controllable = this.spinTimer <= 0 && !this.finished;
    const throttle = controllable ? input.throttle : 0;
    const brake = controllable ? input.brake : 0;
    const steerIn = controllable ? input.steer : 0;
    const driftBtn = controllable ? input.drift : false;

    // ---- 드리프트 상태기계 ----
    if (this._driftActive) {
      if (!driftBtn || this.speed < 6) {
        this._endDrift(driftBtn ? false : true);
      } else {
        this._driftCharge += dt;
        this.driftLevel =
          this._driftCharge >= DRIFT_CHARGE_T[2] ? 3 :
          this._driftCharge >= DRIFT_CHARGE_T[1] ? 2 :
          this._driftCharge >= DRIFT_CHARGE_T[0] ? 1 : 0;
      }
    } else if (driftBtn && Math.abs(steerIn) > 0.25 && this.speed > 12) {
      this._driftActive = true;
      this._driftDir = Math.sign(steerIn);
      this._driftCharge = 0;
      this.driftLevel = 0;
    }

    // ---- 종방향: 부드러운 가속 커브 (최고속 근접 시 가속 감소) ----
    // 견인 배율은 목표로 서서히 수렴시킨다(순위가 바뀔 때 속도가 튀지 않게).
    this.catchup += (this._catchupTarget - this.catchup) * Math.min(1, CATCHUP_LERP * dt);

    const boosting = this.boostTimer > 0;
    let topSpeed = boosting ? BOOST_SPEED * Math.min(1, this._boostPower) : MAX_SPEED;
    // 견인: 뒤처진 카트의 최고속을 올린다. 부스트 중에는 효과를 줄여 상한이 과하게 커지지 않게 한다.
    topSpeed *= boosting ? 1 + (this.catchup - 1) * CATCHUP_BOOST_SHARE : this.catchup;

    // 트랙 샘플
    const s = track.sample(this.position, this._sampleHint);

    // ---- 노면 경사 ----
    // roadDir은 3D 단위 접선(경사 성분 포함)이므로 XZ 길이로 나눠 dy/d(수평)을 얻는다.
    // 스플라인 진행 방향 기준 기울기를 카트 heading 기준으로 부호 정렬(역주행 대응).
    // 평면 맵에서는 roadDir.y === 0 → roadGrade 0 → 아래 보정이 전부 항등이다.
    const rXZ = Math.hypot(s.roadDir.x, s.roadDir.z) || 1;
    const gradeF = s.roadDir.y / rXZ;
    const hfx = -Math.sin(this.heading), hfz = -Math.cos(this.heading); // 전방 f = (-sin h, 0, -cos h)
    const alongSign = (hfx * s.roadDir.x + hfz * s.roadDir.z) < 0 ? -1 : 1;
    this.roadGrade = gradeF * alongSign;
    // 최고속 배율: 오르막에서 낮추고 내리막에서 조금 올린다.
    // 반드시 offRoad 40% 캡 '앞'에 곱한다(계약: offRoad 캡이 마지막에 남아야 한다).
    topSpeed *= THREE.MathUtils.clamp(1 - SLOPE_TOP_K * this.roadGrade, SLOPE_TOP_MIN, SLOPE_TOP_MAX);

    if (s.offRoad) topSpeed *= OFFROAD_FACTOR; // 계약: offRoad면 부스트 중이라도 최고속 40% 제한

    if (boosting) {
      // 부스트: 강제 가속
      this.speed += (topSpeed - this.speed) * Math.min(1, 6 * dt);
    } else if (throttle > 0) {
      const curve = Math.max(0, 1 - Math.max(this.speed, 0) / topSpeed); // 속도 비례 감쇠
      this.speed += ACCEL * this.catchup * throttle * (0.35 + 0.65 * curve) * dt;
      if (this.speed > topSpeed) this.speed += (topSpeed - this.speed) * Math.min(1, 4 * dt);
    }
    if (brake > 0) {
      this.speed -= BRAKE_DECEL * brake * dt;
      if (this.speed < REVERSE_MAX) this.speed = REVERSE_MAX;
    }
    if (throttle <= 0 && brake <= 0) {
      // 자연 감속 (0으로 수렴)
      const d = COAST_DECEL * dt;
      if (this.speed > 0) this.speed = Math.max(0, this.speed - d);
      else this.speed = Math.min(0, this.speed + d);
    }
    if (!boosting && this.speed > topSpeed) {
      this.speed += (topSpeed - this.speed) * Math.min(1, 2.5 * dt); // 잔디 진입 등 초과속 감쇠
    }

    // ---- 경사 중력: 오르막 감속 / 내리막 가속 ----
    // speed 부호와 무관하게 언덕 아래쪽으로 작용한다(후진 중에도 물리적으로 옳다).
    // grade가 0(평면 맵)이면 통째로 건너뛰어 기존 속도 시계열을 비트 단위로 보존한다.
    const slopeAccel = SLOPE_GRAVITY * (this.roadGrade / Math.hypot(1, this.roadGrade));
    if (slopeAccel !== 0) {
      this.speed -= slopeAccel * dt;
      this.speed = THREE.MathUtils.clamp(this.speed, REVERSE_MAX, SPEED_ABS_MAX); // 긴 내리막 발산 방지
    }

    // ---- 조향: 속도 비례 (저속에서 약하고, 고속에서 포화) ----
    const speedFactor = THREE.MathUtils.clamp(Math.abs(this.speed) / 14, 0, 1) *
                        (1 - 0.35 * THREE.MathUtils.clamp((Math.abs(this.speed) - 25) / 30, 0, 1));
    let steer = steerIn;
    if (this._driftActive) {
      // 드리프트: 드리프트 방향으로 기본 회전 + 스틱으로 조절
      steer = this._driftDir * (0.55 + 0.45 * THREE.MathUtils.clamp(steerIn * this._driftDir, -0.6, 1));
      steer *= DRIFT_STEER_BONUS;
    }
    // steer > 0 = 오른쪽 입력. Three.js에서 heading(rotation.y) 증가는 (위에서 볼 때)
    // 반시계 = 왼쪽 회전이므로, 오른쪽으로 돌려면 heading을 감소시켜야 한다.
    const yawRate = -steer * STEER_RATE * speedFactor * Math.sign(this.speed || 1);
    this.heading += yawRate * dt;

    // 슬립(드리프트 시 바깥으로 미끄러짐): 진행 방향이 차체 방향보다 덜 꺾인다.
    // 오른쪽 드리프트(_driftDir=+1)는 heading이 감소하므로 진행각은 heading보다 커야 한다.
    const targetSlip = this._driftActive ? this._driftDir * 0.35 : 0;
    this._slip += (targetSlip - this._slip) * Math.min(1, 6 * dt);

    // ---- 스핀 ----
    if (this.spinTimer > 0) {
      this.spinTimer = Math.max(0, this.spinTimer - dt);
      this._spinAngle = (1 - this.spinTimer) * Math.PI * 2;
      this.speed *= Math.pow(0.2, dt); // 급감
    }

    // ---- 이동 ----
    const moveAngle = this.heading + this._slip;
    this.position.x += -Math.sin(moveAngle) * this.speed * dt;
    this.position.z += -Math.cos(moveAngle) * this.speed * dt;

    // ---- 벽 클램프 + 슬라이드 충돌 ----
    // 벽에 부딪히면 멈추는 대신, 속도의 '벽 법선 성분'만 제거하고 '접선 성분'은 남긴다.
    const s2 = track.sample(this.position, this._sampleHint);
    this._sampleHint = s2.index; // track.sample()의 hint는 t(0..1)가 아니라 샘플 인덱스(0..399)
    const limit = s2.halfWidth + WALL_MARGIN;
    if (Math.abs(s2.lateral) > limit) {
      // lateral을 limit로 클램프해 위치 보정 (왼쪽 + : left = (-roadDir.z, 0, roadDir.x), track.js와 동일 정의)
      _v1.set(-s2.roadDir.z, 0, s2.roadDir.x).normalize(); // left 벡터
      const clamped = THREE.MathUtils.clamp(s2.lateral, -limit, limit);
      _v2.copy(s2.roadPoint).addScaledVector(_v1, clamped);
      this.position.x = _v2.x;
      this.position.z = _v2.z;

      // 도로 진행 방향(XZ 정규화)
      const rLen = Math.hypot(s2.roadDir.x, s2.roadDir.z) || 1;
      const rx = s2.roadDir.x / rLen, rz = s2.roadDir.z / rLen;
      // 벽 바깥 법선 n̂ = left × sign(lateral)  (닿은 쪽 벽에서 코스 바깥을 향한다)
      const lSign = s2.lateral < 0 ? -1 : 1;
      const nx = _v1.x * lSign, nz = _v1.z * lSign;
      // 전방벡터 f = (-sin h, 0, -cos h)
      const fx = -Math.sin(this.heading), fz = -Math.cos(this.heading);
      // 주행 부호: 전/후진(speed 부호)과 진행 쪽(f·roadDir 부호)을 함께 반영해
      // 벽 접선 t̂가 항상 '카트가 실제로 나아가는 쪽'을 가리키게 한다(투영이 진행 방향을 뒤집지 않음).
      const travelSign = this.speed < 0 ? -1 : 1;
      const along = fx * rx + fz * rz;
      const tanSign = (along < 0 ? -1 : 1) * travelSign;
      const tx = rx * tanSign, tz = rz * tanSign;

      // 실제 이동 방향(슬립 포함)이 벽을 파고드는 정도 = 법선 성분 크기(0..1)
      const mx = -Math.sin(moveAngle), mz = -Math.cos(moveAngle);
      const into = THREE.MathUtils.clamp((mx * nx + mz * nz) * travelSign, 0, 1);

      if (into > 0) {
        // 접선 투영: 새 속도 = speed × clamp(f·t̂, 0, 1). 정면 충돌이면 f·t̂≈0 → 거의 정지.
        const proj = THREE.MathUtils.clamp((fx * tx + fz * tz) * travelSign, 0, 1);
        this.speed *= proj;

        // 접촉 '순간' 1회만: 법선 성분 크기에 비례한 충격 감속(최대 15%) + 럼블 플래그
        if (!this.wallContact) {
          this.speed *= 1 - WALL_IMPACT_MAX * into;
          this.wallHitImpulse = into;
        }

        // 접촉 지속 중: heading을 벽 접선으로 부드럽게 정렬(최대 WALL_ALIGN_RATE rad/s)
        let dh = Math.atan2(-tx, -tz) - this.heading; // f(h)=t̂ 가 되는 heading
        dh = Math.atan2(Math.sin(dh), Math.cos(dh));  // [-π, π]로 정규화
        const maxTurn = WALL_ALIGN_RATE * dt;
        this.heading += THREE.MathUtils.clamp(dh, -maxTurn, maxTurn);

        // 스치는 동안의 약한 마찰(초당 약 12%)
        this.speed *= Math.pow(WALL_SCRAPE_KEEP, dt);
        this.wallContact = true;
      } else {
        this.wallContact = false; // 벽에서 떨어져 나가는 중 — 속도에 손대지 않는다
      }
      this._endDrift(false);
    } else {
      this.wallContact = false;
    }
    this.position.y = s2.roadPoint.y;
    this.roadY = s2.roadPoint.y;

    // ---- 랩/진행도 ----
    const t = s2.t;
    if (this._prevT !== null && !this.finished) {
      if (this._prevT > 0.9 && t < 0.1) {
        // 정주행 라인 통과. 스폰이 출발선 뒤(t≈0.99)이므로 최초 1회는 랩을 올리지 않는다.
        if (this._crossedStartOnce) this.lap += 1;
        else this._crossedStartOnce = true;
      } else if (this._prevT < 0.1 && t > 0.9) {
        // 역주행 보정. 최초 통과를 되돌린 경우엔 랩 대신 플래그를 되돌린다.
        if (!this._crossedStartOnce) { /* 출발선을 아직 안 넘음 → 보정할 랩 없음 */ }
        else if (this.lap <= 1) this._crossedStartOnce = false;
        else this.lap -= 1;
      }
      if (this.lap > track.totalLaps) {
        this.finished = true;
        this.finishTime = raceTime !== undefined ? raceTime : null;
      }
    }
    this._prevT = t;
    this.progress = this.lap + t;

    // ---- 시각화 ----
    // 노면 피치를 감쇠 추종(노면 y의 미세 변동이 차체를 떨게 하지 않도록).
    // 전방이 로컬 -Z이고 R_x(θ)·(0,0,-1) = (0, sinθ, -cosθ) 이므로 오르막(전방 y>0)은 θ>0.
    const targetPitch = Math.atan(this.roadGrade);
    this._pitch += (targetPitch - this._pitch) * Math.min(1, PITCH_LERP * dt);
    // order = 'YXZ' → yaw 먼저, 그 다음 로컬 X 피치. 평면 맵에서는 _pitch=0 → 기존과 동일.
    // 롤(뱅킹)은 넣지 않는다 — 도로 리본은 단면이 수평인 능선면이라 물리적 뱅크가 없고,
    // _tiltGroup.rotation.z는 드리프트 전용으로 남긴다.
    this.object3d.rotation.set(this._pitch, this.heading + this._spinAngle, 0);
    // 드리프트/조향 기울임
    // rotation.z > 0 은 오른쪽이 들리는 = 왼쪽으로 기우는 롤. 회전 방향으로 기울이므로 부호 반전.
    const targetTilt = this._driftActive ? -this._driftDir * 0.18 : -steer * 0.06;
    this._tiltGroup.rotation.z += (targetTilt - this._tiltGroup.rotation.z) * Math.min(1, 8 * dt);
    this._tiltGroup.rotation.y = this._slip * 0.8;
    // 바퀴 굴림 + 앞바퀴 조향
    const roll = this.speed * dt / this._wheelRadius;
    this._wheelSpin += roll;
    for (let i = 0; i < this._wheels.length; i++) {
      const base = this._wheelBases[i];
      // GLB 바퀴는 원래 자세(base) 위에 로컬 X 스핀을 얹는다. 절차 메시는 기존대로 누적.
      if (base) this._wheels[i].quaternion.copy(base).multiply(_spinQ.setFromAxisAngle(_AXIS_X, this._wheelSpin));
      else this._wheels[i].rotation.x += roll;
    }
    // 앞바퀴 조향: rotation.y 증가 = 왼쪽을 가리킴이므로 입력 부호를 반전.
    const visSteer = this._driftActive ? -this._driftDir * 0.5 : -steerIn * 0.45;
    for (const p of this._frontPivots) {
      p.rotation.y += (visSteer - p.rotation.y) * Math.min(1, 10 * dt);
    }
    // 스타: 깜빡임 연출(스케일 펄스)
    const pulse = this.starTimer > 0 ? 1 + 0.06 * Math.sin(this.starTimer * 25) : 1;
    this._tiltGroup.scale.setScalar(pulse);
  }
}

export function collideKarts(a, b) {
  const dx = b.position.x - a.position.x;
  const dz = b.position.z - a.position.z;
  const distSq = dx * dx + dz * dz;
  const minDist = KART_RADIUS * 2;
  if (distSq >= minDist * minDist || distSq < 1e-8) return;

  const dist = Math.sqrt(distSq);
  const nx = dx / dist, nz = dz / dist;
  const overlap = minDist - dist;

  // 밀어내기 (절반씩)
  a.position.x -= nx * overlap * 0.5;
  a.position.z -= nz * overlap * 0.5;
  b.position.x += nx * overlap * 0.5;
  b.position.z += nz * overlap * 0.5;

  // 속도 일부 교환 (스칼라 speed 기반 간이 교환)
  const exchanged = (a.speed - b.speed) * 0.25;
  a.speed -= exchanged;
  b.speed += exchanged;

  // 스타 카트가 상대를 스핀시킴
  if (a.starTimer > 0 && b.starTimer <= 0) b.spin();
  if (b.starTimer > 0 && a.starTimer <= 0) a.spin();
}
