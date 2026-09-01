# Kart Game — Module Contracts (v3, as-built)

3D 마리오카트풍 2인 대전 레이싱. Three.js, ES modules.

> **v2 → v3 변경 (고저차 트랙 지원)**: 트랙이 더 이상 평면이 아니어도 된다.
> `controlPoints`가 `[x,z]`(평면)와 `[x,y,z]`(고저차) 두 형식을 받고, `sample()`의
> `roadPoint.y`가 실제 노면 높이를, `roadDir`이 3D 접선을 돌려준다. 카트는 노면에
> 붙어 다니고 피치가 들어가며, 경사가 최고속·가속에 반영된다. 고저차 맵은 조각 지형
> 메시를 만들고, 평면 맵은 기존 원판을 그대로 쓴다.
> **하위 호환은 값 수준에서 보장된다** — 기존 평면 4맵(green-circuit / sunset-speedway /
> coastal-grandtour / night-technical)은 지오메트리·머티리얼·스폰·sample()·주행 시계열이
> v2와 비트 단위로 동일하다(헤드리스 회귀 검증 완료). 아래 표시된 신규 필드는 평면
> 맵에서 전부 0 또는 기존 값과 같은 항등이다.

> **v1 → v2 변경**: 초기 계약은 "외부 에셋 없음(전부 절차 생성 + WebAudio 합성)"이었으나,
> 이후 `src/assets.js`가 추가되어 GLB(카트/프롭) · PNG(노면/벽 텍스처) · OGG(효과음/엔진음) · TTF를
> 로드한다. **절차 생성/합성은 폴백으로 전부 살아 있다** — 개별 에셋 로드 실패는 `null`로 흡수되고
> 소비 측이 기존 경로로 되돌아간다. 아래 문서는 실제 구현(as-built) 기준이다.

## 전역 규칙

- ES module 문법. Three.js는 `import * as THREE from 'three'` (importmap이 `three`를 CDN으로 매핑함 — 모듈은 그냥 `'three'`에서 import).
- 좌표계: Y-up. 트랙은 XZ 평면. 단위는 미터, `dt`는 초 단위.
- 각 모듈은 명시된 **named export**만 제공. 계약에 없는 것을 다른 모듈에서 import하지 말 것.
- 모듈끼리 서로 import 금지 (three 제외). 모든 조립은 `main.js`가 담당. 단, 타 모듈 인스턴스를 **인자로 받는 것**은 허용 (예: `kart.update(dt, input, track)`).
- DOM을 만드는 모듈(HUD, Settings)은 `document.body`에 자신이 컨테이너를 append하고, 스타일은 JS에서 인라인 또는 `<style>` 주입으로 자체 해결.
- 파일당 대략 200–500줄. 주석은 꼭 필요한 제약만.

## 게임 상수 (모든 모듈 공통 가정)

- 랩 수: 3
- 플레이어 수: 2 (P0 = 빨강 카트, P1 = 파랑 카트)
- 최고 속도: 일반 주행 약 38 m/s, 부스트 시 약 55 m/s
- 트랙 폭(halfWidth): 약 9 m

---

## src/track.js

