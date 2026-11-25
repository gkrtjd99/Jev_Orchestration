---
name: hls-ladder-encode
description: "Encode a source video into an adaptive bitrate ladder for HLS/DASH with ffmpeg: rendition sizes, GOP alignment, segment length. Use when preparing video for streaming playback across network conditions."
---

# ABR ladder encoding

1. Pick renditions from the source resolution (never upscale): e.g. 1080p/720p/480p/360p/240p.
2. Fixed GOP of 2 s aligned across renditions, 4-6 s segments, closed GOPs.
3. Produce a master playlist with correct BANDWIDTH and CODECS attributes.
4. Test playback with network throttling.
