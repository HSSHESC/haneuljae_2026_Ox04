// src/audio.js
// 기본은 WebAudio 오실레이터/노이즈 합성. provideBuffers()로 샘플(AudioBuffer)이
// 주입되면 해당 슬롯은 샘플 재생으로 전환하고, 없는 슬롯은 계속 합성으로 폴백한다.
// AudioContext는 브라우저 자동재생 정책 때문에 첫 사용자 입력 전에는 'suspended' 상태로 시작한다.
// unlock()을 첫 입력(클릭/키다운/버튼) 핸들러에서 호출해 resume() 한다.

const MAX_SPEED_FOR_PITCH = 55; // m/s, 엔진 피치 매핑 상한 (부스트 최고속 기준)
const LOOP_EDGE_MARGIN = 0.05;  // s, 루프 이음매 클릭 방지용 loopStart/loopEnd 여유
const ENGINE_BASE_SPEED = 38;   // m/s, 샘플 엔진 playbackRate 공식의 기준 속도

const RESUME_RETRY_INTERVAL_MS = 1000; // ctx.state 재확인/resume() 재시도 스로틀 간격
const RACE_IDLE_GAIN = 0.03;           // setRaceActive(false) 상태에서 덕킹할 엔진 게인(합성 경로 아이들 게인과 동일)
const RACE_DUCK_TIME_CONSTANT = 0.1;   // setTargetAtTime 시간상수: ~3*tau(≈0.3s)에서 목표치에 사실상 도달

export class AudioEngine {
  constructor() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = Ctx ? new Ctx() : null;

    this._volume = 0.6;
    this._unlocked = false;
    this._engines = new Map(); // karts 배열 인덱스 -> per-kart persistent engine nodes
    this._lastResumeAttempt = 0; // performance.now()/Date.now() 기준, resume() 재시도 스로틀용
    this._raceActive = true;     // setRaceActive(false)면 엔진 게인을 RACE_IDLE_GAIN으로 덕킹(타이틀/카운트다운/결과 화면용)

    // provideBuffers()로 채워지는 샘플 자산 (없으면 전부 null → 기존 합성 유지)
    this._sampleSfx = null;      // { count, go, pickup, use, boost, hit, lap, finish, menu, results, switch }
    this._engineBuffers = null;  // AudioBuffer[] (카트 인덱스별 루프 소재)
    this._thrusterBuffer = null; // AudioBuffer

    if (!this.ctx) return; // WebAudio 미지원 환경: 전 메서드가 조용히 no-op 되도록 이하 가드

    this.master = this.ctx.createGain();
    this.master.gain.value = this._volume;
    this.master.connect(this.ctx.destination);