```js
export class Track {
  constructor(scene, def, assets)
  // def   = tracks.js TRACKS의 원소 (생략 시 TRACKS[0])
  // assets = assets.js loadAssets() 결과 (생략/null 가능 → 전부 절차 생성 폴백)
  // Catmull-Rom 닫힌 스플라인(closed, centripetal) 기반. 도로 리본 + 연석 + 벽 +
  // 출발선/게이트 + 부스터 패드 + GLB 프롭 + 코너 깃발 + 원거리 능선 + 장식 + 아이템 박스.

  readonly id / name / halfWidth / theme   // def에서 승계
  readonly length            // 스플라인 총 길이(m) = curve.getLength()
  totalLaps = 3              // main이 설정 랩 수를 여기에 써 넣는다(Kart가 완주 판정에 읽음)

  getSpawnTransforms(n)      // → [{ position: THREE.Vector3, quaternion: THREE.Quaternion }] n개.
                             // 출발선 뒤에 2열 그리드, 전방(주행 방향)을 향함.
                             // quaternion은 lookAt 규약 = 로컬 -Z가 주행 방향.

  sample(position /*Vector3*/, hint /*샘플 인덱스 0..399, optional*/)
  // → { t,            // 0..1 스플라인 진행도 (가장 가까운 지점)
  //     roadPoint,    // THREE.Vector3. x,z = 중심선 400샘플 중 최근접점 그대로.
  //                   //   y = 질의 위치(x,z)의 "실제 노면 높이" (평면 맵에서는 항상 0).
  //                   //   400샘플 y를 그대로 쓰지 않고 리본 표면을 재현해 보간하므로
  //                   //   경사에서 계단이 생기지 않는다(리본 표면 대비 실측 오차 <3e-5 m).
  //     roadDir,      // THREE.Vector3 주행 방향 3D 단위벡터. 경사 맵에서는 y != 0 이다.
  //                   //   ★ XZ 평면 방향이 필요하면 반드시 (x,z)만 뽑아 재정규화할 것.
  //                   //     dy/d(수평) = roadDir.y / hypot(roadDir.x, roadDir.z).
  //     lateral,      // 중심선 기준 부호 있는 "수평" 횡방향 오프셋(m, 왼쪽 +).
  //                   //   경사와 무관한 순수 수평 거리 — 벽 판정 의미가 경사에서 변하지 않는다.
  //     halfWidth,    // 그 지점 도로 반폭(m)
  //     offRoad,      // |lateral| > halfWidth 여부 (boolean)
  //     index }       // 다음 프레임에 hint로 되돌려줄 샘플 인덱스 (0..399)
  // 구현: 스플라인을 400개 점으로 샘플해 최근접 탐색(수평 투영 기준). hint가 있으면
  //       ±25 국소 창만 보고, 국소 최선이 40m보다 멀면 전역 재탐색으로 자동 폴백한다.

  readonly itemBoxPositions  // THREE.Vector3[] — 아이템 박스 위치 (4 클러스터 × 3개 = 12개).
                             // y = 그 지점 노면 높이 + 1.0 (평면 맵에서는 1.0).
                             // 박스 메시/회전/리스폰 연출은 ItemSystem이 담당. Track은 위치만 제공.

  readonly boostPads         // [{ position: THREE.Vector3, radius: number }]
  // def.boostPads[{ t: 0..1 호길이 비율, lateral: m(왼쪽 +) }] 로부터 생성. radius는 2.4m 고정.
  // 시각 요소(3×4m 발광 셰브론 패드)는 Track이 그리고, 접촉 판정/부스트 발동은 main이 한다
  // (main.updateBoostPads: 카트×패드 조합별 1.5초 쿨다운 → kart.applyBoost(1, 1.2)).
  // def.boostPads가 없는 맵은 빈 배열. dispose() 후에도 빈 배열로 리셋된다.

  // --- 고저차(3D) 트랙 ---
  // def.controlPoints 는 [x, z](평면) 또는 [x, y, z](고저차) 두 형식을 받는다.
  // 판별은 "원소 배열의 길이"(2 또는 3)뿐이고, 한 맵 안에서 섞으면 생성자가 즉시 throw한다.
  // 3D 형식이어도 y가 전부 0이면 평면 경로로 떨어져 출력이 [x,z] 맵과 완전히 동일하다.
  // 평면 맵은 지형 메시를 만들지 않고 기존 CircleGeometry 원판(y=-0.05)을 그대로 쓴다.
  // 고저차 맵은 단일 PlaneGeometry 조각 지형(드로우콜은 원판과 같은 1개)을 만들고,
  // 노면 평탄대(halfWidth + 최대 5m) 안에서는 지형이 노면보다 정확히 0.05m 아래에 온다.
  //
  // 내부 높이 함수(외부 비공개 — 다른 모듈은 sample().roadPoint.y 로 충분하다):
  //   _roadY(x,z,hint)        노면 능선면 높이. 평면 맵에서 0.
  //   _groundY(x,z,hint)      해석적 지형면 높이. 평면 맵에서 -0.05.
  //   _terrainSurfaceY(x,z)   ★ 실제로 렌더되는 지형 메시 표면 높이.
  //     지형 격자는 탈루스 완화와 노면 구속(_clampUnderRoad)을 거치므로 해석식 _groundY와
  //     최대 ±3m까지 어긋난다. 지면에 얹는 오브젝트(나무/바위/GLB 프롭/원경 능선)는
  //     반드시 이 함수를 써야 한다 — _groundY로 놓으면 파묻히거나 공중에 뜬다.
  //     평면 맵에서는 격자가 없어 _groundY(≡ -0.05)로 떨어지므로 배치가 기존과 동일하다.

  dispose(scene)             // 자기가 add한 것 전부 제거 + 자기가 만든 지오/머티만 해제.
  // GLB 프롭은 clone이라 원본과 지오/머티를 공유 → 씬에서 떼어내기만 하고 dispose하지 않는다.
  // 텍스처도 assets 소유라 해제하지 않는다(맵 전환 시 재사용). itemBoxPositions/boostPads는 []로 리셋.
  // 지형 높이 격자도 해제한다.
  // main은 맵 전환마다 itemSystem.dispose() → track.dispose(scene) 순으로 부른다.
}
```

