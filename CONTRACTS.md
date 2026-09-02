# Kart Game — Module Contracts (v4, as-built)

3D 마리오카트풍 2인 대전 레이싱. Three.js, ES modules.

> **v3 → v4 변경 (2층 오버패스 · 가변 폭 · 지름길 · 게임 모드 · 물풍선)**
> 1. **2층(오버패스)**: `def.overpasses`가 있는 맵에서는 같은 XZ 좌표를 도로가 두 번 지나갈 수 있다.
>    `sample()`의 최근접 탐색 비용이 `dXZ² + 4·Δy²`가 되어 **질의 `position.y`가 레벨 판별에 쓰인다**.
>    오버패스가 없는 맵에서는 비용 함수 참조 자체가 v3의 `sqDistXZ` 그대로라 `position.y`가 완전히 무시된다.
> 2. **가변 폭**: `def.widthProfile`로 halfWidth가 t에 따라 변한다. `sample()`이 좌우 반폭을 따로 돌려준다.
> 3. **지름길**: `def.shortcuts`로 코너 안쪽 한쪽만 넓힌 "거친 노면" 컷 존. `sample().surfaceFactor`(0.88)가
>    최고속에 곱해진다. 컷 존 밖과 정상 라인에서는 정확히 1이다.
> 4. **게임 모드**: 아이템전 / 스피드전. `itemSystem.setEnabled(bool)` + `hud.setGameMode(mode)`.
> 5. **물풍선**: 5번째 아이템. `kart.applySlip(duration)` / `kart.slipTimer`.
> 6. **맵 구성 변경**: terrace-valley / coastal-grandtour / caldera-circuit / alpine-pass **삭제**,
>    harbor-viaduct(난이도 2) / ravine-crossover(난이도 3) **신규**.
>    (v4 정정) 기존 3맵의 `difficulty`는 초기에 일괄 1이었으나 실측 재산정으로
>    green-circuit **2** / night-technical **3** / sunset-speedway 1 이 되었다. 근거는 tracks.js 헤더 주석.
> 7. **lateral 부호 규약 정정**: v3까지의 "왼쪽 +"는 **오답**이었다. 실제로는
>    `left = (-roadDir.z, 0, roadDir.x)`가 **진행방향 기준 오른쪽**을 가리킨다(전방 -Z일 때 +X = 화면 오른쪽).
>    `steer +1`도 화면 오른쪽이다. 내부 일관성은 v1부터 있었으므로 **동작은 변하지 않았다** — 문서/주석만 정정.
> **하위 호환은 값 수준에서 보장된다** — green-circuit / sunset-speedway / night-technical 3맵은
> 지오메트리·머티리얼·스폰·`sample()`·1인/2인 주행 시계열이 v3(HEAD)와 **비트 단위로 동일**하다
> (헤드리스 회귀 검증 MAXDIFF = 0).

