// src/camview.js — 손 인식 카메라 영상을 게임 화면 모서리에 띄운다.
//
// P1은 왼쪽 위, P2는 오른쪽 위. handsteer/hand_steering.py 가 켜져 있으면 MJPEG 스트림을
// 받아 보여주고, 없으면 "NoCamera" 를 띄운다. 스크립트를 나중에 켜도 알아서 붙는다.
//
// 카메라는 파이썬이 점유하므로 브라우저가 getUserMedia 로 직접 열 수 없다 — 그래서
// 파이썬이 인식 결과를 그려 넣은 영상을 중계받는다.
//
// 게임 로직과 완전히 분리돼 있다(모듈 간 import 없음). index.html 이 직접 불러온다.

const STREAM_ORIGIN = 'http://localhost:8090';
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
      + '<div class="sub">hand_steering.py 를 실행하면 연결됩니다</div>';
    this.root.appendChild(this.placeholder);

    this.img = null;
    this.timer = null;
    document.body.appendChild(this.root);
    this.connect();
  }

  showPlaceholder() {
    if (this.img) {
      this.img.remove();
      this.img = null;
    }
    this.placeholder.style.display = '';
  }

  connect() {
    clearTimeout(this.timer);
    if (this.img) this.img.remove();

    const img = document.createElement('img');
    this.img = img;
    let settled = false;

    // MJPEG 은 계속 열려 있는 응답이라 load 가 늦게 온다 — 첫 프레임을 못 받으면 NoCamera.
    const giveUp = setTimeout(() => {
      if (settled) return;
      settled = true;
      this.showPlaceholder();
      this.timer = setTimeout(() => this.connect(), RETRY_MS);
    }, CONNECT_TIMEOUT_MS);

    img.onload = () => {
      if (settled) return;
      settled = true;
      clearTimeout(giveUp);
      this.placeholder.style.display = 'none';
    };
    img.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(giveUp);
      this.showPlaceholder();
      this.timer = setTimeout(() => this.connect(), RETRY_MS);
    };

    // 캐시를 타지 않게 매번 다른 쿼리를 붙인다(재연결 시 같은 URL이면 브라우저가 재요청을 안 한다).
    img.src = `${STREAM_ORIGIN}/${this.key}?t=${performance.now().toFixed(0)}`;
    this.root.appendChild(img);
  }
}

function init() {
  injectStyle();
  // eslint-disable-next-line no-new
  new CamFeed('p1', 'P1');
  new CamFeed('p2', 'P2');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
