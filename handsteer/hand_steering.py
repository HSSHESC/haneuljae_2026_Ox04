"""
손동작 스티어링 — 웹캠 2대 분리 방식 (P1 전용 캠 / P2 전용 캠)

의자가 고정되어 있고 각 웹캠이 한 자리씩 전담하므로, 얼굴 인식이나 앵커 추적 없이
"이 카메라에 잡히는 손 = 이 플레이어 손"으로 바로 처리한다. 대신 가로 화각을 좁게
잘라(세로로 긴 비율) 옆자리나 구경꾼이 애초에 프레임에 안 걸리게 한다.

가상 Xbox 360 패드 2개를 만들어 브라우저 Gamepad API로 흘려보내므로,
게임(index.html) 쪽은 아무것도 고칠 필요가 없다. 그냥 실제 컨트롤러로 보인다.

── 제스처 ──────────────────────────────────────────────────
  양손을 핸들처럼 들고 기울이기   조향        (좌스틱 X)
  기본 상태                       가속        (RT 항상 ON)
  양손 다 주먹                    브레이크    (LT)
  한 손만 주먹                    아이템 사용 (X 버튼, 누를 때 1회)
  양손을 가운데로 모으기          시작/확인   (A 버튼, 누를 때 1회)
  양손을 같이 위/아래로           메뉴 위/아래(좌스틱 Y — 타이틀에서 항목 이동)

  ※ 시작·아이템 제스처가 없으면 손만으로는 레이스를 시작할 수도, 아이템을 쓸 수도 없다.
     게임의 패드 매핑이 A/Start=시작, X 또는 LB=아이템이기 때문이다.

── 준비물 ──────────────────────────────────────────────────
  1) ViGEmBus 드라이버 (vgamepad가 요구하는 커널 드라이버 — 이거 없으면 실행 즉시 실패)
       https://github.com/nefarius/ViGEmBus/releases  →  ViGEmBus_x64_*.exe 설치 후 재부팅
  2) pip install opencv-python mediapipe vgamepad
  3) hand_landmarker.task 를 이 스크립트와 같은 폴더에
       https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task

── 실행 ────────────────────────────────────────────────────
  python hand_steering.py            평소 실행
  python hand_steering.py --list     연결된 카메라 인덱스 훑어보기 (번호가 꼬였을 때)
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

# ================= 설정값 ================= #
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
FIST_RATIO = 0.45           # 손가락 끝 평균거리 / 손 크기 — 이 값보다 작으면 주먹
CONFIRM_RATIO = 0.55        # 손목 간격 / 어깨너비 추정치 — 이보다 좁으면 "모으기"
MENU_Y_DEADZONE = 0.12      # 양손 평균 높이가 중앙에서 이만큼 벗어나야 메뉴 위/아래
EDGE_COOLDOWN = 0.45        # 아이템·확인 제스처 재발동까지 최소 간격(초)

HAND_MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               "hand_landmarker.task")
# ========================================== #


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
    """손 크기(손목→중지 밑마디 거리). 주먹 판정을 카메라 거리와 무관하게 만드는 기준자."""
    wrist, mcp = landmarks[0], landmarks[9]
    return math.hypot((mcp.x - wrist.x) * aspect, mcp.y - wrist.y)


def is_fist(landmarks, aspect):
    """손끝 4개의 평균 거리를 손 크기로 나눠 판정 — 멀리 있어도 같은 기준이 된다.

    원본은 정규화 좌표 거리를 고정 임계값과 비교했는데, 그러면 (1) 카메라에서 멀어질수록
    주먹으로 오판하고 (2) 가로를 좁게 크롭한 프레임에서는 x가 y보다 과장돼 판정이 틀어진다.
    """
    span = hand_span(landmarks, aspect)
    if span < 1e-6:
        return False
    wrist = landmarks[0]
    tips = (8, 12, 16, 20)
    avg = sum(
        math.hypot((landmarks[t].x - wrist.x) * aspect, landmarks[t].y - wrist.y)
        for t in tips
    ) / len(tips)
    return (avg / span) < FIST_RATIO * 2.2


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
        # 제스처 엣지 상태
        self.item_held = False
        self.item_last = 0.0
        self.confirm_held = False
        self.confirm_last = 0.0

    def reframe(self, frame):
        """가로를 좁게 잘라 세로로 긴 프레임으로 (물리적으로 돌려 거치했으면 회전만)."""
        if CAMERA_IS_PHYSICALLY_ROTATED:
            return cv2.rotate(frame, cv2.ROTATE_90_CLOCKWISE)
        h, w = frame.shape[:2]
        crop_w = max(1, int(w * CROP_WIDTH_RATIO))
        x1 = (w - crop_w) // 2
        return frame[:, x1:x1 + crop_w]

    def process(self):
        ok, frame = self.cap.read()
        if not ok or frame is None:
            return None

        frame = cv2.flip(frame, 1)          # 거울 모드 — 오른손을 들면 화면 오른쪽
        frame = self.reframe(frame)
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

        steer = 0.0
        menu_y = 0.0
        angle_deg = 0.0
        fists = 0
        hands = result.hand_landmarks or []
        confirm_now = False

        if len(hands) == 2:
            # 화면 왼쪽 손 / 오른쪽 손으로 나눈다
            pair = sorted(hands, key=lambda lm: lm[0].x)
            lw, rw = pair[0][0], pair[1][0]

            # 각도는 반드시 픽셀 공간에서 — 정규화 좌표로 계산하면 크롭 비율만큼 왜곡된다
            # (가로 35% 크롭이면 실제 16.7도가 10.6도로 읽혀 조향이 0.63배로 둔해진다).
            dx_px = (rw.x - lw.x) * w
            dy_px = (rw.y - lw.y) * h
            angle_deg = math.degrees(math.atan2(dy_px, dx_px))
            steer = clamp(angle_deg / MAX_ANGLE_DEG, -1.0, 1.0)

            fists = sum(1 for hl in hands if is_fist(hl, aspect))

            # 양손 모으기 = 확인/시작. 손 크기를 기준자로 삼아 거리와 무관하게 판정한다.
            span = max(hand_span(pair[0], aspect), hand_span(pair[1], aspect), 1e-6)
            wrist_gap = math.hypot((rw.x - lw.x) * aspect, rw.y - lw.y)
            confirm_now = (wrist_gap / span) < (CONFIRM_RATIO * 3.0)

            # 양손 평균 높이 → 메뉴 위/아래 (타이틀에서 항목 이동. 주행 중에는 무시된다)
            mid_y = (lw.y + rw.y) / 2.0
            off = mid_y - 0.5
            if abs(off) > MENU_Y_DEADZONE:
                menu_y = clamp(-off * 3.0, -1.0, 1.0)   # 화면 위 = 스틱 위(+)

        now = time.perf_counter()

        # ── 아이템: 한 손만 주먹일 때 1회 (양손 주먹은 브레이크라 제외) ──
        item_now = (fists == 1)
        item_fire = False
        if item_now and not self.item_held and (now - self.item_last) > EDGE_COOLDOWN:
            item_fire = True
            self.item_last = now
        self.item_held = item_now

        # ── 확인/시작: 손 모으기 1회 ──
        confirm_fire = False
        if confirm_now and not self.confirm_held and (now - self.confirm_last) > EDGE_COOLDOWN:
            confirm_fire = True
            self.confirm_last = now
        self.confirm_held = confirm_now

        # ── 가상 패드로 송출 ──
        gp = self.gamepad
        gp.left_joystick_float(x_value_float=steer, y_value_float=menu_y)

        braking = (fists == 2)
        gp.left_trigger_float(value_float=1.0 if braking else 0.0)
        gp.right_trigger_float(value_float=0.0 if braking else 1.0)

        # X = 아이템, A = 시작/확인. 누른 프레임에만 눌러 준다(게임이 엣지로 읽는다).
        if item_fire:
            gp.press_button(vg.XUSB_BUTTON.XUSB_GAMEPAD_X)
        else:
            gp.release_button(vg.XUSB_BUTTON.XUSB_GAMEPAD_X)
        if confirm_fire:
            gp.press_button(vg.XUSB_BUTTON.XUSB_GAMEPAD_A)
        else:
            gp.release_button(vg.XUSB_BUTTON.XUSB_GAMEPAD_A)
        gp.update()

        # ── 화면 표시 ──
        for landmarks in hands:
            for lm in landmarks:
                cv2.circle(frame, (int(lm.x * w), int(lm.y * h)), 4, (255, 255, 0), -1)

        def put(text, y, color=(0, 255, 0), scale=0.7):
            cv2.putText(frame, text, (10, y), cv2.FONT_HERSHEY_SIMPLEX, scale, color, 2)

        put(self.name, 35, (0, 255, 0), 1.0)
        put(f"angle {angle_deg:+.1f}  steer {steer:+.2f}", 68)
        put(f"hands {len(hands)}  fists {fists}", 96)
        if braking:
            put("BRAKE", 128, (0, 0, 255), 0.9)
        if item_fire:
            put("ITEM", 160, (0, 200, 255), 0.9)
        if confirm_now:
            put("CONFIRM", 192, (255, 200, 0), 0.9)
        if menu_y:
            put(f"menu {'UP' if menu_y > 0 else 'DOWN'}", 224, (200, 200, 255))

        return frame

    def release(self):
        gp = self.gamepad
        gp.reset()
        gp.update()
        self.cap.release()


def main():
    print("가상 패드 2개 생성 중... (ViGEmBus 드라이버가 없으면 여기서 실패한다)")
    p1 = PlayerCam("P1", P1_CAM_INDEX, vg.VX360Gamepad())
    p2 = PlayerCam("P2", P2_CAM_INDEX, vg.VX360Gamepad())
    print("준비 완료. 게임 창을 클릭해 포커스를 준 뒤 손을 들어라. 종료는 q.")

    try:
        while True:
            f1 = p1.process()
            f2 = p2.process()
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
            main()
    except Exception:
        import traceback
        traceback.print_exc()
        input("\n에러가 발생했다. 위 내용을 확인한 뒤 Enter를 누르면 창이 닫힌다...")
