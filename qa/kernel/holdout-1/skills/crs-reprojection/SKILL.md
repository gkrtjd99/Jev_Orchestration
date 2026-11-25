---
name: crs-reprojection
description: "Reproject vector and raster datasets between coordinate reference systems, including the Korean grids EPSG:5179 and EPSG:5186, with correct datum transformations. Use when layers do not line up or coordinates appear shifted by tens or hundreds of metres."
---

# CRS reprojection

1. Identify the true source CRS (check the .prj, extent and units; do not trust the label).
2. A constant shift of a few hundred metres in Korea usually means Bessel/Tokyo datum data treated as GRS80.
3. Reproject with `ogr2ogr -s_srs ... -t_srs ...` or `gdalwarp`, choosing the datum transformation explicitly.
4. Verify against three known control points.
