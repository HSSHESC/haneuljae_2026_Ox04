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

const TEXTURE_ANISOTROPY = 4;

const FONT_FAMILY = 'Kenney Future';
const FONT_URL = BASE + 'ui/KenneyFuture.ttf';
const FONT_STYLE_ID = 'kart-assets-fontface';

// ---- 매니페스트 (assets/ 실측 목록과 1:1) -----------------------------

const KART_FILES = {
  red: 'karts/kart-red.glb',   // kart-oodi
  blue: 'karts/kart-blue.glb', // kart-oobi
};

const PROP_FILES = {
  lightSquare: 'props/light-square.glb',
  lightCurved: 'props/light-curved.glb',
  signWarning: 'props/road-sign-warning.glb',
  signStop: 'props/road-sign-stop.glb',
  signHighway: 'props/sign-highway.glb',
  trafficLight: 'props/traffic-light.glb',
  cone: 'props/construction-cone.glb',
  barrier: 'props/construction-barrier.glb',
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

// 가로등(light-square) 실측 높이로 일괄 계수를 산출. 실패 시 계획상 ×7.
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

// KHR_texture_transform을 쓰는 킷이라 머티리얼은 절대 교체하지 않는다(GLTFLoader가 처리).
function prepareProp(scene, key, factor) {
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

  // 프롭 (리스케일 계수는 전부 로드된 뒤 가로등 실측으로 결정)
  const propKeys = Object.keys(PROP_FILES);
  const propTasks = propKeys.map((key) =>
    progress.track(`prop ${key}`, async () => {
      const gltf = await gltfLoader.loadAsync(BASE + PROP_FILES[key]);
      return [key, gltf.scene];
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

  const [kartPairs, rawPropPairs, texPairs, sfxPairs, engineBuffers, thruster] = await Promise.all([
    Promise.all(kartTasks),
    Promise.all(propTasks),
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

  const propScale = resolvePropScale(rawProps);
  const props = {};
  for (const key of propKeys) {
    props[key] = rawProps[key] ? prepareProp(rawProps[key], key, propScale) : null;
  }

  const textures = {};
  for (const key of Object.keys(TEXTURE_FILES)) textures[key] = null;
  for (const pair of texPairs) if (pair) textures[pair[0]] = pair[1];

  const sfx = {};
  for (const key of Object.keys(SFX_FILES)) sfx[key] = null;
  for (const pair of sfxPairs) if (pair) sfx[pair[0]] = pair[1];

  return {
    karts,
    props,
    textures,
    sfx,
    engine: [engineBuffers[0] || null, engineBuffers[1] || null],
    thruster: thruster || null,
  };
}