> **v2 → v3 변경 (고저차 트랙 지원)**: 트랙이 더 이상 평면이 아니어도 된다.
> `controlPoints`가 `[x,z]`(평면)와 `[x,y,z]`(고저차) 두 형식을 받고, `sample()`의
> `roadPoint.y`가 실제 노면 높이를, `roadDir`이 3D 접선을 돌려준다. 카트는 노면에
> 붙어 다니고 피치가 들어가며, 경사가 최고속·가속에 반영된다. 고저차 맵은 조각 지형
> 메시를 만들고, 평면 맵은 기존 원판을 그대로 쓴다.
> **하위 호환은 값 수준에서 보장된다** — 기존 평면 4맵(green-circuit / sunset-speedway /
> coastal-grandtour / night-technical)은 지오메트리·머티리얼·스폰·sample()·주행 시계열이
> v2와 비트 단위로 동일하다(헤드리스 회귀 검증 완료).
> *(v4 주: coastal-grandtour는 v4에서 삭제되었다. 남은 회귀 기준선은 green-circuit /
> sunset-speedway / night-technical 3맵이다.)* 아래 표시된 신규 필드는 평면
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
- 게임 모드: 아이템전(기본) / 스피드전 (v4)
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

  readonly maxHalfWidth      // 전 샘플 반폭의 최대값(지형/산/장식/프롭 배치 반경 산정용).
                             // widthProfile / shortcuts 가 없으면 halfWidth 와 같다.

  sample(position /*Vector3*/, hint /*샘플 인덱스 0..399, optional*/)
  // → { t,            // 0..1 스플라인 진행도 (가장 가까운 지점)
  //     roadPoint,    // THREE.Vector3. x,z = 중심선 400샘플 중 최근접점 그대로.
  //                   //   y = 질의 위치(x,z)의 "실제 노면 높이" (평면 맵에서는 항상 0).
  //                   //   400샘플 y를 그대로 쓰지 않고 리본 표면을 재현해 보간하므로
  //                   //   경사에서 계단이 생기지 않는다(리본 표면 대비 실측 오차 <3e-5 m).
  //     roadDir,      // THREE.Vector3 주행 방향 3D 단위벡터. 경사 맵에서는 y != 0 이다.
  //                   //   ★ XZ 평면 방향이 필요하면 반드시 (x,z)만 뽑아 재정규화할 것.
  //                   //     dy/d(수평) = roadDir.y / hypot(roadDir.x, roadDir.z).
  //     lateral,      // 중심선 기준 부호 있는 "수평" 횡방향 오프셋(m).
  //                   //   ★ 부호 규약(v4 정정): + = left 벡터 (-roadDir.z, 0, roadDir.x) 쪽
  //                   //     = **진행방향 기준 오른쪽**(전방 -Z일 때 +X = 화면 오른쪽).
  //                   //     v3까지의 "왼쪽 +"는 오답이다. 동작은 v1부터 이 규약이었다.
  //                   //   경사와 무관한 순수 수평 거리 — 벽 판정 의미가 경사에서 변하지 않는다.
  //     halfWidth,    // 그 지점 도로 반폭(m). ★ v4: **질의 위치의 lateral 부호 쪽** 반폭이다
  //                   //   (lateral >= 0 이면 halfWidthPos, 아니면 halfWidthNeg).
  //                   //   덕분에 kart.js 벽 클램프와 items.js 셸 소멸 판정이 코드 변경 없이
  //                   //   좌우 비대칭(지름길) 도로에서도 정확해진다. 대칭 구간에서는 항등.
  //                   //   ★ (v4) 반폭은 **샘플 계단이 아니라 인접 샘플 사이 선형 보간값**이다 —
  //                   //     도로 리본(_ribbonGeometry)이 샘플 사이를 직선으로 잇기 때문에,
  //                   //     물리 경계를 도색 경계와 일치시키려면 보간이 필요하다. 계단으로
  //                   //     두면 지름길 닫힘 램프에서 "화면상 포장 위인데 offRoad"가 되고
  //                   //     샘플 경계마다 뒤집혀 최고속이 38↔15.2 m/s 로 점멸한다.
  //                   //     보간 계수는 중심선 구간 길이가 아니라 **그 경계선 자신의 종방향
  //                   //     길이**로 잰다(코너 안팎에서 최대 ±hw/R 어긋나기 때문).
  //                   //     고정폭 구간은 두 끝값이 같아 (b-a)===0 → IEEE754 항등이다.
  //     halfWidthPos, // (v4) +lateral 쪽 반폭(m)
  //     halfWidthNeg, // (v4) -lateral 쪽 반폭(m)
  //     offRoad,      // |lateral| > halfWidth 여부 (boolean) — per-side 기준
  //     surfaceFactor,// (v4) 노면 종류 최고속 배율. **일반 노면은 정확히 1**.
  //                   //   지름길 컷 존의 가산 폭 영역(|lateral| > 기준 반폭, 그리고 컷 존 쪽)에서만
  //                   //   SHORTCUT_SURFACE(0.88). kart.js가 offRoad 40% 캡 '앞'에 곱한다.
  //     index }       // 다음 프레임에 hint로 되돌려줄 샘플 인덱스 (0..399)
  // 구현: 스플라인을 400개 점으로 샘플해 최근접 탐색. hint가 있으면 ±25 국소 창만 보고,
  //       국소 최선이 40m(비용 40²)보다 멀면 전역 재탐색으로 자동 폴백한다.
  //
  // ★ v4 — 질의 position.y 의 의미 (2층 맵에서만):
  //   def.overpasses 가 있는 맵(_multiLevel === true)에서는 최근접 비용이
  //     cost = dx² + dz² + LEVEL_W·dy²   (LEVEL_W = 4.0)
  //   이 되어 **질의 위치의 y가 어느 층인지를 결정한다**. 질의 위치는 자기가 있는 레벨의
  //   노면 근처 y를 가져야 하며, 아니면 반대 레벨로 스냅될 수 있다.
  //   오버패스가 없는 맵에서는 비용 함수 참조가 v3의 sqDistXZ 그대로라 **y가 완전히 무시된다**
  //   (연산 순서까지 동일 → 비트 단위 항등).
  //   허용 대역 실측(수직 여유 11.55m, 무힌트 전역 탐색): 횡오프셋 0m에서 하단 판정 y<5.78,
  //   벽 한계 10.5m에서 y<4.58. 하단 카트(y=0)와 셸(y=0.4)은 4m 이상 여유가 있다.
  //   정상 주행은 hint 국소창(±25 샘플 ≈ ±52m 호길이)만으로 100% 안전하다 — 오버패스의
  //   두 t는 300m 이상 떨어져 있어 국소창에 상대 레벨이 들어올 수 없다.
  //   힌트가 없는 경로는 (a) 스폰 첫 프레임, (b) 전역 폴백, (c) 발사체 스폰
  //   — (c)는 items.js가 스폰 시 sample() 1회로 힌트를 시딩해 이중으로 막는다.

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

  // --- (v4) 2층 오버패스 ---
  // def.overpasses = [{ tStart, tEnd }] — **상단(교량 데크) 구간의 t 범위만** 적는다.
  //   진입/진출 램프는 성토(지형이 따라 올라감)라 포함하지 않는다.
  //   0 <= tStart < tEnd <= 1 이 아니면 생성자 throw. 데이터 규약은 0.06 < tStart < tEnd < 0.94
  //   (랩 판정이 t=0 근처 교차에서 깨지지 않도록).
  // 지형: 신설 _nearestGroundIndex(x,z) 가 **오버패스 span 밖 샘플만** 후보로 삼는다.
  //   _groundY / _buildTerrain / _clampUnderRoad 세 곳만 이 함수를 쓰고, sample()/_roadY 는 쓰지 않는다
  //   (노면은 두 레벨 모두 존재해야 하므로). 결과적으로 데크 아래 지형은 하단 노면을 따라가고
  //   상단 데크는 지형에 아무 구속을 걸지 않는다(교량이 떠 있는 것이 맞다).
  //   _multiLevel === false 이면 _nearestGroundIndex 는 _nearestIndex 를 그대로 호출한다(항등).
  // 프롭/깃발/장식은 오버패스 span의 t를 건너뛴다. _buildDecorations의 continue 는
  //   반드시 minD 검사와 같은 위치에 둔다 — rand() 소비 개수가 바뀌면 기존 3맵의 장식 60개가 전부 이동한다.
  // 교량 구조물(_buildOverpasses, _buildWalls 직후 호출): 소핏(상판 밑면, 법선 -Y) + 측면 페이샤
  //   + 난간(데크 위에만) + 교각 + 교대 블록. 전부 _own()/_mat() 등록이라 dispose()가 자동 해제한다.
  //   교각 밑동은 반드시 _terrainSurfaceY(x,z) - 0.4 에 놓는다(_groundY로 놓으면 최대 ±3m 어긋난다).
  //   하단 도로를 관통하는 교각은 생략한다.
  // 수직 여유: DECK_CLEAR = 11.0m (하단 노면 -> 상판 밑면), DECK_THICK = 0.55m.
  //   상단 노면 = 하단 노면 + 11.55m 이상. 데크 반폭 = halfWidth + WALL_OFF + 0.6.
  //
  // --- (v4) 가변 폭 / 지름길 ---
  // def.widthProfile = [{ t, halfWidth }] — **주기 smoothstep 보간**(Catmull-Rom 금지: 오버슛이
  //   반폭을 곡률반경 위로 밀어 리본을 접는다). 없으면 전 샘플 def.halfWidth 상수 → 기존 맵 항등.
  // def.shortcuts = [{ tStart, tEnd, side: -1|+1, extra /*m*/, blend /*m, 기본 20*/ }]
  //   side +1 = lateral > 0 쪽 = **진행방향 기준 오른쪽**. 좌회전 코너(κ>0) 안쪽은 side: -1.
  //   가산 폭은 컷 존 **안에서** blend m에 걸쳐 붙었다 떼어진다(존 밖으로 새지 않는다).
  //   컷 존은 2·blend 이상으로 잡을 것(그보다 짧으면 최대 폭에 도달만 하고 평탄부가 없다).
  // 저작 상한(생성자가 _validateWidths로 검사, 위반 시 console.warn):
  //   감폭 |d hw/ds| <= 0.10(선형 평균 기준, smoothstep 첨두는 그 1.5배) / 증폭 <= 0.30
  //   반폭 >= 5.0m / 출발선 ±30m 구간 반폭 상수 / 샘플별 R_i > _hwMax[i] + 4
  // 시각: 컷 존 쪽 연석은 생략되고 대신 y=0.012의 거친 노면 스트립 + 진입 셰브론이 그려진다
  //   (theme.shortcutColor, 기본 0x8a7a58). 벽은 자동으로 바깥으로 부풀어 열린다.
  // _ribbonGeometry(inner, outer, y, withUV) 는 숫자와 (i)=>number 를 모두 받는다.
  //   ★ 인덱스 감기 idx.push(a,c,b, b,c,e) 와 불변식 innerOff > outerOff 는 절대 손대지 말 것
  //     (깨지면 도로 법선이 -Y가 되어 위에서 도로가 안 보인다).

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
  //   ★ (v4) 클램프는 위치를 재구성하지 않고 **횡방향 초과분만** 밀어낸다
  //     (position += left × (clamped - lateral)). roadPoint 로부터 위치를 다시 만들면
  //     중심선 샘플과 카트 사이의 접선 잔차가 매 프레임 0으로 리셋되어, 벽을 긁는 동안
  //     한 프레임 전진량이 0 아니면 샘플 간격(길이/400) 둘 중 하나가 된다 →
  //     전진하려면 v·dt > 샘플간격/2 여야 하고, 신규 2맵(간격 1.67m/2.08m → 탈출 임계
  //     50.0/62.5 m/s)은 부스트 최고속 55로도 못 넘겨 '벽에 붙으면 영구 정지'가 된다.
  //     그동안 kart.speed 필드는 15 m/s 를 계속 표시해 HUD·엔진음과 실제가 어긋난다.
  // 벽 처리는 "정지"가 아니라 **슬라이드**다(v2): 속도의 벽 법선 성분만 제거하고 접선 성분은 남긴 뒤,
  //   heading을 최대 3rad/s로 벽 접선에 정렬하고 스치는 동안 초당 12% 마찰만 준다.
  //   접촉 '순간' 1회에 한해 법선 성분에 비례한 충격 감속(최대 15%)을 추가로 건다.
  // 방향 규약: 전방 f = (-sin(heading), 0, -cos(heading)). steer>0=오른쪽 입력이고
  //   rotation.y 증가는 왼쪽이므로 yawRate = -steer × ... (부호 반전이 정상이다).
  //   ★ steer +1 = 화면 오른쪽 = sample().lateral 이 커지는 쪽 (헤드리스 직선 스텁으로 실측 확인).
  // (v4) 노면 종류 배율: topSpeed *= (s.surfaceFactor ?? 1) 를 **offRoad 40% 캡 바로 앞**에
  //   곱한다. 일반 노면은 정확히 1이라 기존 맵은 IEEE754상 항등(x*1 === x)이다.
  //   계약 순서: 부스트/견인 → 경사 배율 → surfaceFactor → offRoad 캡(항상 마지막).
  // 바퀴 회전/조향 시각화, 드리프트 시 카트 기울임.

  // 상태 (읽기용)
  position                   // THREE.Vector3 (object3d.position과 동일 참조 허용)
  speed                      // m/s
  heading                    // 라디안
  driftLevel                 // 0|1|2|3 (현재 차지 단계, HUD/파티클용)
  boostTimer                 // 남은 부스트 초 (>0이면 부스트 중)
  spinTimer                  // >0이면 스핀 중(조작 불능)
  catchup                    // (v4) 견인(러버밴딩) 배율. 1 = 없음. 읽기 전용. 초기값 1.
  setCatchup(factor)         // 목표 배율 지정. 1 미만/NaN/undefined는 1로 클램프.
                             // 즉시 반영이 아니라 update()에서 초당 2.0으로 수렴한다.
  // 적용 지점 2곳: topSpeed(비부스트 ×catchup, 부스트 중에는 ×(1+(catchup-1)×0.4))와
  //   throttle 가속(ACCEL ×catchup).
  // 호출자(main.updateCatchup)는 선두와의 progress 격차 30m~130m를 smoothstep으로
  //   보간해 최대 1.25를 넘긴다.
  // ★ 그래서 아래 '게임 상수'의 "최고 속도 약 38 m/s"는 조건부다 — 뒤처진 카트는 부스트
  //   없이 47.5 m/s, 부스트 중에는 60.5 m/s 까지 낸다(절대 상한 SPEED_ABS_MAX=66).

  // 진행/랩 (Kart가 자체 관리; main이 읽음)
  lap                        // 현재 랩 (1부터, 완주 시 totalLaps+1)
  progress                   // lap + t 를 합친 총 진행도 숫자 (순위 정렬용, 단조 증가)
  finished                   // boolean
  finishTime                 // 완주 시각(초) — main이 넘겨주는 raceTime을 update의 5번째 인자로 받아 기록
  // update(dt, input, track, raceTime) 시그니처로 raceTime(초) 수신.
  // 랩 판정: t가 0.9→0.1로 감기면 lap+1, 역주행으로 0.1→0.9면 lap-1 보정.
  //   단 스폰이 출발선 뒤(t≈0.98)이므로 **최초 1회 통과는 랩을 올리지 않는다**
  //   (내부 _crossedStartOnce 플래그. 역주행으로 되감으면 랩 대신 이 플래그를 되돌린다).
  // ★ (v4) 완주 판정은 **결승선을 정주행으로 막 통과한 프레임에만** 검사한다
  //   (매 프레임 lap > totalLaps 를 보지 않는다). 매 프레임 비교를 하면 레이스 도중
  //   설정에서 랩 수를 현재 랩보다 낮추는 순간, 결승선과 무관한 트랙 한복판에서 완주가
  //   확정되고 finishTime에 통과와 무관한 raceTime이 박혀 두 카트의 순위가 붕괴한다.
  //   랩 수가 라이브로 낮아진 경우엔 **다음 결승선 통과 시점**에 정상 완주 처리된다.
  //   역주행 보정으로 lap이 줄어드는 경로는 완주를 트리거하지 않는다.

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

  // (v4) 물풍선/웅덩이 — 접지력 상실. **스핀이 아니다**: 조작은 살아 있고 조향이 둔해진다.
  applySlip(duration)        // starTimer > 0 이면 무시(spin()과 동일 규약). 기존 값과 max로 합쳐진다.
  slipTimer                  // 읽기 전용, 초. >0인 동안:
  //   조향 권한 ×0.45 (yawRate에만 곱한다 — steerIn을 0으로 만들지 않는다),
  //   목표 슬립각 = clamp(-yawRate × 0.42, ±0.5) 이고 수렴 속도가 6 → 2.0으로 느려진다,
  //   speed *= 0.90^dt 항력.
  //   실측(38m/s, steer 1): 요레이트 -2.20 → -0.99 rad/s, 선회반경 17.3m → 38.4m, 슬립각 23.8도.
  //   ★ (v4) main은 slipTimer의 **상승 에지**에 'hit' 효과음 + 럼블(0.35, 0.6, 400ms)을 건다 —
  //     스핀(0.75, 0.5, 250ms)과 세기·길이로 구분한다. 피드백이 없으면 조향 권한을 55%
  //     빼앗기는데 화면상 단서가 없어 "조작이 먹통"으로 읽힌다.
  //   slipTimer === 0 이면 위 셋이 전부 정확한 항등이라 기존 주행 시계열은 비트 단위로 보존된다.
}

