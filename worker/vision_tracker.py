#!/usr/bin/env python3
"""Optional OpenCV face candidate tracker for local skin correction.

Run with an explicitly configured Python that already contains OpenCV.  The
bundled Haar cascade detects candidate faces; LK optical flow follows them
between periodic detections.  This never identifies a person or labels all
orange pixels as skin.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import subprocess
import sys

import cv2
import numpy as np


DETECT_EVERY = 10
MAX_FACES = 3
MIN_TRACK_POINTS = 6
MIN_TRACK_INLIER_RATIO = 0.55
MAX_FORWARD_BACKWARD_ERROR = 1.5
SCENE_CUT_MIN_DIFFERENCE = 0.06
SCENE_CUT_CHROMA_CORRELATION = 0.45
SCENE_CUT_CHROMA_HISTOGRAM_DISTANCE = 0.55
SCENE_CUT_CHROMA_AFFINE_ERROR = 0.08


def sampled_faces(source_path: str, sample_count: int = 5) -> dict:
    """Sparse, seeked face candidates for analysis; no temporal claim."""
    capture = cv2.VideoCapture(source_path)
    if not capture.isOpened():
        raise RuntimeError("OpenCV cannot decode source")
    total = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    if total < 1:
        capture.release()
        raise RuntimeError("Video has no indexed frames for sparse face sampling")
    cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    if cascade.empty():
        capture.release()
        raise RuntimeError("Bundled Haar cascade unavailable")
    indices = sorted({min(total-1, int((index+.5)*total/sample_count)) for index in range(sample_count)})
    decoded, frames_with_faces, detections = 0, 0, 0
    for index in indices:
        if not capture.set(cv2.CAP_PROP_POS_FRAMES, index):
            continue
        ok, frame = capture.read()
        if not ok:
            continue
        decoded += 1
        width = min(640, frame.shape[1])
        height = max(1, round(frame.shape[0]*width/frame.shape[1]))
        gray = cv2.cvtColor(cv2.resize(frame,(width,height),interpolation=cv2.INTER_AREA),cv2.COLOR_BGR2GRAY)
        found = cascade.detectMultiScale(gray,scaleFactor=1.08,minNeighbors=4,
                                         minSize=(max(24,width//25),max(24,width//25)))
        detections += len(found)
        frames_with_faces += bool(len(found))
    capture.release()
    if not decoded:
        raise RuntimeError("No requested face-sample frames decoded")
    return {"sampled_frames": decoded, "frames_with_faces": frames_with_faces,
            "face_detections": detections, "candidate_only": True,
            "available": frames_with_faces >= min(2,decoded),
            "confidence": "low", "method": "OpenCV Haar faces on up to five seeked frames",
            "limitation": "Sparse candidates; stable tracking is checked only during skin preview or export."}


def preview_frame_faces(source_path: str, frame_index: int) -> dict:
    """Detect face candidates on the requested presentation frame only."""
    capture = cv2.VideoCapture(source_path)
    if not capture.isOpened() or frame_index < 0:
        raise RuntimeError("OpenCV cannot seek to preview frame")
    if not capture.set(cv2.CAP_PROP_POS_FRAMES, frame_index):
        capture.release()
        raise RuntimeError("OpenCV cannot seek to preview frame")
    ok, frame = capture.read()
    actual_index = int(round(capture.get(cv2.CAP_PROP_POS_FRAMES))) - 1
    capture.release()
    if not ok or actual_index != frame_index:
        raise RuntimeError("OpenCV did not decode the requested preview frame")
    cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    if cascade.empty():
        raise RuntimeError("Bundled Haar cascade unavailable")
    width = min(640, frame.shape[1])
    height = max(1, round(frame.shape[0] * width / frame.shape[1]))
    gray = cv2.cvtColor(cv2.resize(frame, (width, height), interpolation=cv2.INTER_AREA),
                        cv2.COLOR_BGR2GRAY)
    found = cascade.detectMultiScale(gray, scaleFactor=1.08, minNeighbors=4,
                                     minSize=(max(24, width//25), max(24, width//25)))
    regions = []
    for x,y,w,h in sorted(found, key=lambda box: box[2]*box[3], reverse=True)[:MAX_FACES]:
        pad_x, pad_y = w*.10, h*.10
        x0, y0 = max(0,x-pad_x), max(0,y-pad_y)
        x1, y1 = min(width,x+w+pad_x), min(height,y+h+pad_y)
        regions.append({"x":x0/width,"y":y0/height,"width":(x1-x0)/width,
                        "height":(y1-y0)/height,"feather":.012})
    return {"preview_frame_index":frame_index,"preview_regions":regions,
            "sampled_frames":1,"face_detections":len(found),"face_count":len(regions),
            "track_scope":"single_preview_frame","tracked_coverage":None,
            "method":"OpenCV Haar face candidates on the selected frame",
            "limitation":"Temporal tracking is performed only for full-video export."}


def intersection_over_union(a: tuple[float, ...], b: tuple[float, ...]) -> float:
    x0, y0 = max(a[0], b[0]), max(a[1], b[1])
    x1, y1 = min(a[0] + a[2], b[0] + b[2]), min(a[1] + a[3], b[1] + b[3])
    overlap = max(0.0, x1-x0) * max(0.0, y1-y0)
    union = a[2]*a[3] + b[2]*b[3] - overlap
    return overlap/union if union else 0.0


def landmarks(gray: np.ndarray, box: tuple[float, ...]) -> np.ndarray | None:
    x, y, w, h = map(int, box)
    mask = np.zeros(gray.shape, dtype=np.uint8)
    inset_x, inset_y = max(2, w//8), max(2, h//8)
    cv2.rectangle(mask, (x+inset_x, y+inset_y), (x+w-inset_x, y+h-inset_y), 255, -1)
    return cv2.goodFeaturesToTrack(gray, maxCorners=48, qualityLevel=.02, minDistance=4, mask=mask)


def _scene_cut(previous: np.ndarray, current: np.ndarray) -> bool:
    """Detect an abrupt shot change from tiny luma and color thumbnails.

    A cut discards old boxes and forces same-frame detection. False positives
    can briefly remove a candidate; missed cuts could carry an old face box
    into an unrelated shot.
    """
    if previous.shape != current.shape:
        return True
    size = (64, 36)
    before_small = cv2.resize(previous, size, interpolation=cv2.INTER_AREA)
    after_small = cv2.resize(current, size, interpolation=cv2.INTER_AREA)
    if before_small.ndim == 3:
        before = cv2.cvtColor(before_small, cv2.COLOR_BGR2GRAY)
        after = cv2.cvtColor(after_small, cv2.COLOR_BGR2GRAY)
        color_difference = float(cv2.absdiff(before_small, after_small).mean()) / 255.0
    else:
        before, after = before_small, after_small
        color_difference = 0.0
    mean_difference = max(float(cv2.absdiff(before, after).mean()) / 255.0,
                          color_difference)
    if mean_difference < SCENE_CUT_MIN_DIFFERENCE:
        return False

    before_values = before.astype(np.float32).reshape(-1)
    after_values = after.astype(np.float32).reshape(-1)
    before_std, after_std = float(before_values.std()), float(after_values.std())
    if before_std < 1 or after_std < 1:
        correlation = 1.0 if before_std < 1 and after_std < 1 else 0.0
    else:
        correlation = float(np.corrcoef(before_values, after_values)[0, 1])
    before_hist = cv2.calcHist([before], [0], None, [32], [0, 256])
    after_hist = cv2.calcHist([after], [0], None, [32], [0, 256])
    cv2.normalize(before_hist, before_hist)
    cv2.normalize(after_hist, after_hist)
    histogram_distance = float(cv2.compareHist(before_hist, after_hist, cv2.HISTCMP_BHATTACHARYYA))
    if correlation < 0.45 or histogram_distance > 0.60:
        return True

    if before_small.ndim != 3:
        return False

    # A gray thumbnail can be identical when strongly different colors with
    # equal luminance exchange places. Compare spatial chroma structure too.
    # Per-channel positive affine changes model broad white-balance/exposure
    # shifts; they should not reset tracks merely because a chroma histogram
    # moved. A changed spatial relationship or a non-affine distribution
    # change is stronger evidence of a cut.
    before_ycc = cv2.cvtColor(before_small, cv2.COLOR_BGR2YCrCb)
    after_ycc = cv2.cvtColor(after_small, cv2.COLOR_BGR2YCrCb)
    chroma_correlations: list[float] = []
    affine_errors: list[float] = []
    for channel in (1, 2):
        before_chroma = before_ycc[:, :, channel].astype(np.float32).reshape(-1)
        after_chroma = after_ycc[:, :, channel].astype(np.float32).reshape(-1)
        before_mean = float(before_chroma.mean())
        after_mean = float(after_chroma.mean())
        before_centered = before_chroma - before_mean
        after_centered = after_chroma - after_mean
        before_variance = float(np.mean(before_centered ** 2))
        after_variance = float(np.mean(after_centered ** 2))
        if before_variance >= 1 and after_variance >= 1:
            covariance = float(np.mean(before_centered * after_centered))
            chroma_correlations.append(covariance / math.sqrt(before_variance * after_variance))
            # A global white-balance shift remains close to a positive affine
            # map. Clamp negative slopes to zero so spatial color reversals
            # cannot masquerade as a global channel adjustment.
            slope = max(0.0, covariance / before_variance)
            intercept = after_mean - slope * before_mean
            residual = after_chroma - (slope * before_chroma + intercept)
            affine_errors.append(float(np.sqrt(np.mean(residual ** 2))) / 255.0)
        elif max(before_variance, after_variance) >= 400:
            # One frame has a spatially uniform chroma channel while the
            # other varies substantially, so there is no useful correlation.
            affine_errors.append(float(math.sqrt(max(before_variance, after_variance))) / 255.0)

    before_chroma_hist = cv2.calcHist([before_ycc], [1, 2], None, [16, 16], [0, 256, 0, 256])
    after_chroma_hist = cv2.calcHist([after_ycc], [1, 2], None, [16, 16], [0, 256, 0, 256])
    cv2.normalize(before_chroma_hist, before_chroma_hist)
    cv2.normalize(after_chroma_hist, after_chroma_hist)
    chroma_histogram_distance = float(cv2.compareHist(
        before_chroma_hist, after_chroma_hist, cv2.HISTCMP_BHATTACHARYYA))
    chroma_structure_changed = any(
        value < SCENE_CUT_CHROMA_CORRELATION for value in chroma_correlations)
    chroma_distribution_changed = (
        chroma_histogram_distance > SCENE_CUT_CHROMA_HISTOGRAM_DISTANCE
        and any(error > SCENE_CUT_CHROMA_AFFINE_ERROR for error in affine_errors)
    )
    uniform_color_cut = (
        not chroma_correlations
        and color_difference > 0.25
        and chroma_histogram_distance > SCENE_CUT_CHROMA_HISTOGRAM_DISTANCE
    )
    return chroma_structure_changed or chroma_distribution_changed or uniform_color_cut


def _track_affine(previous: np.ndarray, current: np.ndarray,
                  points: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray] | None:
    """Track points with forward/backward validation and a robust local affine fit."""
    if points is None or len(points) < MIN_TRACK_POINTS:
        return None
    moved, forward_status, _ = cv2.calcOpticalFlowPyrLK(
        previous, current, points, None, winSize=(21, 21), maxLevel=2,
        criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 20, .03))
    if moved is None or forward_status is None:
        return None
    returned, backward_status, _ = cv2.calcOpticalFlowPyrLK(
        current, previous, moved, None, winSize=(21, 21), maxLevel=2,
        criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 20, .03))
    if returned is None or backward_status is None:
        return None

    source_points = points.reshape(-1, 2)
    moved_points = moved.reshape(-1, 2)
    returned_points = returned.reshape(-1, 2)
    valid = (forward_status.reshape(-1) == 1) & (backward_status.reshape(-1) == 1)
    valid &= np.isfinite(moved_points).all(axis=1) & np.isfinite(returned_points).all(axis=1)
    valid &= np.linalg.norm(returned_points - source_points, axis=1) <= MAX_FORWARD_BACKWARD_ERROR
    if np.count_nonzero(valid) < MIN_TRACK_POINTS:
        return None

    before = source_points[valid]
    after = moved_points[valid]
    transform, inliers = cv2.estimateAffinePartial2D(
        before, after, method=cv2.RANSAC, ransacReprojThreshold=2.5,
        maxIters=100, confidence=.95, refineIters=5)
    if transform is None or inliers is None:
        return None
    if not np.isfinite(transform).all():
        return None
    inlier_mask = inliers.reshape(-1).astype(bool)
    if np.count_nonzero(inlier_mask) < MIN_TRACK_POINTS:
        return None
    if np.count_nonzero(inlier_mask) / len(before) < MIN_TRACK_INLIER_RATIO:
        return None
    residuals = after - (before @ transform[:, :2].T + transform[:, 2])
    if float(np.quantile(np.linalg.norm(residuals[inlier_mask], axis=1), .9)) > 2.5:
        return None

    scale = float(math.hypot(transform[0, 0], transform[1, 0]))
    # Very large per-frame scale changes usually mean LK followed a different
    # surface or the subject was lost. Let periodic Haar detection reacquire.
    if not .80 <= scale <= 1.25:
        return None
    tracked = after[inlier_mask].reshape(-1, 1, 2).astype(np.float32)
    return transform, tracked, inlier_mask


def tracked_regions(source_path: str, max_segments: int, mask_output: str | None = None, fps: str | None = None) -> dict:
    capture = cv2.VideoCapture(source_path)
    if not capture.isOpened():
        raise RuntimeError("OpenCV cannot decode source")
    cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    if cascade.empty():
        raise RuntimeError("Bundled Haar cascade unavailable")
    tracks: list[dict] = []
    last_gray = None
    last_small = None
    per_frame: list[list[tuple[int, tuple[float, ...]]]] = []
    frame_index = 0
    detections_count = 0
    next_track_id = 1
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        frame_index += 1
        width = min(640, frame.shape[1])
        height = max(1, round(frame.shape[0] * width / frame.shape[1]))
        small = cv2.resize(frame, (width, height), interpolation=cv2.INTER_AREA)
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        cut = last_small is not None and _scene_cut(last_small, small)
        if cut:
            # Do not allow LK to carry the prior shot's face into the new one.
            tracks.clear()
        if last_gray is not None and not cut:
            for track in tracks:
                points = track.get("points")
                result = _track_affine(last_gray, gray, points)
                if result is None:
                    track["valid"] = False
                    # Points belong to last_gray. Once the frame advances, a
                    # failed set cannot be compared to the next last_gray.
                    # Periodic detection must seed a fresh set before flow resumes.
                    track["points"] = None
                    continue
                transform, tracked_points, _ = result
                x,y,w,h = track["box"]
                scale = float(math.hypot(transform[0, 0], transform[1, 0]))
                center = np.array([x + w / 2, y + h / 2], dtype=np.float64)
                moved_center = transform[:, :2] @ center + transform[:, 2]
                new_w, new_h = w * scale, h * scale
                x = float(np.clip(moved_center[0] - new_w / 2, 0, max(0, width-new_w)))
                y = float(np.clip(moved_center[1] - new_h / 2, 0, max(0, height-new_h)))
                track["box"] = (x, y, min(new_w, width), min(new_h, height))
                track["points"] = tracked_points
                track["valid"] = True
        tracks = [track for track in tracks
                  if frame_index - track["last_detect"] <= DETECT_EVERY * 3]
        if frame_index == 1 or frame_index % DETECT_EVERY == 0 or cut:
            detected = cascade.detectMultiScale(gray, scaleFactor=1.08, minNeighbors=4,
                                                 minSize=(max(24,width//25),max(24,width//25)))
            detections_count += len(detected)
            for detected_box in sorted(detected, key=lambda box: box[2]*box[3], reverse=True):
                box = tuple(map(float, detected_box))
                closest = max(tracks, key=lambda item: intersection_over_union(item["box"],box), default=None)
                if closest is not None and intersection_over_union(closest["box"],box) > .20:
                    closest["box"] = box
                    closest["points"] = landmarks(gray,box)
                    closest["valid"] = True
                    closest["last_detect"] = frame_index
                elif len(tracks) < MAX_FACES:
                    tracks.append({"id":next_track_id,"box":box,"points":landmarks(gray,box),
                                   "valid":True,"last_detect":frame_index})
                    next_track_id += 1
        active: list[tuple[int, tuple[float, ...]]] = []
        for track in tracks:
            if track["valid"] and frame_index - track["last_detect"] <= DETECT_EVERY*3:
                x,y,w,h = track["box"]
                pad_x, pad_y = w*.10, h*.10
                x0, y0 = max(0,x-pad_x), max(0,y-pad_y)
                x1, y1 = min(width,x+w+pad_x), min(height,y+h+pad_y)
                active.append((track["id"],(x0/width,y0/height,(x1-x0)/width,(y1-y0)/height)))
        per_frame.append(active)
        last_gray = gray
        last_small = small
    capture.release()
    if not per_frame:
        raise RuntimeError("No video frames decoded")
    span = max(1, math.ceil(len(per_frame)/max_segments))
    segments = []
    for start in range(0,len(per_frame),span):
        window = per_frame[start:start+span]
        regions = []
        ids = sorted({face_id for frame in window for face_id,_ in frame})
        for face_id in ids:
            boxes = [box for frame in window for active_id,box in frame if active_id == face_id]
            if len(boxes) < max(1,len(window)//3):
                continue
            x0,y0 = min(box[0] for box in boxes), min(box[1] for box in boxes)
            x1,y1 = max(box[0]+box[2] for box in boxes), max(box[1]+box[3] for box in boxes)
            regions.append({"x":x0,"y":y0,"width":x1-x0,"height":y1-y0,"feather":.012})
        segments.append({"start_frame":start,"end_frame":min(len(per_frame),start+span),"regions":regions})
    coverage = sum(bool(frame) for frame in per_frame)/len(per_frame)
    frame_regions = [[{"x": box[0], "y": box[1], "width": box[2], "height": box[3], "feather": .012}
                      for _, box in frame] for frame in per_frame]
    peak_active_face_count = max((len(frame) for frame in per_frame), default=0)
    if mask_output is not None:
        if not fps or not Path(mask_output).is_absolute():
            raise RuntimeError("Mask output and exact frame rate are required")
        mask_width = 320
        mask_height = max(2, round(height * mask_width / width / 2)*2)
        command = ["ffmpeg", "-hide_banner", "-v", "error", "-f", "rawvideo", "-pix_fmt", "gray",
                   "-s", f"{mask_width}x{mask_height}", "-r", fps, "-i", "-", "-an", "-c:v", "ffv1",
                   "-pix_fmt", "gray", "-y", mask_output]
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        assert process.stdin is not None
        xx = np.arange(mask_width, dtype=np.float32)[None, :] / mask_width
        yy = np.arange(mask_height, dtype=np.float32)[:, None] / mask_height
        for frame in frame_regions:
            # Match media_worker's face_region_expr: a linear, inward feather
            # confined to each bounding box, combined by maximum over faces.
            mask = np.zeros((mask_height,mask_width), dtype=np.float32)
            for region in frame:
                x, y, w, h = (region[key] for key in ("x", "y", "width", "height"))
                feather = region["feather"]
                ramp = np.minimum(np.minimum((xx-x)/feather, (x+w-xx)/feather),
                                  np.minimum((yy-y)/feather, (y+h-yy)/feather))
                np.maximum(mask, np.clip(ramp, 0, 1), out=mask)
            process.stdin.write(np.rint(mask*255).astype(np.uint8).tobytes())
        process.stdin.close()
        stderr = process.stderr.read().decode(errors="replace") if process.stderr else ""
        if process.wait():
            raise RuntimeError(f"Could not encode tracked mask: {stderr[-800:]}")
    # Keep the legacy face_count as the number of unique tracks seen over the
    # clip; report peak simultaneous visible candidates separately.
    total_track_ids = next_track_id - 1
    return {"frame_count":len(per_frame),"face_detections":detections_count,"tracked_coverage":coverage,
            "face_count":total_track_ids,"total_track_ids":total_track_ids,
            "peak_active_face_count":peak_active_face_count,"segments":segments,
            "frame_regions":frame_regions,
            "mask_output":mask_output,
            "method":"OpenCV Haar face candidates + forward-backward validated pyramidal Lucas-Kanade flow"}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-path",required=True)
    parser.add_argument("--max-segments",type=int,default=12)
    parser.add_argument("--mask-output")
    parser.add_argument("--fps")
    parser.add_argument("--sample-count",type=int)
    parser.add_argument("--preview-frame-index",type=int)
    args = parser.parse_args()
    try:
        if args.preview_frame_index is not None:
            if args.sample_count is not None or args.mask_output is not None:
                raise ValueError("Preview-frame detection cannot create a full mask")
            result = preview_frame_faces(args.source_path,args.preview_frame_index)
        elif args.sample_count is not None:
            if args.sample_count < 1 or args.sample_count > 5 or args.mask_output is not None:
                raise ValueError("Sparse sample count must be 1–5 without a mask output")
            result = sampled_faces(args.source_path,args.sample_count)
        else:
            result = tracked_regions(args.source_path,args.max_segments,args.mask_output,args.fps)
        print(json.dumps({"status":"ok",**result},separators=(",",":")))
        return 0
    except Exception as exc:
        print(json.dumps({"status":"error","code":"vision_unavailable","error":str(exc)},separators=(",",":")))
        return 1


if __name__ == "__main__":
    sys.exit(main())
