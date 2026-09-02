// src/main.js — 통합: 에셋 부팅 / 씬·렌더러 / 맵 선택 / 상태머신 / 루프.
// 모듈 간 조립은 전부 여기서. 각 모듈은 서로를 import하지 않는다(three와 데이터 모듈 tracks.js 제외).
import * as THREE from 'three';
import { TRACKS } from './tracks.js';
import { loadAssets } from './assets.js';
import { Track } from './track.js';
import { Kart, collideKarts } from './kart.js';
import { InputManager } from './input.js';
import { SplitView } from './view.js';
import { ItemSystem } from './items.js';
import { HUD } from './hud.js';
import { AudioEngine } from './audio.js';
import { SettingsMenu } from './settings.js';

const SKY_COLOR = 0x8fc4ee;
const KART_COLORS = [0xe03a3a, 0x3a72e0];
const KART_NAMES = ['P1 RED', 'P2 BLUE'];
const KART_MODEL_KEYS = ['red', 'blue'];   // assets.karts 의 슬롯 (P0=빨강, P1=파랑)
const COUNTDOWN_LENGTH = 4; // 3 → 2 → 1 → GO! (각 1초)
const FINISH_FORCE_TIMEOUT = 15; // 첫 완주자 이후 나머지를 강제 DNF 처리하기까지 대기 시간(초)

const MAP_STORAGE_KEY = 'kart-map';
const MAP_EDGE_ON = 0.5;   // 이 값을 넘는 순간이 "엣지" (계획 규정)
const MAP_EDGE_OFF = 0.3;  // 여기까지 돌아와야 다음 엣지를 받는다(히스테리시스)

const MODE_STORAGE_KEY = 'kart-mode';   // 'items' | 'speed'

// ───────────────────────────────── 렌더러 / 씬 ─────────────────────────────────

const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setClearColor(SKY_COLOR, 1);

const scene = new THREE.Scene();
scene.background = new THREE.Color(SKY_COLOR);
scene.fog = new THREE.Fog(SKY_COLOR, 190, 620);

// 햇빛(그림자) + 하늘/땅 앰비언트. 세기/색은 맵 테마에 맞춰 applyTheme()가 조정한다.
const sun = new THREE.DirectionalLight(0xfff4e0, 2.1);
sun.position.set(120, 180, 60);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 20;
sun.shadow.camera.far = 520;
sun.shadow.camera.left = -160;
sun.shadow.camera.right = 160;
sun.shadow.camera.top = 160;
sun.shadow.camera.bottom = -160;
sun.shadow.bias = -0.0008;
sun.shadow.normalBias = 0.05;
scene.add(sun);
scene.add(sun.target);

const hemi = new THREE.HemisphereLight(0xbfe0ff, 0x3f6b33, 1.15);
const ambient = new THREE.AmbientLight(0xffffff, 0.25);
scene.add(hemi);
scene.add(ambient);

const SUN_BASE = 2.1;
const HEMI_BASE = 1.15;
const AMBIENT_BASE = 0.25;

// ───────────────────────────────── 오디오 (에셋보다 먼저 필요) ─────────────────────────────────
// assets.js가 OGG를 디코드하려면 AudioContext가 필요하므로 AudioEngine을 가장 먼저 만든다.
const audio = new AudioEngine();

function unlockAudio() {
  audio.unlock();
  window.removeEventListener('pointerdown', unlockAudio);
  window.removeEventListener('keydown', unlockAudio);
}
window.addEventListener('pointerdown', unlockAudio);
window.addEventListener('keydown', unlockAudio);

// ───────────────────────────────── 상태 ─────────────────────────────────

/** @type {any} */ let assets = null;
/** @type {Track|null} */ let track = null;
/** @type {ItemSystem|null} */ let itemSystem = null;
/** @type {Kart[]} */ let karts = [];
/** @type {InputManager} */ let inputManager = null;
/** @type {SplitView} */ let splitView = null;
/** @type {HUD} */ let hud = null;
/** @type {SettingsMenu} */ let settingsMenu = null;

let laps = 3;
let sensitivity = 1.0;

let state = 'title';       // 'title' | 'countdown' | 'race' | 'finished'
let countdownTimer = 0;
let lastCountdownNum = null;
let raceTime = 0;
let padCount = -1;
let finishForceTimer = null; // 첫 완주자 발생 후 카운트다운(초); null이면 미시작
let prev = [];               // 효과음 edge 검출용 직전 프레임 스냅샷

let mapIndex = 0;
let mapSteerLatch = 0;       // 0 | -1 | 1 — 맵 선택 스틱 엣지 래치

let gameMode = 'items';      // 'items' | 'speed' — boot()에서 loadGameMode()로 즉시 덮어씀
let modeBrakeLatch = false;  // 타이틀 모드 전환 브레이크(P0) 엣지 래치

