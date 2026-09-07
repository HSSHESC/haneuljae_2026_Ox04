"""
손동작 스티어링 — 웹캠으로 손을 읽어 가상 Xbox 패드로 흘려보낸다.

카메라 1대면 P1만, 2대면 P1/P2를 각각 전담시킨다. 의자가 고정되어 있고 카메라가 한
자리씩 맡으므로 얼굴 인식이나 앵커 추적이 필요 없다 — "이 카메라에 잡히는 손 = 이
플레이어 손". 대신 가로 화각을 좁게 잘라 옆자리나 구경꾼이 프레임에 안 걸리게 한다.

게임(index.html) 쪽은 아무것도 고칠 필요가 없다. 브라우저에는 그냥 실제 컨트롤러로 보인다.

── 조작 ────────────────────────────────────────────────────
  핸들 자세(양손 들기)        가속        RT ON
  핸들 자세를 풀면            감속        RT OFF (스로틀 떼기)
  핸들 기울이기               조향        좌스틱 X
  핸들 자세에서 좌/우로 유지  맵 변경     타이틀에서 1초마다 (게임 쪽에서 처리)
  손 펴기                     아이템 사용 / 결과 화면에서 타이틀로
  손 폈다 쥐었다 2회          레이스 시작 / 재시작

── 준비물 ──────────────────────────────────────────────────
  1) ViGEmBus 드라이버 — pip install vgamepad 이 설치 창을 띄운다
  2) pip install opencv-python mediapipe vgamepad
  3) hand_landmarker.task 를 이 스크립트와 같은 폴더에
       https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task

── 실행 ────────────────────────────────────────────────────
  python hand_steering.py            평소 실행
  python hand_steering.py --list     연결된 카메라 인덱스 훑어보기
  python hand_steering.py --tune     패드로 아무것도 안 보내고 인식 결과만 표시
  python hand_steering.py --selftest 카메라 없이 파이프라인만 점검(패드 생성·송출)
"""

import os
import sys
import math
import time

os.environ["GLOG_minloglevel"] = "2"

import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cv2
import numpy as np
import mediapipe as mp
import vgamepad as vg
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision as mp_vision

# ================= 카메라 ================= #
# 카메라가 1대뿐이면 P2_CAM_INDEX = None 으로 두면 된다 (P1만 동작).
P1_CAM_INDEX = 0
P2_CAM_INDEX = None

CAPTURE_WIDTH = 1280
CAPTURE_HEIGHT = 720

# 가운데에서 가로폭의 이 비율만큼만 남기고 양옆을 잘라낸다.
# 사람 한 명의 상반신과 양손이 딱 들어올 정도로 현장에서 조정할 것.
# 카메라 1대에 한 사람이면 1.0(전체 폭)이 맞다. 두 사람이 나란히 앉을 때만 좁힌다.
CROP_WIDTH_RATIO = 1.0

# 웹캠을 물리적으로 90도 돌려 거치했다면 True (크롭 대신 회전을 쓴다)
CAMERA_IS_PHYSICALLY_ROTATED = False

# ================= 인식 임계값 ================= #
MAX_ANGLE_DEG = 45          # 이 각도에서 조향이 최대치(±1.0)가 된다
FIST_RATIO = 1.0            # 손끝 평균거리 / 손 크기 — 이보다 작으면 쥔 손
OPEN_RATIO = 1.35           # 이보다 크면 편 손 (사이 구간은 직전 상태를 유지 — 떨림 방지)
HANDLE_MAX_Y = 0.80         # 양손 평균 높이가 이보다 아래로 내려가면 핸들을 놓은 것
HANDLE_MIN_GAP = 1.2        # 손목 간격 / 손 크기 — 이보다 좁으면 핸들 자세로 안 봄
HANDLE_MAX_GAP = 12.0       # 이보다 넓어도 핸들 자세로 안 봄
PUMP_WINDOW = 2.0           # 폈다 쥐었다를 이 시간(초) 안에 2회 해야 성립
DETECT_CONFIDENCE = 0.3     # 손 최초 검출 문턱 — 주먹은 팜 디텍터가 놓치기 쉬워 낮게 잡았다
TRACK_CONFIDENCE = 0.3      # 추적 유지 문턱
EDGE_COOLDOWN = 0.45        # 같은 제스처가 다시 발동하기까지 최소 간격(초)

