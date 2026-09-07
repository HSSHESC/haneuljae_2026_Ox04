"""
한어울 그랑프리 — 통합 실행기

이 파일 하나만 실행하면 웹서버와(설정에 따라) 손동작 조작이 함께 뜨고, 브라우저가 열린다.
Ctrl+C 를 누르면 둘 다 정리된다.

    python run.py

조작 방식은 아래 HAND_STEERING 한 줄로 바뀐다.
"""

import os
import sys
import time
import socket
import threading
import subprocess
import webbrowser
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

# ═══════════════════════ 설정 ═══════════════════════ #

# True  = 배포용. 웹캠 손동작으로 조작한다(handsteer/hand_steering.py 를 함께 띄운다).
# False = 테스트용. 키보드로 조작한다(P1: WASD / P2: 방향키).
HAND_STEERING = True

# 손동작 조작의 OpenCV 미리보기 창을 띄울지. 게임 화면 좌상단·우상단에도 같은 영상이
# 나오므로, 배포할 때는 False 로 두면 화면이 깔끔하다. 임계값을 맞출 때는 True 가 편하다.
SHOW_PREVIEW_WINDOW = True

PORT = 8000
OPEN_BROWSER = True

# ════════════════════════════════════════════════════ #

ROOT = os.path.dirname(os.path.abspath(__file__))
HAND_SCRIPT = os.path.join(ROOT, "handsteer", "hand_steering.py")


class QuietHandler(SimpleHTTPRequestHandler):
    """요청 로그로 콘솔을 더럽히지 않는다."""

    def log_message(self, *args):
        pass

    def end_headers(self):
        # 고칠 때마다 강제 새로고침을 안 해도 되게 캐시를 끈다.
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()


def port_in_use(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


def start_web_server():
    if port_in_use(PORT):
        print(f"[웹] 포트 {PORT} 에 이미 뭔가 떠 있다 — 그걸 그대로 쓴다.")
        return None
    handler = functools.partial(QuietHandler, directory=ROOT)
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print(f"[웹] http://localhost:{PORT}")
    return srv


def start_hand_steering():
    if not os.path.exists(HAND_SCRIPT):
        print(f"[손] 스크립트가 없다: {HAND_SCRIPT}")
        return None

    model = os.path.join(ROOT, "handsteer", "hand_landmarker.task")
    if not os.path.exists(model):
        print("[손] hand_landmarker.task 가 없다. 아래를 받아 handsteer/ 에 두어라:")
        print("     https://storage.googleapis.com/mediapipe-models/hand_landmarker/"
              "hand_landmarker/float16/1/hand_landmarker.task")
        return None

    for mod in ("cv2", "mediapipe", "vgamepad"):
        try:
            __import__(mod)
        except ImportError:
            print(f"[손] 패키지 '{mod}' 가 없다 →  pip install opencv-python mediapipe vgamepad")
            return None

    args = [sys.executable, HAND_SCRIPT]
    if not SHOW_PREVIEW_WINDOW:
        args.append("--no-window")
    # 새 콘솔 창을 띄우지 않고 이 창에 로그를 섞어 보여준다.
    # 별도 프로세스 그룹으로 띄워야 이 창의 Ctrl+C 가 자식까지 무차별로 죽이지 않는다
    # (우리가 finally 에서 순서대로 정리한다 — 카메라를 확실히 놓게 하려면 이 편이 안전하다).
    kw = {}
    if os.name == "nt":
        kw["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    proc = subprocess.Popen(args, cwd=ROOT, **kw)
    print(f"[손] hand_steering.py 실행 (pid {proc.pid})")
    return proc


def main():
    mode = "손동작 (배포용)" if HAND_STEERING else "키보드 (테스트용)"
    print("=" * 58)
    print(f"  한어울 그랑프리   —   조작: {mode}")
    print("=" * 58)

    srv = start_web_server()
    proc = None

    if HAND_STEERING:
        proc = start_hand_steering()
        if proc is None:
            print("[손] 손동작 조작을 띄우지 못했다. 키보드로도 플레이할 수 있다.")
            print("     (P1: WASD / P2: 방향키)")
    else:
        print("[손] 꺼져 있음 — 키보드로 조작한다. P1: WASD / P2: 방향키")
        print("     게임 화면 모서리에는 NoCamera 가 표시된다.")

    if OPEN_BROWSER:
        time.sleep(0.6)
        webbrowser.open(f"http://localhost:{PORT}")

    print("\n종료하려면 이 창에서 Ctrl+C.\n")
    try:
        while True:
            if proc is not None and proc.poll() is not None:
                print(f"\n[손] hand_steering.py 가 종료됐다 (코드 {proc.returncode}).")
                print("     게임은 계속 돌아간다. 키보드로 조작할 수 있다.")
                proc = None
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("\n정리 중...")
    finally:
        if proc is not None and proc.poll() is None:
            # 부드럽게 → 안 죽으면 강제. 카메라 핸들이 남지 않게 확실히 정리한다.
            for step in ("terminate", "kill"):
                try:
                    getattr(proc, step)()
                    proc.wait(timeout=3)
                    break
                except subprocess.TimeoutExpired:
                    continue
                except Exception:
                    break
        if srv is not None:
            srv.shutdown()
        print("종료.")


if __name__ == "__main__":
    main()
