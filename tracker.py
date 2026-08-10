#!/usr/bin/env python3
"""
Local Body Tracker (raw, terminal-run)

Tracks your hands, face, and body pose from the built-in webcam using
MediaPipe — fully offline, using the local model files in ./models. Nothing
leaves this machine, and nothing about your OS is touched: this only opens a
camera window and draws in it. You run it yourself:

    python3 -m pip install opencv-python mediapipe
    python3 tracker.py

Keys
----
    h   toggle hand  drawing
    f   toggle face   drawing
    p   toggle pose   drawing
    m   toggle mirror (selfie view)
    q / Esc   quit
"""

import os
import sys
import time

import numpy as np
import cv2

try:
    import mediapipe as mp
    from mediapipe.tasks import python as mp_tasks
    from mediapipe.tasks.python import vision
    from mediapipe.solutions import drawing_utils
    from mediapipe.solutions.hands import HAND_CONNECTIONS
    from mediapipe.solutions.pose import POSE_CONNECTIONS
    from mediapipe.solutions.face_mesh import FACEMESH_CONTOURS
except ImportError as exc:
    print("Missing Python dependencies:", exc)
    print("Install with:  python3 -m pip install opencv-python mediapipe")
    sys.exit(1)

HANDS_ = HAND_CONNECTIONS
POSE_ = POSE_CONNECTIONS
FACE_ = FACEMESH_CONTOURS

BASE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(BASE, "models")

MODEL_FILES = {
    "hand": "hand_landmarker.task",
    "face": "face_landmarker.task",
    "pose": "pose_landmarker_lite.task",
}

class LocalLandmarkers:
    """Three MediaPipe Tasks landmarkers (video mode, images are local .task"""

    def __init__(self, model_dir=None):
        model_dir = model_dir or MODEL
        missing = [os.path.join(model_dir, f) for f in MODEL_FILES.values()
                   if not os.path.exists(os.path.join(model_dir, f))]
        if missing:
            print("Missing model file(s):")
            for m in missing:
                print("  " + m)
            print("The same small models used by the web version live in ./models.")
            sys.exit(1)

        base = lambda name: mp_tasks.BaseOptions(
            model_asset_path=os.path.join(model_dir, MODEL_FILES[name]))
        opts_video = {"running_mode": vision.RunningMode.VIDEO}

        self.hand = vision.HandLandmarker.create_from_options(
            vision.HandLandmarkerOptions(base_options=base("hand"), num_hands=2, **opts_video))
        self.face = vision.FaceLandmarker.create_from_options(
            vision.FaceLandmarkerOptions(
                base_options=base("face"), num_faces=1, output_face_blendshapes=True, **opts_video))
        self.pose = vision.PoseLandmarker.create_from_options(
            vision.PoseLandmarkerOptions(base_options=base("pose"), num_poses=2, **opts_video))

    def detect(self, frame, timestamp_ms):
        """Detect all enabled models on `frame` (BGR). Returns (hands, face, pose)."""
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        img = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb))
        return (
            self.hand.detect(img, timestamp_ms),
            self.face.detect(img, timestamp_ms),
            self.pose.detect(img, timestamp_ms)
        )

    def close(self):
        self.hand.close()
        self.face.close()
        self.pose.close()


def draw_hand(frame, lm, connections):
    drawing_utils.draw_landmarks(
        frame, lm, connections,
        landmark_drawing_spec=drawing_utils.DrawingSpec(
            color=(255, 255, 255), thickness=2, circle_radius=2),
        connection_drawing_spec=drawing_utils.DrawingSpec(color=(0, 220, 220), thickness=2))


def draw_pose(frame, lm, connections):
    drawing_utils.draw_landmarks(
        frame, lm, connections,
        landmark_drawing_spec=drawing_utils.DrawingSpec(
            color=(240, 240, 240), thickness=2, circle_radius=2),
        connection_drawing_spec=drawing_utils.DrawingSpec(color=(150, 150, 160), thickness=2))


def draw_face(frame, lm, connections):
    drawing_utils.draw_landmarks(
        frame, lm, connections,
        landmark_drawing_spec=None,
        connection_drawing_spec=drawing_utils.DrawingSpec(color=(255, 130, 30), thickness=1))


def main():
    cap = cv2.VideoCapture(0)
    if not cap.isOpened():
        print("Couldn't open webcam.")
        return

    trackers = LocalLandmarkers()
    show_hand = show_face = show_pose = True
    mirror = True
    last_ms = 0

    print("Local tracker running — press h/f/p/m to toggle, q or Esc to quit.")

    try:
        while True:
            t = time.monotonic()
            last_ms = int(t * 1000)  # monotonically increasing, required by Tasks

            ok, frame = cap.read()
            if not ok:
                break

            hands, face, pose = trackers.detect(frame, last_ms)

            disp = frame.copy()

            if show_pose and pose.pose_landmarks:
                for lm in pose.pose_landmarks:
                    draw_pose(disp, lm, POSE_)

            if show_hand and hands.hand_landmarks:
                for lm in hands.hand_landmarks:
                    draw_hand(disp, lm, HAND_)

            if show_face and face.face_landmarks:
                for lm in face.face_landmarks:
                    draw_face(disp, lm, FACE_)

            if mirror:
                disp = cv2.flip(disp, 1)

            cv2.putText(disp, f"{int(1.0 / max((time.monotonic() - t), 1e-9))}fps",
                        (10, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 220, 120), 2)

            cv2.imshow("Local Tracker", disp)
            key = cv2.waitKey(1) & 0xFF
            if key in (ord("q"), 27):
                print("Quit.")
                break
            if key in (ord("h"), ord("f"), ord("p"), ord("m")):
                if key == ord("h"):
                    show_hand = not show_hand
                if key == ord("f"):
                    show_face = not show_face
                if key == ord("p"):
                    show_pose = not show_pose
                if key == ord("m"):
                    mirror = not mirror
                print(f"hand={show_hand} face={show_face} pose={show_pose} mirror={mirror}")
    finally:
        cv2.destroyAllWindows()
        cap.release()
        trackers.close()


if __name__ == "__main__":
    main()