let mapPreviewTimer = null;         // 타이틀 배경 프리뷰 재구축 디바운스 타이머
const MAP_PREVIEW_DEBOUNCE = 200;   // ms — 맵 연타 중 매 엣지마다 씬을 재구축하지 않도록

const BOOST_PAD_COOLDOWN = 1.5;     // 초 — 카트×패드 조합별 재발동 대기시간
let boostPadCooldowns = new Map();  // key: `${kartIndex}_${padIndex}` -> 남은 쿨다운(초). 맵 재구축 시 초기화(buildTrack).

let lastSwitchSoundTime = -Infinity; // 설정 슬라이더 onChange 스로틀용
const SWITCH_SOUND_THROTTLE = 150;   // ms

const _tmpV = new THREE.Vector3();   // respawnKartsAtSpawns()의 heading 계산용 스크래치

// ───────────────────────────────── 로딩 오버레이 ─────────────────────────────────

const loaderEl = document.getElementById('boot-loader');
const loaderFill = document.getElementById('boot-bar-fill');
const loaderText = document.getElementById('boot-status');

function setLoaderProgress(done, total) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  if (loaderFill) loaderFill.style.width = `${pct}%`;
  if (loaderText) loaderText.textContent = `에셋 로딩 중… ${pct}% (${done}/${total})`;
}

function hideLoader() {
  if (!loaderEl) return;
  loaderEl.style.opacity = '0';
  setTimeout(() => { if (loaderEl.parentNode) loaderEl.parentNode.removeChild(loaderEl); }, 400);
}

// ───────────────────────────────── 맵 선택 ─────────────────────────────────

function loadMapIndex() {
  try {
    const raw = localStorage.getItem(MAP_STORAGE_KEY);
    if (raw === null) return 0;
    const byId = TRACKS.findIndex((t) => t.id === raw);
    if (byId >= 0) return byId;
    const n = Number(raw); // 과거 저장 형식(인덱스)도 받아준다
    if (Number.isInteger(n) && n >= 0 && n < TRACKS.length) return n;
  } catch (e) { /* 프라이빗 모드 등 — 기본값 */ }
  return 0;
}

function saveMapIndex() {
  try { localStorage.setItem(MAP_STORAGE_KEY, TRACKS[mapIndex].id); } catch (e) { /* 무시 */ }
}

function setMapIndex(i, announce) {
  mapIndex = ((i % TRACKS.length) + TRACKS.length) % TRACKS.length;
  saveMapIndex();
  if (hud) hud.setMapInfo({ name: TRACKS[mapIndex].name, difficulty: TRACKS[mapIndex].difficulty ?? 1 });
  if (announce) {
    audio.play('menu');
    scheduleMapPreview();
  }
}

// 타이틀 배경 프리뷰: 맵을 연타하며 넘기는 동안 매번 트랙(씬)을 재구축하면 무겁다.
// 200ms 동안 추가 변경이 없을 때만 실제로 배경을 선택된 맵으로 재구축한다.
function scheduleMapPreview() {
  if (mapPreviewTimer !== null) clearTimeout(mapPreviewTimer);
  mapPreviewTimer = setTimeout(() => {
    mapPreviewTimer = null;
    if (state !== 'title') return; // 타이머 도착 전 Start 등으로 상태가 바뀌었으면 무시
    buildTrack(TRACKS[mapIndex]);
    respawnKartsAtSpawns(); // 카트는 재생성하지 않고 새 트랙 기준 스폰 위치만 갱신
  }, MAP_PREVIEW_DEBOUNCE);
}

function cancelMapPreview() {
  if (mapPreviewTimer !== null) { clearTimeout(mapPreviewTimer); mapPreviewTimer = null; }
}

// 타이틀에서 P0 조향 입력(스틱/십자키/A·D)의 ±0.5 엣지로 맵을 순환한다.
// 감도 배율을 타지 않은 raw steer를 쓴다 — 설정 감도가 낮아도 맵 선택은 동일하게 동작.
function updateMapSelect(rawSteer) {
  const s = rawSteer || 0;
  const dir = s > 0 ? 1 : -1;
  if (Math.abs(s) > MAP_EDGE_ON) {
    if (mapSteerLatch !== dir) {      // 방향이 바뀌면 중립을 거치지 않아도 새 엣지로 인정(키보드 A↔D)
      mapSteerLatch = dir;
      setMapIndex(mapIndex + dir, true);
    }
  } else if (Math.abs(s) < MAP_EDGE_OFF) {
    mapSteerLatch = 0;
  }
}

// ───────────────────────────────── 게임 모드 (아이템전 / 스피드전) ─────────────────────────────────

function loadGameMode() {
  try {
    const raw = localStorage.getItem(MODE_STORAGE_KEY);
    return raw === 'speed' ? 'speed' : 'items';
  } catch (e) { return 'items'; } // 프라이빗 모드 등 — 기본값
}

