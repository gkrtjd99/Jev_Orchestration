---
name: video-loudness-normalize
description: "Measure and normalise programme loudness to a target (EBU R128 -23 LUFS or streaming -14 LUFS) with true-peak limiting. Use when audio levels differ between clips or a platform rejects a delivery for loudness."
---

# Loudness normalisation

1. Measure integrated loudness and true peak for each file.
2. Two-pass loudnorm in ffmpeg with the measured values.
3. True peak ceiling of -1 dBTP (-2 for broadcast).
4. Copy the video stream; re-encode audio only.