## src/kart.js

```js
export class Kart {
  constructor({ color /*hex*/, spawn /*{position,quaternion}*/, name /*string*/, model /*optional*/ })
  // model이 있으면 GLB 사본(assets.karts.red/blue)을 시각 메시로 쓰고, 없으면 저폴리 절차 메시
  // (바디+바퀴 4개+드라이버)로 폴백. this.object3d (THREE.Group). main이 scene.add(kart.object3d).
  // 주의: GLB 경로는 지오/머티를 원본 템플릿과 공유하므로 main은 dispose하면 안 된다
  //       (main이 kart.usesSharedModel 플래그를 붙여 구분한다).

  update(dt, input, track)
  // input: { throttle:0..1, brake:0..1, steer:-1..1, drift:boolean, useItem:boolean }
  // 아케이드 물리: 가속/감속, 속도 비례 조향, 드리프트(drift 누르며 조향 시 미끄러지며
  // 차지 → 3단계 미니터보: 0.8s/1.6s/2.4s 차지 시 놓으면 부스트 0.6s/1s/1.4s).
  // 트랙 처리: track.sample(pos)로 offRoad면 최고속도 40%로 제한(잔디 감속),
  //   position.y 는 매 프레임 sample().roadPoint.y (실제 노면 높이)로 맞춘다 — 경사 맵에서
  //   카트가 노면에 붙어 다닌다. 평면 맵에서는 항상 0.
  //   ★ sample().roadDir 은 3D 단위벡터다(경사 성분 포함). XZ 방향이 필요한 곳에서는
  //     반드시 재정규화할 것(현재 벽 클램프/슬라이드 코드는 이미 그렇게 한다).
  // |lateral| > halfWidth + 1.5 면 벽으로 간주해 lateral을 클램프한다.
  // 벽 처리는 "정지"가 아니라 **슬라이드**다(v2): 속도의 벽 법선 성분만 제거하고 접선 성분은 남긴 뒤,
  //   heading을 최대 3rad/s로 벽 접선에 정렬하고 스치는 동안 초당 12% 마찰만 준다.
  //   접촉 '순간' 1회에 한해 법선 성분에 비례한 충격 감속(최대 15%)을 추가로 건다.
  // 방향 규약: 전방 f = (-sin(heading), 0, -cos(heading)). steer>0=오른쪽 입력이고
  //   rotation.y 증가는 왼쪽이므로 yawRate = -steer × ... (부호 반전이 정상이다).
  // 바퀴 회전/조향 시각화, 드리프트 시 카트 기울임.

  // 상태 (읽기용)
  position                   // THREE.Vector3 (object3d.position과 동일 참조 허용)
  speed                      // m/s
  heading                    // 라디안
  driftLevel                 // 0|1|2|3 (현재 차지 단계, HUD/파티클용)
  boostTimer                 // 남은 부스트 초 (>0이면 부스트 중)
  spinTimer                  // >0이면 스핀 중(조작 불능)

  // 진행/랩 (Kart가 자체 관리; main이 읽음)
  lap                        // 현재 랩 (1부터, 완주 시 totalLaps+1)
  progress                   // lap + t 를 합친 총 진행도 숫자 (순위 정렬용, 단조 증가)
  finished                   // boolean
  finishTime                 // 완주 시각(초) — main이 넘겨주는 raceTime을 update의 5번째 인자로 받아 기록
  // update(dt, input, track, raceTime) 시그니처로 raceTime(초) 수신.
  // 랩 판정: t가 0.9→0.1로 감기면 lap+1, 역주행으로 0.1→0.9면 lap-1 보정.
  //   단 스폰이 출발선 뒤(t≈0.98)이므로 **최초 1회 통과는 랩을 올리지 않는다**
  //   (내부 _crossedStartOnce 플래그. 역주행으로 되감으면 랩 대신 이 플래그를 되돌린다).

  // 벽 접촉 상태 (읽기 전용 — main이 럼블/사운드에 사용)
  wallContact                // 이번 프레임에 벽을 긁고 있는가 (boolean)
  wallHitImpulse             // 접촉 순간의 법선 성분 크기(0..1), 0.25초에 걸쳐 0으로 감쇠

  // 노면 경사 (읽기 전용 — 고저차 맵 지원. 평면 맵에서는 둘 다 항상 정확히 0)
  roadGrade                  // 카트 heading 기준 노면 기울기 dy/d(수평). + = 오르막.
                             // sample().roadDir 에서 계산하고 카트 진행 방향으로 부호를 맞춘다
                             // (역주행하면 부호가 뒤집힌다). 400샘플 인덱스 단위로 양자화돼
                             // 있어 프레임간 최대 ~0.015의 계단이 있다 — 보간 없이 카메라나
                             // 이펙트에 직접 먹이면 그 계단이 그대로 보인다.
  roadY                      // 현재 노면 높이(m). position.y 와 같은 값.
  // 시각: object3d.rotation.order = 'YXZ' 로 고정하고 rotation.x 에 피치를 넣는다
  //   (pitch = atan(roadGrade) 를 초당 8의 지수 감쇠로 추종). 평면 맵은 pitch=0 →
  //   순수 yaw라 기존 'XYZ' 와 완전히 동일한 회전이다. 뱅킹(롤)은 넣지 않는다 —
  //   rotation.z / _tiltGroup.rotation.z 는 드리프트 기울임 전용이다.
  // 물리: (a) 최고속 × clamp(1 - 1.2·roadGrade, 0.75, 1.15) — offRoad 40% 캡보다 먼저 적용,
  //       (b) 중력 성분 speed -= 14 · sin(atan(roadGrade)) · dt, 그 뒤 속도를 [-10, 66]으로 클램프.
  //       평면 맵에서는 roadGrade가 0이라 (a)는 항등이고 (b)는 통째로 건너뛴다.

  // 외부 이벤트
  applyBoost(power /*1=버섯급*/, duration /*초*/)
  spin()                     // 아이템 피격: 1초 스핀, 속도 급감. star 중이면 무시.
  starTimer                  // >0이면 무적(스타). setStar(duration)로 켬.
  setStar(duration)
}

export function collideKarts(a, b)
// 두 카트 간 원형 충돌(반경 1.2m): 겹치면 서로 밀어내고 속도 일부 교환. 매 프레임 main이 호출.
```

