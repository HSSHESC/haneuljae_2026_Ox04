"""
손동작 스티어링 — 웹캠 2대 분리 방식 (P1 전용 캠 / P2 전용 캠)

의자가 고정되어 있고 각 웹캠이 한 자리씩 전담하므로, 얼굴 인식이나 앵커 추적 없이
"이 카메라에 잡히는 손 = 이 플레이어 손"으로 바로 처리한다. 대신 가로 화각을 좁게
잘라(세로로 긴 비율) 옆자리나 구경꾼이 애초에 프레임에 안 걸리게 한다.

가상 Xbox 360 패드 2개를 만들어 브라우저 Gamepad API로 흘려보내므로,
게임(index.html) 쪽은 아무것도 고칠 필요가 없다. 그냥 실제 컨트롤러로 보인다.

── 고정 동작 (축 입력) ─────────────────────────────────────
  양손을 핸들처럼 들고 기울이기   조향     (좌스틱 X)
  기본 상태                       가속     (RT 항상 ON)
  양손 다 주먹                    브레이크 (LT)

── 나머지 제스처는 아래 GESTURE_MAP 에서 직접 지정한다 ─────
  기본값은 전부 미지정(None)이다.

── 준비물 ──────────────────────────────────────────────────
  1) ViGEmBus 드라이버 (vgamepad가 요구하는 커널 드라이버 — 없으면 실행 즉시 실패)
       https://github.com/nefarius/ViGEmBus/releases  →  ViGEmBus_x64_*.exe 설치 후 재부팅
  2) pip install opencv-python mediapipe vgamepad
  3) hand_landmarker.task 를 이 스크립트와 같은 폴더에
       https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task

── 실행 ────────────────────────────────────────────────────
  python hand_steering.py            평소 실행
  python hand_steering.py --list     연결된 카메라 인덱스 훑어보기 (번호가 꼬였을 때)
  python hand_steering.py --tune     제스처만 화면에 띄우고 패드로는 아무것도 안 보냄
                                     (임계값 맞출 때. 게임에 영향 없이 인식만 확인)
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

# ================= 카메라 / 인식 설정 ================= #
P1_CAM_INDEX = 0
P2_CAM_INDEX = 1

CAPTURE_WIDTH = 1280
CAPTURE_HEIGHT = 720

# 가운데에서 가로폭의 이 비율만큼만 남기고 양옆을 잘라낸다.
# 사람 한 명의 상반신과 양손이 딱 들어올 정도로 현장에서 조정할 것.
CROP_WIDTH_RATIO = 0.35

# 웹캠을 물리적으로 90도 돌려 거치했다면 True (크롭 대신 회전을 쓴다)
CAMERA_IS_PHYSICALLY_ROTATED = False

MAX_ANGLE_DEG = 45          # 이 각도에서 조향이 최대치(±1.0)가 된다
FIST_RATIO = 1.0            # 손끝 평균거리 / 손 크기 — 이 값보다 작으면 주먹
TOGETHER_RATIO = 1.6        # 손목 간격 / 손 크기 — 이 값보다 좁으면 "모으기"
APART_RATIO = 5.0           # 손목 간격 / 손 크기 — 이 값보다 넓으면 "벌리기"
HAND_Y_DEADZONE = 0.12      # 양손 평균 높이가 화면 중앙에서 이만큼 벗어나야 위/아래로 침
EDGE_COOLDOWN = 0.45        # 같은 제스처가 다시 발동하기까지 최소 간격(초)

HAND_MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               "hand_landmarker.task")


# ================= 제스처 → 패드 버튼 매핑 ================= #
#
# 왼쪽이 인식되는 제스처, 오른쪽이 그때 눌러 줄 패드 버튼이다. 원하는 대로 바꿔 쓰면 된다.
# None 이면 그 제스처는 아무것도 하지 않는다.
#
#   쓸 수 있는 값:
#     None
#     "A"  "B"  "X"  "Y"  "LB"  "RB"  "START"  "BACK"
#     "DPAD_UP"  "DPAD_DOWN"  "DPAD_LEFT"  "DPAD_RIGHT"
#
#   인식되는 제스처:
#     "one_fist"         한 손만 주먹 (양손 주먹은 브레이크라 제외된다)
#     "hands_together"   양손을 가운데로 모으기
#     "hands_apart"      양손을 크게 벌리기
#     "both_hands_up"    양손을 같이 위로
#     "both_hands_down"  양손을 같이 아래로
#     "no_hands"         손이 하나도 안 잡힘
#
# 참고 — 이 게임이 실제로 읽는 버튼:
#     A 또는 START = 레이스 시작 / 결과 화면에서 재시작·확인
#     X 또는 LB    = 아이템 사용
#     B            = 결과 화면에서 타이틀로 돌아가기
#     DPAD 상하    = 타이틀에서 항목 이동 (맵 / 모드)
#     DPAD 좌우    = 그 항목의 값 변경
#     START        = 레이스 중 일시정지
#   전부 None 으로 두면 손으로는 레이스를 시작할 수 없다. 최소한 A 하나는 지정해야 한다.
#
GESTURE_MAP = {
    "one_fist":        None,
    "hands_together":  None,
    "hands_apart":     None,
    "both_hands_up":   None,
    "both_hands_down": None,
    "no_hands":        None,
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

GESTURE_NAMES = ("one_fist", "hands_together", "hands_apart",
                 "both_hands_up", "both_hands_down", "no_hands")


def validate_map():
    bad_g = [g for g in GESTURE_MAP if g not in GESTURE_NAMES]
    bad_b = [(g, b) for g, b in GESTURE_MAP.items() if b is not None and b not in BUTTONS]
    if bad_g:
        raise ValueError(f"GESTURE_MAP에 모르는 제스처 이름: {bad_g}\n  쓸 수 있는 것: {list(GESTURE_NAMES)}")
    if bad_b:
        raise ValueError(f"GESTURE_MAP에 모르는 버튼 이름: {bad_b}\n  쓸 수 있는 것: {list(BUTTONS)}")


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def list_cameras(max_index=6):
    """어떤 인덱스에 카메라가 붙어 있는지 훑어본다."""
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
    print("이 스크립트 상단의 P1_CAM_INDEX / P2_CAM_INDEX 를 원하는 번호로 바꾸면 된다.")


def make_landmarker():
    if not os.path.exists(HAND_MODEL_PATH):
        raise FileNotFoundError(
            f"손 모델 파일이 없다: {HAND_MODEL_PATH}\n"
            "  https://storage.googleapis.com/mediapipe-models/hand_landmarker/"
            "hand_landmarker/float16/1/hand_landmarker.task\n"
            "  위 파일을 받아 이 스크립트와 같은 폴더에 두어라."
        )
    options = mp_vision.HandLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=HAND_MODEL_PATH),
        running_mode=mp_vision.RunningMode.VIDEO,
        num_hands=2,                      # 이 캠은 한 사람만 보므로 양손 2개면 충분
        min_hand_detection_confidence=0.6,
        min_tracking_confidence=0.6,
    )
    return mp_vision.HandLandmarker.create_from_options(options)


def hand_span(landmarks, aspect):
    """손 크기(손목→중지 밑마디). 카메라 거리와 무관한 판정을 만드는 기준자."""
    wrist, mcp = landmarks[0], landmarks[9]
    return math.hypot((mcp.x - wrist.x) * aspect, mcp.y - wrist.y)


def is_fist(landmarks, aspect):
    """손끝 4개의 평균 거리를 손 크기로 나눠 판정 — 멀리 있어도 같은 기준이 된다."""
    span = hand_span(landmarks, aspect)
    if span < 1e-6:
        return False
    wrist = landmarks[0]
    tips = (8, 12, 16, 20)
    avg = sum(
        math.hypot((landmarks[t].x - wrist.x) * aspect, landmarks[t].y - wrist.y)
        for t in tips
    ) / len(tips)
    return (avg / span) < FIST_RATIO


class PlayerCam:
    def __init__(self, name, cam_index, gamepad):
        self.name = name
        self.cam_index = cam_index
        self.cap = cv2.VideoCapture(cam_index, cv2.CAP_DSHOW)
        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, CAPTURE_WIDTH)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, CAPTURE_HEIGHT)
        if not self.cap.isOpened():
            raise RuntimeError(f"{name}: 카메라 {cam_index} 를 열 수 없다. --list 로 인덱스를 확인하라.")
        self.landmarker = make_landmarker()
        self.gamepad = gamepad
        self.t0 = time.perf_counter()
        self.last_ts_ms = -1
        self.held = {g: False for g in GESTURE_NAMES}   # 제스처별 엣지 상태
        self.last_fire = {g: 0.0 for g in GESTURE_NAMES}

    def reframe(self, frame):
        """가로를 좁게 잘라 세로로 긴 프레임으로 (물리적으로 돌려 거치했으면 회전만)."""
        if CAMERA_IS_PHYSICALLY_ROTATED:
            return cv2.rotate(frame, cv2.ROTATE_90_CLOCKWISE)
        h, w = frame.shape[:2]
        crop_w = max(1, int(w * CROP_WIDTH_RATIO))
        x1 = (w - crop_w) // 2
        return frame[:, x1:x1 + crop_w]

    def detect(self, frame):
        """프레임 하나에서 조향값·브레이크·제스처 집합을 뽑는다."""
        h, w = frame.shape[:2]
        aspect = w / h                       # 정규화 x를 y와 같은 척도로 되돌리는 계수

        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        # 실제 경과 시간을 쓴다(고정 33ms 가정은 카메라 2대를 번갈아 처리할 때 어긋난다).
        ts_ms = int((time.perf_counter() - self.t0) * 1000)
        if ts_ms <= self.last_ts_ms:         # VIDEO 모드는 단조 증가를 요구한다
            ts_ms = self.last_ts_ms + 1
        self.last_ts_ms = ts_ms
        result = self.landmarker.detect_for_video(mp_image, ts_ms)

        hands = result.hand_landmarks or []
        info = {"hands": hands, "angle": 0.0, "steer": 0.0, "fists": 0,
                "gap_ratio": 0.0, "mid_y": 0.5, "active": set()}

        if not hands:
            info["active"].add("no_hands")
            return info

        info["fists"] = sum(1 for hl in hands if is_fist(hl, aspect))

        if len(hands) == 2:
            pair = sorted(hands, key=lambda lm: lm[0].x)   # 화면 왼쪽 손 / 오른쪽 손
            lw, rw = pair[0][0], pair[1][0]

            # 각도는 반드시 픽셀 공간에서 — 정규화 좌표로 계산하면 크롭 비율만큼 왜곡된다
            # (가로 35% 크롭이면 실제 16.7도가 10.6도로 읽혀 조향이 0.63배로 둔해진다).
            dx_px = (rw.x - lw.x) * w
            dy_px = (rw.y - lw.y) * h
            info["angle"] = math.degrees(math.atan2(dy_px, dx_px))
            info["steer"] = clamp(info["angle"] / MAX_ANGLE_DEG, -1.0, 1.0)

            span = max(hand_span(pair[0], aspect), hand_span(pair[1], aspect), 1e-6)
            gap = math.hypot((rw.x - lw.x) * aspect, rw.y - lw.y)
            info["gap_ratio"] = gap / span
            if info["gap_ratio"] < TOGETHER_RATIO:
                info["active"].add("hands_together")
            elif info["gap_ratio"] > APART_RATIO:
                info["active"].add("hands_apart")

            info["mid_y"] = (lw.y + rw.y) / 2.0
            off = info["mid_y"] - 0.5
            if off < -HAND_Y_DEADZONE:
                info["active"].add("both_hands_up")
            elif off > HAND_Y_DEADZONE:
                info["active"].add("both_hands_down")

        if info["fists"] == 1:
            info["active"].add("one_fist")

        return info

    def send(self, info):
        """감지 결과를 가상 패드로 흘려보낸다."""
        gp = self.gamepad
        braking = (info["fists"] == 2)
        gp.left_joystick_float(x_value_float=info["steer"], y_value_float=0.0)
        gp.left_trigger_float(value_float=1.0 if braking else 0.0)
        gp.right_trigger_float(value_float=0.0 if braking else 1.0)

        now = time.perf_counter()
        fired = []
        for g in GESTURE_NAMES:
            btn = GESTURE_MAP.get(g)
            on = g in info["active"]
            # 누르기 시작한 프레임에만 1회 (게임이 엣지로 읽는다)
            fire = on and not self.held[g] and (now - self.last_fire[g]) > EDGE_COOLDOWN
            if fire:
                self.last_fire[g] = now
                fired.append(g)
            self.held[g] = on
            if btn:
                if fire:
                    gp.press_button(BUTTONS[btn])
                else:
                    gp.release_button(BUTTONS[btn])
        gp.update()
        return fired

    def draw(self, frame, info, fired, tune):
        h, w = frame.shape[:2]
        for landmarks in info["hands"]:
            for lm in landmarks:
                cv2.circle(frame, (int(lm.x * w), int(lm.y * h)), 4, (255, 255, 0), -1)

        def put(text, y, color=(0, 255, 0), scale=0.62):
            cv2.putText(frame, text, (10, y), cv2.FONT_HERSHEY_SIMPLEX, scale, color, 2)

        put(self.name + ("  [TUNE]" if tune else ""), 32, (0, 255, 0), 0.95)
        put(f"angle {info['angle']:+6.1f}   steer {info['steer']:+.2f}", 62)
        put(f"hands {len(info['hands'])}  fists {info['fists']}  gap {info['gap_ratio']:.2f}", 88)
        if info["fists"] == 2:
            put("BRAKE", 116, (0, 0, 255), 0.8)

        y = 148
        for g in GESTURE_NAMES:
            on = g in info["active"]
            btn = GESTURE_MAP.get(g)
            label = f"{g:<16} {btn or '-'}"
            color = (0, 220, 255) if g in fired else ((255, 255, 255) if on else (110, 110, 110))
            put(label, y, color, 0.55)
            y += 24
        return frame

    def step(self, tune):
        ok, frame = self.cap.read()
        if not ok or frame is None:
            return None
        frame = cv2.flip(frame, 1)          # 거울 모드 — 오른손을 들면 화면 오른쪽
        frame = self.reframe(frame)
        info = self.detect(frame)
        fired = [] if tune else self.send(info)
        if tune:  # 인식만 하고 패드로는 아무것도 안 보낸다
            now = time.perf_counter()
            for g in GESTURE_NAMES:
                on = g in info["active"]
                if on and not self.held[g] and (now - self.last_fire[g]) > EDGE_COOLDOWN:
                    self.last_fire[g] = now
                    fired.append(g)
                self.held[g] = on
        return self.draw(frame, info, fired, tune)

    def release(self):
        self.gamepad.reset()
        self.gamepad.update()
        self.cap.release()


def main(tune=False):
    validate_map()
    if not tune and not any(GESTURE_MAP.values()):
        print("\n[알림] GESTURE_MAP이 전부 비어 있다 — 조향·가속·브레이크만 동작한다.")
        print("       레이스를 시작하려면 어떤 제스처든 \"A\" 또는 \"START\"에 지정해야 한다.")
        print("       (또는 키보드 Enter로 시작해도 된다.)\n")

    print("가상 패드 2개 생성 중... (ViGEmBus 드라이버가 없으면 여기서 실패한다)")
    p1 = PlayerCam("P1", P1_CAM_INDEX, vg.VX360Gamepad())
    p2 = PlayerCam("P2", P2_CAM_INDEX, vg.VX360Gamepad())
    print("준비 완료. 게임 창을 클릭해 포커스를 준 뒤 손을 들어라. 종료는 q.")

    try:
        while True:
            f1 = p1.step(tune)
            f2 = p2.step(tune)
            if f1 is not None:
                cv2.imshow("P1 Camera", f1)
            if f2 is not None:
                cv2.imshow("P2 Camera", f2)
            if cv2.waitKey(1) & 0xFF == ord("q"):
                break
    finally:
        p1.release()
        p2.release()
        cv2.destroyAllWindows()


if __name__ == "__main__":
    try:
        if "--list" in sys.argv:
            list_cameras()
        else:
            main(tune="--tune" in sys.argv)
    except Exception:
        import traceback
        traceback.print_exc()
        input("\n에러가 발생했다. 위 내용을 확인한 뒤 Enter를 누르면 창이 닫힌다...")