function saveGameMode() {
  try { localStorage.setItem(MODE_STORAGE_KEY, gameMode); } catch (e) { /* 무시 */ }
}

function setGameMode(m, announce) {
  gameMode = m === 'speed' ? 'speed' : 'items';
  saveGameMode();
  if (itemSystem && typeof itemSystem.setEnabled === 'function') itemSystem.setEnabled(gameMode === 'items');
  if (hud && typeof hud.setGameMode === 'function') hud.setGameMode(gameMode);
  if (announce) audio.play('switch');
}

// 타이틀에서 P0 brake(키보드 S / 패드 LT)의 0.5 상승 엣지로 모드를 순환한다.
// steer(맵 선택)/anyStartPressed/backPressed 어느 것과도 축이 겹치지 않는 유일한 입력이라 brake를 쓴다
// (drift는 패드 A/RB에 매핑되어 있어 anyStartPressed와 동시에 눌리는 문제가 있다 — 설계서 §E-3).
function updateModeSelect(rawBrake) {
  const b = rawBrake || 0;
  if (!modeBrakeLatch && b > 0.5) {
    modeBrakeLatch = true;
    setGameMode(gameMode === 'items' ? 'speed' : 'items', true);
  } else if (modeBrakeLatch && b < 0.2) {
    modeBrakeLatch = false;
  }
}

// ───────────────────────────────── 씬 구성 (맵 전환) ─────────────────────────────────

// 하늘색 밝기로 조명을 맞춘다 — 나이트 맵이 대낮처럼 보이지 않게.
function applyTheme(theme) {
  const skyHex = theme && theme.sky !== undefined ? theme.sky : SKY_COLOR;
  const sky = new THREE.Color(skyHex);
  renderer.setClearColor(sky, 1);

  const lum = 0.2126 * sky.r + 0.7152 * sky.g + 0.0722 * sky.b;
  const f = THREE.MathUtils.clamp(0.35 + lum * 0.9, 0.35, 1.2);
  sun.intensity = SUN_BASE * f;
  hemi.intensity = HEMI_BASE * f;
  ambient.intensity = AMBIENT_BASE * Math.max(f, 0.7);
  hemi.color.set(theme && theme.fog ? theme.fog.color : skyHex);
  hemi.groundColor.set(theme && theme.groundColor !== undefined ? theme.groundColor : 0x3f6b33);
}

// 맵마다 크기가 달라 그림자 프러스텀을 트랙 범위에 맞춘다(고정 ±160이면 큰 맵에서 잘림).
function fitSunToTrack(def) {
  const cps = def.controlPoints;
  // controlPoints는 [x, z](평면) 또는 [x, y, z](고저차) 두 형식이다 — track.js와 같은
  // 판별(원소 배열 길이)을 쓴다. 이 구분을 안 하면 [x,y,z] 맵에서 y를 z로 오독해
  // 그림자 프러스텀이 통째로 어긋난다(에러 없이 조용히 실패 — alpine-pass 실측 z 17.1m 이탈).
  const dim3 = cps[0].length >= 3;
  const px = (p) => p[0];
  const py = (p) => (dim3 ? p[1] : 0);
  const pz = (p) => (dim3 ? p[2] : p[1]);

  let cx = 0, cz = 0, cy = 0, ymin = Infinity, ymax = -Infinity;
  for (const p of cps) {
    cx += px(p); cz += pz(p); cy += py(p);
    ymin = Math.min(ymin, py(p)); ymax = Math.max(ymax, py(p));
  }
  cx /= cps.length; cz /= cps.length; cy /= cps.length;
  let r = 0;
  for (const p of cps) r = Math.max(r, Math.hypot(px(p) - cx, pz(p) - cz));
  r = THREE.MathUtils.clamp(r + 45, 120, 320);

  // 평면 맵에서는 cy = 0, ymax - ymin = 0 이라 아래 네 줄이 기존과 완전히 동일하다.
  sun.position.set(cx + 120, 180 + cy, cz + 60);
  sun.target.position.set(cx, cy, cz);
  sun.target.updateMatrixWorld();
  const cam = sun.shadow.camera;
  cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
  cam.far = 520 + r + (ymax - ymin);
  cam.updateProjectionMatrix();
}