## src/input.js

```js
export class InputManager {
  constructor()
  // Gamepad API 폴링 + 키보드 폴백. 매 프레임 main이 poll() 호출.
  poll()

  getPlayerInput(i /*0|1*/)
  // → { throttle, brake, steer, drift, useItem, pause }
  //   useItem/pause는 "이번 프레임에 눌림(edge)" boolean.
  // 기본 매핑(Xbox 표준): RT=throttle, LT=brake, 좌스틱X=steer(데드존 0.15),
  //   A 또는 RB=drift, X 또는 LB=useItem, Menu(Start)=pause.
  // 키보드 폴백(v2):
  //   P0 = WASD 이동 + Space(드리프트, KeyE도 허용) + ShiftLeft(아이템)
  //   P1 = 방향키 이동 + Digit0(드리프트) + ShiftRight(아이템, Period도 허용)
  //   Esc = pause(공용). 아이템은 좌/우 Shift로 플레이어를 가른다.
  // 게임패드가 연결된 플레이어는 게임패드 우선, 없으면 키보드.

  getMapping() / setMapping(mapping)   // {steerAxis, throttle, brake, drift, useItem, pause: 버튼 인덱스}
                                       // Settings가 저장/복원에 사용. 두 패드 공통 매핑.
  listenForButton(callback)            // 다음에 눌리는 게임패드 버튼 인덱스를 1회 콜백 (리매핑 UI용)
  rumble(i, strong /*0..1*/, weak, ms) // 지원 시 진동, 미지원 시 무시
  connectedCount()                     // 연결된 게임패드 수
  anyStartPressed()                    // 아무 패드 Menu/A 또는 키보드 Enter edge (시작/재시작용)
  backPressed()                        // 아무 패드 B 또는 키보드 Backspace edge (결과 → 타이틀 복귀용)
                                       // Esc는 pause 전용이라 여기 포함되지 않는다.
}
```

