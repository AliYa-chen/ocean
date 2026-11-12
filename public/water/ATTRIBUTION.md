# Ocean scene asset provenance

The root MIT License covers the project's original source code, documentation
and configuration. Third-party assets retain their own terms; they are not
relicensed under MIT by this repository. Source availability is not evidence
of permission to use or redistribute an asset. Unverified entries below need
permission from the relevant rights holder before reuse or redistribution.

Reference: https://www.threejswaterpro.com/ and the user-supplied recording
`SnowShot_Video_2026-09-24_09-39-25.mp4`. Assets below were observed in the public
demo's resource inventory on 2026-09-24 and are stored locally, with no runtime
dependency on the reference website.

## Reference demo assets

Base URL: `https://www.threejswaterpro.com/`

| Local file | Observed source path |
| --- | --- |
| models/dutch_ship_medium_2k.glb | models/dutch_ship_medium_2k.glb |
| models/island.glb | models/island.glb |
| models/buoy.glb | models/buoy.glb |
| models/rocks.glb | models/rocks.glb |
| models/seaweed.glb | models/seaweed.glb |
| models/grass.glb | models/grass.glb |
| models/fish.glb | models/fish.glb |
| textures/foam.jpg | assets/foam3-CyaGqCrv.jpg |
| textures/sand.jpg | assets/sand_diff_1k-CM4n0Z7n.jpg |
| textures/sand-normal.jpg | assets/sand_norm_1k-ChJ1a3sd.jpg |

`textures/foam-filaments.png` is a local grayscale coverage mask derived from
`textures/foam.jpg` by `scripts/create-foam-mask.py`. It retains the bright bubble
walls and removes the gray interior before GPU mipmapping. It is not an
additional asset downloaded from the reference demo.

The fish GLB embeds this attribution:
“Animated Low poly Fish”, by Atlas (https://sketchfab.com/Atlasmodels),
https://sketchfab.com/3d-models/animated-low-poly-fish-64adc2e5a4be471e8279532b9610c878,
licensed CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).

The other reference GLBs do not embed author/license metadata. Their public
availability does not establish a redistribution license; that status is unverified.
The reference textures `foam.jpg`, `sand.jpg` and `sand-normal.jpg` also have
unverified redistribution permissions. The derived `foam-filaments.png` mask
retains the licensing uncertainty of its source texture.

## Earlier assets with unverified provenance

The following files were carried over from the earlier project. Their author,
source and redistribution permission have not been established. Their presence
in this repository does not grant a license to them.

| Local file (relative to public/) | Status |
| --- | --- |
| jsm/draco/gltf/Shark.glb | Source and license unverified |
| jsm/draco/gltf/chenchuan.glb | Source and license unverified |
| jsm/draco/gltf/chenchuan2.glb | Source and license unverified |
| water/textures/cracks.png | Source and license unverified |
| water/textures/smokeMap.png | Source and license unverified |

## Draco utilities

The JavaScript and WebAssembly Draco utilities in `public/jsm/draco/gltf/`
are distributed under Apache License 2.0. A copy of the upstream license is
included at `public/jsm/draco/gltf/LICENSE`.
The upstream copyright-holder list is preserved in
`public/jsm/draco/gltf/AUTHORS` (Google Inc. and other contributors).
The four utility files match the Three.js r177 distribution byte for byte;
the license and author list were copied verbatim from google/draco 1.5.7.

Upstream: https://github.com/google/draco

Three.js distribution documentation:
https://github.com/mrdoob/three.js/blob/r177/examples/jsm/libs/draco/README.md

The `.glb` models in the same directory are separate assets and are not covered
by the Draco license.

## Unused earlier sky reference

`textures/day-sky.jpg` is an ACES-tonemapped 4096×2048 conversion of Poly Haven's
**Kloofendal 48d Partly Cloudy (Pure Sky)**, CC0:
https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky

Exact source, discovered through `https://api.polyhaven.com/files/kloofendal_48d_partly_cloudy_puresky`:
https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/4k/kloofendal_48d_partly_cloudy_puresky_4k.hdr

This photograph is retained as a previous visual reference; the ocean scene no
longer loads it. The current sky uses the Takram libraries and local assets described below,
composed by `VolumetricSky.ts`. Water normals are now derived from the GPU FFT displacement
fields; the scene no longer loads `/texture/water_normals.jpg`.

## Implementation

The water, buoyancy, caustics and UI are local implementations using the
project's Three.js r177. The commercial Three.js Water Pro / Sky Pro libraries and
their website bundles are not included. `Reflector` and the loaders come from
Three.js (MIT); its upstream license remains in the dependency distribution.


## Takram clouds and atmosphere (2026-09-29)

Source: https://github.com/takram-design-engineering/three-geospatial

Reference: https://takram-design-engineering.github.io/three-geospatial/?path=/story/clouds-3d-tiles-renderer-integration--tokyo

The actual open-source CloudsEffect/AerialPerspectiveEffect are integrated via
@takram/three-clouds 0.7.6, @takram/three-atmosphere 0.19.1 and
@takram/three-geospatial 0.9.1, with postprocessing 6.39.5. The upstream project
is MIT, Copyright (c) 2024 Shota Matsuda. A copy is in `takram/LICENSE`.

Assets are vendored from the exact upstream revisions used by the packages:

| Directory under takram/ | Files | Upstream asset revision |
| --- | --- | --- |
| clouds/ | local_weather.png, shape.bin, shape_detail.bin, turbulence.png | 45a1c6c1bb9fd38b3680fd120795ff4c32df68ff |
| atmosphere/ | transmittance.exr, scattering.exr, irradiance.exr, higher_order_scattering.exr | eac103980f20c0956f2d3215833e73514be08462 |
| core/ | stbn.bin | 9627216cc50057994c98a2118f3c4a23765d43b9 |

Download URL pattern:
`https://media.githubusercontent.com/media/takram-design-engineering/three-geospatial/{revision}/packages/{directory}/assets/{file}`.
See `scripts/fetch-cloud-assets.py` for reproducible downloads. No city tiles,
Google Maps assets, API credentials or website bundles are included.