HAND_MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               "hand_landmarker.task")

# ================= 표시 ================= #
VIEW_HEIGHT = 620           # 미리보기 창 높이(px). 화면이 작으면 줄여라.
STREAM_PORT = 8090          # 게임 화면에 손 영상을 띄우기 위한 MJPEG 포트
STREAM_WIDTH = 320          # 게임에 보낼 영상 가로폭(px)
PANEL_WIDTH = 360           # 오른쪽 상태판 폭
BUTTON_FLASH = 0.6          # 눌린 버튼을 화면에 붙잡아 두는 시간(초)


# ================= 제스처 → 패드 버튼 매핑 ================= #
#
# 값은 버튼 이름 하나, 또는 여러 개를 리스트로. None 이면 아무것도 하지 않는다.
#   "A" "B" "X" "Y" "LB" "RB" "START" "BACK"
#   "DPAD_UP" "DPAD_DOWN" "DPAD_LEFT" "DPAD_RIGHT"
#
# 인식되는 제스처:
#   "hands_open"    핸들 자세에서 양손을 폄
#   "double_pump"   핸들 자세에서 폈다 쥐었다 2회 (PUMP_WINDOW 안에)
#   "one_fist"      한 손만 쥠
#   "hands_apart"   양손을 크게 벌림
#   "no_handle"     핸들 자세를 풀었을 때(손을 내리거나 프레임 밖)
#
# 이 게임이 읽는 버튼: A/START=시작·재시작, X 또는 LB=아이템, B=결과에서 타이틀로,
#                      DPAD 상하=타이틀 항목 이동, DPAD 좌우=값 변경, START=일시정지
#
GESTURE_MAP = {
    "hands_open":  ["X", "B"],   # 주행 중엔 아이템, 결과 화면에선 타이틀로
    "double_pump": "A",          # 레이스 시작 / 재시작
    "one_fist":    None,
    "hands_apart": None,
    "no_handle":   None,
}
# =========================================================== #


BUTTONS = {
    "A": vg.XUSB_BUTTON.XUSB_GAMEPAD_A,
    "B": vg.XUSB_BUTTON.XUSB_GAMEPAD_B,
    "X": vg.XUSB_BUTTON.XUSB_GAMEPAD_X,
    "Y": vg.XUSB_BUTTON.XUSB_GAMEPAD_Y,
    "LB": vg.XUSB_BUTTON.XUSB_GAMEPAD_LEFT_SHOULDER,
    "RB": vg.XUSB_BUTTON.XUSB_GAMEPAD_RIGHT_SHOULDER,
    "START": vg.XUSB_BUTTON.XUSB_GAMEPAD_START,
    "BACK": vg.XUSB_BUTTON.XUSB_GAMEPAD_BACK,
    "DPAD_UP": vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_UP,
    "DPAD_DOWN": vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_DOWN,
    "DPAD_LEFT": vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_LEFT,
    "DPAD_RIGHT": vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_RIGHT,
}

GESTURE_NAMES = ("hands_open", "double_pump", "one_fist", "hands_apart", "no_handle")

# ================= 게임 화면용 MJPEG 스트림 ================= #
# 게임(브라우저)이 <img src="http://localhost:8090/p1"> 로 받아 화면 모서리에 띄운다.
# 카메라를 파이썬이 점유하므로 브라우저가 직접 getUserMedia 로 열 수는 없다 — 그래서 중계한다.

_frames = {}                      # "p1" / "p2" → 최신 JPEG 바이트
_frames_lock = threading.Lock()


