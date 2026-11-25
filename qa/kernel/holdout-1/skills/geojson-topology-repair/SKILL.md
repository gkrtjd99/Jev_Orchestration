---
name: geojson-topology-repair
description: "Repair invalid vector geometries: self-intersections, unclosed rings, sliver polygons, and gaps or overlaps between adjacent boundaries. Use when a spatial join, dissolve or area calculation errors out or gives odd totals."
---

# Geometry and topology repair

1. Run a validity check and list failures by reason.
2. Fix with make-valid first; avoid buffer(0) on multipolygons, it can drop parts.
3. Snap shared boundaries to a tolerance, then remove slivers below an area threshold.
4. Re-check validity and compare total area before and after.
