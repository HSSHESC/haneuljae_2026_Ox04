# 에셋 통합 + 멀티 맵 — 배치 결정 & 계약 v2

CONTRACTS.md의 증보판. 충돌 시 이 문서가 우선. 기존 모듈 간 규약(좌표계 Y-up, 전방 -Z, 미터 단위, named export, 모듈 간 직접 import 금지(three와 assets.js/tracks.js 데이터 모듈 제외))은 유지.

## assets/ 폴더 (복사 완료 상태로 제공됨 — 구현 에이전트는 존재를 신뢰하되 시작 시 목록 확인)

```
assets/
  karts/kart-red.glb            # Kenney car-kit kart-oodi (P0)
  karts/kart-blue.glb           # kart-oobi (P1)
  karts/Textures/colormap.png   # GLB가 상대경로 'Textures/colormap.png'로 참조 — 위치 불변
  props/light-square.glb  light-curved.glb  road-sign-warning.glb  road-sign-stop.glb
        sign-highway.glb  traffic-light.glb  construction-cone.glb  construction-barrier.glb
  props/Textures/colormap.png   # city-kit 공용 아틀라스 (동일 규칙)
  textures/road-dark.png  road-light.png  road-purple.png     # prototype texture_07 (라벨 없는 체커, 1024², 타일링 OK)
           grass-green.png  ground-orange.png  ground-dark.png # texture_06 (은은한 준단색)
           wall-red.png  wall-orange.png                       # texture_08
  audio/sfx/count.ogg go.ogg pickup.ogg use.ogg boost.ogg hit.ogg lap.ogg finish.ogg menu.ogg results.ogg switch.ogg
  audio/engine/engine-0.ogg engine-1.ogg thruster.ogg          # 5.0s 루프 소재 (mono)
  ui/medal-1st.png medal-2nd.png                               # 40×80 저해상도 — 표시 크기 ≤80px 권장, image-rendering 무관
  ui/KenneyFuture.ttf
```

전부 CC0 (Kenney). GLB의 텍스처는 **외부 참조**이므로 glb와 Textures/ 상대 위치를 옮기지 말 것.

## 실측 메모 (해체 보고에서)

- 카트 GLB: 전장 1.428m → **스케일 2.1배**로 약 3m. 로컬 **+Z가 전방**(게임은 -Z 전방 → 내부 래퍼에 rotation.y=π 보정). 원점=바닥 접지면. 바퀴는 자식 노드 4개: `wheel-front-left/right`, `wheel-back-left/right` (스핀 회전축=로컬 X). 차체 색은 5종 공통 라벤더-그레이 — **머티리얼 clone 후 코드 틴트 필수**(P0 빨강, P1 파랑). 운전자 노드 이름 `character`.
- 프롭 GLB: 킷 자체 스케일이 1m 타일 기준으로 작음(가로등 0.6m 등) — 일괄 리스케일 계수 필요, **약 ×7** 후 눈으로 확인 권장(가로등 ≈4.2m). KHR_texture_transform 사용 — 표준 GLTFLoader가 지원, 커스텀 머티리얼로 갈아끼우지 말 것.
- 엔진 루프: 시작/끝 경계 샘플 갭이 있어 그대로 loop=true 시 미세 클릭 가능 — loopStart/loopEnd를 50ms 안쪽으로 잡거나 무시(허용). 두 카트에 engine-0/engine-1을 **서로 다르게** 배정(위상 간섭 방지).

## 새 모듈: src/assets.js

```js
export async function loadAssets(onProgress /* (done,total)=>void, 선택 */)
// → { karts: { red: THREE.Group, blue: THREE.Group },   // 전처리 완료: 스케일 2.1, 전방 -Z 보정 래퍼,
//                                                        // 차체 머티리얼 clone+틴트(red 0xd23a2f / blue 0x2f6bd2),
//                                                        // 그림자 castShadow 설정. 바퀴 노드 이름 유지.
//     props: { lightSquare, lightCurved, signWarning, signStop, signHighway, trafficLight, cone, barrier }, // 리스케일 완료 Group
//     textures: { roadDark, roadLight, roadPurple, grassGreen, groundOrange, groundDark, wallRed, wallOrange },
//                                                        // RepeatWrapping, SRGB, anisotropy 4 설정 완료
//     sfx: { count, go, pickup, use, boost, hit, lap, finish, menu, results, switch: AudioBuffer },
//     engine: [AudioBuffer, AudioBuffer], thruster: AudioBuffer }
// GLTFLoader/TextureLoader 사용. AudioBuffer 디코드는 AudioContext가 필요하므로
// loadAssets(onProgress, audioContext) 두 번째 인자로 받는다 (audio.js의 ctx를 main이 전달).
// 로드 실패한 개별 항목은 throw하지 말고 null로 두고 console.warn — 소비 측은 null이면 기존 절차 생성/합성으로 폴백.
// @font-face 'Kenney Future' (assets/ui/KenneyFuture.ttf) 를 <style>로 주입하는 것도 이 모듈 책임.
```

three/addons import 사용: `import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'` — index.html importmap에 `"three/addons/": "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/"` 추가(통합 담당).

## 새 모듈: src/tracks.js (순수 데이터)