export function collideKarts(a, b)
// 두 카트 간 원형 충돌(반경 1.2m): 겹치면 서로 밀어내고 속도 일부 교환. 매 프레임 main이 호출.
// ★ (v4) 판정 **앞에 층 게이트**가 있다: |a.position.y - b.position.y| > 5.0 이면 즉시 return.
//   겹침 판정 자체는 XZ 거리만 쓰는데, 2층 오버패스 맵에서는 같은 XZ를 노면이 두 번 지나므로
//   게이트가 없으면 수직 13~15m 떨어진 서로 다른 층의 두 카트가 서로를 밀고 속도를 교환하고,
//   위층이 스타면 매 프레임 spin()이 재호출되어 아래층 카트 속도가 0으로 무너진다.
//   임계 5.0m는 items.js PUDDLE_LEVEL_DY와 같은 값이다. 실측 여유: 같은 층에서 XZ<2.4m인
//   두 노면점의 최대 |dy| 는 harbor 0.26m / ravine 0.35m, 층이 갈린 쌍의 최소 |dy| 는 13.0/15.0m
//   → 단일 레벨 맵에서는 무발동(항등)이고 층간은 확실히 차단된다.
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

  enabled                    // (v4) 아이템전/스피드전 스위치. 기본 true.
  setEnabled(enabled)        // (v4) false면 박스를 숨기고(_clearProjectiles로 발사체·웅덩이 전부 제거)
                             // update()와 use()가 즉시 return한다(use는 kart.item도 null로 비운다).
                             // boxes/shells/bananas/balloons/puddles 배열 자체는 유지된다
                             // (main.resetItems()가 이 배열들을 직접 순회하므로).
                             // ★ 그래서 main.resetItems()는 박스 가시성을 되돌릴 때 반드시
                             //   itemSystem.enabled 를 존중해야 한다. 무조건 visible=true 로
                             //   되돌리면 update()가 !enabled 로 즉시 return하는 탓에 회전도
                             //   부유도 하지 않는 큐브 12개가 스피드전 노면 위에 얼어붙는다.

  update(dt, karts)
  // - 박스 픽업 판정(반경 1.6m, XZ 거리): 아이템 없는 카트에 랜덤 지급 →
  //   kart.item = 'mushroom'|'shell'|'banana'|'star'|'balloon'
  //   가중치(합 1.00): 뒤처짐 [0.32, 0.18, 0.08, 0.26, 0.16] / 선두 [0.22, 0.30, 0.24, 0.06, 0.18]
  //   (뒤처진 쪽 우대 규약 유지: star 0.26 vs 0.06, mushroom 0.32 vs 0.22)
  // - 카트의 input.useItem 처리는 main이 함: main이 useItem edge 시 itemSystem.use(kart, karts) 호출.
  // - 발사체/설치물 갱신: shell은 전방 직진 25m/s+사용자 속도, 벽/카트 충돌 시 소멸(카트면 spin()),
  //   banana는 뒤에 설치, 밟으면 spin(). star는 kart.setStar(5), mushroom은 kart.applyBoost(1, 1.2).
  //   shell의 속도는 XZ 전용(y 성분 0)이고, y는 매 프레임 track.sample().roadPoint.y + 0.4로
  //   덮어써 노면에 밀착한다 — 경사 맵에서 언덕을 관통하지 않는다(벽 판정용 sample 호출을
  //   재사용하므로 추가 비용 0). 평면 맵에서는 roadPoint.y가 0이라 y가 계속 0.4로 고정된다.
  //   banana는 kart.position.y + 0.25 — 카트 y가 이미 노면 높이라 자동으로 따라온다.
  //   박스 픽업 판정은 XZ 거리만 쓰므로 경사와 무관하다.
  // - kart.item 필드는 ItemSystem이 kart 객체에 동적으로 붙여 관리 (Kart 클래스는 모름). 초기 null.

  // (v4) 물풍선: 포물선으로 던져 착탄점에 물웅덩이를 만든다.
  //   발사 = 전방 1.6m / +1.0m, 수평 18 + 사용자 속도×0.5, 수직 +9.0, 중력 22 m/s²
  //   (v4 정정) 체공은 **0.8944s** — 0.818s는 발사 높이로 되돌아오는 시간이고 파열은 그보다
  //   0.75m 아래다. 정점 노면+2.84m(발사점 대비 +1.84m). 30m/s 주행 시 수평속 33 m/s →
  //   도달 **29.5m**(실측 29.15m). "20m 앞 카트를 넘겨 착탄" 전제는 그대로 성립한다.
  //   ★ 발사 수직속도는 BALLOON_UP 고정이 아니라 **경사 보정**된다: 평지라면 날아갔을 거리
  //     앞의 노면 높이를 미리 재고(sample() 1회, 발사 높이를 탐침 y로 넣어 같은 층을 재게 한다)
  //     그 고저차를 체공시간으로 나눈 값을 더한다. 보정이 없으면 파열 기준면(roadPoint.y)이
  //     비행 중 함께 오르내려 도달거리가 13.6~54.9m(4배)로 흔들린다 → 보정 후 30.8~35.2m.
  //     평면 맵은 고저차가 정확히 0이라 vel.y = 9.0 + 0 으로 **비트 단위 항등**이다.
  //   파열 조건: 착탄(y <= roadPoint.y + 0.25) / 직격(3D 거리 1.4m, 발사 0.3s간 주인 무시) / 수명 3.0s.
  //   **수명 초과만 웅덩이를 남기지 않는다.** 직격 시 kart.applySlip(1.6).
  //   ★ (v4) 착탄이라도 |lateral| > halfWidth + 1.5 면 웅덩이를 남기지 않고 조용히 소멸한다
  //     (셸과 같은 코스 이탈 규약). 벽 높이 1.4m보다 포물선 정점이 높아 물풍선은 벽을 넘어가는데,
  //     그대로 두면 어느 카트도 닿을 수 없는 곳에 8초짜리 웅덩이가 남고, 노면 단면을 횡방향으로
  //     무한 외삽하는 _roadY 탓에 지형 위 공중에 뜬 웅덩이까지 생긴다.
  //     실측 억제 효과: 중심선 전방 투척 400발 중 벽 바깥 착탄이 5맵 전부 0건(수정 전 86~173건).
  //   웅덩이: 반경 4.0m, 수명 8.0s, 판정 반경 4.6m. CircleGeometry 17개 정점 각각에
  //     track.sample()로 노면 높이를 얹어 경사를 따른다(평면 디스크는 18% 경사에서 ±0.72m 파묻힌다).
  //     depthWrite:false로 z-fighting 원천 차단. 페이드인 0.15s / 페이드아웃 1.0s.
  //     판정은 매 프레임 XZ 거리 + **높이차 5m 이내**(2층 맵에서 위/아래층 오판 방지).
  //     지오/재질은 위치 종속이라 웅덩이마다 새로 만들고 소멸 시 dispose 한다.
  // (v4) 발사체 힌트 시딩: _spawnShell / _spawnBalloon 은 스폰 시 track.sample()을 1회 호출해
  //   _sampleHint 를 채운다. 2층 맵에서 첫 프레임 무힌트 전역 탐색이 반대 레벨을 잡는 것을 막는다.
  //   (발사당 400회 비교 1번 — 무시 가능.)

  balloons                   // [{ mesh, vel, owner, life, _sampleHint }]
  puddles                    // [{ mesh, life, age, owner, ownerGrace }]

  use(kart, allKarts)        // kart.item 사용 후 null로. enabled === false 면 즉시 null로만 비운다.
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
  setMapInfo({ name, difficulty })
  // 선택된 맵 이름 — 타이틀의 ◀ 맵명 ▶ 와 레이스 중 상단 배지에 동시 반영.
  // (v4) difficulty 1|2|3 → 타이틀 맵 이름 아래 ★☆☆ / ★★☆ / ★★★. 생략 시 1. {name}만 넘기는 v3 호출도 동작한다.
  setGameMode(mode)          // (v4) 'items' | 'speed'. 그 외 값은 'items'로 폴백.
  // - 타이틀 모드 행(아이템전 / 스피드전)의 강조를 바꾼다. 힌트: "S / LT: 모드 전환"
  // - speed면 아이템 가이드 카드(this.itemGuideEl)를 display:none
  // - speed면 update()가 플레이어 패널의 itemSlot을 숨기고 아이템 획득/사용 토스트를 띄우지 않는다
  //   (_prevItems 갱신은 계속 하므로 모드를 되돌려도 오작동하지 않는다)
  // - 레이스 중 상단 맵 배지를 "맵명 · 스피드전"으로 병기
  // ITEM_ICONS / ITEM_INFO / ITEM_ORDER 5종: mushroom 🍄 / shell 🐢 / banana 🍌 / star ⭐ / balloon 💧.
  // ITEM_INFO는 여전히 가이드 카드와 토스트의 단일 출처다.
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
export const TRACKS = [ /* 5개 맵 (평면 3 + 고저차·2층 2) */ ]
// 원소: { id, name, halfWidth, difficulty, controlPoints, theme, boostPads: [{t, lateral}],
//         overpasses?, widthProfile?, shortcuts? }
// difficulty: 1(초심자) | 2(조금 적응) | 3(많이 적응). HUD 타이틀 별표 표시에만 쓰이는 불활성 데이터다
//   (def를 키 순회하거나 직렬화하는 코드가 코드베이스에 한 곳도 없음을 grep으로 확인).
//   ★ 축은 **주행 난이도**(코스를 벗어나지 않고 도는 어려움)이지 길이도 고저차도 아니다.
//   맵을 추가/수정하면 눈대중으로 1을 넣지 말고 tracks.js 헤더의 4지표를 다시 재고 등급을
//   재산정할 것 — v4 초기에 기존 3맵에 일괄 1을 넣어 최난도(night)와 최이지(sunset)가 같은
//   ★☆☆ 를 달았고, 별표만 보고 고르는 초심자가 가장 어려운 맵을 집게 되어 있었다.
// overpasses:   [{ tStart, tEnd }]                                → track.js 2층 절 참조
// widthProfile: [{ t, halfWidth }]                                 → 주기 smoothstep 보간
// shortcuts:    [{ tStart, tEnd, side: -1|+1, extra, blend? }]     → side +1 = 진행방향 오른쪽
// theme 추가 키(선택): bridgeColor(기본 0x9a9a96), shortcutColor(기본 0x8a7a58)
// theme: { road /*textures 키*/, roadTint, wall, sky, fog:{color,near,far}, groundColor,
//          mountainColor, curbA, curbB, boostColor, decor:'trees'|'rocks'|'none',
//          props: [{ key /*assets.props 키*/, spacing /*m*/, side /*1|-1|0=교대*/, offset /*m*/, scale? }] }
//
// controlPoints는 [x, z](평면) 또는 [x, y, z](고저차) 두 형식을 받는다. 판별은 원소 배열의
// 길이(2/3)뿐이고, 한 맵 안에서 섞으면 track.js가 즉시 throw한다. 두 형식을 모두 읽는
// 소비자는 track.js 생성자와 main.js fitSunToTrack 둘뿐이다 — 새로 추가하는 소비자는
// 반드시 같은 판별을 쓸 것(y를 z로 오독해도 에러가 안 나는 조용한 실패다).
//
// controlPoints는 오프라인 수치 검증을 통과한 값이다. **임의로 수정하지 말 것** —
// 특히 night는 곡률 여유가 0.15m뿐이다.
//
// ★ v4 형상 검증 조건 (v3의 "비인접 이격 > 2*halfWidth+4"를 대체한다 — 그 조건 자체가
//   오버패스를 정의상 금지하는 조건이었다):
//   호길이 간격이 π·(max hw + 4) 이상인 모든 중심선 점 쌍 (i, j)에 대해,
//   S = hw_i + hw_j + 4, dXZ = 수평 거리, dY = |y_i - y_j| 라 할 때
//     ZONE-A (평면 이격):  dXZ >= S + 8                                        → 통과 (dY 무관)
//     ZONE-B (입체 교차):  dY >= 11.0  AND  i 또는 j 가 선언된 overpass span 안 → 통과 (dXZ 무관)
//     그 외                                                                    → 실패
//   +8m 가드밴드가 "간신히 평면 이격만 되는" 애매한 중간 영역을 제거한다.
//   ZONE-B의 "선언된 span" 조건은 우연한 적층을 금지한다 — 데이터에 적지 않은 곳에서 두 노면이
//   겹치면 지형·교량이 생성되지 않아 조용히 깨진다.
//   추가: 모든 overpass에 0.06 < tStart < tEnd < 0.94, 교차 t 중 하나가 <0.1이고 다른 하나가
//   >0.9인 조합 금지(랩 판정 보호), 교차각 >= 70도, 하단 통과 구간 ±20m에서 |dy/ds| <= 0.02.
//   곡률 정합은 **샘플별**로 검사한다: R_i > _hwMax[i] + 4 (리본), R_i > _hwMax[i] + 3.2 (지형 평탄대).
//   폭: 감폭 |d hw/ds| <= 0.10 / 증폭 <= 0.30 / 반폭 >= 5.0m / 출발선 ±30m 반폭 상수.
//   ★ (v4) 감폭 검사는 기준폭(_hwBase)뿐 아니라 **합성 반폭**(_hwPos/_hwNeg — 기준폭 + 지름길
//     가산폭)에도 건다. 카트가 부딪히는 벽 한계는 sample().halfWidth + 1.5 = _hwPos + 1.5 이므로,
//     "컷 존이 닫히는" 것도 카트 입장에서는 본선이 좁아지는 것과 완전히 같은 '다가오는 벽'이다.
//     기준폭과 가산폭을 따로 보면 닫힘 램프가 증폭 상한(0.30)으로만 검사돼 조용히 통과한다.
//   ※ 현재 harbor-viaduct / ravine-crossover 는 이 검사에서 첨두 0.374(상한 0.10의 3.7배)로
//     **생성자 경고가 뜬다** — 알려진 데이터 저작 위반이며 아래 '잔여 아티팩트'에 함께 적었다.
// 고저차 맵은 위 XZ 조건에 더해 다음을 만족해야 한다(s = XZ 투영 호길이):
//   - 최대 기울기 |dy/ds| <= 0.20 (권장 0.18)
//   - 출발 구간 s ∈ [-25, +30] 에서 |dy/ds| < 0.01
//     (출발선 타일/게이트/스폰 그리드가 피치 보정 없이 수평으로 놓이기 때문)
//   - halfWidth + 3.2 < 최소 곡률반경  (지형 평탄대가 코너 안쪽에서 접히지 않게)
//   - (v3까지) "XZ 이격 조건은 고저차가 있어도 그대로 지킬 것 — 지형은 단일 높이장이라 같은 XZ에
//     두 개의 노면 높이(입체 교차)를 표현할 수 없다"는 **v4에서 폐기**되었다. 아래 ZONE-A/B 규칙을 쓴다.
//
// 실측값 (독립 재계산, three 0.170.0):
//   맵                 난이도 halfWidth  3D길이   XZ길이  최소곡률R  최대|dy/ds|  고도차  오버패스
//   green-circuit         2       9      411.50  411.50    13.43       0        0       -
//   sunset-speedway       1      11      465.30  465.30    22.81       0        0       -
//   night-technical       3       8      362.70  362.70    12.16       0        0       -
//   harbor-viaduct        2      10      667.31  664.90    18.74     0.1570   22.00m   1개(수직여유 13.0m)
//   ravine-crossover      3       9      833.01  829.86    18.02     0.1690   29.00m   1개(수직여유 15.0m)
// 신규 2맵은 반경 변조 폐곡선이 아니라 **구간 시퀀스**(직선 + 클로소이드-원호-클로소이드 코너)를
// 적분해 만들었다. 두 로브를 각각 총회전 +270도 / -270도로 폐합해 이어 붙이면 총회전 0(=8자)이고
// 접합점을 두 번 지나며 heading 차가 정확히 90도가 된다 → 교차각 90.0도를 설계로 얻는다.
// 균일 호길이 6.0m 재샘플(8m는 R20 코너에서 Catmull-Rom이 원호를 설계값의 0.79배까지 깎는다).
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
- **(v4) 게임 모드**: `gameMode`는 `'items' | 'speed'`, `localStorage 'kart-mode'`에 저장.
  - 타이틀에서 **P0 raw brake**(키보드 S / 패드 LT)의 0.5 상승 엣지로 토글(해제 0.2 히스테리시스).
    brake를 쓰는 이유: `steer`는 맵 선택, `drift`는 패드 A/RB라 `anyStartPressed()`와 동시에
    눌린다 — 세 축 중 충돌하지 않는 유일한 축이다. `input.js`는 손대지 않는다.
  - `goToTitle()`에서 현재 brake 값으로 래치를 시딩한다(brake를 누른 채 타이틀에 들어와도 즉시 토글되지 않게).
  - `setGameMode(m, announce)` → `itemSystem.setEnabled(m === 'items')` + `hud.setGameMode(m)` (+ 'switch' 효과음).
  - `buildTrack()`이 `new ItemSystem(...)` 직후에 `setEnabled(gameMode === 'items')`를 다시 건다.
  - 레이스 루프의 아이템 사용 중계는 `gameMode === 'items'` 가드로 감싼다(효과음 중복 방지).
  - `resetItems()`는 balloons/puddles도 정리한다(웅덩이는 지오/재질까지 dispose).
  - 스피드전에 남는 것: 드리프트 미니터보, 부스터 패드, 견인, 벽 슬라이드, 경사 물리.
