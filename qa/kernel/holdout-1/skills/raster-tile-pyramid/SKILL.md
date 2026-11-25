---
name: raster-tile-pyramid
description: "Convert large rasters into Cloud Optimized GeoTIFFs or XYZ tile pyramids with overviews and sensible compression. Use when imagery or elevation data must be served to a web map."
---

# Raster tiling

1. Imagery: COG with JPEG or WebP compression; elevation: DEFLATE with a predictor.
2. Build internal overviews with a resampling method suited to the data.
3. For XYZ tiles choose the zoom range from the ground resolution.
4. Validate the COG before upload.