// 기존 트랙/아이템을 정리하고 def로 다시 만든다. 아이템 박스 위치가 트랙에 종속이라
// ItemSystem도 반드시 함께 재생성한다.
function buildTrack(def) {
  if (itemSystem) { itemSystem.dispose(); itemSystem = null; }
  if (track) { track.dispose(scene); track = null; }

  track = new Track(scene, def, assets);   // scene.background/fog는 Track이 테마대로 설정
  track.totalLaps = laps;
  applyTheme(def.theme || {});
  fitSunToTrack(def);
  itemSystem = new ItemSystem(scene, track);
  if (typeof itemSystem.setEnabled === 'function') itemSystem.setEnabled(gameMode === 'items');
  boostPadCooldowns.clear(); // 맵 재구축 시 부스트 패드 쿨다운 초기화(패드 배치가 트랙마다 다르므로)
  if (hud) hud.setMapInfo({ name: def.name, difficulty: def.difficulty ?? 1 });
}

function disposeKarts() {
  for (const k of karts) {
    // GLB 사본은 지오메트리/머티리얼을 원본 템플릿과 공유한다 → dispose하면 에셋이 죽는다.
    // 절차 생성 카트만 GPU 리소스를 해제한다(재시작마다 누적되는 것을 막기 위함).
    if (!k.usesSharedModel) {
      k.object3d.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) m.dispose();
        }
      });
    }
    scene.remove(k.object3d);
  }
  karts = [];
}

function snapshotKarts() {
  prev = karts.map((k) => ({
    lap: k.lap,
    item: k.item || null,
    boost: k.boostTimer,
    spin: k.spinTimer,
    finished: k.finished,
    // kart.js에 아직 없을 수 있는 필드 — 있으면만 추적(존재 가드)
    slip: typeof k.slipTimer === 'number' ? k.slipTimer : 0,
    wallHitImpulse: typeof k.wallHitImpulse === 'number' ? k.wallHitImpulse : 0,
  }));
}

// 출발 그리드 좌우 배정.
// track.getSpawnTransforms 는 col 0 을 +lateral(= 진행방향 기준 화면 오른쪽)에 놓는다.
// 그런데 P0(빨강)은 WASD, P1(파랑)은 방향키 — 키보드에서 WASD가 왼쪽이고 분할화면도
// P0가 왼쪽 반쪽이다. 그리드만 반대라 혼란스러우므로 배정을 뒤집어 P0를 왼쪽에 세운다.
// (track.js 의 그리드 정의는 건드리지 않는다 — 맵 지오메트리 계약이라 그대로 두는 게 맞다.)
const GRID_SLOT = [1, 0];   // 플레이어 i → spawns 인덱스

function buildKarts() {
  disposeKarts();
  const spawns = track.getSpawnTransforms(2);
  karts = [0, 1].map((i) => {
    const model = assets && assets.karts ? assets.karts[KART_MODEL_KEYS[i]] : null;
    const kart = new Kart({
      color: KART_COLORS[i],
      spawn: spawns[GRID_SLOT[i]],
      name: KART_NAMES[i],
      model: model || undefined,   // 없으면 Kart가 절차 생성 메시로 폴백
    });
    kart.usesSharedModel = !!model;
    kart.item = null; // ItemSystem이 관리하는 동적 필드 초기화
    scene.add(kart.object3d);
    return kart;
  });
  snapshotKarts();
}

// 타이틀 맵 프리뷰 재구축 후용: 카트를 재생성하지 않고(disposeKarts/buildKarts 아님)
// 새 트랙의 스폰 좌표만 기존 카트 오브젝트에 반영한다.
function respawnKartsAtSpawns() {
  if (!track || karts.length === 0) return;
  const spawns = track.getSpawnTransforms(karts.length);
  for (let i = 0; i < karts.length; i++) {
    const sp = spawns[GRID_SLOT[i] ?? i];   // 타이틀 프리뷰 재배치도 같은 규칙
    const k = karts[i];
    if (!sp || !k) continue;
    k.object3d.position.copy(sp.position);
    k.object3d.quaternion.copy(sp.quaternion);
    _tmpV.set(0, 0, -1).applyQuaternion(sp.quaternion);
    k.heading = Math.atan2(-_tmpV.x, -_tmpV.z);
    k.speed = 0;
    k.driftLevel = 0;
    k.boostTimer = 0;
    k.spinTimer = 0;
  }
  snapshotKarts();
}

function resetItems() {
  if (!itemSystem) return;
  // 스피드전(setEnabled(false))에서는 박스를 계속 숨긴 채로 되돌린다.
  // 무조건 visible=true로 되돌리면 ItemSystem.update()가 !enabled로 즉시 빠지는 탓에
  // 회전도 부유도 하지 않는 큐브 12개가 노면 위에 얼어붙는다(CONTRACTS.md setEnabled 계약 위반).
  const boxesVisible = itemSystem.enabled !== false;
  for (const box of itemSystem.boxes) {
    box.active = true;
    box.respawnTimer = 0;
    box.mesh.visible = boxesVisible;
    box.mesh.scale.setScalar(1);
  }
  for (const s of itemSystem.shells) scene.remove(s.mesh);
  itemSystem.shells.length = 0;
  for (const b of itemSystem.bananas) scene.remove(b.mesh);
  itemSystem.bananas.length = 0;
  // 물풍선/웅덩이(§F) — items.js가 아직 배열을 노출하지 않는 빌드와도 호환되도록 존재 가드.
  if (Array.isArray(itemSystem.balloons)) {
    for (const b of itemSystem.balloons) scene.remove(b.mesh);
    itemSystem.balloons.length = 0;
  }
  if (Array.isArray(itemSystem.puddles)) {
    for (const p of itemSystem.puddles) {
      scene.remove(p.mesh);
      if (p.mesh.geometry) p.mesh.geometry.dispose();
      if (p.mesh.material) p.mesh.material.dispose();
    }
    itemSystem.puddles.length = 0;
  }
}

