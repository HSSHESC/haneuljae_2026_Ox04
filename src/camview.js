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
const CONNECT_TIMEOUT_MS = 4000;  // 이 시간 안에 첫 프레임이 안 오면 NoCamera

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

    const img = document.createElement('img');
    this.img = img;
    this.connected = false;

    // MJPEG(multipart/x-mixed-replace)는 응답이 계속 열려 있어서 브라우저가 load 를
    // 안 주거나 늦게 줄 수 있다. load 에만 기대면 잘 나오는 영상을 지워버린다 —
    // 실제로 프레임이 그려졌는지는 naturalWidth 로 본다.
    const started = performance.now();
    this.poll = setInterval(() => {
      if (img.naturalWidth > 0) {
        if (!this.connected) {
          this.connected = true;
          this.placeholder.style.display = 'none';
        }
        return;                       // 붙었으면 계속 지켜보기만 한다
      }
      if (performance.now() - started > CONNECT_TIMEOUT_MS) {
        clearInterval(this.poll);
        this.showPlaceholder();
        this.timer = setTimeout(() => this.connect(), RETRY_MS);
      }
    }, 400);

    // 연결 자체가 거부되면(서버 꺼짐 등) 즉시 재시도로 넘어간다.
    img.onerror = () => {
      if (this.connected) return;     // 스트림 도중의 오류는 무시 — 다음 프레임을 기다린다
      clearInterval(this.poll);
      this.showPlaceholder();
      this.timer = setTimeout(() => this.connect(), RETRY_MS);
    };

    // 캐시를 타지 않게 매번 다른 쿼리를 붙인다(재연결 시 같은 URL이면 브라우저가 재요청을 안 한다).
    img.src = `${STREAM_ORIGIN}/${this.key}?t=${performance.now().toFixed(0)}`;
    this.root.appendChild(img);
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
