import * as THREE from 'three';
import { TRACKS } from './tracks.js';

const SAMPLES = 400;
// 프로토타입 체커 텍스처(1024px)는 픽셀 실측상 1타일에 체커 4칸 (256px 셀 4x4).
// 노면: 체커 1칸 ≈ 1.5m 가 되게 1타일 = 4칸 x 1.5m = 6m 마다 반복.
const ROAD_TILE = 6;
// 벽 텍스처(가로 8칸): 세로는 벽 높이에 1회, 가로는 스트라이프가 2.5m 간격으로
// 보이게 1타일 = 8칸 x 2.5m = 20m 마다 반복.
const WALL_TILE = 20;
const CURB_W = 1.1;
const WALL_OFF = 2.6;   // 중심선 기준 벽 안쪽면 (kart.js 충돌 한계 halfWidth+1.5 바깥)
const WALL_H = 1.4;
// 가로등류: 실측상 팔이 로컬 -Z로 뻗는다 → 팔이 도로 중심을 향하게 side별 ±90° 요 보정.
const ARM_KEYS = new Set(['lightSquare', 'lightCurved']);
// signHighway 실측: 판이 로컬 YZ 평면, 앞면 법선은 -X(+X는 회색 뒷판), 폭 7.33m는 로컬 Z 방향.
const SIGN_HIGHWAY_W = 7.33;

// --- 고저차(3D) 지원 상수 ---
// 노면은 지형보다 GROUND_SINK 만큼 위에 뜬다. 평면 맵의 기존 원판 y=-0.05와 같은 값이라
// 평면 맵에서는 시각 구성이 완전히 동일하다.
const GROUND_SINK = 0.05;
const PLATEAU_PAD = 5.0;      // 노면 평탄대 반경 = halfWidth + 이 값 (벽/연석/깃발/카트한계 포함)
const TERRAIN_FALLOFF = 35;   // 평탄대 밖에서 기저 고도로 수렴하는 폭(m)
const GRID_CELL = 4.0;        // 지형 격자 셀 크기(m)
const TALUS_PASSES = 4;
const TALUS_MAX_GRAD = Math.tan((38 * Math.PI) / 180); // ≈0.781 — 지형 최대 경사 38°
const HILL_A1 = 4.0, HILL_W1 = 130;   // 저주파 언덕
const HILL_A2 = 1.6, HILL_W2 = 62;    // 고주파 굴곡

// 폐곡선 트랙: Catmull-Rom 닫힌 스플라인 + 도로/연석/벽/출발선/게이트/부스터 패드/
// 프롭/깃발/능선/장식/아이템 박스. 공개 필드 boostPads = [{position, radius}].
// def는 tracks.js의 TRACKS 원소, assets는 assets.js의 결과(둘 다 생략 가능 — 폴백).
export class Track {
  constructor(scene, def, assets) {
    this.def = def || TRACKS[0];
    this.assets = assets || null;
    this._scene = scene;
    this.id = this.def.id;
    this.name = this.def.name;
    this.totalLaps = 3;
    this.halfWidth = typeof this.def.halfWidth === 'number' ? this.def.halfWidth : 9;
    this.theme = this.def.theme || {};

    // 자기가 만든 리소스만 추적 (clone된 프롭은 원본과 공유이므로 넣지 않는다)
    this._ownGeo = new Set();
    this._ownMat = new Set();
    this._propRoots = [];

    // controlPoints는 [x, z](평면) 또는 [x, y, z](고저차) 두 형식을 받는다.
    // 판별은 원소 배열 길이로만 하고, 한 맵 안에서 섞이면 즉시 throw한다(조용한 실패 금지).
    const raw = this.def.controlPoints;
    const dim = raw[0].length >= 3 ? 3 : 2;
    for (const p of raw) {
      if ((p.length >= 3 ? 3 : 2) !== dim) {
        throw new Error(
          `[Track ${this.id}] controlPoints 차원 혼용: 맵 전체가 [x,z] 또는 [x,y,z] 중 하나여야 한다`
        );
      }
    }
    const cps = dim === 3
      ? raw.map((p) => new THREE.Vector3(p[0], p[1], p[2]))
      : raw.map((p) => new THREE.Vector3(p[0], 0, p[1]));
    // y가 전부 0이면 3D 형식이어도 평면 경로로 떨어진다 (기존 맵과 완전 동일 출력).
    this._hasElevation = dim === 3 && cps.some((c) => c.y !== 0);
    this.curve = new THREE.CatmullRomCurve3(cps, true, 'centripetal', 0.5);

    // --- 스플라인 샘플 캐시 (sample() 최근접 탐색 + 리본 생성 + UV용) ---
    this._pts = [];   // 중심선 점 (y = 노면 높이)
    this._dirs = [];  // 주행 방향 단위벡터 (XZ 평탄 — left/yaw 계산의 기준)
    this._dirs3 = []; // 주행 방향 단위벡터 (3D — 경사 성분 포함)
    for (let i = 0; i < SAMPLES; i++) {
      const t = i / SAMPLES;
      this._pts.push(this.curve.getPointAt(t));
      const tan = this.curve.getTangentAt(t);
      const flat = tan.clone().setY(0).normalize();
      this._dirs.push(flat);
      this._dirs3.push(this._hasElevation ? tan.normalize() : flat.clone());
    }
    this.length = this.curve.getLength();

    // 샘플별 누적 호길이 (리본 UV의 종방향 좌표). 경사에서 UV가 늘어나지 않게 3D 길이로 잰다
    // (평면 맵에서는 y차가 0이라 기존 값과 완전히 동일).
    this._cum = [0];
    for (let i = 0; i < SAMPLES; i++) {
      const a = this._pts[i], b = this._pts[(i + 1) % SAMPLES];
      this._cum.push(this._cum[i] + (this._hasElevation
        ? Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
        : Math.hypot(b.x - a.x, b.z - a.z)));
    }

    let br = 0, sr = Infinity;
    for (const p of this._pts) {
      const r = Math.hypot(p.x, p.z);
      br = Math.max(br, r);
      sr = Math.min(sr, r);
    }
    this._trackOuterRadius = br;   // 원점~중심선 최대거리 — 산 배치가 트랙을 피하는 데 쓴다
    this._trackInnerRadius = sr;   // 원점~중심선 최소거리 — 지형 질의 조기 종료용

    // 최소 곡률반경(XZ). 코너 안쪽으로 R 이상 오프셋하면 곡률중심을 지나 자기 자신과
    // 겹치고, 그 안에서 "중심선 최근접" 기반 높이장이 불연속이 된다.
    // → 노면 평탄대 반경을 R 아래로 제한한다. 최소한 벽(hw+2.6)은 덮어야 한다.
    let rmin = Infinity;
    for (let i = 0; i < SAMPLES; i++) {
      const A = this._pts[(i - 1 + SAMPLES) % SAMPLES], B = this._pts[i], C = this._pts[(i + 1) % SAMPLES];
      const a = Math.hypot(B.x - C.x, B.z - C.z);
      const b = Math.hypot(A.x - C.x, A.z - C.z);
      const c = Math.hypot(A.x - B.x, A.z - B.z);
      const cross2 = Math.abs((B.x - A.x) * (C.z - A.z) - (B.z - A.z) * (C.x - A.x));
      if (cross2 < 1e-9) continue;
      rmin = Math.min(rmin, (a * b * c) / (2 * cross2));
    }
    // 400샘플(≈2m 간격) 외접원 추정은 곡률 첨두를 뭉개서 해석 최소값을 최대 20% 과대평가한다
    // (tracks.js 주석의 해석값 대비 실측: green 14.07/13.42, coastal 24.28/20.22) → 0.8 안전계수.
    this._minCurveRadius = rmin;
    const padFloor = WALL_OFF + 0.6;   // 벽(hw+2.6) 밑동은 반드시 평탄대 안이어야 한다
    this._plateauPad = Math.max(
      padFloor,
      Math.min(PLATEAU_PAD, rmin * 0.8 - 0.5 - this.halfWidth)
    );
    if (this._hasElevation && rmin - 0.5 - this.halfWidth < padFloor) {
      console.warn(`[Track ${this.id}] 최소곡률반경(~${rmin.toFixed(1)}m)이 평탄대 하한`
        + `(halfWidth+${padFloor})보다 작다 — 급코너 안쪽에서 지형이 접힐 수 있다`);
    }
    this._groundRadius = br + 150;

    // --- 씬 그룹 ---
    this.group = new THREE.Group();

    // 공개 필드: 부스터 패드 (main/kart가 접촉 판정에 사용)
    this.boostPads = [];
    // 지형 높이 격자 (고저차 맵에서만 _buildTerrain이 채운다). 평면 맵은 null.
    this._terrain = null;

    this._applyEnvironment(scene);
    this._buildGround();
    this._buildMountains();
    this._buildRoad();
    this._buildCurbs();
    this._buildWalls();
    this._buildStartLine();
    this._buildStartGate();
    this._buildBoostPads();
    this._buildProps();
    this._buildFlags();
    this._buildDecorations();
    this._computeItemBoxPositions();

    scene.add(this.group);
  }

