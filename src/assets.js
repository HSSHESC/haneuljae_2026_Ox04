// src/assets.js
// 외부 에셋(GLB/PNG/OGG/TTF) 로더. 모든 항목은 개별적으로 실패할 수 있고,
// 실패한 항목은 throw 대신 null + console.warn — 소비 측이 기존 절차 생성/합성으로 폴백한다.
// loadAssets 자체는 (치명적 예외가 아닌 한) 항상 resolve 한다.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const BASE = 'assets/';

// ---- 실측 기반 상수 --------------------------------------------------
// 카트 GLB 전장 1.428m → ×2.1 ≈ 3.0m. 로컬 +Z가 전방이라 게임 규약(-Z 전방)에 맞춰 π 회전.
const KART_SCALE = 2.1;
const KART_TINT = { red: 0xd23a2f, blue: 0x2f6bd2 };

// 프롭 킷은 1m 타일 기준으로 작다(가로등 실측 0.6m). 가로등이 이 높이가 되도록
// 일괄 계수를 산출하고 모든 프롭에 같은 값을 적용한다(킷 내부 상대 비율 유지).
const PROP_TARGET_LIGHT_HEIGHT = 4.4; // m — 계획의 4~5m 범위
const PROP_SCALE_FALLBACK = 7;        // 가로등 측정 실패 시 계획상 기준 계수
const PROP_SCALE_RANGE = [3, 15];     // 측정값이 이상할 때의 안전 클램프

// 아이템 모델 실측(로컬 유닛):
//  item-box  = platformer-kit crate-item.glb — 0.5x0.5x0.5, min.y=0 (피벗이 바닥면)
//              → ×2.8 = 1.40m 정육면체, inner.position.y = -0.25 로 중심 정렬
//  water-orb = marble-kit marble-low.glb — 0.38x0.40x0.38, 노드 T(0,-0.2,0)로 이미 중심 정렬
//              → ×1.75 = 지름 0.70m (기존 SphereGeometry(0.35)와 동일). 유리 머티리얼 alpha 0.5
const ITEM_EXPECT_TOL = 0.25; // 실측 크기가 기대치에서 이만큼(비율) 벗어나면 경고만 남긴다

const TEXTURE_ANISOTROPY = 4;

const FONT_FAMILY = 'Kenney Future';
const FONT_URL = BASE + 'ui/KenneyFuture.ttf';
const FONT_STYLE_ID = 'kart-assets-fontface';

// ---- 매니페스트 (assets/ 실측 목록과 1:1) -----------------------------

const KART_FILES = {
  red: 'karts/kart-red.glb',   // kart-oodi
  blue: 'karts/kart-blue.glb', // kart-oobi
};

// 프롭 팩. 킷마다 모델링 단위가 달라서 스케일 규칙을 팩 단위로 가른다.
//  city   — city-kit-roads. 1유닛 타일 킷. 가로등 실측(0.6유닛=4.4m) → 계수 ≈7.33.
//           기존 5맵의 프롭 배치가 이 계수와 '원본 피벗'에 맞춰져 있으므로 재중심화 금지.
//  space  — kenney_space-kit. 같은 1유닛 타일 킷이라 city와 동일 계수를 쓴다.
//           ★ 낱개 GLB가 전부 tmpParent(T=0) > <오브젝트>(T=[2,0,1.5]) 구조라
//             그대로 붙이면 (2,0,1.5)×scale ≈ (14.7,0,11.0)m 밀린다 → recenter 필수.
//  castle — kenney_retro-fantasy-kit. 실측 미터 단위(벽 1모듈=1.0m) 킷이라 auto 계수를
//           적용하면 안 된다. 아케이드 스케일에 맞춘 8m 모듈로 고정한다.
const PROP_PACKS = {
  city: { dir: 'props/', scale: 'auto', recenter: false },
  space: { dir: 'props-space/', scale: 'auto', recenter: true },
  castle: { dir: 'props-castle/', scale: 8.0, recenter: false },
};