## src/view.js  (동적 분할화면)

```js
export class SplitView {
  constructor(renderer /*THREE.WebGLRenderer*/, scene)
  // 카메라 2개(체이스캠) + 합체 카메라 관리. 리사이즈 자체 처리(window resize 리스너).

  setMode(mode)              // 'auto' | 'split' | 'single'
  get layout                 // 현재 화면 레이아웃 'single'|'split' — HUD의 splitLayout에 그대로 넘긴다
  render(dt, karts /*[Kart,Kart]*/)
  // 체이스캠: 카트 뒤 8.5m·위 5.0m, 시선 전방 4.5m·위 2.0m (GLB 카트 전고 2.79m를 넘기려
  //   v1의 7m/3.2m에서 올린 값). 부드럽게 추적(lerp), 부스트 시 FOV 살짝 증가.
  // 경사 대응: 뒤/앞 방향 벡터를 kart.roadGrade(±0.45로 clamp)만큼 기울여 리그 전체를
  //   노면 경사에 맞춘다 → 내리막에서 카메라가 언덕을 뚫지 않고, 오르막에서 하늘만
  //   보이지 않는다. 최후 방어선으로 카메라 y >= 카트 y + 2.2m 를 항상 보장한다.
  //   kart.roadGrade가 없거나(구버전) 0이면(평면 맵) 이 보정은 완전한 항등이다.
  // auto 모드: 두 카트 거리 < 26m → 한 화면(두 카트를 모두 담는 카메라),
  //            > 34m → 세로 2분할(P0 왼쪽, P1 오른쪽). 사이 구간은 히스테리시스,
  //            전환은 0.5s 정도 부드럽게(분할선이 화면 밖에서 미끄러져 들어오는 연출 권장,
  //            어려우면 크로스페이드/즉시 전환도 허용). 분할 시 중앙에 2px 구분선(DOM 또는 scissor).
  // split 모드: 항상 2분할. single 모드: 항상 합체 카메라.
  // 구현은 renderer.setScissor/setViewport 사용.
}
```

## src/items.js

```js
export class ItemSystem {
  constructor(scene, track)
  // track.itemBoxPositions에 회전하는 반투명 큐브 박스 생성. 먹으면 3초 후 리스폰.

  update(dt, karts)
  // - 박스 픽업 판정(반경 1.6m): 아이템 없는 카트에 랜덤 지급 → kart.item = 'mushroom'|'shell'|'banana'|'star'
  //   (가중치: 뒤처진 카트에 star/mushroom 확률 ↑ — progress 비교)
  // - 카트의 input.useItem 처리는 main이 함: main이 useItem edge 시 itemSystem.use(kart, karts) 호출.
  // - 발사체/설치물 갱신: shell은 전방 직진 25m/s+사용자 속도, 벽/카트 충돌 시 소멸(카트면 spin()),
  //   banana는 뒤에 설치, 밟으면 spin(). star는 kart.setStar(5), mushroom은 kart.applyBoost(1, 1.2).
  //   shell의 속도는 XZ 전용(y 성분 0)이고, y는 매 프레임 track.sample().roadPoint.y + 0.4로
  //   덮어써 노면에 밀착한다 — 경사 맵에서 언덕을 관통하지 않는다(벽 판정용 sample 호출을
  //   재사용하므로 추가 비용 0). 평면 맵에서는 roadPoint.y가 0이라 y가 계속 0.4로 고정된다.
  //   banana는 kart.position.y + 0.25 — 카트 y가 이미 노면 높이라 자동으로 따라온다.
  //   박스 픽업 판정은 XZ 거리만 쓰므로 경사와 무관하다.
  // - kart.item 필드는 ItemSystem이 kart 객체에 동적으로 붙여 관리 (Kart 클래스는 모름). 초기 null.

  use(kart, allKarts)        // kart.item 사용 후 null로
}
```