def publish_frame(key, jpeg_bytes):
    with _frames_lock:
        _frames[key] = jpeg_bytes


class _StreamHandler(BaseHTTPRequestHandler):
    def log_message(self, *a):     # 요청 로그로 콘솔을 더럽히지 않는다
        pass

    def do_GET(self):
        key = self.path.strip("/").lower()
        if key not in ("p1", "p2"):
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
        self.end_headers()
        try:
            while True:
                with _frames_lock:
                    buf = _frames.get(key)
                if buf is not None:
                    self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\n"
                                     b"Content-Length: " + str(len(buf)).encode() + b"\r\n\r\n")
                    self.wfile.write(buf)
                    self.wfile.write(b"\r\n")
                time.sleep(0.05)
        except (BrokenPipeError, ConnectionResetError):
            pass           # 브라우저가 창을 닫으면 정상적으로 끊긴다


def start_stream_server():
    try:
        srv = ThreadingHTTPServer(("127.0.0.1", STREAM_PORT), _StreamHandler)
    except OSError as e:
        print(f"[경고] 스트림 서버를 열지 못했다(포트 {STREAM_PORT}): {e}")
        print("       게임 안 손 영상만 안 뜬다. 조작 자체는 정상 동작한다.")
        return None
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    print(f"손 영상 스트림: http://localhost:{STREAM_PORT}/p1  (게임이 자동으로 받아 간다)")
    return srv


# MediaPipe 손 랜드마크 21개를 잇는 뼈대 — 점만 찍는 것보다 손 모양이 훨씬 잘 읽힌다.
HAND_BONES = (
    (0, 1), (1, 2), (2, 3), (3, 4),            # 엄지
    (0, 5), (5, 6), (6, 7), (7, 8),            # 검지
    (5, 9), (9, 10), (10, 11), (11, 12),       # 중지
    (9, 13), (13, 14), (14, 15), (15, 16),     # 약지
    (13, 17), (17, 18), (18, 19), (19, 20),    # 새끼
    (0, 17),                                   # 손바닥 아래
)


def buttons_for(gesture):
    v = GESTURE_MAP.get(gesture)
    if not v:
        return []
    return [v] if isinstance(v, str) else list(v)


def validate_map():
    bad_g = [g for g in GESTURE_MAP if g not in GESTURE_NAMES]
    if bad_g:
        raise ValueError(f"GESTURE_MAP에 모르는 제스처: {bad_g}\n  쓸 수 있는 것: {list(GESTURE_NAMES)}")
    for g in GESTURE_MAP:
        for b in buttons_for(g):
            if b not in BUTTONS:
                raise ValueError(f"GESTURE_MAP['{g}'] 의 '{b}' 는 모르는 버튼\n  쓸 수 있는 것: {list(BUTTONS)}")


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def list_cameras(max_index=6):
    print("카메라 인덱스 확인 중...\n")
    found = []
    for i in range(max_index):
        cap = cv2.VideoCapture(i, cv2.CAP_DSHOW)
        ok, frame = cap.read()
        if ok and frame is not None:
            h, w = frame.shape[:2]
            print(f"  [{i}] 사용 가능 — {w}x{h}")
            found.append(i)
            cv2.imshow(f"camera {i}  (아무 키나 누르면 다음)", frame)
            cv2.waitKey(0)
            cv2.destroyAllWindows()
        else:
            print(f"  [{i}] 없음")
        cap.release()
    print(f"\n사용 가능한 인덱스: {found}")
    print("스크립트 상단의 P1_CAM_INDEX / P2_CAM_INDEX 를 원하는 번호로 바꾸면 된다.")
    print("카메라가 1대뿐이면 P2_CAM_INDEX = None 으로 두면 P1만 동작한다.")


