// src/camview.js — 손 인식 카메라 영상을 게임 화면 모서리에 띄운다.
//
// P1은 왼쪽 위, P2는 오른쪽 위. handsteer/hand_steering.py 가 켜져 있으면 MJPEG 스트림을
// 받아 보여주고, 없으면 "NoCamera" 를 띄운다. 스크립트를 나중에 켜도 알아서 붙는다.
//
// 카메라는 파이썬이 점유하므로 브라우저가 getUserMedia 로 직접 열 수 없다 — 그래서
// 파이썬이 인식 결과를 그려 넣은 영상을 중계받는다.
//
// 게임 로직과 완전히 분리돼 있다(모듈 간 import 없음). index.html 이 직접 불러온다.

let STREAM_ORIGIN = 'http://localhost:8090';   // runtime.json 의 streamPort 로 덮인다
const RETRY_MS = 5000;      // 스트림이 없을 때 다시 붙어 보는 간격
const FRAME_MS = 80;        // 영상 갱신 주기(ms). 12.5fps — 확인용이라 이 정도면 충분하다
const MISS_LIMIT = 25;      // 연속 실패가 이만큼 쌓이면 NoCamera 로 내린다(약 2초)

const STYLE = `
.camview {
  position: fixed;
  top: 12px;
  width: 240px;
  z-index: 900;
  border-radius: 10px;
  overflow: hidden;
  border: 2px solid rgba(255, 255, 255, 0.35);
  background: #14161c;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
  pointer-events: none;
  font-family: 'Kenney Future', 'Segoe UI', Arial, sans-serif;
}
.camview.p1 { left: 12px; border-color: rgba(210, 58, 47, 0.75); }
.camview.p2 { right: 12px; border-color: rgba(47, 107, 210, 0.75); }
.camview .tag {
  position: absolute;
  top: 4px;
  left: 6px;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 1px;
  padding: 1px 6px;
  border-radius: 5px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
}
.camview.p1 .tag { color: #ff8a80; }
.camview.p2 .tag { color: #90c2ff; }
.camview img { display: block; width: 100%; height: auto; }
.camview .nocam {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 135px;
  color: #6d7381;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.5px;
}
.camview .nocam .sub {
  font-size: 10px;
  font-weight: 400;
  opacity: 0.75;
  letter-spacing: 0;
}
`;

function injectStyle() {
  if (document.getElementById('camview-style')) return;
  const el = document.createElement('style');
  el.id = 'camview-style';
  el.textContent = STYLE;
  document.head.appendChild(el);
}

class CamFeed {
  constructor(key, label) {
    this.key = key;                     // 'p1' | 'p2'
    this.root = document.createElement('div');
    this.root.className = `camview ${key}`;

    this.tag = document.createElement('div');
    this.tag.className = 'tag';
    this.tag.textContent = label;
    this.root.appendChild(this.tag);

    this.placeholder = document.createElement('div');
    this.placeholder.className = 'nocam';
    this.placeholder.innerHTML = '<div>NoCamera</div>'
      + '<div class="sub">카메라 연결 대기 중</div>';
    this.root.appendChild(this.placeholder);

    this.img = null;
    this.timer = null;
    this.poll = null;
    this.connected = false;
    this.misses = 0;
    document.body.appendChild(this.root);
    this.connect();
  }

  showPlaceholder() {
    clearInterval(this.poll);
    this.connected = false;
    if (this.img) {
      this.img.remove();
      this.img = null;
    }
    this.placeholder.style.display = '';
  }

  connect() {
    clearTimeout(this.timer);
    clearInterval(this.poll);
    if (this.img) this.img.remove();

    // 단일 JPEG 를 짧은 주기로 갈아 끼운다.
    // MJPEG(multipart/x-mixed-replace)를 <img> 로 받는 방식은 브라우저·버전에 따라
    // 아예 그려지지 않는 경우가 있어 신뢰할 수 없었다.
    const img = document.createElement('img');
    this.img = img;
    this.connected = false;
    this.misses = 0;
    this.root.appendChild(img);

    const tick = () => {
      const next = new Image();
      next.onload = () => {
        this.misses = 0;
        if (!this.connected) {
          this.connected = true;
          this.placeholder.style.display = 'none';
        }
        img.src = next.src;          // 다 받은 뒤에 바꿔야 깜빡이지 않는다
      };
      next.onerror = () => {
        this.misses += 1;
        if (this.misses >= MISS_LIMIT) {
          this.showPlaceholder();
          this.timer = setTimeout(() => this.connect(), RETRY_MS);
        }
      };
      next.src = `${STREAM_ORIGIN}/${this.key}.jpg?t=${performance.now().toFixed(0)}`;
    };

    tick();
    this.poll = setInterval(tick, FRAME_MS);
  }
}

// run.py 가 남기는 실행 상태. 손동작이 꺼져 있으면(키보드 디버그 모드) 카메라 칸을
// 아예 띄우지 않는다 — 없는 기능의 자리가 화면에 남아 있으면 고장으로 읽힌다.
async function readRuntime() {
  try {
    const res = await fetch(`runtime.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;   // 파일이 없으면(서버만 따로 띄운 경우) 아래 기본값으로 간다
  }
}

async function init() {
  injectStyle();
  const rt = await readRuntime();

  // runtime.json 이 없으면 손동작을 쓰는 것으로 보고 붙여 본다(스트림이 없으면 NoCamera).
  const handOn = rt ? rt.handSteering !== false : true;
  if (rt && rt.streamPort) STREAM_ORIGIN = `http://localhost:${rt.streamPort}`;
  if (!handOn) return;

  const feeds = [new CamFeed('p1', 'P1')];
  if (!rt || (rt.cameras ?? 2) >= 2) feeds.push(new CamFeed('p2', 'P2'));
  return feeds;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