  // ---------- 공개 API ----------

  // 출발선 뒤 2열 그리드 스폰 (전방을 향함)
  getSpawnTransforms(n) {
    const out = [];
    const rowGap = 5;      // 종방향 간격
    const colOff = 3;      // 횡방향 오프셋
    const startBack = 8;   // 출발선 뒤 거리(m) → t 환산
    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / 2);
      const col = i % 2;
      const dist = startBack + row * rowGap;
      let t = 1 - dist / this.length;
      t = ((t % 1) + 1) % 1;
      const p = this.curve.getPointAt(t);
      const dir = this.curve.getTangentAt(t).setY(0).normalize();
      const left = new THREE.Vector3(-dir.z, 0, dir.x); // 왼쪽 +
      const position = p.clone()
        .addScaledVector(left, col === 0 ? colOff : -colOff);
      position.y = this._roadY(position.x, position.z);
      // 전방 = 주행 방향(dir)을 바라보는 표준 lookAt 쿼터니언
      const quaternion = new THREE.Quaternion().setFromRotationMatrix(
        new THREE.Matrix4().lookAt(position, position.clone().add(dir), new THREE.Vector3(0, 1, 0))
      );
      out.push({ position, quaternion });
    }
    return out;
  }

  // 최근접 탐색. hint: 전 프레임 인덱스(optional) — 있으면 국소 탐색
  sample(position, hint) {
    let bestI = 0;
    let bestD = Infinity;
    if (typeof hint === 'number' && hint >= 0) {
      const H = Math.round(hint) % SAMPLES;
      const R = 25; // 국소 창
      for (let k = -R; k <= R; k++) {
        const i = (H + k + SAMPLES) % SAMPLES;
        const d = sqDistXZ(position, this._pts[i]);
        if (d < bestD) { bestD = d; bestI = i; }
      }
      // 국소 결과가 너무 멀면 전역 재탐색
      if (bestD > 40 * 40) bestD = Infinity;
    }
    if (bestD === Infinity) {
      for (let i = 0; i < SAMPLES; i++) {
        const d = sqDistXZ(position, this._pts[i]);
        if (d < bestD) { bestD = d; bestI = i; }
      }
    }

    const flatDir = this._dirs[bestI];
    const roadPoint = this._pts[bestI].clone();
    // x,z는 중심선 샘플 그대로. y만 질의 위치의 실제 노면 높이로 바꾼다(계단 방지).
    roadPoint.y = this._roadY(position.x, position.z, bestI);
    const roadDir = this._dirs3[bestI].clone(); // 3D 접선 (경사 성분 포함)
    // left는 반드시 XZ 평탄 접선에서 만든다 — 3D roadDir로 만들면 비단위가 되어
    // lateral이 경사에서 과소평가된다.
    const left = new THREE.Vector3(-flatDir.z, 0, flatDir.x);
    const toPos = new THREE.Vector3(position.x - roadPoint.x, 0, position.z - roadPoint.z);
    const lateral = toPos.dot(left);
    const halfWidth = this.halfWidth;
    return {
      t: bestI / SAMPLES,
      index: bestI, // 다음 프레임 hint 용 (계약 외 보너스 필드)
      roadPoint,
      roadDir,
      lateral,
      halfWidth,
      offRoad: Math.abs(lateral) > halfWidth,
    };
  }

  // 자기가 add한 오브젝트 전부 제거. clone 프롭은 원본과 지오메트리/머티리얼을
  // 공유하므로 dispose하지 않고 씬에서 떼어내기만 한다.
  dispose(scene) {
    for (const root of this._propRoots) {
      if (root.parent) root.parent.remove(root);
    }
    this._propRoots.length = 0;

    const s = scene || this._scene;
    if (s) s.remove(this.group);

    for (const g of this._ownGeo) g.dispose();
    for (const m of this._ownMat) m.dispose();
    this._ownGeo.clear();
    this._ownMat.clear();

    this.group.clear();
    this.itemBoxPositions = [];
    this.boostPads = [];
    this._terrain = null;
    this._scene = null;
  }

  // ---------- 내부 헬퍼 ----------

  // assets.textures에서 조회. 없으면 null(→ 호출부가 단색 폴백).
  _tex(key) {
    const t = key && this.assets && this.assets.textures ? this.assets.textures[key] : null;
    if (!t) return null;
    if (t.wrapS !== THREE.RepeatWrapping || t.wrapT !== THREE.RepeatWrapping) {
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.RepeatWrapping;
      t.needsUpdate = true;
    }
    return t;
  }

  // 텍스처가 있으면 흰색 틴트(에셋 원색 유지), 없으면 테마 단색.
  _mat(Ctor, color, map, extra) {
    const params = Object.assign({ color: map ? 0xffffff : color }, extra || {});
    if (map) params.map = map;
    const m = new Ctor(params);
    this._ownMat.add(m);
    return m;
  }

  _own(geo) {
    this._ownGeo.add(geo);
    return geo;
  }

  // ---------- 높이장 (평면 맵에서는 항등: _roadY≡0, _groundY≡-0.05) ----------

  // 중심선 샘플 중 XZ 최근접 인덱스 (브루트포스 — 400샘플 규모에서 공간해시보다 빠르다)
  _nearestIndex(x, z) {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < SAMPLES; i++) {
      const p = this._pts[i];
      const dx = x - p.x, dz = z - p.z;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; bi = i; }
    }
    return bi;
  }

  // 노면(도로 리본) 높이. 리본은 "각 단면이 수평인 직선 능선면"이므로,
  // 질의점의 횡오프셋(lateral)만큼 밀어낸 세그먼트 위에서 u를 구해 y를 선형보간하면
  // 리본 표면과 정확히 일치한다(중심선 세그먼트 보간은 최대 0.2m 오차 → 지형이 도로를 뚫는다).
  _roadY(x, z, hintIndex) {
    if (!this._hasElevation) return 0;
    const i = (typeof hintIndex === 'number') ? hintIndex : this._nearestIndex(x, z);
    const L = this._dirs[i];
    const lat = (x - this._pts[i].x) * (-L.z) + (z - this._pts[i].z) * (L.x);
    let bestD = Infinity, bestY = this._pts[i].y;
    const pairs = [[(i - 1 + SAMPLES) % SAMPLES, i], [i, (i + 1) % SAMPLES]];
    for (const [ia, ib] of pairs) {
      const A = this._pts[ia], B = this._pts[ib];
      const la = this._dirs[ia], lb = this._dirs[ib];
      const ax = A.x + (-la.z) * lat, az = A.z + (la.x) * lat;
      const bx = B.x + (-lb.z) * lat, bz = B.z + (lb.x) * lat;
      const ex = bx - ax, ez = bz - az;
      const l2 = ex * ex + ez * ez;
      if (l2 < 1e-12) continue;
      let u = ((x - ax) * ex + (z - az) * ez) / l2;
      u = u < 0 ? 0 : (u > 1 ? 1 : u);
      const dx = x - (ax + ex * u), dz = z - (az + ez * u);
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; bestY = A.y + (B.y - A.y) * u; }
    }
    return bestY;
  }

  // 기저 지형 노이즈. 원경(능선 링 구간)에서는 0으로 게이트해 산 밑동이 뜨지 않게 한다.
  _hills(x, z) {
    const gate = 1 - smoothstep01((Math.hypot(x, z) - (this._trackOuterRadius + 60)) / 50);
    if (gate <= 0) return 0;
    return (valueNoise(x / HILL_W1, z / HILL_W1) * HILL_A1
          + valueNoise(x / HILL_W2 + 11.3, z / HILL_W2 - 7.1) * HILL_A2) * gate;
  }

  // 중심선 최근접 거리가 확실히 감쇠 범위 밖이면 최근접 탐색을 건너뛴다.
  // 원점 기준 반경만으로 거리의 하한을 잡는 정확한 판정이다(근사 아님) — 지형 격자
  // 정점의 60%가 여기서 걸러진다(coastal 실측: 빌드 268ms → 89ms).
  _farFromRoad(x, z) {
    const reach = this.halfWidth + this._plateauPad + TERRAIN_FALLOFF;
    const r = Math.hypot(x, z);
    return (r - this._trackOuterRadius > reach) || (this._trackInnerRadius - r > reach);
  }

  // 지형면 높이. 노면 평탄대(halfWidth + _plateauPad) 안에서는 노면보다 정확히
  // GROUND_SINK 만큼 아래, 밖에서는 TERRAIN_FALLOFF에 걸쳐 기저 지형으로 수렴.
  _groundY(x, z, hintIndex) {
    if (!this._hasElevation) return -GROUND_SINK;
    if (hintIndex === undefined && this._farFromRoad(x, z)) return this._hills(x, z) - GROUND_SINK;
    const i = (typeof hintIndex === 'number') ? hintIndex : this._nearestIndex(x, z);
    const p = this._pts[i];
    const d = Math.hypot(x - p.x, z - p.z);
    const w = 1 - smoothstep01((d - (this.halfWidth + this._plateauPad)) / TERRAIN_FALLOFF);
    if (w >= 1) return this._roadY(x, z, i) - GROUND_SINK;
    return this._roadY(x, z, i) * w + this._hills(x, z) * (1 - w) - GROUND_SINK;
  }

  // 실제로 렌더되는 지형 메시 표면의 높이. 지형 격자가 있으면 렌더러와 동일한
  // 삼각형 분할((v00,v10,v01)/(v11,v01,v10) — PlaneGeometry의 대각선은 v01-v10)로
  // 무게중심 보간한다. 평면 맵은 격자가 없어 _groundY(≡ -GROUND_SINK)로 떨어지므로
  // 기존 배치와 완전히 동일하다.
  _terrainSurfaceY(x, z) {
    const T = this._terrain;
    if (!T) return this._groundY(x, z);
    const fc = (x + T.half) / T.cell, fr = (z + T.half) / T.cell;
    const c = Math.floor(fc), r = Math.floor(fr);
    if (c < 0 || r < 0 || c >= T.SEG || r >= T.SEG) return this._groundY(x, z);
    const fx = fc - c, fz = fr - r;
    const v00 = r * T.cols + c, v10 = v00 + 1, v01 = v00 + T.cols, v11 = v01 + 1;
    return (fx + fz <= 1)
      ? (1 - fx - fz) * T.h[v00] + fx * T.h[v10] + fz * T.h[v01]
      : (fx + fz - 1) * T.h[v11] + (1 - fx) * T.h[v01] + (1 - fz) * T.h[v10];
  }

  _applyEnvironment(scene) {
    const th = this.theme;
    if (!scene) return;
    if (th.sky !== undefined) {
      if (scene.background && scene.background.isColor) scene.background.setHex(th.sky);
      else scene.background = new THREE.Color(th.sky);
    }
    if (th.fog) {
      if (scene.fog && scene.fog.isFog) {
        scene.fog.color.setHex(th.fog.color);
        scene.fog.near = th.fog.near;
        scene.fog.far = th.fog.far;
      } else {
        scene.fog = new THREE.Fog(th.fog.color, th.fog.near, th.fog.far);
      }
    }
  }

  // ---------- 내부 빌드 ----------

  _buildGround() {
    // 지면은 텍스처를 쓰지 않는다: ground 계열 준단색+1~2px 격자 텍스처는 밉맵에서
    // 완전히 사라지는 실측 문제 → 채도 있는 단색이 더 낫다.
    if (this._hasElevation) { this._buildTerrain(); return; }
    const r = this._groundRadius;
    const geo = this._own(new THREE.CircleGeometry(r, 64));
    geo.rotateX(-Math.PI / 2);
    const mat = this._mat(THREE.MeshLambertMaterial, this.theme.groundColor ?? 0x4c9a3f, null);
    const ground = new THREE.Mesh(geo, mat);
    ground.position.y = -0.05;
    ground.receiveShadow = true;
    this.group.add(ground);
  }

  // 고저차 맵 전용 지형: 도로 고도장을 따라 조각된 단일 격자 메시(드로우콜 1).
  // 원판 대신 정사각 판을 쓰며 원점 중심·같은 색이라 평면 맵과 시각 구성이 이어진다.
  _buildTerrain() {
    const span = this._groundRadius * 2;
    const SEG = Math.min(192, Math.max(64, Math.ceil(span / GRID_CELL)));
    const geo = this._own(new THREE.PlaneGeometry(span, span, SEG, SEG));
    geo.rotateX(-Math.PI / 2); // (x,y,0) → (x,0,-y): 행=z 증가, 열=x 증가
    const attr = geo.attributes.position;
    const n = attr.count;
    const h = new Float32Array(n);
    const locked = new Uint8Array(n);
    const P = this.halfWidth + this._plateauPad;

    for (let v = 0; v < n; v++) {
      const x = attr.getX(v), z = attr.getZ(v);
      if (this._farFromRoad(x, z)) { h[v] = this._hills(x, z) - GROUND_SINK; continue; }
      const i = this._nearestIndex(x, z);
      const p = this._pts[i];
      const d = Math.hypot(x - p.x, z - p.z);
      h[v] = this._groundY(x, z, i);
      locked[v] = d <= P ? 1 : 0; // 평탄대 정점은 노면과 정확히 일치 → 완화 패스에서 고정
    }

    // 탈루스(경사 상한) 완화: 공간적으로 가까운 두 구간 사이의 절벽/주름을 없앤다.
    // 잠긴 정점은 움직이지 않고 상대만 끌어올린다 → 평탄대 경계 조건이 보존된다.
    const cols = SEG + 1;
    const cell = span / SEG;
    const maxStep = TALUS_MAX_GRAD * cell;
    for (let pass = 0; pass < TALUS_PASSES; pass++) {
      for (let row = 0; row <= SEG; row++) {
        for (let col = 0; col <= SEG; col++) {
          const a = row * cols + col;
          if (col < SEG) relaxEdge(h, locked, a, a + 1, maxStep);
          if (row < SEG) relaxEdge(h, locked, a, a + cols, maxStep);
        }
      }
    }

    this._clampUnderRoad(h, locked, SEG, cols, span, cell);

    for (let v = 0; v < n; v++) attr.setY(v, h[v]);
    attr.needsUpdate = true;
    geo.computeVertexNormals();

    // 완성된 격자를 보관한다. 탈루스 완화와 _clampUnderRoad를 거친 뒤의 높이는
    // 해석식 _groundY와 최대 ±3m까지 어긋나므로(실측: alpine-pass 산자락),
    // 지면에 얹는 오브젝트는 반드시 이 격자에서 높이를 읽어야 한다(_terrainSurfaceY).
    this._terrain = { h, SEG, cols, cell, half: span / 2 };

    const mat = this._mat(THREE.MeshLambertMaterial, this.theme.groundColor ?? 0x4c9a3f, null);
    const ground = new THREE.Mesh(geo, mat);
    ground.receiveShadow = true;
    this.group.add(ground);
  }

  // 격자 정점을 노면 높이에 맞춰도, 4m 셀의 선형 보간은 굽은 노면을 재현하지 못해
  // 셀 내부에서 지형이 도로 위로 몇 cm 솟는다(코너 바깥 가장자리에서 실측 +2.6cm).
  // 각 삼각형 내부 표본에서 초과분만큼 그 삼각형의 세 정점을 함께 내려
  // "지형 ≤ 노면 - GROUND_SINK" 를 빌드 타임 불변식으로 만든다.
  // (무게중심 가중치 합이 1이므로 세 정점을 excess만큼 내리면 보간값도 정확히 excess만큼 내려간다.)
  // 보정은 야코비 방식 — 정점별로 "인접 구속들이 요구하는 최대 하강량"을 모아 한 번에 적용한다.
  // 가우스-자이델처럼 누적 차감하면 좁은 코너에서 과보정되어 1m 넘는 도랑이 파인다(실측).
  _clampUnderRoad(h, locked, SEG, cols, span, cell) {
    const P = this.halfWidth + this._plateauPad;
    const half = span / 2;
    const SP = [[1 / 3, 1 / 3], [2 / 3, 2 / 3], [0.5, 0.5]]; // 두 삼각형 무게중심 + 공유 대각 중점
    const cons = []; // [v0,v1,v2,b0,b1,b2,target]
    for (let r = 0; r < SEG; r++) {
      for (let c = 0; c < SEG; c++) {
        const v00 = r * cols + c, v10 = v00 + 1, v01 = v00 + cols, v11 = v01 + 1;
        // 평탄대에 걸치지 않는 셀은 건너뛴다 (평탄대 폭 2(hw+5) >> 셀 4m 라 누락 없음)
        if (!locked[v00] && !locked[v10] && !locked[v01] && !locked[v11]) continue;
        for (const [fx, fz] of SP) {
          const x = c * cell - half + fx * cell;
          const z = r * cell - half + fz * cell;
          const i = this._nearestIndex(x, z);
          const p = this._pts[i];
          if (Math.hypot(x - p.x, z - p.z) > P) continue; // 평탄대 밖은 노면 구속 없음
          const target = this._roadY(x, z, i) - GROUND_SINK;
          // PlaneGeometry의 사각형 분할: (v00,v10,v01) / (v11,v01,v10)
          if (fx + fz <= 1) cons.push([v00, v10, v01, 1 - fx - fz, fx, fz, target]);
          else cons.push([v11, v01, v10, fx + fz - 1, 1 - fx, 1 - fz, target]);
        }
      }
    }
    if (!cons.length) return;
    const drop = new Map();
    for (const k of cons) {
      const ex = k[3] * h[k[0]] + k[4] * h[k[1]] + k[5] * h[k[2]] - k[6];
      if (ex <= 0) continue;
      for (let s = 0; s < 3; s++) {
        const v = k[s];
        if (!(drop.get(v) >= ex)) drop.set(v, ex);
      }
    }
    // 세 정점이 모두 ex 이상 내려가므로 보간값도 ex 이상 내려간다 → 한 번에 모든 구속 충족.
    for (const [v, d] of drop) h[v] -= d;
  }

  // 원거리 산 능선 링: 저폴리 5각뿔을 지면 가장자리에 두르고 fog에 잠기게 둔다.
  _buildMountains() {
    const geo = this._own(new THREE.ConeGeometry(1, 1, 5));
    geo.translate(0, 0.5, 0); // 밑면이 y=0에 접지
    const mat = this._mat(THREE.MeshLambertMaterial, this.theme.mountainColor ?? 0x6e6e7a, null);
    let seed = 31;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed & 0xffff) / 0xffff;
    };
    // 트랙 바깥 경계: 원점에서 가장 먼 중심선 점 + 도로 반폭 + 벽/연석 여유.
    // 능선 밑동이 이 반경 안으로 들어오면 도로 위로 산이 겹쳐 보인다(코스탈 그랜드투어에서 실제 발생).
    const outer = this._trackOuterRadius + this.halfWidth + 8;
    // 링은 지면 원판 안쪽(fog 감쇠 구간)에 두되, 트랙이 큰 코스에서는 바깥으로 밀어낸다.
    const ringR = Math.max(this._groundRadius * 0.72, outer + 60);
    const n = 26;
    for (let k = 0; k < n; k++) {
      const ang = ((k + rand() * 0.5) / n) * Math.PI * 2;
      const rad = ringR * (0.92 + rand() * 0.14);
      const h = 28 + rand() * 46;
      // 폭 클램프 3중: 기본 크기 / 지면 원판 밖으로 안 나가게 / 트랙 위로 안 덮치게
      const w = Math.min(50 + rand() * 65, this._groundRadius - rad - 5, rad - outer);
      if (w < 12) continue;   // 남는 폭이 없으면 그 자리는 비운다(찌그러진 원뿔을 두지 않는다)
      const m = new THREE.Mesh(geo, mat);
      m.scale.set(w, h, w);
      m.rotation.y = rand() * Math.PI * 2;
      const mx = Math.cos(ang) * rad, mz = Math.sin(ang) * rad;
      // 밑동을 실제 지형면에 얹는다. 평면 맵에서는 격자가 없어 -GROUND_SINK(=-0.05)로
      // 떨어지므로 기존과 완전히 동일하고, 고저차 맵에서는 능선 링이 언덕 위에 뜨거나
      // 파묻히지 않는다(실측: alpine-pass 에서 -3.33 ~ +1.96m 어긋나 있었다).
      m.position.set(mx, this._terrainSurfaceY(mx, mz), mz);
      this.group.add(m);
    }
  }

  // 중심선 기준 좌측(+) innerOff..outerOff 구간의 리본 (닫힘). 각 단면은 수평이며
  // y는 "절대 높이"가 아니라 노면 기준 상대 오프셋이다(평면 맵에서는 p.y=0이라 동일).
  // withUV: 종방향=누적 호길이/ROAD_TILE, 횡방향=오프셋/ROAD_TILE (체커 1칸 ≈ 1.5m)
  _ribbonGeometry(innerOff, outerOff, y, withUV) {
    const pos = [];
    const uvs = [];
    const idx = [];
    for (let i = 0; i <= SAMPLES; i++) {
      const j = i % SAMPLES;
      const p = this._pts[j], d = this._dirs[j];
      const lx = -d.z, lz = d.x; // 왼쪽 단위벡터
      pos.push(p.x + lx * innerOff, p.y + y, p.z + lz * innerOff);
      pos.push(p.x + lx * outerOff, p.y + y, p.z + lz * outerOff);
      if (withUV) {
        const u = this._cum[i] / ROAD_TILE;
        uvs.push(u, innerOff / ROAD_TILE);
        uvs.push(u, outerOff / ROAD_TILE);
      }
    }
    for (let i = 0; i < SAMPLES; i++) {
      const a = i * 2, b = a + 1, c = a + 2, e = a + 3;
      // a=좌측(innerOff), b=우측(outerOff). innerOff > outerOff 이므로
      // CCW(위에서 볼 때) = a→c→b 순서여야 면 법선이 +Y가 된다.
      idx.push(a, c, b, b, c, e);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    if (withUV) geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return this._own(geo);
  }

  _buildRoad() {
    const hw = this.halfWidth;
    const geo = this._ribbonGeometry(hw, -hw, 0, true);
    // 밝은 체커(roadLight) x 테마 틴트: 어두운 체커는 두 색 명암차가 2%뿐이라
    // 단색으로 보이는 실측 문제 → 밝은 체커에 색을 곱해 체커를 살린다.
    // 텍스처가 없으면 틴트색 단색 폴백.
    const map = this._tex(this.theme.road);
    const tint = this.theme.roadTint ?? 0x3b3b40;
    const params = { color: tint };
    if (map) params.map = map;
    const mat = new THREE.MeshLambertMaterial(params);
    this._ownMat.add(mat);
    const road = new THREE.Mesh(geo, mat);
    road.receiveShadow = true;
    this.group.add(road);

    // 중앙 점선 대신 옅은 센터라인
    const lineGeo = this._ribbonGeometry(0.18, -0.18, 0.02, false);
    const lineMat = this._mat(THREE.MeshBasicMaterial, 0x8a8a92, null);
    this.group.add(new THREE.Mesh(lineGeo, lineMat));
  }

  _buildCurbs() {
    // 줄무늬 연석: 짧은 세그먼트를 번갈아 배치 (테마 색 2종)
    const hw = this.halfWidth;
    const segLen = 4; // 대략 세그먼트당 샘플 수
    const matA = this._mat(THREE.MeshLambertMaterial, this.theme.curbA ?? 0xd23c2f, null);
    const matB = this._mat(THREE.MeshLambertMaterial, this.theme.curbB ?? 0xf2f2ee, null);
    for (const side of [1, -1]) {
      for (let s = 0; s < SAMPLES; s += segLen) {
        const pos = [];
        const idx = [];
        let v = 0;
        for (let i = s; i <= Math.min(s + segLen, SAMPLES); i++) {
          const j = i % SAMPLES;
          const p = this._pts[j], d = this._dirs[j];
          const lx = -d.z, lz = d.x;
          const inn = hw * side;
          const out = (hw + CURB_W) * side;
          pos.push(p.x + lx * inn, p.y + 0.06, p.z + lz * inn);
          pos.push(p.x + lx * out, p.y + 0.02, p.z + lz * out);
          if (i > s) {
            const a = v - 2, b = v - 1, c = v, e = v + 1;
            // a/c = 안쪽(inn), b/e = 바깥쪽(out). side=+1이면 out이 inn보다
            // 더 왼쪽이라 a→b→c가 +Y이고, side=-1이면 좌우가 뒤집히므로
            // a→c→b로 감아야 양쪽 모두 법선이 +Y가 된다.
            if (side > 0) idx.push(a, b, c, b, e, c);
            else idx.push(a, c, b, b, c, e);
          }
          v += 2;
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.setIndex(idx);
        geo.computeVertexNormals();
        this._own(geo);
        const mesh = new THREE.Mesh(geo, (Math.floor(s / segLen) % 2 === 0) ? matA : matB);
        mesh.receiveShadow = true;
        this.group.add(mesh);
      }
    }
  }

  _buildWalls() {
    // 시각용 저벽. 양면 렌더라 와인딩 방향과 무관하게 안쪽에서 보인다.
    const mat = this._mat(THREE.MeshLambertMaterial, this.theme.curbA ?? 0x9a4038, this._tex(this.theme.wall), {
      side: THREE.DoubleSide,
    });
    const off = this.halfWidth + WALL_OFF;
    for (const side of [1, -1]) {
      const pos = [];
      const uvs = [];
      const idx = [];
      for (let i = 0; i <= SAMPLES; i++) {
        const j = i % SAMPLES;
        const p = this._pts[j], d = this._dirs[j];
        const lx = -d.z, lz = d.x;
        const x = p.x + lx * off * side, z = p.z + lz * off * side;
        pos.push(x, p.y, z);
        pos.push(x, p.y + WALL_H, z);
        // 세로는 텍스처 1회(v 0..1), 가로는 WALL_TILE(20m)마다 1타일 → 스트라이프 간격 ~2.5m
        const u = this._cum[i] / WALL_TILE;
        uvs.push(u, 0, u, 1);
        if (i > 0) {
          const a = (i - 1) * 2, b = a + 1, c = a + 2, e = a + 3;
          idx.push(a, c, b, b, c, e);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      this._own(geo);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
  }

  _buildStartLine() {
    // t=0 지점에 체크무늬 출발선 (작은 사각 타일들)
    const hw = this.halfWidth;
    const p = this._pts[0], d = this._dirs[0];
    const left = new THREE.Vector3(-d.z, 0, d.x);
    const cols = 12, rows = 3;
    const cellW = (hw * 2) / cols;
    const cellL = 1.0;
    const matB = this._mat(THREE.MeshBasicMaterial, 0x111111, null);
    const matW = this._mat(THREE.MeshBasicMaterial, 0xffffff, null);
    const tile = this._own(new THREE.PlaneGeometry(cellW, cellL));
    tile.rotateX(-Math.PI / 2);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const m = new THREE.Mesh(tile, ((r + c) % 2 === 0) ? matW : matB);
        const lat = -hw + cellW * (c + 0.5);
        const lon = (r - (rows - 1) / 2) * cellL;
        m.position.copy(p)
          .addScaledVector(left, lat)
          .addScaledVector(d, lon);
        // 출발 구간은 맵 데이터 제약(|dy/ds|<0.01)상 평탄하므로 타일에 피치 보정을 넣지 않는다.
        m.position.y = p.y + 0.03;
        m.quaternion.setFromRotationMatrix(
          new THREE.Matrix4().lookAt(new THREE.Vector3(), d.clone().negate(), new THREE.Vector3(0, 1, 0))
        );
        // 위 lookAt은 z축이 수평(d)이라 순수 Y축 요(yaw)만 만든다 —
        // rotateX(-PI/2)로 이미 수평인 타일이 그대로 수평을 유지하면서
        // 주행 방향에만 정렬된다. 여기에 추가 회전을 넣으면 타일이 선다.
        this.group.add(m);
      }
    }

    // 출발 게이트 기둥 2개
    const poleGeo = this._own(new THREE.CylinderGeometry(0.3, 0.3, 6, 8));
    const poleMat = this._mat(THREE.MeshLambertMaterial, 0xcccccc, null);
    for (const side of [1, -1]) {
      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.position.copy(p).addScaledVector(left, (hw + 1.8) * side);
      pole.position.y = p.y + 3;
      pole.castShadow = true;
      this.group.add(pole);
    }
  }

  // 출발 게이트: signHighway가 있으면 출발선 위 갠트리로, 없으면 절차 생성 크로스바 아치.
  _buildStartGate() {
    const p = this._pts[0], d = this._dirs[0];
    const span = (this.halfWidth + 1.8) * 2; // _buildStartLine 기둥 간격과 일치
    const heading = Math.atan2(d.x, d.z);
    const bank = this.assets && this.assets.props ? this.assets.props : null;
    const sign = bank ? bank.signHighway : null;
    if (sign) {
      const gate = sign.clone();
      gate.userData.sharedAsset = true;
      // 실측: 판은 로컬 YZ 평면, 앞면 법선은 -X(+X는 회색 뒷판), 폭 7.33m는 로컬 Z 방향.
      // rotation.y=θ에서 -X는 (-cosθ, 0, sinθ)로 매핑되므로 θ=heading-π/2를 넣으면
      // -X → (-sin(heading), 0, -cos(heading)) = -dir, 즉 앞면이 출발 그리드(다가오는
      // 주행자)를 정면으로 향하고 로컬 Z(판 폭)는 도로를 가로지른다.
      gate.rotation.y = heading - Math.PI / 2;
      gate.scale.z *= span / SIGN_HIGHWAY_W; // 폭만 도로 폭에 맞춰 늘림 (높이 유지)
      gate.position.copy(p);
      gate.position.y = p.y;
      gate.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      this._propRoots.push(gate);
      this.group.add(gate);
    } else {
      // 폴백: 기존 기둥(높이 6m) 위를 잇는 크로스바
      const barGeo = this._own(new THREE.BoxGeometry(0.5, 0.9, span));
      const barMat = this._mat(THREE.MeshLambertMaterial, 0xd8d8d2, null);
      const bar = new THREE.Mesh(barGeo, barMat);
      bar.position.copy(p);
      bar.position.y = p.y + 5.6;
      bar.rotation.y = heading + Math.PI / 2; // 로컬 Z(길이 방향)를 도로 가로로
      bar.castShadow = true;
      this.group.add(bar);
    }
  }

  // 부스터 패드: def.boostPads [{t, lateral}] → 도로 면 발광 셰브론(3x4m) +
  // 공개 필드 this.boostPads = [{position, radius}].
  _buildBoostPads() {
    const defs = Array.isArray(this.def.boostPads) ? this.def.boostPads : [];
    if (!defs.length) return;
    const color = this.theme.boostColor ?? 0x33e6ff;
    // MeshBasicMaterial: 조명 무관하게 항상 최대 밝기 → 야간 맵에서도 확 띈다.
    const baseMat = this._mat(THREE.MeshBasicMaterial, 0x14161c, null);
    const chevMat = this._mat(THREE.MeshBasicMaterial, color, null);
    const baseGeo = this._own(new THREE.PlaneGeometry(3, 4));
    baseGeo.rotateX(-Math.PI / 2);
    // 셰브론: Shape는 XY 평면이라 -Y 방향으로 그린다 → rotateX(-π/2)가 (x,y,0)을
    // (x,0,-y)로 보내므로 갈매기 꼭짓점이 로컬 +Z(주행 방향)를 가리키게 된다.
    const shape = new THREE.Shape();
    shape.moveTo(-1.1, 0);
    shape.lineTo(0, -0.75);
    shape.lineTo(1.1, 0);
    shape.lineTo(1.1, -0.55);
    shape.lineTo(0, -1.3);
    shape.lineTo(-1.1, -0.55);
    shape.closePath();
    const chevGeo = this._own(new THREE.ShapeGeometry(shape));
    chevGeo.rotateX(-Math.PI / 2);

    for (const bp of defs) {
      const t = ((bp.t % 1) + 1) % 1;
      const p = this.curve.getPointAt(t);
      const dir3 = this.curve.getTangentAt(t).normalize();     // 3D (피치용)
      const dir = dir3.clone().setY(0).normalize();            // 평탄 (요용)
      const left = new THREE.Vector3(-dir.z, 0, dir.x);
      const pos = p.clone().addScaledVector(left, bp.lateral || 0);
      pos.y = this._roadY(pos.x, pos.z);

      const pad = new THREE.Group();
      const base = new THREE.Mesh(baseGeo, baseMat);
      // 센터라인 리본이 y=0.02라 동일 평면이면 z-fighting → 패드는 그 위로
      // (연석 y=0.06보다는 낮게 유지).
      base.position.y = 0.03;
      pad.add(base);
      for (const zOff of [-1.6, 0.1]) {
        const ch = new THREE.Mesh(chevGeo, chevMat);
        ch.position.set(0, 0.045, zOff);
        pad.add(ch);
      }
      pad.position.copy(pos);
      pad.rotation.y = Math.atan2(dir.x, dir.z); // 로컬 +Z → 주행 방향
      if (this._hasElevation) {
        // 패드는 로컬 +Z가 전방이라 카트(로컬 -Z 전방)와 피치 부호가 반대다:
        // R_x(θ)·(0,0,1) = (0, -sinθ, cosθ) → 오르막(+y)은 θ < 0.
        pad.rotation.order = 'YXZ';
        pad.rotation.x = -Math.asin(Math.max(-1, Math.min(1, dir3.y)));
      }
      this.group.add(pad);

      this.boostPads.push({ position: pos.clone(), radius: 2.4 });
    }
  }

  // 코너 깃발 폴: 곡률이 큰 지점(코너 바깥쪽)에 저폴리 폴+삼각기 6~10개.
  _buildFlags() {
    const N = SAMPLES;
    const S = 8; // 곡률 추정 간격 (~트랙길이/50)
    const items = []; // {i, R, side}
    for (let i = 0; i < N; i++) {
      const A = this._pts[(i - S + N) % N], B = this._pts[i], C = this._pts[(i + S) % N];
      const a = Math.hypot(B.x - C.x, B.z - C.z);
      const b = Math.hypot(A.x - C.x, A.z - C.z);
      const c = Math.hypot(A.x - B.x, A.z - B.z);
      const cross2 = (B.x - A.x) * (C.z - A.z) - (B.z - A.z) * (C.x - A.x);
      const K = Math.abs(cross2) / 2;
      if (K < 1e-6) continue;
      const R = (a * b * c) / (4 * K);
      if (R > 40) continue;
      // 좌회전이면 d1×d2의 y가 음수(left=(-z,0,x) 규약 기준) → 바깥쪽은 오른쪽(-1).
      const d1 = this._dirs[(i - S + N) % N], d2 = this._dirs[(i + S) % N];
      const crossY = d1.z * d2.x - d1.x * d2.z;
      items.push({ i, R, side: crossY >= 0 ? 1 : -1 });
    }
    items.sort((u, v) => u.R - v.R);
    const minGap = Math.max(8, Math.round((25 / this.length) * N)); // 깃발끼리 25m 이상
    const chosen = [];
    for (const it of items) {
      if (chosen.length >= 10) break;
      let ok = true;
      for (const c of chosen) {
        const gap = Math.min(Math.abs(c.i - it.i), N - Math.abs(c.i - it.i));
        if (gap < minGap) { ok = false; break; }
      }
      if (ok) chosen.push(it);
    }
    if (!chosen.length) return;

    const poleGeo = this._own(new THREE.CylinderGeometry(0.07, 0.09, 2.8, 6));
    poleGeo.translate(0, 1.4, 0);
    const poleMat = this._mat(THREE.MeshLambertMaterial, 0xe8e8e8, null);
    // 삼각기: XY 평면 삼각형 → 폴 상단에서 옆으로 나부끼는 모양 (양면)
    const flagShape = new THREE.Shape();
    flagShape.moveTo(0, 0);
    flagShape.lineTo(1.0, -0.28);
    flagShape.lineTo(0, -0.56);
    flagShape.closePath();
    const flagGeo = this._own(new THREE.ShapeGeometry(flagShape));
    const flagMat = this._mat(THREE.MeshLambertMaterial, this.theme.curbA ?? 0xd23c2f, null, {
      side: THREE.DoubleSide,
    });

    const off = this.halfWidth + WALL_OFF + 1.6; // 벽 바깥
    for (const it of chosen) {
      const p = this._pts[it.i], d = this._dirs[it.i];
      const left = new THREE.Vector3(-d.z, 0, d.x);
      const g = new THREE.Group();
      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.castShadow = true;
      const flag = new THREE.Mesh(flagGeo, flagMat);
      flag.position.y = 2.72;
      g.add(pole, flag);
      g.position.copy(p).addScaledVector(left, off * it.side);
      g.position.y = p.y; // 오프셋 hw+4.2 < 평탄대 hw+5 → 노면 높이 그대로
      g.rotation.y = Math.atan2(d.x, d.z); // 깃발 면이 도로 진행축과 나란히
      this.group.add(g);
    }
  }

  // theme.props: 스플라인을 spacing(m) 간격으로 돌며 도로 밖에 GLB 프롭 clone 배치.
  _buildProps() {
    const list = this.theme.props;
    const bank = this.assets && this.assets.props ? this.assets.props : null;
    if (!Array.isArray(list) || !bank) return;

    for (const entry of list) {
      const src = bank[entry.key];
      if (!src) continue; // 로드 실패 항목은 생략
      const spacing = Math.max(8, entry.spacing || 100);
      const count = Math.max(1, Math.floor(this.length / spacing));
      const offset = entry.offset != null ? entry.offset : this.halfWidth + 4;
      const isArm = ARM_KEYS.has(entry.key);

      for (let k = 0; k < count; k++) {
        const t = (k * spacing) / this.length;
        const p = this.curve.getPointAt(t % 1);
        const dir = this.curve.getTangentAt(t % 1).setY(0).normalize();
        const left = new THREE.Vector3(-dir.z, 0, dir.x);
        const side = entry.side === 0 ? (k % 2 === 0 ? 1 : -1) : (entry.side < 0 ? -1 : 1);

        const obj = src.clone();
        obj.userData.sharedAsset = true;
        obj.position.copy(p).addScaledVector(left, offset * side);
        // 오프셋이 평탄대(hw+5)를 넘는 프롭이 있어 지형면에서 샘플링한다
        // (평탄대 안이면 지형면 + GROUND_SINK == 노면 높이로 자동 일치).
        obj.position.y = this._terrainSurfaceY(obj.position.x, obj.position.z) + GROUND_SINK;
        if (entry.scale) obj.scale.multiplyScalar(entry.scale);
        // 요(yaw) 보정 — 실측 근거:
        //  - 표지판/신호등/배리어: 판이 로컬 YZ 평면, 앞면 법선은 -X(+X는 회색 뒷판
        //    — GLB 픽셀 실측: stop 빨강/warning 황색/신호등 램프가 모두 -X 면).
        //    rotation.y=θ에서 -X는 (-cosθ, 0, sinθ)로 매핑되므로 θ = heading - π/2
        //    (heading = atan2(dir.x, dir.z), 로컬 +Z→dir인 요)를 넣으면 -X → -dir,
        //    즉 앞면이 다가오는 주행자를 정면으로 향한다. (+π/2는 뒷판이 보이는 180° 오류.)
        //  - 가로등(lightSquare/lightCurved): 팔이 로컬 -Z로 뻗는다. -Z는
        //    (-sinθ, 0, -cosθ)로 매핑되므로 θ = heading - side*π/2 를 넣으면
        //    -Z → -side*left, 즉 팔이 배치된 쪽에서 도로 중심 위를 가로지른다.
        const heading = Math.atan2(dir.x, dir.z);
        obj.rotation.y = isArm ? heading - side * (Math.PI / 2) : heading - Math.PI / 2;
        obj.traverse((o) => { if (o.isMesh) o.castShadow = true; });

        this._propRoots.push(obj);
        this.group.add(obj);
      }
    }
  }

  _buildDecorations() {
    // 저폴리 나무·바위: 트랙 바깥쪽에 결정적 배치. theme.decor로 종류 선택.
    const decor = this.theme.decor === undefined ? 'trees' : this.theme.decor;
    if (decor === 'none') return;
    const hw = this.halfWidth;

    const treeTrunkGeo = this._own(new THREE.CylinderGeometry(0.25, 0.35, 1.6, 6));
    const treeTopGeo = this._own(new THREE.ConeGeometry(1.6, 3.2, 7));
    const trunkMat = this._mat(THREE.MeshLambertMaterial, 0x6b4a2b, null);
    const topMat = this._mat(THREE.MeshLambertMaterial, 0x2f7031, null);
    const rockGeo = this._own(new THREE.DodecahedronGeometry(1, 0));
    const rockMat = this._mat(THREE.MeshLambertMaterial, 0x8d8d85, null);

    let seed = 7;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed & 0xffff) / 0xffff;
    };

    const treeChance = decor === 'rocks' ? 0 : 0.7;

    for (let k = 0; k < 60; k++) {
      const i = Math.floor(rand() * SAMPLES);
      const p = this._pts[i], d = this._dirs[i];
      const left = new THREE.Vector3(-d.z, 0, d.x);
      const side = rand() < 0.5 ? 1 : -1;
      const dist = hw + 8 + rand() * 22;
      const pos = p.clone().addScaledVector(left, dist * side);
      // 다른 도로 구간과 겹치지 않게: 중심선 최근접 거리 검사
      let minD = Infinity;
      for (let s = 0; s < SAMPLES; s += 4) {
        const dd = sqDistXZ(pos, this._pts[s]);
        if (dd < minD) minD = dd;
      }
      if (minD < (hw + 5) * (hw + 5)) continue;
      // pos는 중심선 점의 clone이라 노면 y를 물려받는다 — 반드시 지형면으로 덮어쓴다.
      // (+GROUND_SINK: 기존 평면 맵에서 나무 밑동 y=0 / 바위 y=0.3 이었던 값을 그대로 보존)
      pos.y = this._terrainSurfaceY(pos.x, pos.z) + GROUND_SINK;

      if (rand() < treeChance) {
        const tree = new THREE.Group();
        const trunk = new THREE.Mesh(treeTrunkGeo, trunkMat);
        trunk.position.y = 0.8;
        const top = new THREE.Mesh(treeTopGeo, topMat);
        top.position.y = 3.0;
        trunk.castShadow = top.castShadow = true;
        tree.add(trunk, top);
        const s = 0.8 + rand() * 0.8;
        tree.scale.setScalar(s);
        tree.position.copy(pos);
        this.group.add(tree);
      } else {
        const rock = new THREE.Mesh(rockGeo, rockMat);
        rock.castShadow = true;
        rock.scale.set(0.7 + rand(), 0.5 + rand() * 0.6, 0.7 + rand());
        rock.position.copy(pos);
        rock.position.y = pos.y + 0.3;
        rock.rotation.y = rand() * Math.PI * 2;
        this.group.add(rock);
      }
    }
  }

  _computeItemBoxPositions() {
    // 3~4 클러스터, 총 ~12개. 각 클러스터는 트랙 가로로 3개 나란히.
    this.itemBoxPositions = [];
    const lat = this.halfWidth * 0.55;
    const clusterTs = [0.18, 0.42, 0.65, 0.87];
    for (const ct of clusterTs) {
      const i = Math.floor(ct * SAMPLES) % SAMPLES;
      const p = this._pts[i], d = this._dirs[i];
      const left = new THREE.Vector3(-d.z, 0, d.x);
      for (const l of [-lat, 0, lat]) {
        const pos = p.clone().addScaledVector(left, l);
        pos.y = this._roadY(pos.x, pos.z, i) + 1.0;
        this.itemBoxPositions.push(pos);
      }
    }
    // 총 12개 → 계약의 "10±개" 범위 내
  }
}