## src/hud.js

```js
export class HUD {
  constructor()              // 풀스크린 오버레이 DOM 생성 (pointer-events: none)
  update({ players, state, countdown, raceTime, splitLayout })
  // players: [{ lap, totalLaps, rank /*1|2*/, item /*string|null*/, speed, driftLevel, name, color }]
  // state: 'menu'|'countdown'|'race'|'finished'
  // countdown: 3|2|1|0 (0='GO!') — countdown 상태에서 크게 표시
  // splitLayout: 'single'|'split' — split이면 좌우 각각의 HUD 코너에 배치, single이면 양쪽 끝에
  // 표시: 랩(2/3), 순위(1st/2nd), 보유 아이템 아이콘(이모지 허용: 🍄🐢🍌⭐), 속도(km/h), 레이스 타임.
  showResults(results)       // [{ name, color, finishTime|null, rank }] — 중앙 결과 패널.
                             // finishTime === null 이면 'DNF'로 표기(메달 생략).
  hideResults()
  showTitle(visible)         // 타이틀 화면: 게임 제목 + "Start 버튼 또는 Enter로 시작" + 조작법 요약 + 연결된 패드 수 표시용 setPadCount(n)
  setPadCount(n)
  setMapInfo({ name })       // 선택된 맵 이름 — 타이틀의 ◀ 맵명 ▶ 와 레이스 중 상단 배지에 동시 반영
}
```

## src/audio.js

```js
export class AudioEngine {
  constructor()              // AudioContext는 첫 사용자 입력 후 resume (자동재생 정책)
  get context                // AudioContext — main이 assets.js에 넘겨 OGG 디코드에 쓴다.
                             // 그래서 AudioEngine은 loadAssets()보다 먼저 생성해야 한다.
  unlock()                   // main이 첫 입력 시 호출
  setVolume(v /*0..1*/)
  setRaceActive(active)      // 레이스 중에만 엔진음 채널을 돌린다(타이틀/결과에서는 정지)
  provideBuffers({ sfx, engine, thruster })
  // assets.js가 디코드한 OGG를 주입. 있으면 샘플 재생, 없으면 아래 합성 폴백.
  update(karts)              // 엔진음 2채널: 샘플 루프 또는 톱니파+로우패스, 피치는 speed에 비례,
                             // 드리프트 시 스키드 노이즈
  play(name)                 // 'count'|'go'|'pickup'|'use'|'boost'|'hit'|'lap'|'finish'|'menu'
                             // |'results'|'switch'  (11종 — 샘플과 합성 폴백 양쪽에 전부 존재)
  // 샘플이 없는 이름은 오실레이터/노이즈 합성으로 폴백하고, 둘 다 없으면 조용히 무시한다.
}
```

## src/settings.js

```js
export class SettingsMenu {
  constructor({ onChange })  // onChange(settings) — 값 변경 시마다 호출
  readonly settings          // { splitMode:'auto'|'split'|'single', volume:0..1,
                             //   sensitivity:0.5..1.5, laps:3, quality:'high'|'low' }
  open() / close() / toggle()
  isOpen
  // DOM 패널 (중앙 모달). localStorage 'kart-settings'에 저장/복원.
  // 항목: 화면 분할(자동 합체/항상 분할/항상 한 화면), 볼륨, 조향 감도, 랩 수(1~5), 그래픽 품질.
  // 버튼 리매핑 1개 이상 지원: "드리프트 버튼 변경" 클릭 → InputManager.listenForButton 연동은
  //   main이 중계 (SettingsMenu는 onRemapRequest 콜백만 노출: constructor 옵션 { onChange, onRemapRequest }).
  // 마우스로 조작 (게임패드 메뉴 내비게이션은 불요).
}
```