const PROP_FILES = {
  lightSquare: { pack: 'city', file: 'light-square.glb' },
  lightCurved: { pack: 'city', file: 'light-curved.glb' },
  signWarning: { pack: 'city', file: 'road-sign-warning.glb' },
  signStop: { pack: 'city', file: 'road-sign-stop.glb' },
  signHighway: { pack: 'city', file: 'sign-highway.glb' },
  trafficLight: { pack: 'city', file: 'traffic-light.glb' },
  cone: { pack: 'city', file: 'construction-cone.glb' },
  barrier: { pack: 'city', file: 'construction-barrier.glb' },
  // 우주선 맵(orbital-station)
  spaceGate: { pack: 'space', file: 'gate.glb' },
  spacePylon: { pack: 'space', file: 'pylon.glb' },
  spaceDish: { pack: 'space', file: 'dish.glb' },
  spaceBlock: { pack: 'space', file: 'block.glb' },
  spaceTank: { pack: 'space', file: 'tank.glb' },
  // 중세 성 맵(castle-rampart)
  castleWall: { pack: 'castle', file: 'wall.glb' },
  castleGate: { pack: 'castle', file: 'wall-gate.glb' },
  castleTower: { pack: 'castle', file: 'tower-base.glb' },
  castleBarrel: { pack: 'castle', file: 'barrels.glb' },
};

// 아이템 모델. tint가 있으면 prepareKart와 같은 방식으로 머티리얼을 clone 후 색만 바꾼다
// (원본 템플릿 오염 금지). transparent/opacity/side 등 GLB가 준 값은 건드리지 않는다 —
// marble-low의 alpha 0.5가 물풍선의 유리질을 만든다.
const ITEM_FILES = {
  // scale/recenterY는 위 실측에서 나온 고정값. expect는 전처리 후 실측으로 되짚는 자기검증용.
  box: { file: 'items/item-box.glb', scale: 2.8, recenterY: -0.25, tint: null, expect: 1.4 },
  orb: { file: 'items/water-orb.glb', scale: 1.75, recenterY: 0, tint: 0x3fb6e8, expect: 0.7 },
};

const TEXTURE_FILES = {
  roadDark: 'textures/road-dark.png',
  roadLight: 'textures/road-light.png',
  roadPurple: 'textures/road-purple.png',
  grassGreen: 'textures/grass-green.png',
  groundOrange: 'textures/ground-orange.png',
  groundDark: 'textures/ground-dark.png',
  wallRed: 'textures/wall-red.png',
  wallOrange: 'textures/wall-orange.png',
};

const SFX_FILES = {
  count: 'audio/sfx/count.ogg',
  go: 'audio/sfx/go.ogg',
  pickup: 'audio/sfx/pickup.ogg',
  use: 'audio/sfx/use.ogg',
  boost: 'audio/sfx/boost.ogg',
  hit: 'audio/sfx/hit.ogg',
  lap: 'audio/sfx/lap.ogg',
  finish: 'audio/sfx/finish.ogg',
  menu: 'audio/sfx/menu.ogg',
  results: 'audio/sfx/results.ogg',
  switch: 'audio/sfx/switch.ogg',
};

const ENGINE_FILES = ['audio/engine/engine-0.ogg', 'audio/engine/engine-1.ogg'];
const THRUSTER_FILE = 'audio/engine/thruster.ogg';

// 진행률 분모: 실제로 네트워크를 타는 작업 수 + 폰트 1
const TOTAL_TASKS =
  Object.keys(KART_FILES).length +
  Object.keys(PROP_FILES).length +
  Object.keys(ITEM_FILES).length +
  Object.keys(TEXTURE_FILES).length +
  Object.keys(SFX_FILES).length +
  ENGINE_FILES.length + 1 /* thruster */ + 1 /* font */;

// ---- 진행률/실패 처리 헬퍼 --------------------------------------------