- **(v4) 난이도 표기**: `hud.setMapInfo`의 3개 호출부(`setMapIndex` / `buildTrack` / `goToTitle`)가
  모두 `difficulty: def.difficulty ?? 1`을 함께 넘긴다.
- pause: race 중 pause 입력 → settingsMenu.toggle() + 게임 일시정지(dt 무시).
- settings.onChange: splitMode → splitView.setMode, volume → audio.setVolume, sensitivity → input에 곱, laps → track.totalLaps 대신 main이 보관하고 kart 생성 시 전달… (laps는 main이 보관, Kart.update 랩 판정은 lap만 올리고 완주 판정은 main이 `kart.lap > laps`로 해도 됨 — 통합 담당 재량, 단 HUD 표기는 일관되게).
- quality: 'low'면 그림자 끄기 + pixelRatio 1.
- `fitSunToTrack(def)`: 그림자 카메라를 맵 크기에 맞춘다. **controlPoints의 두 형식을 아는
  track.js 밖의 유일한 코드**다 — 원소 배열 길이로 [x,z] / [x,y,z]를 판별해 x/z를 뽑고,
  타깃 y와 `cam.far`에 고도 범위를 반영한다. 판별을 빼면 [x,y,z] 맵에서 y를 z로 오독해
  그림자 프러스텀이 어긋나는데 **에러가 나지 않는다**(alpine-pass 실측 z 17.1m 이탈).