def make_landmarker():
    if not os.path.exists(HAND_MODEL_PATH):
        raise FileNotFoundError(
            f"손 모델 파일이 없다: {HAND_MODEL_PATH}\n"
            "  https://storage.googleapis.com/mediapipe-models/hand_landmarker/"
            "hand_landmarker/float16/1/hand_landmarker.task"
        )
    # 경로를 넘기지 않고 바이트로 읽어 넘긴다 — MediaPipe의 C++ 파일 로더가 윈도우에서
    # 비ASCII 경로(예: 한글 폴더명)를 못 열어 errno=-1 로 죽는다.
    with open(HAND_MODEL_PATH, "rb") as f:
        model_bytes = f.read()
    options = mp_vision.HandLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_buffer=model_bytes),
        running_mode=mp_vision.RunningMode.VIDEO,
        num_hands=2,
        min_hand_detection_confidence=DETECT_CONFIDENCE,
        min_tracking_confidence=TRACK_CONFIDENCE,
    )
    return mp_vision.HandLandmarker.create_from_options(options)


def hand_span(landmarks, aspect):
    """손 크기(손목→중지 밑마디). 카메라 거리와 무관한 판정을 만드는 기준자."""
    wrist, mcp = landmarks[0], landmarks[9]
    return math.hypot((mcp.x - wrist.x) * aspect, mcp.y - wrist.y)


def openness(landmarks, aspect):
    """손끝 4개의 평균 거리 / 손 크기. 작으면 쥔 손, 크면 편 손."""
    span = hand_span(landmarks, aspect)
    if span < 1e-6:
        return 1.0
    wrist = landmarks[0]
    tips = (8, 12, 16, 20)
    avg = sum(
        math.hypot((landmarks[t].x - wrist.x) * aspect, landmarks[t].y - wrist.y)
        for t in tips
    ) / len(tips)
    return avg / span