function sqDistXZ(a, b) {
  const dx = a.x - b.x, dz = a.z - b.z;
  return dx * dx + dz * dz;
}

function smoothstep01(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

// 결정적 해시 → [-1,1)
function hash2(ix, iz) {
  let h = Math.imul(ix, 374761393) + Math.imul(iz, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) / 2147483648) - 1;
}

// 2D value noise (smoothstep 보간). 옥타브 합성은 _hills에서.
function valueNoise(x, z) {
  const x0 = Math.floor(x), z0 = Math.floor(z);
  const fx = smoothstep01(x - x0), fz = smoothstep01(z - z0);
  const a = hash2(x0, z0), b = hash2(x0 + 1, z0);
  const c = hash2(x0, z0 + 1), d = hash2(x0 + 1, z0 + 1);
  return (a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz;
}

// 격자 두 이웃의 높이차가 maxStep을 넘으면 서로 끌어당긴다.
// 잠긴(평탄대) 정점은 움직이지 않고 상대만 이동시켜 노면 경계 조건을 보존한다.
function relaxEdge(h, locked, a, b, maxStep) {
  const diff = h[a] - h[b];
  const excess = Math.abs(diff) - maxStep;
  if (excess <= 0) return;
  const la = locked[a], lb = locked[b];
  if (la && lb) return;
  const s = diff > 0 ? 1 : -1;
  if (la) h[b] += s * excess;
  else if (lb) h[a] -= s * excess;
  else { h[a] -= (s * excess) / 2; h[b] += (s * excess) / 2; }
}
