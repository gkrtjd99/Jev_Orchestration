---
name: fbx-import-normalize
description: "Normalise FBX files coming from artists before import into the engine: unit scale, up-axis, pivot placement and bone naming. Use when a model arrives the wrong size, rotated, or with a rig that will not retarget."
---

# FBX import normalisation

1. Check exporter units (cm vs m) and up-axis; fix at the import preset, not per asset by hand.
2. Apply transforms so root scale is 1 and rotation is zero.
3. Rename bones to the studio skeleton convention so retargeting works.
4. Save the preset under Assets/ImportPresets and re-import.