// ───────────────────────────────── 설정 반영 ─────────────────────────────────

let appliedQuality = null;

function applyQuality(quality) {
  // 슬라이더(볼륨/감도/랩)는 드래그 중 input마다 onChange를 쏘므로 applySettings가
  // 초당 수십 번 불린다. 아래 scene.traverse + needsUpdate는 전 머티리얼 셰이더
  // 재컴파일을 유발하니, 품질이 실제로 바뀐 경우에만 수행한다.
  if (quality === appliedQuality) return;
  appliedQuality = quality;

  const high = quality !== 'low';
  renderer.shadowMap.enabled = high;
  sun.castShadow = high;
  renderer.setPixelRatio(high ? Math.min(window.devicePixelRatio || 1, 2) : 1);
  // shadowMap.enabled 토글은 이미 컴파일된 머티리얼 재컴파일이 필요하다.
  scene.traverse((o) => {
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) m.needsUpdate = true;
    }
  });
  // SplitView가 resize 리스너에서 setSize를 담당하므로 픽셀비 변경을 그쪽으로 흘려보낸다.
  window.dispatchEvent(new Event('resize'));
}

function applySettings(s) {
  splitView.setMode(s.splitMode);
  audio.setVolume(s.volume);
  sensitivity = s.sensitivity;
  laps = s.laps;
  // Kart의 완주 판정은 track.totalLaps를 읽으므로 설정 랩 수를 여기에 반영한다.
  if (track) track.totalLaps = laps;
  applyQuality(s.quality);
}

// ───────────────────────────────── 상태 전이 ─────────────────────────────────

function startCountdown() {
  buildKarts();
  resetItems();
  boostPadCooldowns.clear(); // 결과 화면에서 같은 맵으로 재시작(buildTrack 미경유) 시 이전 레이스 쿨다운이 남지 않도록
  hud.hideResults();
  raceTime = 0;
  countdownTimer = COUNTDOWN_LENGTH;
  lastCountdownNum = null;
  finishForceTimer = null;
  state = 'countdown';
  if (typeof audio.setRaceActive === 'function') audio.setRaceActive(true);
}

// 타이틀에서 Start → 선택된 맵을 확정하고(트랙 재생성) 카운트다운 시작.
function startSelectedMap() {
  cancelMapPreview(); // 프리뷰 디바운스가 남아 있다가 뒤늦게 트랙을 다시 갈아치우지 않도록
  buildTrack(TRACKS[mapIndex]);
  startCountdown();
}

function goToTitle() {
  buildKarts();
  resetItems();
  hud.hideResults();
  hud.setMapInfo({ name: TRACKS[mapIndex].name, difficulty: TRACKS[mapIndex].difficulty ?? 1 });
  // 스틱/키를 꺾은 채로 타이틀에 들어오면 곧바로 맵이 넘어가지 않도록 현재 값으로 래치를 채운다.
  const held = inputManager ? (inputManager.getPlayerInput(0).steer || 0) : 0;
  mapSteerLatch = Math.abs(held) > MAP_EDGE_ON ? (held > 0 ? 1 : -1) : 0;
  // 브레이크를 밟은 채로 타이틀에 들어오면 곧바로 모드가 전환되지 않도록 래치를 채운다.
  modeBrakeLatch = (inputManager ? (inputManager.getPlayerInput(0).brake || 0) : 0) > 0.5;
  raceTime = 0;
  state = 'title';
  if (typeof audio.setRaceActive === 'function') audio.setRaceActive(false);
}

// ───────────────────────────────── 견인(러버밴딩) ─────────────────────────────────
// 선두와의 실제 거리(m)로 뒤처진 카트의 최고속·가속 배율을 정한다.
// progress = lap + t 이므로 (선두 progress - 내 progress) * track.length 가 곧 뒤처진 거리다.
const CATCHUP_NEAR = 30;    // m — 이 안쪽이면 견인 없음(접전에서는 개입하지 않는다)
const CATCHUP_FAR = 130;    // m — 이 밖이면 최대 배율
const CATCHUP_MAX = 1.25;   // 최고속 배율 상한(38 → 47.5 m/s)