function makeProgress(onProgress) {
  let done = 0;
  const report = () => {
    if (typeof onProgress !== 'function') return;
    try {
      onProgress(done, TOTAL_TASKS);
    } catch (err) {
      console.warn('[assets] onProgress 콜백에서 예외:', err);
    }
  };
  report(); // 0/total 로 시작 상태를 한 번 알린다
  return {
    // task를 감싸 실패는 null로 흡수하고, 성패와 무관하게 진행률을 올린다.
    async track(label, promiseFactory) {
      try {
        return await promiseFactory();
      } catch (err) {
        console.warn(`[assets] ${label} 로드 실패 — 폴백 사용:`, err && err.message ? err.message : err);
        return null;
      } finally {
        done++;
        report();
      }
    },
  };
}

// ---- 카트 전처리 ------------------------------------------------------

// 차체가 아닌(= 틴트 대상이 아닌) 노드: 바퀴 4개와 운전자 'character'.
// 카트 GLB는 body/wheel/character가 머티리얼 하나('colormap')를 공유하므로
// 노드 이름으로 구분해 차체 계열만 clone 후 틴트한다.
const NON_CHASSIS_NAME = /(^|[-_ ])(wheel|tire|tyre|character|driver|person|helmet)([-_ ]|$)/i;

function isChassisNode(obj, root) {
  for (let n = obj; n && n !== root.parent; n = n.parent) {
    if (n.name && NON_CHASSIS_NAME.test(n.name)) return false;
  }
  return true;
}

// gltf.scene → 게임 규약에 맞춘 Group.
// 반환 구조: wrapper(scale 2.1) > inner(rotation.y=π, 원본 노드 트리)
// 바퀴 노드 이름(wheel-front-left 등)과 로컬 축은 그대로 유지된다(회전은 부모에만 적용).
function prepareKart(scene, tintHex, label) {
  const inner = scene;
  inner.rotation.y = Math.PI; // 로컬 +Z 전방 → 게임 -Z 전방
  inner.name = inner.name || `${label}-body-root`;

  const wrapper = new THREE.Group();
  wrapper.name = `kart-model-${label}`;
  wrapper.scale.setScalar(KART_SCALE);
  wrapper.add(inner);

  const clonedBySource = new Map();
  const tintOne = (mat) => {
    if (!mat) return mat;
    let cloned = clonedBySource.get(mat);
    if (!cloned) {
      cloned = mat.clone();
      cloned.name = `${mat.name || 'kart'}-${label}`;
      if (cloned.color) cloned.color.setHex(tintHex);
      clonedBySource.set(mat, cloned);
    }
    return cloned;
  };

  let chassisMeshes = 0;
  wrapper.traverse((obj) => {
    if (!obj.isMesh) return;
    obj.castShadow = true;
    obj.receiveShadow = true;
    if (!isChassisNode(obj, wrapper)) return; // 바퀴/운전자는 원본 머티리얼 그대로
    chassisMeshes++;
    obj.material = Array.isArray(obj.material) ? obj.material.map(tintOne) : tintOne(obj.material);
  });

  if (chassisMeshes === 0) {
    console.warn(`[assets] ${label}: 차체 메시를 찾지 못해 틴트를 적용하지 못했습니다.`);
  }
  return wrapper;
}

// ---- 프롭 전처리 ------------------------------------------------------

function measureHeight(object3d) {
  const box = new THREE.Box3().setFromObject(object3d);
  if (box.isEmpty()) return 0;
  return box.max.y - box.min.y;
}

// 가로등(light-square) 실측 높이로 'auto' 팩의 일괄 계수를 산출. 실패 시 계획상 ×7.
function resolvePropScale(rawScenes) {
  const ref = rawScenes.lightSquare;
  if (!ref) return PROP_SCALE_FALLBACK;
  const h = measureHeight(ref);
  if (!Number.isFinite(h) || h <= 1e-4) return PROP_SCALE_FALLBACK;
  const factor = PROP_TARGET_LIGHT_HEIGHT / h;
  if (factor < PROP_SCALE_RANGE[0] || factor > PROP_SCALE_RANGE[1]) {
    console.warn(`[assets] 프롭 리스케일 계수 ${factor.toFixed(2)} 가 예상 범위를 벗어나 ${PROP_SCALE_FALLBACK} 사용`);
    return PROP_SCALE_FALLBACK;
  }
  return factor;
}

