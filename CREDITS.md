# 에셋 출처

`assets/` 아래의 모든 3D 모델·텍스처·사운드·폰트는 **Kenney**(<https://kenney.nl>)가 제작·배포한
**CC0 1.0 (퍼블릭 도메인 헌정)** 에셋이다. 상업적 사용을 포함해 제약 없이 쓸 수 있으며 출처 표기도
의무가 아니지만, 각 팩의 `License.txt`가 "크레딧을 남겨주면 좋겠다"고 권하므로 여기에 밝혀 둔다.

> License: Creative Commons Zero, CC0 — <http://creativecommons.org/publicdomain/zero/1.0/>
> Created/distributed by Kenney (www.kenney.nl)

## 사용한 팩과 실제로 쓴 파일

| Kenney 팩 | 저장소 내 위치 | 용도 |
|---|---|---|
| Car Kit 3.1 | `assets/karts/` | 카트 모델 2종(`kart-oodi` → 빨강, `kart-oobi` → 파랑) + 공용 컬러맵 |
| City Kit Roads 2.1 | `assets/props/` | 가로등·표지판·신호등·공사용 콘/바리케이드 8종 + 공용 컬러맵 |
| Prototype Textures 1.0 | `assets/textures/` | 노면·지면·벽 체커 텍스처 8장 |
| Digital Audio | `assets/audio/sfx/` | 카운트다운·출발·아이템 획득/사용·부스트·랩 효과음 |
| Sci-Fi Sounds 1.0 | `assets/audio/sfx/`, `assets/audio/engine/` | 충돌음, 엔진 루프 2종, 부스터 분사음 |
| Music Jingles | `assets/audio/sfx/` | 완주 팡파르, 결과 화면 징글 |
| UI Pack 2.0 | `assets/audio/sfx/`, `assets/ui/` | 메뉴 클릭·설정 전환음, Kenney Future 폰트 |
| Medals 1.1 | `assets/ui/` | 결과 화면 1위/2위 메달 |
| Platformer Kit 4.1 | `assets/items/` | 아이템 박스(`crate-item` → `item-box.glb`) + 공용 컬러맵 |
| Marble Kit 2.0 | `assets/items/` | 물풍선 발사체(`marble-low` → `water-orb.glb`, 유리 머티리얼) |
| Space Kit 2.0 | `assets/props-space/` | 오비탈 스테이션 맵 프롭 5종(게이트·지지기둥·접시안테나·모듈블록·드럼탱크) |
| Retro Fantasy Kit 2.0 | `assets/props-castle/` | 캐슬 램파트 맵 프롭 4종(성벽·성문·탑 기단·통) + 석재/판자/통 텍스처 4장 |

원본 배포본(zip과 압축 해제본)은 저장소 용량을 아끼려고 `.gitignore`로 제외했다. 게임이 실제로
로드하는 파일만 위 경로에 슬롯 이름으로 이름을 바꿔 넣어 두었으므로, 저장소만 받아도 그대로 실행된다.

GLB가 텍스처를 상대경로(`Textures/…png`)로 외부 참조하는 팩은 `.glb` 옆에 `Textures/` 폴더를 함께
두어야 한다 — `assets/karts/`, `assets/props/`, `assets/items/`, `assets/props-castle/`가 그렇다.
Space Kit과 Marble Kit 모델은 `baseColorFactor` 단색만 쓰므로 동반 텍스처가 없다.

킷마다 모델링 단위가 달라서 `src/assets.js`가 스케일 규칙을 팩 단위로 가른다: City Kit Roads와
Space Kit은 1유닛 타일 킷이라 가로등 실측(0.6유닛 = 4.4m)에서 나온 계수 ≈7.33을 공유하고,
Retro Fantasy Kit은 이미 실측 미터 단위(벽 1모듈 = 1.0m)라 아케이드 스케일에 맞춘 ×8.0을 따로 쓴다.
Space Kit 낱개 모델은 원본에 카탈로그 좌표 `T=[2, 0, 1.5]`가 남아 있어 로드 직후 재중심화한다.

## 라이선스 관계

- **코드**(`src/`, `index.html`)는 저장소 루트의 `LICENSE` — Apache License 2.0.
- **에셋**(`assets/`)은 위와 같이 CC0. 퍼블릭 도메인 헌정이므로 Apache 2.0 저장소에 포함하는 데
  제약이 없고, 에셋만 따로 가져다 쓰는 것도 자유다.

## 외부 런타임 의존

- [three.js](https://threejs.org) r170 — MIT. 번들하지 않고 `index.html`의 importmap이 jsDelivr CDN에서
  받아 온다. 따라서 최초 실행에는 인터넷 연결이 필요하다.
- 한글 웹폰트(Black Han Sans, Jua)는 `design/`의 시안에서만 Google Fonts로 불러오며, 게임 본편은
  사용하지 않는다.