    this._noiseBuffer = this._makeNoiseBuffer(2.0);
  }

  // ---- 초기화/전역 제어 ----------------------------------------------

  unlock() {
    if (!this.ctx) return;
    this._unlocked = true;
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  setVolume(v) {
    this._volume = Math.max(0, Math.min(1, v));
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    // master 하나로 모든 출력(합성 SFX/엔진/스키드 + 샘플 SFX/엔진/thruster)이 라우팅되므로
    // 샘플 경로/합성 경로 구분 없이 항상 일관되게 볼륨이 적용된다.
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(this._volume, now, 0.05);
  }

  // 레이스가 실제로 진행 중인지 알린다(타이틀/카운트다운/일시정지/결과 화면 등에서는 false).
  // false인 동안에는 update()가 매 프레임 불려도 엔진 게인이 RACE_IDLE_GAIN으로 덕킹된다
  // (약 0.3초 페이드, setTargetAtTime 시간상수 기준). true로 돌아오면 기존처럼 speed 비례 게인을 쓴다.
  // 기존 공개 API(unlock/setVolume/provideBuffers/update/play/context)는 그대로이며 이 메서드는 추가분이다.
  setRaceActive(active) {
    this._raceActive = !!active;
  }

  // ---- 에셋 주입 (assets.js 로드 결과) --------------------------------

  provideBuffers({ sfx, engine, thruster } = {}) {
    if (!this.ctx) return;
    this._sampleSfx = sfx || null;
    // assets.js는 실패한 슬롯을 null로 채운 배열을 준다([null, null]도 length 2).
    // 그대로 받으면 buffer=null인 BufferSource가 만들어져 "에러 없이 무음"이 된다 —
    // null을 걸러내고, 남은 게 없으면 합성 엔진음으로 폴백한다.
    const engineList = Array.isArray(engine) ? engine.filter(Boolean) : [];
    this._engineBuffers = engineList.length ? engineList : null;
    this._thrusterBuffer = thruster || null;

    // 이미 생성된 per-kart 엔진 채널이 있다면 폐기 — 다음 update() 호출에서
    // 방금 주입된 버퍼 유무에 맞는 모드(샘플/합성)로 다시 만든다.
    this._teardownEngines();
  }

  _teardownEngines() {
    for (const eng of this._engines.values()) {
      for (const node of Object.values(eng)) {
        this._disposeNode(node);
      }
    }
    this._engines.clear();
  }

  _disposeNode(node) {
    if (!node || typeof node !== 'object') return;
    if (typeof node.stop === 'function') {
      try { node.stop(); } catch (_) { /* 이미 정지된 소스일 수 있음 */ }
    }
    if (typeof node.disconnect === 'function') {
      try { node.disconnect(); } catch (_) { /* no-op */ }
    }
  }

  // ---- 매 프레임 엔진음/스키드음 갱신 ---------------------------------

  update(karts) {
    if (!this.ctx || !karts) return;
    // 게임패드 전용 세션 안전장치: unlock()은 main.js가 'pointerdown'/'keydown'에서만 부르므로
    // 게임패드만 쓰는 세션에서는 영원히 호출되지 않을 수 있다. update()는 입력 종류와 무관하게
    // 매 프레임 불리므로, 여기서 suspended 여부를 스로틀링하며 재확인해 resume()을 재시도한다.
    this._tryResume();
    // 더 이상 존재하지 않는(사라진) 인덱스의 엔진은 그대로 두어도 무해하나,
    // karts 길이가 줄어드는 경우는 없다고 가정(게임 규칙상 2인 고정).
    for (let i = 0; i < karts.length; i++) {
      this._updateEngineChannel(i, karts[i]);
    }
  }

  _tryResume() {
    if (!this.ctx || this.ctx.state !== 'suspended') return;
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (now - this._lastResumeAttempt < RESUME_RETRY_INTERVAL_MS) return; // 스로틀: 매 프레임 resume() 호출 방지
    this._lastResumeAttempt = now;
    this.ctx.resume().catch(() => {}); // 사용자 제스처 없이는 브라우저가 조용히 거부할 수 있음 — 다음 스로틀 주기에 재시도
  }

  _getOrCreateEngine(i) {
    let eng = this._engines.get(i);
    if (eng) return eng;

    const ctx = this.ctx;
    const now = ctx.currentTime;

    const engineNodes = this._engineBuffers
      ? this._createSampleEngineNodes(i, now)
      : this._createSynthEngineNodes(now);

    // 스키드(드리프트) 노이즈는 샘플 제공 여부와 무관하게 항상 합성 유지.
    const skidNodes = this._createSkidNodes(now);

    eng = { ...engineNodes, ...skidNodes };
    this._engines.set(i, eng);
    return eng;
  }

  _createSynthEngineNodes(now) {
    const ctx = this.ctx;

    // 엔진 본체: 톱니파 오실레이터 -> 로우패스 필터 -> 게인
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 60;

    // 배음감을 살짝 더하는 2차 오실레이터(약하게, 한 옥타브 위)
    const osc2 = ctx.createOscillator();
    osc2.type = 'sawtooth';
    osc2.frequency.value = 120;
    const osc2Gain = ctx.createGain();
    osc2Gain.gain.value = 0.25;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 400;
    filter.Q.value = 0.7;

    const gain = ctx.createGain();
    gain.gain.value = 0.0001;

    osc.connect(filter);
    osc2.connect(osc2Gain);
    osc2Gain.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);

    osc.start(now);
    osc2.start(now);

    return { sampleMode: false, osc, osc2, osc2Gain, filter, gain };
  }

  _createSampleEngineNodes(i, now) {
    const ctx = this.ctx;
    const buffer = this._engineBuffers[i % this._engineBuffers.length];

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    this._applyLoopBounds(source, buffer);
    source.playbackRate.value = 0.6;

    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    source.connect(gain);
    gain.connect(this.master);
    source.start(now);

    let thrusterSource = null;
    let thrusterGain = null;
    if (this._thrusterBuffer) {
      thrusterSource = ctx.createBufferSource();
      thrusterSource.buffer = this._thrusterBuffer;
      thrusterSource.loop = true;
      this._applyLoopBounds(thrusterSource, this._thrusterBuffer);

      thrusterGain = ctx.createGain();
      thrusterGain.gain.value = 0.0001;
      thrusterSource.connect(thrusterGain);
      thrusterGain.connect(this.master);
      thrusterSource.start(now);
    }

    return { sampleMode: true, sampleSource: source, sampleGain: gain, thrusterSource, thrusterGain };
  }

  _applyLoopBounds(source, buffer) {
    const dur = buffer && buffer.duration;
    if (!dur || dur <= LOOP_EDGE_MARGIN * 2) return; // 너무 짧으면 전체 길이 그대로 루프
    source.loopStart = LOOP_EDGE_MARGIN;
    source.loopEnd = dur - LOOP_EDGE_MARGIN;
  }

  _createSkidNodes(now) {
    const ctx = this.ctx;

    const skidSource = ctx.createBufferSource();
    skidSource.buffer = this._noiseBuffer;
    skidSource.loop = true;

    const skidFilter = ctx.createBiquadFilter();
    skidFilter.type = 'bandpass';
    skidFilter.frequency.value = 1800;
    skidFilter.Q.value = 0.9;

    const skidGain = ctx.createGain();
    skidGain.gain.value = 0.0001;

    skidSource.connect(skidFilter);
    skidFilter.connect(skidGain);
    skidGain.connect(this.master);
    skidSource.start(now);

    return { skidSource, skidFilter, skidGain };
  }

  _updateEngineChannel(i, kart) {
    if (!kart) return;
    const eng = this._getOrCreateEngine(i);
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const speed = Math.abs(kart.speed || 0);
    const t = Math.max(0, Math.min(1, speed / MAX_SPEED_FOR_PITCH));
    const boosting = (kart.boostTimer || 0) > 0;

    // 레이스 비활성(타이틀/카운트다운/일시정지/결과 등) 동안에는 speed 비례 게인 대신
    // RACE_IDLE_GAIN으로 덕킹한다 — main.js가 setRaceActive(false)를 부르지 않는 한
    // 기존과 동일하게 동작한다(this._raceActive 기본값 true).
    const duckTau = this._raceActive ? 0.06 : RACE_DUCK_TIME_CONSTANT;

    if (eng.sampleMode) {
      const rate = 0.6 + (speed / ENGINE_BASE_SPEED) * 1.1;
      eng.sampleSource.playbackRate.setTargetAtTime(rate, now, 0.06);

      const engineGain = this._raceActive ? (0.35 + t * 0.5) : RACE_IDLE_GAIN;
      eng.sampleGain.gain.setTargetAtTime(engineGain, now, duckTau);

      if (eng.thrusterGain) {
        const thrusterTarget = (this._raceActive && boosting) ? 0.55 : 0.0001;
        eng.thrusterGain.gain.setTargetAtTime(thrusterTarget, now, boosting ? 0.05 : 0.15);
      }
    } else {
      const baseFreq = 55 + t * 210; // 공회전~고속 피치
      const freq = boosting ? baseFreq * 1.12 : baseFreq;

      eng.osc.frequency.setTargetAtTime(freq, now, 0.06);
      eng.osc2.frequency.setTargetAtTime(freq * 2, now, 0.06);
      eng.filter.frequency.setTargetAtTime(300 + t * 3200, now, 0.06);

      const idleGain = 0.03;
      const engineGain = this._raceActive ? (idleGain + t * 0.2) : RACE_IDLE_GAIN;
      eng.gain.gain.setTargetAtTime(engineGain * this._volumeSafety(), now, duckTau);
    }

    // 스키드는 합성 여부와 무관하게 항상 동일 로직.
    const drifting = (kart.driftLevel || 0) > 0;
    const skidTarget = drifting
      ? 0.12 + Math.min(kart.driftLevel, 3) * 0.06
      : 0.0001;
    eng.skidFilter.frequency.setTargetAtTime(1400 + t * 1200, now, 0.05);
    eng.skidGain.gain.setTargetAtTime(skidTarget * this._volumeSafety(), now, 0.08);
  }

  _volumeSafety() {
    // master 게인이 이미 볼륨을 적용하므로 채널 게인 자체는 1 취급.
    // (일부 브라우저에서 setTargetAtTime 누적 오차 방지용 안전판만 둠)
    return 1;
  }

  // ---- 효과음 -----------------------------------------------------

  play(name) {
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') {
      // 아직 unlock 전이면 재생 시도는 하되(브라우저가 막으면 조용히 무시됨) resume도 같이 시도
      this.ctx.resume().catch(() => {});
    }

    const sampleBuffer = this._sampleSfx && this._sampleSfx[name];
    if (sampleBuffer) {
      this._playSampleOneShot(sampleBuffer);
      return;
    }

    const fn = this._sfx[name];
    if (fn) fn.call(this); // 미지 이름은 조용히 무시(둘 다 없으면 아무 것도 안 함)
  }

  _playSampleOneShot(buffer, gain = 1) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buffer;

    const g = ctx.createGain();
    g.gain.value = gain;

    src.connect(g);
    g.connect(this.master); // master가 볼륨을 적용 → setVolume과 일관
    src.start(ctx.currentTime);
  }

  get _sfx() {
    return {
      count: () => this._tone({ freq: 440, duration: 0.12, type: 'square', gain: 0.25 }),
      go: () => {
        this._tone({ freq: 660, duration: 0.28, type: 'square', gain: 0.3 });
        this._tone({ freq: 990, duration: 0.22, type: 'square', gain: 0.22, delay: 0.1 });
      },
      pickup: () => this._arpeggio([523.25, 659.25, 783.99], 0.08, 'triangle', 0.22),
      use: () => this._sweep({ from: 900, to: 300, duration: 0.15, type: 'sawtooth', gain: 0.18 }),
      boost: () => {
        this._sweep({ from: 200, to: 1000, duration: 0.4, type: 'sawtooth', gain: 0.28 });
        this._noiseBurst({ duration: 0.35, filterFreq: 2500, gain: 0.15 });
      },
      hit: () => {
        this._thud({ freq: 90, duration: 0.25, gain: 0.35 });
        this._noiseBurst({ duration: 0.2, filterFreq: 900, gain: 0.3 });
      },
      lap: () => this._arpeggio([784, 988, 1175], 0.09, 'sine', 0.22),
      finish: () => this._arpeggio([523.25, 659.25, 783.99, 1046.5], 0.14, 'triangle', 0.26),
      menu: () => this._tone({ freq: 300, duration: 0.06, type: 'sine', gain: 0.15 }),
      results: () => this._arpeggio([659.25, 523.25, 783.99], 0.1, 'triangle', 0.22),
      switch: () => this._tone({ freq: 500, duration: 0.05, type: 'sine', gain: 0.12 }),
    };
  }

  // ---- 저수준 합성 헬퍼 ----------------------------------------------

  _tone({ freq, duration, type = 'sine', gain = 0.2, delay = 0 }) {
    const ctx = this.ctx;
    const start = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.linearRampToValueAtTime(gain, start + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    osc.connect(g);
    g.connect(this.master);
    osc.start(start);
    osc.stop(start + duration + 0.05);
  }

  _sweep({ from, to, duration, type = 'sawtooth', gain = 0.2, delay = 0 }) {
    const ctx = this.ctx;
    const start = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, start);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), start + duration);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.linearRampToValueAtTime(gain, start + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    osc.connect(g);
    g.connect(this.master);
    osc.start(start);
    osc.stop(start + duration + 0.05);
  }

  _thud({ freq, duration, gain = 0.3, delay = 0 }) {
    const ctx = this.ctx;
    const start = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, start);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq * 0.4), start + duration);

    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, start);
    g.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    osc.connect(g);
    g.connect(this.master);
    osc.start(start);
    osc.stop(start + duration + 0.05);
  }

  _arpeggio(freqs, step, type, gain) {
    freqs.forEach((f, idx) => {
      this._tone({ freq: f, duration: step * 1.6, type, gain, delay: idx * step });
    });
  }

  _noiseBurst({ duration = 0.2, filterFreq = 1500, gain = 0.25, delay = 0 }) {
    const ctx = this.ctx;
    const start = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this._noiseBuffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = filterFreq;
    filter.Q.value = 0.8;

    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, start);
    g.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    src.connect(filter);
    filter.connect(g);
    g.connect(this.master);
    src.start(start);
    src.stop(start + duration + 0.05);
  }

  _makeNoiseBuffer(seconds) {
    const ctx = this.ctx;
    const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  // ---- 외부 노출 ------------------------------------------------------

  get context() {
    return this.ctx;
  }
}