function updateCatchup() {
  if (!track || karts.length < 2) return;
  const len = track.length || 1;
  let lead = karts[0];
  for (const k of karts) if (k.progress > lead.progress) lead = k;

  for (const k of karts) {
    if (typeof k.setCatchup !== 'function') continue;   // 절차 폴백 카트 등 미지원 대비
    let factor = 1;
    if (k !== lead && !k.finished) {
      const gap = (lead.progress - k.progress) * len;   // 뒤처진 거리(m)
      const t = THREE.MathUtils.clamp((gap - CATCHUP_NEAR) / (CATCHUP_FAR - CATCHUP_NEAR), 0, 1);
      factor = 1 + (CATCHUP_MAX - 1) * (t * t * (3 - 2 * t));   // smoothstep
    }
    k.setCatchup(factor);
  }
}

// ───────────────────────────────── 순위 / 결과 ─────────────────────────────────

function computeRanks() {
  const order = karts.slice().sort((a, b) => {
    if (a.finished && b.finished) return (a.finishTime ?? 0) - (b.finishTime ?? 0);
    if (a.finished) return -1;
    if (b.finished) return 1;
    return b.progress - a.progress;   // progress = lap + t (단조 증가)
  });
  order.forEach((k, i) => { k.rank = i + 1; });
}

function finishRace() {
  state = 'finished';
  if (typeof audio.setRaceActive === 'function') audio.setRaceActive(false);
  // 'finish' 효과음은 playEventSounds()가 개별 완주 시점에 이미 재생한다(중복 방지).
  // 결과 패널 진입은 별도 슬롯('results')으로 알린다.
  audio.play('results');
  hud.showResults(karts.map((k) => ({
    name: k.name,
    color: k.color,
    finishTime: k.finished ? k.finishTime : null,
    rank: k.rank,
  })));
}

// ───────────────────────────────── 입력 어댑터 ─────────────────────────────────

// 조향 감도만 곱해서 넘긴다. (나머지 필드는 InputManager 반환 그대로)
function playerInput(i) {
  const raw = inputManager.getPlayerInput(i);
  return {
    throttle: raw.throttle,
    brake: raw.brake,
    steer: THREE.MathUtils.clamp(raw.steer * sensitivity, -1, 1),
    drift: raw.drift,
    useItem: raw.useItem,
  };
}

const EMPTY_INPUT = { throttle: 0, brake: 0, steer: 0, drift: false, useItem: false };

// ───────────────────────────────── 이벤트 사운드 ─────────────────────────────────

function playEventSounds() {
  for (let i = 0; i < karts.length; i++) {
    const k = karts[i];
    const p = prev[i];
    if (!p) continue;
    if ((k.item || null) && !p.item) audio.play('pickup');
    if (k.boostTimer > 0 && p.boost <= 0) audio.play('boost');
    if (k.spinTimer > 0 && p.spin <= 0) {
      audio.play('hit');
      inputManager.rumble(i, 0.75, 0.5, 250);
    }
    // 물풍선 직격/웅덩이 통과(applySlip) — 스핀과 달리 조작은 살아 있지만 조향 권한이 55% 줄어든다.
    // 아무 피드백이 없으면 "조작이 먹통"으로 읽히므로, 스핀('hit' + 0.75/0.5/250ms)과 구분되도록
    // 같은 효과음에 약하고 긴 럼블(0.35/0.6/400ms)을 건다.
    if (typeof k.slipTimer === 'number' && k.slipTimer > 0 && !(p.slip > 0)) {
      audio.play('hit');
      inputManager.rumble(i, 0.35, 0.6, 400);
    }
    if (k.lap > p.lap && k.lap <= laps) audio.play('lap');
    if (k.finished && !p.finished) audio.play('finish');
    // kart.wallHitImpulse(존재 시) — 벽 충돌 순간에 짧은 러블을 연동한다(존재 가드).
    if (typeof k.wallHitImpulse === 'number' && k.wallHitImpulse > 0 && !(p.wallHitImpulse > 0)) {
      inputManager.rumble(i, 0.4, 0.25, 120);
    }
  }
  snapshotKarts();
}

// ───────────────────────────────── 부스트 패드 ─────────────────────────────────
// 확정 계약: track.boostPads = [{ position: THREE.Vector3, radius: number }] (CONTRACTS.md track 절).
// def.boostPads가 없는 맵은 빈 배열이고, dispose() 후에도 빈 배열로 리셋되므로
// 아래 존재 가드는 "패드 없는 맵 / 해제된 트랙"을 흡수하기 위한 것이다.

