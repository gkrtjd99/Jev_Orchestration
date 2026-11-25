---
name: texture-atlas-pack
description: "Pack sprites and textures into atlases with padding, trim and per-platform compression settings. Use when draw calls are high or texture memory is over budget on mobile."
---

# Texture atlasing

1. Group by screen or usage so an atlas loads with what uses it.
2. Padding of 2 px, trim transparent borders, power-of-two sizes up to 2048.
3. ASTC 6x6 on mobile; keep UI text atlases uncompressed.
4. Verify batching in the frame debugger.