// space 팩 전용: 원본 씬을 XZ 중심 + 바닥(y=0) 기준으로 되돌린다.
// kenney_space-kit 낱개 GLB는 카탈로그 씬 좌표 T=[2,0,1.5]가 노드에 남아 있어
// 이 보정 없이는 프롭이 배치 지점에서 (2,0,1.5)×scale 만큼 밀려 박힌다.
// city 팩에 같은 처리를 하면 light-square(min=(-0.025,0,-0.213))가 실제로 움직여
// 기존 5맵의 프롭 배치가 전부 어긋나므로 반드시 팩 플래그로 가른다.
function recenterToFootprint(inner, key) {
  const box = new THREE.Box3().setFromObject(inner);
  if (box.isEmpty()) {
    console.warn(`[assets] prop ${key}: 빈 bbox — 재중심화 생략`);
    return;
  }
  const cx = (box.min.x + box.max.x) / 2;
  const cz = (box.min.z + box.max.z) / 2;
  inner.position.x -= cx;
  inner.position.z -= cz;
  inner.position.y -= box.min.y;
}

// KHR_texture_transform을 쓰는 킷이라 머티리얼은 절대 교체하지 않는다(GLTFLoader가 처리).
function prepareProp(scene, key, factor, pack) {
  if (pack && pack.recenter) recenterToFootprint(scene, key);
  const wrapper = new THREE.Group();
  wrapper.name = `prop-${key}`;
  wrapper.scale.setScalar(factor);
  wrapper.add(scene);
  wrapper.traverse((obj) => {
    if (!obj.isMesh) return;
    obj.castShadow = true;
    obj.receiveShadow = true;
  });
  return wrapper;
}

// ---- 아이템 전처리 ----------------------------------------------------

// gltf.scene → wrapper(scale) > inner(recenterY 적용). 그룹 원점이 아이템의 중심이다.
// items.js는 이 wrapper를 clone()해 쓰고 userData.sharedAsset을 찍는다 →
// dispose()에서 공유 GLB 사본의 geometry/material을 절대 dispose하지 않는다.
function prepareItem(scene, spec, key) {
  const inner = scene;
  inner.name = inner.name || `item-${key}-root`;
  inner.position.y += spec.recenterY;

  const wrapper = new THREE.Group();
  wrapper.name = `item-${key}`;
  wrapper.scale.setScalar(spec.scale);
  wrapper.add(inner);

  if (spec.tint != null) {
    const clonedBySource = new Map();
    const tintOne = (mat) => {
      if (!mat) return mat;
      let cloned = clonedBySource.get(mat);
      if (!cloned) {
        cloned = mat.clone();
        cloned.name = `${mat.name || 'item'}-${key}`;
        if (cloned.color) cloned.color.setHex(spec.tint);
        clonedBySource.set(mat, cloned);
      }
      return cloned;
    };
    wrapper.traverse((obj) => {
      if (!obj.isMesh) return;
      obj.material = Array.isArray(obj.material) ? obj.material.map(tintOne) : tintOne(obj.material);
    });
  }

  wrapper.traverse((obj) => {
    if (!obj.isMesh) return;
    obj.castShadow = true;
    obj.receiveShadow = true;
  });

  // 자기검증: 전처리 후 실제 크기가 설계 기대치에서 크게 벗어나면 알린다(조용한 실패 방지).
  const box = new THREE.Box3().setFromObject(wrapper);
  if (!box.isEmpty() && spec.expect) {
    const size = box.max.clone().sub(box.min);
    const worst = Math.max(size.x, size.y, size.z);
    if (Math.abs(worst - spec.expect) > spec.expect * ITEM_EXPECT_TOL) {
      console.warn(`[assets] item ${key}: 전처리 후 최대변 ${worst.toFixed(3)}m — 기대 ${spec.expect}m 와 다릅니다.`);
    }
    const cy = (box.min.y + box.max.y) / 2;
    if (Math.abs(cy) > 0.05) {
      console.warn(`[assets] item ${key}: y 중심이 ${cy.toFixed(3)}m — 원점 정렬이 어긋났습니다.`);
    }
  }
  return wrapper;
}