function updateBoostPads(dt) {
  if (!track || !Array.isArray(track.boostPads)) return; // 존재 가드: 배열일 때만 동작

  // 쿨다운 감쇠 — 만료된 항목은 정리해서 Map이 계속 자라지 않게 한다.
  for (const [key, remaining] of boostPadCooldowns) {
    const next = remaining - dt;
    if (next <= 0) boostPadCooldowns.delete(key);
    else boostPadCooldowns.set(key, next);
  }

  for (let i = 0; i < karts.length; i++) {
    const k = karts[i];
    for (let j = 0; j < track.boostPads.length; j++) {
      const pad = track.boostPads[j];
      if (!pad || !pad.position) continue;
      const key = `${i}_${j}`;
      if (boostPadCooldowns.has(key)) continue; // 이 카트×패드 조합은 아직 쿨다운 중

      const dx = k.object3d.position.x - pad.position.x;
      const dz = k.object3d.position.z - pad.position.z;
      const radius = typeof pad.radius === 'number' ? pad.radius : 0;
      if (Math.hypot(dx, dz) < radius) {
        if (typeof k.applyBoost === 'function') k.applyBoost(1, 1.2);
        // 'boost' 효과음은 여기서 재생하지 않는다 — playEventSounds()가 boostTimer 상승 에지에서
        // 이미 재생하므로(main.js playEventSounds), 여기서도 재생하면 한 프레임에 중복 재생된다.
        inputManager.rumble(i, 0.7, 0.4, 250);
        boostPadCooldowns.set(key, BOOST_PAD_COOLDOWN);
      }
    }
  }
}

// ───────────────────────────────── 메인 루프 ─────────────────────────────────

let lastTime = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - lastTime) / 1000;
  lastTime = now;
  if (!isFinite(dt) || dt < 0) dt = 0;
  dt = Math.min(dt, 0.05); // 탭 복귀 등 큰 점프 방지

  inputManager.poll();

  const inA = playerInput(0);
  const inB = playerInput(1);
  const rawA = inputManager.getPlayerInput(0);
  const rawB = inputManager.getPlayerInput(1);

  // 키보드 Esc는 두 플레이어 슬롯 모두에 pause edge를 찍으므로 OR로 한 번만 처리한다.
  // 패드 Start(버튼9)는 pause 매핑이자 anyStartPressed 소스이기도 하다 — title/finished에서는
  // pause 입력을 무시해 startEdge(시작/재시작)가 항상 우선하도록 한다. 설정은 레이스 중 Esc/마우스로만 연다.
  if ((rawA.pause || rawB.pause) && state !== 'title' && state !== 'finished') {
    settingsMenu.toggle();
    audio.play('menu');
  }
  const paused = settingsMenu.isOpen;

  const n = inputManager.connectedCount();
  if (n !== padCount) { padCount = n; hud.setPadCount(n); }

  const startEdge = inputManager.anyStartPressed() && !paused;
  const backEdge = inputManager.backPressed() && !paused;

  if (!paused) {
    switch (state) {
      case 'title':
        // 맵 선택은 시작 판정보다 먼저 — 이번 프레임의 선택이 그대로 확정되도록.
        updateMapSelect(rawA.steer);
        updateModeSelect(rawA.brake);
        if (startEdge) { audio.play('menu'); startSelectedMap(); }
        break;

      case 'countdown': {
        countdownTimer -= dt;
        const num = Math.max(0, Math.ceil(countdownTimer) - 1);
        if (num !== lastCountdownNum) {
          lastCountdownNum = num;
          audio.play(num > 0 ? 'count' : 'go');
        }
        if (countdownTimer <= 0) {
          state = 'race';
          raceTime = 0;
          snapshotKarts();
        }
        break;
      }

      case 'race': {
        raceTime += dt;
        const inputs = [inA, inB];
        updateCatchup();   // 카트 갱신 전에 이번 프레임 견인 배율을 정한다
        for (let i = 0; i < karts.length; i++) karts[i].update(dt, inputs[i], track, raceTime);
        collideKarts(karts[0], karts[1]);
        itemSystem.update(dt, karts);
        updateBoostPads(dt);
        // 아이템 사용은 main이 중계 (useItem은 edge). 스피드전은 아이템이 없으므로 가드해
        // 효과음이 중복 재생되지 않게 한다(itemSystem.use()는 disabled 시 no-op이지만 'use' 음은 여기서 낸다).
        for (let i = 0; i < karts.length; i++) {
          if (gameMode === 'items' && inputs[i].useItem && karts[i].item && !karts[i].finished) {
            itemSystem.use(karts[i], karts);
            audio.play('use');
          }
        }
        computeRanks();
        playEventSounds();
        // 상대(들)가 완주하지 않으면(예: 1인 플레이) every(finished)만으로는 결과 화면이 영원히 안 뜬다.
        // 첫 완주자가 나오면 유예시간을 두고, 그 안에 나머지가 완주하지 않으면 강제 종료(DNF)한다.
        if (finishForceTimer === null && karts.some((k) => k.finished)) {
          finishForceTimer = FINISH_FORCE_TIMEOUT;
        }
        if (karts.every((k) => k.finished)) {
          finishRace();
        } else if (finishForceTimer !== null) {
          finishForceTimer -= dt;
          if (finishForceTimer <= 0) finishRace();
        }
        break;
      }

      case 'finished': {
        // 완주 후에는 조작 불가 상태로 관성 주행만 (raceTime은 정지)
        for (const k of karts) k.update(dt, EMPTY_INPUT, track, raceTime);
        collideKarts(karts[0], karts[1]);
        itemSystem.update(dt, karts);
        // Start = 같은 맵으로 재시작(트랙 유지), B/Backspace = 타이틀로 돌아가 맵 재선택.
        if (startEdge) { audio.play('menu'); startCountdown(); }
        else if (backEdge) { audio.play('menu'); goToTitle(); }
        break;
      }
    }
  }

  computeRanks(); // title/countdown/pause 중에도 HUD 순위 표기를 채워둔다
  audio.update(karts);

  const layout = splitView.layout || 'single';
  hud.update({
    players: karts.map((k) => ({
      lap: k.lap,
      totalLaps: laps,
      rank: k.rank || 1,
      item: k.item || null,
      speed: k.speed,
      driftLevel: k.driftLevel,
      name: k.name,
      color: k.color,
    })),
    state: state === 'title' ? 'menu' : state,
    countdown: state === 'countdown' ? lastCountdownNum : null,
    raceTime,
    splitLayout: layout,
  });

  splitView.render(paused ? 0 : dt, karts);
}