class PlayerCam:
    def __init__(self, name, cam_index, gamepad):
        self.name = name
        self.cam_index = cam_index
        self.cap = cv2.VideoCapture(cam_index, cv2.CAP_DSHOW)
        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, CAPTURE_WIDTH)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, CAPTURE_HEIGHT)
        if not self.cap.isOpened():
            raise RuntimeError(f"{name}: 카메라 {cam_index} 를 열 수 없다. --list 로 확인하라.")
        self.landmarker = make_landmarker()
        self.gamepad = gamepad
        self.t0 = time.perf_counter()
        self.last_ts_ms = -1
        self.held = {g: False for g in GESTURE_NAMES}
        self.last_fire = {g: 0.0 for g in GESTURE_NAMES}
        # 폈다-쥐었다 카운터
        self.hands_were_open = False
        self.pump_count = 0
        self.pump_started = 0.0
        # 표시용
        self.fps = 0.0
        self._last_frame_t = time.perf_counter()
        self.recent_buttons = {}   # 버튼명 → 눌린 시각 (BUTTON_FLASH 동안 표시)
        self.full_frame = None     # 크롭 전 원본 (크롭 영역 안내용)

    def reframe(self, frame):
        if CAMERA_IS_PHYSICALLY_ROTATED:
            return cv2.rotate(frame, cv2.ROTATE_90_CLOCKWISE)
        h, w = frame.shape[:2]
        crop_w = max(1, int(w * CROP_WIDTH_RATIO))
        x1 = (w - crop_w) // 2
        return frame[:, x1:x1 + crop_w]

    def detect(self, frame):
        h, w = frame.shape[:2]
        aspect = w / h                       # 정규화 x를 y와 같은 척도로 되돌리는 계수

        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        # 실제 경과 시간을 쓴다(고정 33ms 가정은 카메라 2대를 번갈아 처리할 때 어긋난다).
        ts_ms = int((time.perf_counter() - self.t0) * 1000)
        if ts_ms <= self.last_ts_ms:
            ts_ms = self.last_ts_ms + 1
        self.last_ts_ms = ts_ms
        result = self.landmarker.detect_for_video(mp_image, ts_ms)

        hands = result.hand_landmarks or []
        info = {"hands": hands, "angle": 0.0, "steer": 0.0, "handle": False,
                "open_n": 0, "gap": 0.0, "mid_y": 1.0, "active": set()}

        if len(hands) == 2:
            pair = sorted(hands, key=lambda lm: lm[0].x)   # 화면 왼쪽 손 / 오른쪽 손
            lw, rw = pair[0][0], pair[1][0]

            # 각도는 반드시 픽셀 공간에서 — 정규화 좌표로 계산하면 크롭 비율만큼 왜곡된다
            # (가로 35% 크롭이면 실제 16.7도가 10.6도로 읽혀 조향이 0.63배로 둔해진다).
            dx_px = (rw.x - lw.x) * w
            dy_px = (rw.y - lw.y) * h
            info["angle"] = math.degrees(math.atan2(dy_px, dx_px))

            span = max(hand_span(pair[0], aspect), hand_span(pair[1], aspect), 1e-6)
            info["gap"] = math.hypot((rw.x - lw.x) * aspect, rw.y - lw.y) / span
            info["mid_y"] = (lw.y + rw.y) / 2.0

            # 핸들 자세: 양손이 적당한 간격으로, 너무 낮지 않은 위치에 있을 것
            info["handle"] = (HANDLE_MIN_GAP < info["gap"] < HANDLE_MAX_GAP
                              and info["mid_y"] < HANDLE_MAX_Y)
            if info["handle"]:
                info["steer"] = clamp(info["angle"] / MAX_ANGLE_DEG, -1.0, 1.0)
            if info["gap"] >= HANDLE_MAX_GAP:
                info["active"].add("hands_apart")

            # 편 손 개수 — 히스테리시스로 떨림을 막는다
            info["open_n"] = sum(1 for hl in hands if openness(hl, aspect) > OPEN_RATIO)
            closed_n = sum(1 for hl in hands if openness(hl, aspect) < FIST_RATIO)
            if closed_n == 1 and info["open_n"] == 1:
                info["active"].add("one_fist")

        if not info["handle"]:
            info["active"].add("no_handle")
            return info

        # ── 핸들 자세일 때만 손 펴기/펌프를 본다 ──
        both_open = (info["open_n"] == 2)
        both_closed = (info["open_n"] == 0)
        now = time.perf_counter()

        if both_open:
            info["active"].add("hands_open")

        # 폈다 → 쥐었다 로 넘어가는 순간을 1회로 센다
        if self.hands_were_open and both_closed:
            if self.pump_count == 0 or (now - self.pump_started) > PUMP_WINDOW:
                self.pump_count = 1
                self.pump_started = now
            else:
                self.pump_count += 1
        if both_open:
            self.hands_were_open = True
        elif both_closed:
            self.hands_were_open = False

        if self.pump_count >= 2 and (now - self.pump_started) <= PUMP_WINDOW:
            info["active"].add("double_pump")
            self.pump_count = 0
        elif self.pump_count and (now - self.pump_started) > PUMP_WINDOW:
            self.pump_count = 0

        return info

    def send(self, info, dry_run=False):
        gp = self.gamepad
        now = time.perf_counter()

        fired = []
        pressed = set()
        for g in GESTURE_NAMES:
            on = g in info["active"]
            fire = on and not self.held[g] and (now - self.last_fire[g]) > EDGE_COOLDOWN
            if fire:
                self.last_fire[g] = now
                fired.append(g)
                pressed.update(buttons_for(g))
            self.held[g] = on

        if dry_run:
            return fired

        # 핸들 자세 = 가속. 자세를 풀면 스로틀을 뗀다(= 감속).
        gp.left_joystick_float(x_value_float=info["steer"], y_value_float=0.0)
        gp.right_trigger_float(value_float=1.0 if info["handle"] else 0.0)
        gp.left_trigger_float(value_float=0.0)

        for name, btn in BUTTONS.items():
            if name in pressed:
                gp.press_button(btn)
            else:
                gp.release_button(btn)
        gp.update()
        return fired

    # ── 표시 ───────────────────────────────────────────────
    def _draw_hands(self, frame, info):
        h, w = frame.shape[:2]
        for landmarks in info["hands"]:
            pts = [(int(lm.x * w), int(lm.y * h)) for lm in landmarks]
            for a, b in HAND_BONES:
                cv2.line(frame, pts[a], pts[b], (90, 220, 90), 2)
            for i, (cx, cy) in enumerate(pts):
                # 손목은 크게, 손끝 4개는 노랗게 — 쥐고 편 게 눈에 들어온다
                if i == 0:
                    cv2.circle(frame, (cx, cy), 7, (255, 120, 0), -1)
                elif i in (4, 8, 12, 16, 20):
                    cv2.circle(frame, (cx, cy), 5, (0, 255, 255), -1)
                else:
                    cv2.circle(frame, (cx, cy), 3, (255, 255, 255), -1)
        return frame

    def _panel(self, info, fired, tune, height):
        """오른쪽 상태판을 그린다."""
        p = np.zeros((height, PANEL_WIDTH, 3), dtype=np.uint8)
        p[:] = (28, 28, 32)

        def text(t, y, color=(230, 230, 230), scale=0.5, thick=1, x=12):
            cv2.putText(p, t, (x, y), cv2.FONT_HERSHEY_SIMPLEX, scale, color, thick, cv2.LINE_AA)

        def bar(y, frac, color, h=14, label=""):
            x0, x1 = 12, PANEL_WIDTH - 12
            cv2.rectangle(p, (x0, y), (x1, y + h), (60, 60, 66), -1)
            wpx = int((x1 - x0) * max(0.0, min(1.0, frac)))
            if wpx > 0:
                cv2.rectangle(p, (x0, y), (x0 + wpx, y + h), color, -1)
            if label:
                text(label, y + h - 2, (200, 200, 200), 0.42, 1, x1 - 52)

        y = 30
        text(f"{self.name}{'   [TUNE]' if tune else ''}", y, (120, 230, 255), 0.75, 2); y += 12
        text(f"{self.fps:4.1f} fps", y, (140, 140, 150), 0.45, 1, PANEL_WIDTH - 78)
        y += 26

        # 손 검출 상태 — 제일 궁금한 것
        n = len(info["hands"])
        if n == 0:
            text("NO HANDS", y, (80, 80, 255), 0.8, 2)
        elif n == 1:
            text("1 HAND (need 2)", y, (0, 165, 255), 0.62, 2)
        else:
            text("2 HANDS", y, (120, 255, 120), 0.8, 2)
        y += 30

        # 핸들 자세 = 가속
        if info["handle"]:
            cv2.rectangle(p, (10, y - 18), (PANEL_WIDTH - 10, y + 8), (0, 110, 0), -1)
            text("HANDLE  ->  ACCEL", y, (180, 255, 180), 0.62, 2)
        else:
            cv2.rectangle(p, (10, y - 18), (PANEL_WIDTH - 10, y + 8), (0, 60, 110), -1)
            text("NO HANDLE -> COAST", y, (180, 220, 255), 0.58, 2)
        y += 34

        # 조향 바 (가운데가 0)
        text("STEER", y, (170, 170, 180), 0.45); y += 8
        x0, x1 = 12, PANEL_WIDTH - 12
        mid = (x0 + x1) // 2
        cv2.rectangle(p, (x0, y), (x1, y + 18), (60, 60, 66), -1)
        sv = info["steer"]
        if abs(sv) > 0.01:
            xa, xb = (mid, mid + int((x1 - mid) * sv)) if sv > 0 else (mid + int((mid - x0) * sv), mid)
            cv2.rectangle(p, (min(xa, xb), y), (max(xa, xb), y + 18), (0, 200, 255), -1)
        cv2.line(p, (mid, y - 3), (mid, y + 21), (200, 200, 200), 1)
        text(f"{sv:+.2f}", y + 14, (255, 255, 255), 0.45, 1, x1 - 46)
        y += 32
        text(f"angle {info['angle']:+6.1f} deg", y, (170, 170, 180), 0.45); y += 22

        # 손 상태 수치
        text(f"open {info['open_n']}/2   gap {info['gap']:.2f}   y {info['mid_y']:.2f}", y,
             (170, 170, 180), 0.45)
        y += 22
        bar(y, self.pump_count / 2.0, (255, 180, 0), 12, f"pump {self.pump_count}/2")
        y += 30

        # 제스처 목록
        text("GESTURES", y, (150, 150, 160), 0.45); y += 20
        for g in GESTURE_NAMES:
            on = g in info["active"]
            btns = buttons_for(g)
            if g in fired:
                col, mark = (0, 220, 255), ">"
            elif on:
                col, mark = (255, 255, 255), "*"
            else:
                col, mark = (100, 100, 106), " "
            text(f"{mark} {g:<12} {'+'.join(btns) if btns else '-'}", y, col, 0.45)
            y += 20

        # 방금 눌린 버튼 — 크게
        y += 8
        text("BUTTON", y, (150, 150, 160), 0.45); y += 26
        now = time.perf_counter()
        live = [b for b, t in self.recent_buttons.items() if now - t < BUTTON_FLASH]
        if live:
            cv2.rectangle(p, (10, y - 22), (PANEL_WIDTH - 10, y + 10), (0, 140, 200), -1)
            text("  ".join(live), y, (255, 255, 255), 0.9, 2)
        else:
            text("-", y, (100, 100, 106), 0.6)
        return p

    def _thumb(self, panel):
        """크롭 전 원본을 작게 붙이고 크롭 영역을 표시한다 — 프레임 안에 있는지 확인용."""
        if self.full_frame is None or CAMERA_IS_PHYSICALLY_ROTATED:
            return panel
        fh, fw = self.full_frame.shape[:2]
        tw = PANEL_WIDTH - 24
        th = max(1, int(tw * fh / fw))
        thumb = cv2.resize(self.full_frame, (tw, th))
        crop_w = int(tw * CROP_WIDTH_RATIO)
        x1 = (tw - crop_w) // 2
        cv2.rectangle(thumb, (x1, 0), (x1 + crop_w, th - 1), (0, 220, 255), 2)
        cv2.putText(thumb, "in-frame area", (x1 + 4, 16), cv2.FONT_HERSHEY_SIMPLEX,
                    0.4, (0, 220, 255), 1, cv2.LINE_AA)
        ph = panel.shape[0]
        y0 = ph - th - 12
        if y0 > 0:
            panel[y0:y0 + th, 12:12 + tw] = thumb
        return panel

    def compose(self, frame, info, fired, tune):
        frame = self._draw_hands(frame, info)
        fh, fw = frame.shape[:2]
        scale = VIEW_HEIGHT / fh
        view = cv2.resize(frame, (max(1, int(fw * scale)), VIEW_HEIGHT))
        panel = self._panel(info, fired, tune, VIEW_HEIGHT)
        panel = self._thumb(panel)
        return np.hstack([view, panel])

    def step(self, tune):
        ok, frame = self.cap.read()
        if not ok or frame is None:
            return None
        now = time.perf_counter()
        dt = now - self._last_frame_t
        self._last_frame_t = now
        if dt > 0:
            self.fps = self.fps * 0.8 + (1.0 / dt) * 0.2 if self.fps else 1.0 / dt

        frame = cv2.flip(frame, 1)          # 거울 모드 — 오른손을 들면 화면 오른쪽
        self.full_frame = frame.copy()
        frame = self.reframe(frame)
        info = self.detect(frame)
        fired = self.send(info, dry_run=tune)
        for g in fired:
            for b in buttons_for(g):
                self.recent_buttons[b] = now

        self._publish(frame, info)
        return self.compose(frame, info, fired, tune)

    def _publish(self, frame, info):
        """게임 화면에 띄울 작은 영상을 만들어 스트림에 올린다."""
        fh, fw = frame.shape[:2]
        scale = STREAM_WIDTH / fw
        small = cv2.resize(frame, (STREAM_WIDTH, max(1, int(fh * scale))))
        n = len(info["hands"])
        if info["handle"]:
            label, color = "ACCEL", (120, 255, 120)
        elif n == 0:
            label, color = "NO HANDS", (80, 80, 255)
        elif n == 1:
            label, color = "1 HAND", (0, 165, 255)
        else:
            label, color = "COAST", (180, 220, 255)
        h2 = small.shape[0]
        cv2.rectangle(small, (0, h2 - 26), (STREAM_WIDTH, h2), (20, 20, 24), -1)
        cv2.putText(small, f"{self.name}  {label}", (8, h2 - 8),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1, cv2.LINE_AA)
        if abs(info["steer"]) > 0.01:   # 조향 막대
            mid = STREAM_WIDTH // 2
            x = mid + int((STREAM_WIDTH // 2 - 8) * info["steer"])
            cv2.line(small, (mid, h2 - 30), (x, h2 - 30), (0, 200, 255), 3)
        ok, enc = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 70])
        if ok:
            publish_frame(self.name.lower(), enc.tobytes())

    def release(self):
        self.gamepad.reset()
        self.gamepad.update()
        self.cap.release()