// ---- 텍스처 ----------------------------------------------------------

function prepareTexture(tex, key) {
  tex.name = key;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = TEXTURE_ANISOTROPY;
  tex.needsUpdate = true;
  return tex;
}

// ---- 오디오 ----------------------------------------------------------

function decodeAudio(ctx, arrayBuffer) {
  // Safari 등 구형은 Promise를 반환하지 않으므로 콜백 형태도 함께 지원한다.
  return new Promise((resolve, reject) => {
    let settled = false;
    const ok = (buf) => { if (!settled) { settled = true; resolve(buf); } };
    const fail = (err) => { if (!settled) { settled = true; reject(err || new Error('decodeAudioData 실패')); } };
    let maybePromise;
    try {
      maybePromise = ctx.decodeAudioData(arrayBuffer, ok, fail);
    } catch (err) {
      fail(err);
      return;
    }
    if (maybePromise && typeof maybePromise.then === 'function') maybePromise.then(ok, fail);
  });
}

async function loadAudioBuffer(url, ctx) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
  const arr = await res.arrayBuffer();
  return decodeAudio(ctx, arr);
}

// ---- 폰트 ------------------------------------------------------------

// @font-face 주입은 이 모듈 책임. HUD는 font-family에 'Kenney Future'만 얹으면 된다.
async function installFont() {
  if (typeof document === 'undefined') return null;
  if (!document.getElementById(FONT_STYLE_ID)) {
    const style = document.createElement('style');
    style.id = FONT_STYLE_ID;
    style.textContent = `@font-face {
  font-family: '${FONT_FAMILY}';
  src: url('${FONT_URL}') format('truetype');
  font-weight: normal;
  font-style: normal;
  font-display: swap;
}`;
    document.head.appendChild(style);
  }
  // 실제 파일이 도착했는지까지 확인해 첫 프레임 폰트 깜빡임을 줄인다.
  if (document.fonts && typeof document.fonts.load === 'function') {
    const faces = await document.fonts.load(`16px '${FONT_FAMILY}'`);
    if (!faces || faces.length === 0) throw new Error(`${FONT_URL} 를 불러오지 못했습니다`);
  }
  return FONT_FAMILY;
}

// ---- 공개 API --------------------------------------------------------

/**
 * 모든 외부 에셋을 병렬 로드한다.
 * @param {(done:number,total:number)=>void} [onProgress]
 * @param {AudioContext} [audioContext] audio.js의 ctx (미전달 시 오디오는 전부 null)
 */