// ───────────────────────────────── 부팅 ─────────────────────────────────
// 로딩 오버레이 → loadAssets(onProgress, audio.context) → 모듈 초기화 → 루프.
// 개별 항목 로드 실패는 assets.js가 null로 흡수하므로, 소비 측 폴백에 맡기고 그대로 진행한다.

async function boot() {
  setLoaderProgress(0, 1);
  try {
    assets = await loadAssets(setLoaderProgress, audio.context);
  } catch (err) {
    console.warn('[main] 에셋 로드 전체 실패 — 절차 생성/합성음으로 진행합니다:', err);
    assets = null;
  }

  // 에셋 로드 이후 모듈 초기화 전체를 감싼다 — 여기서 어떤 예외가 나든(모델/설정
  // 초기화 실패 등) 로딩 오버레이를 그대로 두고 오류 메시지를 보여준다. 조용히
  // 죽어서 빈 화면만 남는 상황을 피하기 위함(원칙 3: 조용한 실패를 의심하기).
  try {
    if (assets) {
      audio.provideBuffers({ sfx: assets.sfx, engine: assets.engine, thruster: assets.thruster });
    }

    inputManager = new InputManager();
    splitView = new SplitView(renderer, scene);
    hud = new HUD();
    settingsMenu = new SettingsMenu({
      onChange: (s) => {
        applySettings(s);
        // 슬라이더 드래그 중에는 input마다 onChange가 연사되므로 효과음은 150ms 스로틀.
        const now = performance.now();
        if (now - lastSwitchSoundTime >= SWITCH_SOUND_THROTTLE) {
          lastSwitchSoundTime = now;
          audio.play('switch');
        }
      },
      // SettingsMenu는 "누가 눌렸는지"만 알려달라고 요청한다 → InputManager로 중계.
      onRemapRequest: (onDone) => {
        inputManager.listenForButton((buttonIndex) => {
          // InputManager는 취소 개념이 없어 리스너가 계속 살아 있다. 설정 쪽에서
          // 취소/타임아웃된 리매핑은 onDone이 false를 돌려주므로 매핑을 적용하지 않는다.
          if (onDone(buttonIndex) === false) return;
          inputManager.setMapping({ drift: buttonIndex });
          audio.play('menu');
        });
      },
    });

    applySettings(settingsMenu.settings);   // 초기 반영은 'switch' 음 없이

    mapIndex = loadMapIndex();
    gameMode = loadGameMode();
    buildTrack(TRACKS[mapIndex]);
    if (typeof hud.setGameMode === 'function') hud.setGameMode(gameMode);
    goToTitle();

    hideLoader();
    lastTime = performance.now();
    requestAnimationFrame(frame);
  } catch (err) {
    console.error('[main] 초기화 실패 — 게임을 시작할 수 없습니다:', err);
    if (loaderText) {
      loaderText.textContent = `초기화 오류: ${err && err.message ? err.message : err}`;
    }
    if (loaderFill) loaderFill.style.background = '#e03a3a';
    // hideLoader()를 호출하지 않는다 — 오버레이가 오류 메시지를 보여준 채로 남는다.
  }
}

boot();