def selftest():
    """카메라 없이 파이프라인만 점검한다 — 렌즈에 캡을 씌워둔 상태에서도 확인 가능."""
    validate_map()
    print("[1/3] 모델 파일 확인")
    make_landmarker()
    print("      OK")
    print("[2/3] 가상 패드 생성 및 송출")
    gp = vg.VX360Gamepad()
    for i in range(30):
        gp.left_joystick_float(x_value_float=math.sin(i / 5) * 0.8, y_value_float=0.0)
        gp.right_trigger_float(value_float=1.0)
        if i % 15 == 0:
            gp.press_button(BUTTONS["A"])
        else:
            gp.release_button(BUTTONS["A"])
        gp.update()
        time.sleep(0.05)
    gp.reset()
    gp.update()
    print("      OK — 브라우저가 이 패드를 컨트롤러로 인식한다")
    print("[3/3] 매핑")
    for g in GESTURE_NAMES:
        b = buttons_for(g)
        print(f"      {g:<13} → {'+'.join(b) if b else '-'}")
    print("\n자체 점검 통과. 렌즈 캡을 벗기고 그냥 실행하면 된다.")


def main(tune=False):
    validate_map()
    cams = [("P1", P1_CAM_INDEX)]
    if P2_CAM_INDEX is not None:
        cams.append(("P2", P2_CAM_INDEX))
    print(f"카메라 {len(cams)}대 사용: " + ", ".join(f"{n}=#{i}" for n, i in cams))
    start_stream_server()

    players = []
    try:
        for name, idx in cams:
            players.append(PlayerCam(name, idx, vg.VX360Gamepad()))
        print("준비 완료. 게임 창을 클릭해 포커스를 준 뒤 핸들 자세를 잡아라. 종료는 q.")
        while True:
            for p in players:
                f = p.step(tune)
                if f is not None:
                    cv2.imshow(f"{p.name} Camera", f)
            if cv2.waitKey(1) & 0xFF == ord("q"):
                break
    finally:
        for p in players:
            p.release()
        cv2.destroyAllWindows()


if __name__ == "__main__":
    try:
        if "--list" in sys.argv:
            list_cameras()
        elif "--selftest" in sys.argv:
            selftest()
        else:
            main(tune="--tune" in sys.argv)
    except Exception:
        import traceback
        traceback.print_exc()
        input("\n에러가 발생했다. 위 내용을 확인한 뒤 Enter를 누르면 창이 닫힌다...")
