#!/usr/bin/env python3
"""
Live plot + CSV log of the node's loudness (sketch: test_loudness_csv.ino).

Usage:
    python loudness_logger.py                       # finds the USB serial port by itself
    python loudness_logger.py --port /dev/cu.usbserial-0001
    python loudness_logger.py --out kitchen_test.csv --window 180

Each row in the CSV gets the computer's clock time, so it can be lined up with the
phone recording. Close the plot window (or press Ctrl+C) to stop; the CSV is saved
as it goes.

Requires: pip install pyserial matplotlib numpy
"""
import argparse
import collections
import csv
import datetime as dt
import sys
import time

import matplotlib.pyplot as plt
import numpy as np
import serial
from matplotlib.animation import FuncAnimation
from serial.tools import list_ports

FIELDS = ["ms", "leq_db", "peak_db", "rms_counts", "peak_counts", "dc", "clip", "headroom_db"]  # headroom from sketch v2


def find_port():
    ports = list(list_ports.comports())
    for p in ports:
        name = (p.device + " " + (p.description or "")).lower()
        if any(k in name for k in ("usbserial", "wchusb", "ttyusb", "cp210", "ch340", "ft232", "uart")):
            return p.device
    if len(ports) == 1:
        return ports[0].device
    sys.exit("Could not find the USB serial port. Use --port. Ports seen: "
             + ", ".join(p.device for p in ports))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", help="serial port (default: auto-detect)")
    ap.add_argument("--baud", type=int, default=38400)
    ap.add_argument("--out", help="CSV file (default: loudness_YYYYmmdd_HHMMSS.csv)")
    ap.add_argument("--window", type=float, default=120, help="seconds shown in the plot")
    args = ap.parse_args()

    port = args.port or find_port()
    out = args.out or dt.datetime.now().strftime("loudness_%Y%m%d_%H%M%S.csv")
    ser = serial.Serial(port, args.baud, timeout=0.05)
    print(f"Reading {port} at {args.baud} baud, writing {out}")
    print("Tip: clap 3 times close to both the node and the phone right after starting both,")
    print("     so compare_loudness.py can line the two recordings up.")

    f = open(out, "w", newline="")
    w = csv.writer(f)
    w.writerow(["pc_time", "unix_s"] + FIELDS + ["cal_offset_db"])
    cal_offset = ""

    t_hist = collections.deque()
    leq_hist = collections.deque()
    peak_hist = collections.deque()
    last_headroom = [float("nan")]
    clip_t = collections.deque()
    clip_db = collections.deque()
    t_start = time.time()

    fig, ax = plt.subplots(figsize=(10, 5))
    (l_leq,) = ax.plot([], [], label="Leq (250 ms)", lw=1.5)
    (l_peak,) = ax.plot([], [], label="Peak", lw=0.8, alpha=0.6)
    clip_pts = ax.scatter([], [], marker="x", color="tab:red", s=50, zorder=5, label="CLIP (mic overloaded)")
    ax.set_xlabel("time since start (s)")
    ax.set_ylabel("dB (node, uncalibrated)")
    ax.set_title(f"Node loudness  ·  {out}")
    ax.grid(alpha=0.3)
    ax.legend(loc="upper left")
    status = ax.text(0.99, 0.97, "", transform=ax.transAxes, ha="right", va="top", fontsize=10)

    def read_lines():
        nonlocal cal_offset
        while True:
            raw = ser.readline()
            if not raw:
                return
            line = raw.decode(errors="replace").strip()
            if not line:
                continue
            if line.startswith("#"):
                print(line)
                if line.startswith("# cal_offset_db="):
                    cal_offset = line.split("=", 1)[1]
                continue
            parts = line.split(",")
            if len(parts) not in (len(FIELDS) - 1, len(FIELDS)) or parts[0] == "ms":
                continue
            if len(parts) == len(FIELDS) - 1:         # v1 sketch: no headroom column
                parts.append("")
            try:
                vals = [float(x) if x != "" else float("nan") for x in parts]
            except ValueError:
                continue
            now = time.time()
            w.writerow([dt.datetime.fromtimestamp(now).isoformat(timespec="milliseconds"),
                        f"{now:.3f}"] + parts + [cal_offset])
            t_hist.append(now - t_start)
            leq_hist.append(vals[1])
            last_headroom[0] = vals[7]
            peak_hist.append(vals[2])
            while t_hist and t_hist[-1] - t_hist[0] > args.window:
                t_hist.popleft(); leq_hist.popleft(); peak_hist.popleft()
            if vals[6]:
                clip_t.append(now - t_start)
                clip_db.append(vals[2])
            while clip_t and t_hist and clip_t[0] < t_hist[0]:
                clip_t.popleft(); clip_db.popleft()
            if vals[6]:
                print(f"{dt.datetime.now():%H:%M:%S}  CLIP - sound too loud for the mic gain")

    def update(_):
        read_lines()
        f.flush()
        if t_hist:
            l_leq.set_data(t_hist, leq_hist)
            l_peak.set_data(t_hist, peak_hist)
            ax.set_xlim(max(0, t_hist[-1] - args.window), max(args.window, t_hist[-1]))
            lo = min(leq_hist) - 5
            hi = max(peak_hist) + 5
            ax.set_ylim(lo, hi)
            clip_pts.set_offsets(list(zip(clip_t, clip_db)) if clip_t else np.empty((0, 2)))
            status.set_text(f"Leq {leq_hist[-1]:.1f} dB   peak {peak_hist[-1]:.1f} dB   "
                            f"headroom {last_headroom[0]:.1f} dB   clips shown: {len(clip_t)}")
        return l_leq, l_peak, clip_pts, status

    anim = FuncAnimation(fig, update, interval=200, cache_frame_data=False)  # keep a reference
    try:
        plt.show()
    except KeyboardInterrupt:
        pass
    finally:
        f.close()
        ser.close()
        print(f"Saved {out}")


if __name__ == "__main__":
    main()