## src/tracks.js  (순수 데이터 — three 비의존, 부작용 없음)

```js
export const TRACKS = [ /* 5개 맵 (평면 4 + 고저차 1) */ ]
// 원소: { id, name, halfWidth, controlPoints, theme, boostPads: [{t, lateral}] }
// theme: { road /*textures 키*/, roadTint, wall, sky, fog:{color,near,far}, groundColor,
//          mountainColor, curbA, curbB, boostColor, decor:'trees'|'rocks'|'none',
//          props: [{ key /*assets.props 키*/, spacing /*m*/, side /*1|-1|0=교대*/, offset /*m*/, scale? }] }
//
// controlPoints는 [x, z](평면) 또는 [x, y, z](고저차) 두 형식을 받는다. 판별은 원소 배열의
// 길이(2/3)뿐이고, 한 맵 안에서 섞으면 track.js가 즉시 throw한다. 두 형식을 모두 읽는
// 소비자는 track.js 생성자와 main.js fitSunToTrack 둘뿐이다 — 새로 추가하는 소비자는
// 반드시 같은 판별을 쓸 것(y를 z로 오독해도 에러가 안 나는 조용한 실패다).
//
// controlPoints는 오프라인 수치 검증(최소 곡률반경 > halfWidth+4, 비인접 이격 > 2*halfWidth+4)을
// 통과한 값이다. **임의로 수정하지 말 것** — 특히 night는 곡률 여유가 0.15m뿐이다.
// 고저차 맵은 위 XZ 조건에 더해 다음을 만족해야 한다(s = XZ 투영 호길이):
//   - 최대 기울기 |dy/ds| <= 0.20 (권장 0.18)
//   - 출발 구간 s ∈ [-25, +30] 에서 |dy/ds| < 0.01
//     (출발선 타일/게이트/스폰 그리드가 피치 보정 없이 수평으로 놓이기 때문)
//   - halfWidth + 3.2 < 최소 곡률반경  (지형 평탄대가 코너 안쪽에서 접히지 않게)
//   - XZ 이격 조건은 고저차가 있어도 그대로 지킬 것 — 지형은 단일 높이장이라
//     같은 XZ에 두 개의 노면 높이(입체 교차)를 표현할 수 없다.
//
// 실측값 (독립 재계산, three 0.170.0):
//   맵                 halfWidth  3D길이   XZ길이  최소곡률R  최소이격  최대|dy/ds|  고도차
//   green-circuit          9      411.50  411.50    13.43     36.59      0        0
//   sunset-speedway       11      465.30  465.30    22.81     44.55      0        0
//   coastal-grandtour     12      885.31  885.31    20.23     44.10      0        0
//   night-technical        8      362.70  362.70    12.16     31.78      0        0
//   alpine-pass           11      746.27  740.21    31.27     44.23    0.1729   35.85m
```

## src/assets.js

```js
export async function loadAssets(onProgress, audioContext)
// onProgress(done, total) — 로딩 오버레이 진행률. audioContext 미전달 시 오디오는 전부 null.
// → { karts:   { red, blue },                       // THREE.Group (전방 -Z 보정 + 스케일 2.1 + 틴트)
//     props:   { lightSquare, lightCurved, signWarning, signStop,
//                signHighway, trafficLight, cone, barrier },  // THREE.Group (일괄 배율 ≈7.33)
//     textures:{ roadDark, roadLight, roadPurple, grassGreen,
//                groundOrange, groundDark, wallRed, wallOrange },  // THREE.Texture
//     sfx:     { count, go, pickup, use, boost, hit, lap, finish, menu, results, switch },
//     engine:  [AudioBuffer|null, AudioBuffer|null], thruster: AudioBuffer|null }
//
// **개별 항목 실패는 throw가 아니라 null + console.warn** — 소비 측이 폴백한다
// (텍스처 없으면 단색, 프롭 없으면 생략, 카트 없으면 절차 메시, 오디오 없으면 합성음).
// loadAssets 자체는 치명적 예외가 아닌 한 항상 resolve 한다.
// props/karts는 **템플릿**이다: 소비 측은 반드시 clone해서 쓰고 원본을 dispose하지 않는다.
```

