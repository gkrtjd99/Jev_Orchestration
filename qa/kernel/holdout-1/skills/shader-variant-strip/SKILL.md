---
name: shader-variant-strip
description: "Reduce shader variant counts by stripping unused keywords and passes to cut build time and memory. Use when builds are slow on shader compilation or the app stalls compiling shaders at first load."
---

# Shader variant stripping

1. Log variant counts per shader from the build report.
2. Convert rarely used multi_compile keywords to shader_feature.
3. Add a stripping callback for keyword combinations no material uses.
4. Prewarm what remains with a variant collection.