```js
export const TRACKS = [ { id, name, controlPoints: [[x,z],...],  // 폐곡선 Catmull-Rom 제어점 (y=0)
    halfWidth,                       // 기본 9
    theme: { road, ground, wall,     // assets.textures 키 이름 (문자열)
             sky: 0x??????, fog: {color, near, far}, groundColor: 0x??????, curbA: 0x??????, curbB: 0x??????,
             props: [ { key: 'lightSquare', spacing: 90, side: 1|-1|0 /*0=양쪽 교대*/, offset: 12 }, ... ] } } ]
```

**맵 3종** (제어점은 구현 재량 — 겹침 없는 닫힌 코스, 각 500~900m):
1. `green-circuit` "그린 서킷" — 완만한 기본 서킷(현행과 유사). road-dark/grass-green/wall-red, 밝은 하늘, 가로등+표지판.
2. `sunset-speedway` "선셋 스피드웨이" — 고속 타원+시케인 1개, halfWidth 11. road-light/ground-orange/wall-orange, 노을 하늘(주황 안개), sign-highway+traffic-light.
3. `night-technical` "나이트 테크니컬" — 헤어핀 2개+S자, halfWidth 8. road-purple/ground-dark/wall-red, 어두운 하늘+짙은 안개, construction-cone/barrier+light-curved.

## 변경: src/track.js

- `new Track(scene, def /*TRACKS 원소*/, assets)` — def.controlPoints/halfWidth/theme 반영. 텍스처는 assets.textures[def.theme.road] 등으로 조회, **null이면 기존 단색 머티리얼 폴백**. 노면/잔디/벽 텍스처 repeat는 월드 크기 기준(체커 1칸≈1m가 되게: repeat = 길이/4 정도로 눈 확인). scene.background/fog도 여기서 theme대로 설정.
- 프롭 배치: theme.props 각 항목에 대해 스플라인을 spacing 간격으로 돌며 도로 밖 offset 위치에 `assets.props[key].clone()` 배치(주행 방향으로 정렬). props가 null이면 생략.
- `dispose(scene)` 추가 — 자기가 add한 모든 Object3D 제거 + geometry/material dispose (clone된 프롭의 geometry/material은 원본 공유이므로 **dispose하지 말고 remove만**; 자체 생성 지오메트리만 dispose).
- 기존 public API(sample, getSpawnTransforms, itemBoxPositions, length, totalLaps)는 시그니처 불변.

## 변경: src/kart.js

- 생성자 옵션에 `model?: THREE.Group` 추가 (assets.karts.red/blue — main이 전달). 있으면 `.clone(true)` 해서 사용하고 절차 생성 메시 생략, 없으면 기존 절차 생성 유지.
- GLB 모델 사용 시: 바퀴 노드(`wheel-*`) 찾아 speed에 비례해 로컬 X축 스핀(바퀴 반지름 0.21×2.1≈0.44m), 앞바퀴는 조향 시각화(Y축 ±0.45rad) — 스핀과 조향 동시 적용 위해 앞바퀴는 부모 피벗 Group으로 감싸기. 드리프트 기울임/틸트 기존 로직 유지(래퍼 그룹에 적용).
- 물리 수치·충돌 반경(1.2)·API 불변.

## 변경: src/audio.js

- `provideBuffers({ sfx, engine, thruster })` 메서드 추가 — 호출 후 play(name)은 해당 슬롯 AudioBuffer가 있으면 샘플 재생(볼륨 연동), 없으면 기존 합성음 폴백. 새 슬롯 'results'(결과 화면 진입), 'switch'(설정 변경) 추가 — 미지 이름은 조용히 무시.
- 엔진음: buffers 제공 시 카트 i에 engine[i] 루프 소스(loop=true) + playbackRate = 0.6 + (speed/38)*1.1, 부스트 중 thruster 레이어 추가. 미제공 시 기존 합성 유지. 스키드 노이즈는 합성 유지.
- `get context()` — AudioContext 노출 (assets.js 디코드용으로 main이 꺼내 씀).

## 변경: src/hud.js

- @font-face는 assets.js가 주입 — HUD는 CSS font-family에 `'Kenney Future', 기존폰트` 우선 적용(숫자·카운트다운·타이틀).
- `setMapInfo({ name })` 추가 — 타이틀 화면에 현재 선택 맵 이름 + "◀ ▶ 로 맵 선택" 표시, 레이스 중 상단 소형 표기.
- 결과 패널: 1위/2위에 `<img src="assets/ui/medal-1st.png">`/`medal-2nd.png` 표시(높이 64px, DNF는 메달 없음).

## 변경: src/main.js + index.html (통합 담당)

- importmap에 three/addons 추가. 부팅: 로딩 오버레이(DOM, 진행 표시) → `loadAssets(onProgress, audio.context)` → 게임 초기화. 실패 항목은 폴백으로 그대로 진행.
- 타이틀에서 맵 선택: P0 steer가 ±0.5를 넘는 엣지(스틱/십자키/A·D)로 TRACKS 인덱스 순환, hud.setMapInfo 갱신, audio.play('menu'). localStorage 'kart-map'에 저장/복원(SettingsMenu와 별개).
- 맵 확정(레이스 시작) 시: 기존 track.dispose(scene) → new Track(scene, def, assets) → 카트/ItemSystem 재생성. 결과 화면에서 재시작하면 같은 맵, 타이틀로 돌아가면(추가: 결과 화면에서 B/Backspace로 타이틀 복귀) 재선택 가능.
- settings.onChange 시 audio.play('switch').
- 기존 수정 유지 주의: Start 우선 처리(타이틀/결과에서 pause 무시), 15초 DNF 타임아웃, dispose 경로.
```