## src/main.js  (통합 — 통합 담당이 작성)

- importmap 기반 `index.html`에서 `<script type="module" src="src/main.js">`.
- 씬/라이트(햇빛 DirectionalLight+그림자, 하늘 배경색, 안개), 렌더러 생성.
- 상태 머신: `title → countdown(3,2,1,GO) → race → finished → (재시작) countdown`.
- 부팅: `AudioEngine` 생성 → `loadAssets(setLoaderProgress, audio.context)` → 나머지 모듈 초기화 → 루프.
  에셋 로드 실패는 폴백으로 계속 진행하되, **초기화 예외는 로딩 오버레이에 오류 문구를 남긴다**
  (빈 화면으로 조용히 죽지 않게).
- 루프: `inputManager.poll()` → (race 중) 카트 update ×2 → `collideKarts` → `itemSystem.update` →
  `updateBoostPads` → 순위 계산(progress 비교로 rank) → `playEventSounds` → `audio.update` →
  `hud.update` → `splitView.render`.
- 부스터 패드 체인: `def.boostPads` → `track.boostPads` → `main.updateBoostPads`가 카트×패드 조합별
  1.5초 쿨다운(`boostPadCooldowns` Map)으로 `kart.applyBoost(1, 1.2)` + 럼블. **효과음은 여기서 울리지
  않는다** — `playEventSounds()`가 `boostTimer` 상승 에지에서 이미 재생하므로 중복이 된다.
  쿨다운 Map은 `buildTrack()`(맵 재구축)과 `startCountdown()`(같은 맵 재시작) 양쪽에서 clear 해야 한다.
- 맵 선택: 타이틀에서 P0 raw steer의 ±0.5 엣지로 순환(히스테리시스 0.3), `localStorage 'kart-map'`에
  맵 id 저장. 타이틀 배경 프리뷰는 200ms 디바운스 후 재구축하고, Start 시 디바운스를 취소한다.
- pause: race 중 pause 입력 → settingsMenu.toggle() + 게임 일시정지(dt 무시).
- settings.onChange: splitMode → splitView.setMode, volume → audio.setVolume, sensitivity → input에 곱, laps → track.totalLaps 대신 main이 보관하고 kart 생성 시 전달… (laps는 main이 보관, Kart.update 랩 판정은 lap만 올리고 완주 판정은 main이 `kart.lap > laps`로 해도 됨 — 통합 담당 재량, 단 HUD 표기는 일관되게).
- quality: 'low'면 그림자 끄기 + pixelRatio 1.
- `fitSunToTrack(def)`: 그림자 카메라를 맵 크기에 맞춘다. **controlPoints의 두 형식을 아는
  track.js 밖의 유일한 코드**다 — 원소 배열 길이로 [x,z] / [x,y,z]를 판별해 x/z를 뽑고,
  타깃 y와 `cam.far`에 고도 범위를 반영한다. 판별을 빼면 [x,y,z] 맵에서 y를 z로 오독해
  그림자 프러스텀이 어긋나는데 **에러가 나지 않는다**(alpine-pass 실측 z 17.1m 이탈).

## index.html

- importmap: `three` → `https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js`,
  `three/addons/` → `.../examples/jsm/` (assets.js의 GLTFLoader용 — 두 항목 모두 필요).
- 로컬 서버 필요 (`python -m http.server` 또는 `npx serve`). README 없이 index.html 주석에 실행법 1줄.
  `file://` 로는 ES module과 `assets/` fetch가 둘 다 막힌다.
- 부팅 로딩 오버레이(`#boot-loader` / `#boot-bar-fill` / `#boot-status`)를 포함한다 — main.js가
  진행률을 갱신하고 로드 완료 후 제거한다(초기화 실패 시에는 남겨서 오류를 보여준다).

## 게임 상수 정정 (v2)

- 트랙 폭 halfWidth는 맵마다 다르다: green 9 / sunset 11 / night 8 (v1의 "약 9m"는 green 기준).
- 랩 수는 설정(1~5)에서 바뀌며 main이 `track.totalLaps`에 써 넣는다. 기본 3.