## 알려진 잔여 아티팩트 (v4, 수용)

- **합체 카메라가 데크 아래를 지날 때 (두 카트가 모두 하단일 때만 남음)**: `splitMode='auto'`에서
  **같은 층에 있는** 두 카트의 중점이 교량 데크 아래에 있으면, 합체 카메라 높이
  `CHASE_UP + 1.2 + spread×0.26`가 상판 밑면을 넘어가 짧게 카트가 상판에 가려질 수 있다.
  차폐 임계 spread 재실측: harbor-viaduct **24.5m**(합체 상한 26m 안이라 발생 가능),
  ravine-crossover는 **합체 구간(26m) 안에서 발생하지 않는다**.
  체이스캠(분할 모드)은 어떤 경사에서도 카메라가 카트보다 최대 6.5m 위라 **영구히 차폐되지 않는다**
  (실측 여유 harbor 7.45m / ravine 9.45m). `splitMode='split'`에서는 발생하지 않는다.
- (v4 해소됨) **층이 갈린 두 카트의 오합체**: 예전에는 `_updateLayoutTarget`이 y를 포함한 3D 거리만
  봐서, 상판과 그 아래 도로에 있는 두 카트(XZ 0.3m, 고도차 13~15m)를 "26m 이내 = 가깝다"로 오판해
  **반드시 합체**했고, 중점 y가 두 층 중간이라 spread=0에서도 카메라가 상판 밑면을 넘어 하단
  플레이어가 0.7~0.9초간 완전히 사라졌다. 이제 거리 판정 **앞에** 층 분리를 둔다:
  `|Δy| > 8.0` 이면 강제 분할, `> 6.5` 이면 재합체를 지연(히스테리시스).
  임계 근거 — 5맵 노면을 **전 주행폭**(중심선 ±0.95·반폭)으로 전수 조사했을 때 3D 26m 이내인
  두 노면점의 같은 층 최대 고도차는 green/sunset/night 0.00m · harbor **6.49m** · ravine **6.11m**
  인 반면 층이 갈린 쌍은 13.00/15.00m 라, 8.0/6.5 는 그 빈 구간 한가운데다.
  ※ 중심선만 재면 4.04/4.29m 가 나오는데 이는 과소평가다 — 스위치백 램프에서 두 카트가 도로
  반대쪽 가장자리에 붙으면 3D 거리가 줄면서 같은 층인데도 6.49m 까지 벌어진다. 임계를 6.0 으로
  두면 그 배치(같은층 배치의 0.0026%)가 거짓 분할된다. 8.0 에서는 1.8M 배치 전수 검사 0건.
  평면 맵은 Δy가 항상 0이라 **값 수준 항등**이다.
