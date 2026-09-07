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

import cv2
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
CROP_WIDTH_RATIO = 0.35

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
EDGE_COOLDOWN = 0.45        # 같은 제스처가 다시 발동하기까지 최소 간격(초)

HAND_MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               "hand_landmarker.task")


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
        min_hand_detection_confidence=0.6,
        min_tracking_confidence=0.6,
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

    def draw(self, frame, info, fired, tune):
        h, w = frame.shape[:2]
        for landmarks in info["hands"]:
            for lm in landmarks:
                cv2.circle(frame, (int(lm.x * w), int(lm.y * h)), 4, (255, 255, 0), -1)

        def put(text, y, color=(0, 255, 0), scale=0.6):
            cv2.putText(frame, text, (10, y), cv2.FONT_HERSHEY_SIMPLEX, scale, color, 2)

        put(self.name + ("  [TUNE]" if tune else ""), 30, (0, 255, 0), 0.9)
        put("HANDLE / accel" if info["handle"] else "no handle / coast", 58,
            (0, 255, 0) if info["handle"] else (0, 165, 255), 0.7)
        put(f"angle {info['angle']:+6.1f}  steer {info['steer']:+.2f}", 84)
        put(f"hands {len(info['hands'])}  open {info['open_n']}  gap {info['gap']:.2f}", 108)
        put(f"pump {self.pump_count}/2", 132, (200, 200, 255))

        y = 162
        for g in GESTURE_NAMES:
            on = g in info["active"]
            btns = buttons_for(g)
            color = (0, 220, 255) if g in fired else ((255, 255, 255) if on else (110, 110, 110))
            put(f"{g:<13} {'+'.join(btns) if btns else '-'}", y, color, 0.52)
            y += 22
        return frame

    def step(self, tune):
        ok, frame = self.cap.read()
        if not ok or frame is None:
            return None
        frame = cv2.flip(frame, 1)          # 거울 모드 — 오른손을 들면 화면 오른쪽
        frame = self.reframe(frame)
        info = self.detect(frame)
        fired = self.send(info, dry_run=tune)
        return self.draw(frame, info, fired, tune)

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