export async function loadAssets(onProgress, audioContext) {
  const progress = makeProgress(onProgress);
  const gltfLoader = new GLTFLoader();
  const texLoader = new THREE.TextureLoader();

  if (!audioContext) {
    console.warn('[assets] AudioContext 미전달 — 오디오 버퍼는 로드하지 않고 합성음 폴백을 사용합니다.');
  }

  // 카트 (로드 즉시 전처리)
  const kartTasks = Object.entries(KART_FILES).map(([key, file]) =>
    progress.track(`kart ${key}`, async () => {
      const gltf = await gltfLoader.loadAsync(BASE + file);
      return [key, prepareKart(gltf.scene, KART_TINT[key], key)];
    })
  );

  // 프롭 ('auto' 팩의 리스케일 계수는 전부 로드된 뒤 가로등 실측으로 결정)
  const propKeys = Object.keys(PROP_FILES);
  const propTasks = propKeys.map((key) =>
    progress.track(`prop ${key}`, async () => {
      const entry = PROP_FILES[key];
      const pack = PROP_PACKS[entry.pack];
      const gltf = await gltfLoader.loadAsync(BASE + pack.dir + entry.file);
      return [key, gltf.scene];
    })
  );

  // 아이템 모델 (로드 즉시 전처리 — 스케일/중심 정렬은 파일별 실측 고정값)
  const itemTasks = Object.entries(ITEM_FILES).map(([key, spec]) =>
    progress.track(`item ${key}`, async () => {
      const gltf = await gltfLoader.loadAsync(BASE + spec.file);
      return [key, prepareItem(gltf.scene, spec, key)];
    })
  );

  const textureTasks = Object.entries(TEXTURE_FILES).map(([key, file]) =>
    progress.track(`texture ${key}`, async () => {
      const tex = await texLoader.loadAsync(BASE + file);
      return [key, prepareTexture(tex, key)];
    })
  );

  const sfxTasks = Object.entries(SFX_FILES).map(([key, file]) =>
    progress.track(`sfx ${key}`, async () => {
      if (!audioContext) return null;
      return [key, await loadAudioBuffer(BASE + file, audioContext)];
    })
  );

  const engineTasks = ENGINE_FILES.map((file, i) =>
    progress.track(`engine ${i}`, async () => {
      if (!audioContext) return null;
      return loadAudioBuffer(BASE + file, audioContext);
    })
  );

  const thrusterTask = progress.track('thruster', async () => {
    if (!audioContext) return null;
    return loadAudioBuffer(BASE + THRUSTER_FILE, audioContext);
  });

  const fontTask = progress.track('font', () => installFont());

  const [kartPairs, rawPropPairs, itemPairs, texPairs, sfxPairs, engineBuffers, thruster] = await Promise.all([
    Promise.all(kartTasks),
    Promise.all(propTasks),
    Promise.all(itemTasks),
    Promise.all(textureTasks),
    Promise.all(sfxTasks),
    Promise.all(engineTasks),
    thrusterTask,
  ]);
  await fontTask;

  const karts = { red: null, blue: null };
  for (const pair of kartPairs) if (pair) karts[pair[0]] = pair[1];

  const rawProps = {};
  for (const key of propKeys) rawProps[key] = null;
  for (const pair of rawPropPairs) if (pair) rawProps[pair[0]] = pair[1];

  const autoScale = resolvePropScale(rawProps);
  const props = {};
  for (const key of propKeys) {
    if (!rawProps[key]) { props[key] = null; continue; }
    const pack = PROP_PACKS[PROP_FILES[key].pack];
    const factor = pack.scale === 'auto' ? autoScale : pack.scale;
    props[key] = prepareProp(rawProps[key], key, factor, pack);
  }

  const items = {};
  for (const key of Object.keys(ITEM_FILES)) items[key] = null;
  for (const pair of itemPairs) if (pair) items[pair[0]] = pair[1];

  const textures = {};
  for (const key of Object.keys(TEXTURE_FILES)) textures[key] = null;
  for (const pair of texPairs) if (pair) textures[pair[0]] = pair[1];

  const sfx = {};
  for (const key of Object.keys(SFX_FILES)) sfx[key] = null;
  for (const pair of sfxPairs) if (pair) sfx[pair[0]] = pair[1];

  // 반환 구조 (모든 슬롯은 개별적으로 null 일 수 있다):
  //   karts   { red, blue }                          Group(scale 2.1) > inner(rot.y=π)
  //   props   { lightSquare … castleBarrel } 17종     Group(scale=팩 계수) > inner
  //   items   { box, orb }                            Group(scale) > inner(중심 정렬)
  //   textures{ roadDark … wallOrange } 8종
  //   sfx     { count … switch } 11종 / engine [2] / thruster
  return {
    karts,
    props,
    items,
    textures,
    sfx,
    engine: [engineBuffers[0] || null, engineBuffers[1] || null],
    thruster: thruster || null,
  };
}