- **신규 2맵의 합성 반폭 감폭률 경고**: harbor-viaduct / ravine-crossover 는 지름길 컷 존이 닫히는
  램프에서 합성 반폭 감폭률 첨두 0.374(상한 0.10)로 생성자 `console.warn` 이 1건씩 뜬다.
  38 m/s 에서 벽이 프레임당 0.237m 밀고 들어온다는 뜻이다. 해소하려면 `shortcuts[].blend` 를
  24m → 90m 이상으로 키워야 하는데(가산폭 E=6 기준 `blend >= 1.5·E/0.10`), 그러면 컷 존 평탄부가
  사라져 두 맵의 지름길 이득이 반토막 난다 — **경고를 남긴 채 수용**한다.
- 근본 해결(터널 구간에서 카메라를 낮추는 것)은 다음 기회로 미룬다. 여유를 15.6m로 키우는 안은
  기각했다 — 진입 램프가 왕복 180m를 잡아먹고 5층 건물 높이의 교각이 카트 스케일과 맞지 않는다.

## index.html

- importmap: `three` → `https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js`,
  `three/addons/` → `.../examples/jsm/` (assets.js의 GLTFLoader용 — 두 항목 모두 필요).
- 로컬 서버 필요 (`python -m http.server` 또는 `npx serve`). README 없이 index.html 주석에 실행법 1줄.
  `file://` 로는 ES module과 `assets/` fetch가 둘 다 막힌다.
- 부팅 로딩 오버레이(`#boot-loader` / `#boot-bar-fill` / `#boot-status`)를 포함한다 — main.js가
  진행률을 갱신하고 로드 완료 후 제거한다(초기화 실패 시에는 남겨서 오류를 보여준다).

## 게임 상수 정정 (v2)

- 트랙 폭 halfWidth는 맵마다 다르다: green 9 / sunset 11 / night 8 / harbor-viaduct 10 /
  ravine-crossover 9 (v1의 "약 9m"는 green 기준). (v4) 신규 2맵은 구간별로 좁아지므로
  기준폭일 뿐이다 — 실제 반폭은 `sample().halfWidth`(per-side), 전역 최대는 `track.maxHalfWidth`.
- 랩 수는 설정(1~5)에서 바뀌며 main이 `track.totalLaps`에 써 넣는다. 기본 3.
