# Cameras and gameplay graph

Everything here was measured on **2026-10-20 (about 22:45-23:30 UTC)** against the live Caltrans services.
Nothing is assumed to work unless a number below says it did. Re-run the scripts (section 8) to refresh.

Owner: Camera-Research. Data files: `shared/src/data/cameras.json`, `shared/src/data/network.json`.

---

## 1. Data sources and fields

| Source | URL | Use |
|---|---|---|
| CWWP2 District 4 JSON feed | `https://cwwp2.dot.ca.gov/data/d4/cctv/cctvStatusD04.json` (2.4 MB, `Access-Control-Allow-Origin: *`, `Last-Modified` was ~1 day old; docs say "as necessary") | Primary. Metadata + snapshot URL + HLS URL per camera. |
| Same data as CSV/TXT/XML | `cctvStatusD04.csv/.txt/.xml` | Not used; identical content per the docs. |
| CWWP2 documentation | `https://cwwp2.dot.ca.gov/documentation/cctv/cctv.htm`, `.../cctv-field-description.htm` | Field meanings. |
| ArcGIS FeatureServer layer | `https://caltrans-gis.dot.ca.gov/arcgis/rest/services/CHhighway/CCTV/FeatureServer/0` (`where=district=4`, `outSR=4326`, max 2000/page) | Cross-check only. Same attribute names (`index_`, `locationName`, `latitude`, `inService`, `currentImageURL`, `streamingVideoURL`, ...). |

Counts on the day: feed **760** D4 records (757 `inService=true`, 3 false; 760 with a snapshot URL;
**196** with an HLS URL, 195 of them in service). The ArcGIS layer returned **688** D4 features:
83 feed indexes are missing from the layer and 11 layer indexes are missing from the feed. The layer is a
lagging, partial copy, so the JSON feed is the source of truth. The layer's own `copyrightText` is
"Copyright (c) 2020 State of California"; its description is the same sentence as the CWWP2 page.

Feed record (`cctv`) fields that matter:

| Field | Meaning / quirk |
|---|---|
| `index` | Row number in the feed. **Not stable** (it is a position; it changes when cameras are added). We key on the `TVxxx` code instead. |
| `location.locationName` | `"TV102 -- I-580 : West of SR-24"`. The prefix (`TV102`, `TVD32`, `T028N`...) is the stable camera code; we derive our id as `d4-<code lowercased>`. |
| `location.latitude/longitude`, `route`, `direction`, `county`, `nearbyPlace`, `postmile`, `milepost`, `elevation` | As documented. `direction` is the direction of travel the camera sits on (may be `Median` or empty). Multi-view sites (e.g. `T028N/E/S/W`) are four separate records at one spot. |
| `inService` | `"true"/"false"/"Not Reported"`. **Does not reflect real health**: 266 of the 757 "in service" cameras serve a "Temporarily Unavailable" card (section 3.3). |
| `recordTimestamp` | Creation date of the *record*, not freshness. Values range 2018-2026. Useless for liveness. |
| `imageData.static.currentImageURL` | Static JPEG, always `https://cwwp2.dot.ca.gov/data/d4/cctv/image/<slug>/<slug>.jpg`. |
| `imageData.static.currentImageUpdateFrequency` | Minutes. **5** for 759 of 760 cameras. |
| `imageData.static.referenceImage1..12...URL`, `referenceImageUpdateFrequency` (60) | Hourly history frames (`.../previous/<slug>-N.jpg`). Not used. |
| `imageData.streamingVideoURL` | `https://wzmedia.dot.ca.gov/D4/<name>.stream/playlist.m3u8` or `Not Reported`. Listed streams are not always live (section 3.2). |
| `imageData.imageDescription` | Free text, almost always empty. |

`scripts/cameras/discover.mjs` normalizes all of this to `scripts/cameras/out/d4-all.json` (gitignored).

## 2. Usage conditions (what Caltrans actually says)

Read on 2026-10-20. Quoted verbatim.

1. **CWWP2 CCTV page**, `https://cwwp2.dot.ca.gov/documentation/cctv/cctv.htm`:
   - "The Closed Circuit Television (CCTV) files provided below describe the location and status of each Caltrans' CCTV located on the State Highway Network."
   - "These files are available for integration into your application and are available via the HTTPS protocol. **There is no charge for the use of this data.**"
   - "Please read the **Conditions Of Use** before using these data sets." (links to `https://dot.ca.gov/conditions-of-use`)
   - "**Caltrans traffic camera video footage and still images are neither retained nor archived.**" (a statement about Caltrans' own practice; we read it as a reason not to build an archive and not to commit images to the repo.)
2. **CWWP2 home page**, `https://cwwp2.dot.ca.gov/`: describes the portal as aggregating "near-real-time traveler information"
   in "common data formats for download", and lists its own **"CCTV Streaming - Displays CCTV streaming sites using CWWP2 CCTV JSON data"**
   tool. So public display of the streams/snapshots from the published JSON is the intended use. No API key, registration or rate limit is described.
3. **Caltrans Conditions of Use**, `https://dot.ca.gov/conditions-of-use` (dated July 19, 2021). Parts relevant to us:
   - OWNERSHIP: "In general, information presented on this website, unless otherwise indicated, is considered in the public domain. It may be distributed or copied as permitted by law. However, the California Department of Transportation does make use of copyrighted data (e.g., photographs) which may require additional permissions prior to your use."
   - LIMITATION OF LIABILITY: "The California Department of Transportation makes no claims, promises, or guarantees about the absolute accuracy, completeness, or adequacy of the contents of this website..." with no warranty of any kind.
   - LINKS TO OTHER SITES: "...Unauthorized attempts to modify any information stored on this system, to defeat or circumvent security features, or to utilize this system for other than its intended purposes are prohibited and may result in criminal prosecution."
4. No separate image licence, attribution requirement, hotlinking rule or rate limit was found on any CWWP2 page. `https://cwwp2.dot.ca.gov/robots.txt`
   returns HTTP 500 (no file); `https://wzmedia.dot.ca.gov/robots.txt` returns a Wowza banner page, not a robots file.

**What we concluded (not legal advice):**
- Linking to and displaying the snapshots/streams in a browser game, and reading the JSON feed, are within the stated purpose ("integration into your application", no charge).
- We do **not** bypass anything: every request below is a plain anonymous GET/HEAD with no cookies, tokens or spoofed headers. Servers answer identically for any `Origin`/no `Origin`, so there is no hotlink protection to circumvent.
- We do **not** commit downloaded images to the repo (the Conditions flag possible third-party copyright and Caltrans itself does not archive). Downloaded
  snapshots for visual review went to a scratch directory outside the repo.
- Be a polite client: <= 4 concurrent requests, a delay between requests, cache aggressively (cameras only refresh every 5 minutes), and show Caltrans as the source in the UI.
- Never present simulated imagery as live; label source ("Caltrans CCTV, snapshot 3 min ago") on every real feed.

## 3. Technical access findings

All checks sent `Origin: http://localhost:5173`.

### 3.1 Snapshots (`cwwp2.dot.ca.gov/.../*.jpg`)

| Check | Result |
|---|---|
| Status | HTTP 200 for **757/757** in-service snapshot URLs (HEAD census). 200 is returned even when the camera is down (3.3). |
| Content-Type | `image/jpeg`, 320x260 px, 2.7-93 KB (median 48 KB; 78 real frames are < 10 KB because they are hazy/low-detail, not broken). The bottom ~8% of every frame is a burned-in timestamp bar ("Tuesday, October 20, 2026  15:59:07 PDT"); `placement` boxes stay above y = 0.905. Many frames also have a camera title burned in at the top. |
| CORS | `Access-Control-Allow-Origin: *` on every checked snapshot (all 36 curated, plus 757/757 in the HEAD census). `<img>` works regardless; `<img crossorigin="anonymous">` + canvas `getImageData`/`toDataURL`/WebGL texture upload **also works**. `OPTIONS` returns 405 but simple GETs need no preflight. |
| Freshness | `Last-Modified` was <= 5 minutes old on 755 of 757 snapshots (median 3 min); 2 cameras were stale for over an hour (one for ~280 days). A fresh `Last-Modified` does **not** prove a real image (see 3.3). Cadence: 3.4. |
| Hotlinking | Identical 200 with `Origin: https://example.com` + `Referer`, with a different origin, and with no `Origin`. |
| HTTPS | Everything is https; no mixed-content issue. |

### 3.2 HLS streams (`wzmedia.dot.ca.gov`, Wowza 4.11)

| Check | Result |
|---|---|
| Master playlist | `application/vnd.apple.mpegurl`, one rendition: H.264 Main, **655x480, ~530 kbps**. |
| Media playlist | `EXT-X-TARGETDURATION:11`, 3 segments of **~9.6-10.7 s** (so about 30 s behind live); `.ts` segments start with the MPEG-TS sync byte 0x47. |
| CORS | `Access-Control-Allow-Origin: *` on master, media playlist and segments; `Allow-Headers` includes `Range`; `OPTIONS` -> 200. hls.js (MSE, XHR/fetch) is therefore fine from a browser. Safari can play the m3u8 natively. `Access-Control-Allow-Credentials: true` is sent but irrelevant without credentials. |
| Availability | See the stream census below. A **listed** stream is not a **working** stream: some playlist URLs 404. |
| Curated set | 36 cameras: 19 have a published HLS URL. **Playable at the final curation check (23:15 UTC): 14** (playlist 200 + first segment 200 + CORS + valid TS). 5 listed streams returned **HTTP 404** (`d4-tve73`, `d4-tve83`, `d4-tv425`, `d4-tv433`, `d4-tvb11`). Streams flap: an earlier run 20 minutes before saw 15 playable (`d4-tvb11` was 200) and `d4-tv121` went 404 -> 200 between two checks. |

**Census of every published D4 stream** (`census.mjs --streams`, 195 in-service cameras with an HLS URL): **108 (55%) answered 200 with a valid, live media playlist** and CORS `*`;
**87 (45%) returned HTTP 404**, each after a slow ~8 s (a backend timeout), so a dead stream URL costs a client 8 s unless it uses its own short timeout. Playlists hold 1-3 segments (rolling).
Of the 108 working streams, 93 also have a real snapshot and 15 have a "Temporarily Unavailable" snapshot: the snapshot and stream pipelines fail independently, so a stream can work when the JPEG does not (and vice versa).
No tokens, cookies or signed URLs were needed for any stream request.

### 3.3 Failure modes seen (important for the adapter)

1. **"Temporarily Unavailable" card**: HTTP 200, fresh `Last-Modified`, 320x260 white JPEG with dark-blue text and a fresh timestamp bar,
   **13.3-13.7 KB**. **266 of 757** in-service snapshots (35%) were this card during the HEAD census (heuristic on `Content-Length`).
   `inService=true` is no protection. `scripts/cameras/lib/probe.mjs#looksLikePlaceholder` flags it; verified manually on 36+ frames.
2. **"No video"**: black frame with "No video" in the corner (seen on `TV958`, `TV959`, Dumbarton). 14-22 KB, so the size heuristic misses it.
3. **Static/noise frame**: pure TV snow, 42 KB (seen on `TVE05`, San Mateo Bridge mid-span; we swapped it out). Also missed by size.
4. **Obstructed/unusable optics**: tree foliage filling the frame (`TVC31`), sky only (`TV939`), heavy blur (`TV967`), lens scratch (`TV433`), lens flare (`TVC42`),
   washed-out (`TV304`), very dark (`TV957`). Some are time-of-day dependent (all frames reviewed at ~16:00 PDT).
5. **HLS 404** for listed streams, and streams can flap (`TV121`'s stream 404'd once and was 200 minutes later).
6. Servers can be slow; use timeouts (we use 15-20 s).

Cases 2-4 need pixel inspection. Because CORS is open, that can run **in the browser** (canvas luminance/variance) or later on the server with `sharp`.
The curated list was chosen to avoid all of the above at curation time; `verified.imageIsPlaceholder` is recorded per camera.

### 3.4 Update cadence

Sampled `Last-Modified` on 6 cameras every ~30 s for ~7 minutes (14 polls each). Every camera's timestamp advanced in **exact 5-minute steps**
(e.g. `d4-tvr03`: 23:03:08 -> 23:08:08 -> 23:13:08; `d4-tvd01`: 23:03:08 -> 23:08:07 -> 23:13:07), each camera on its own phase. That matches `currentImageUpdateFrequency = 5`.
So a snapshot is at most ~5 min old and polling more often than once a minute gains nothing; use `If-Modified-Since`/`ETag` (the server sends both) or just poll `HEAD`/GET every 60-90 s.

## 4. Curated cameras (36)

Selection lives in `scripts/cameras/selection.json` (by Caltrans code). Visual review was done by downloading every snapshot to a scratch
directory and looking at it, then drawing the placement boxes on top of it. "Snapshot" = HTTP 200 + real image (not a placeholder). "HLS" = verified playable
(playlist + segment + CORS), "listed/404" = published but not working, "none" = Caltrans publishes no stream.

| Node | Camera id | Name | Route / dir | Tags | Snapshot | HLS | Notes |
|---|---|---|---|---|---|---|---|
| n-sr37 | d4-tv136 | SR-37 : Sonoma Raceway (SR-121) | SR-37 West | freeway, causeway, north-bay | OK (46 KB) | OK | grey, hazy marsh view; wide open ground |
| n-san-rafael | d4-tve83 | US-101 : San Rafael / I-580 | US-101 East | freeway, interchange, north-bay | OK (57 KB) | listed, HTTP 404 | sharp, daylight; looks along US-101 toward Mt. Tamalpais |
| n-marin-city | d4-tve74 | US-101 : Marin City | US-101 North | freeway, north-bay | OK (33 KB) | none | sharp; Waldo Tunnel mouth visible top-left |
| n-spencer | d4-tve73 | US-101 : Spencer Avenue (Waldo Grade) | US-101 North | freeway, tunnel-approach, north-bay | OK (28 KB) | listed, HTTP 404 | sharp; overpass deck across the top |
| n-gg-north | d4-tve70 | US-101 : Golden Gate Bridge North (Vista Point) | US-101 North | bridge, landmark, north-bay | OK (8 KB) | none | Golden Gate Bridge deck/towers and SF skyline visible; small file (8 KB) but clear |
| n-rsr-bridge | d4-tvr03 | I-580 : Richmond-San Rafael Bridge Truss | I-580 West | bridge, north-bay | OK (25 KB) | OK | high-angle view along the RSR bridge deck over the water |
| n-vallejo | d4-tv962 | I-80 : Vallejo (Redwood Pkwy) | I-80 West | freeway, interchange, north-bay | OK (41 KB) | none | clear freeway view looking west; replaced TV939 (sky only) |
| n-carquinez | d4-tv972 | I-80 : Carquinez Bridge (west approach) | I-80 West | bridge, north-bay | OK (41 KB) | none | symmetric freeway between two hills; grey |
| n-benicia | d4-tv815 | I-780 : Benicia / I-680 Split | I-780 East | freeway, interchange, north-bay | OK (45 KB) | OK | dry grass verge right of the road; sparse traffic |
| n-octavia | d4-tv301 | US-101 : Octavia St (Central Freeway) | US-101 South | freeway, downtown, sf | OK (51 KB) | OK | **sf approach**; slightly out of focus; overhead Bay Bridge signs |
| n-soma-split | d4-tv304 | I-80 : SoMa / US-101 Split | I-80 East | freeway, interchange, downtown, sf | OK (41 KB) | OK | **sf approach**; washed out / low contrast; dense SoMa traffic |
| n-bay-bridge-sf | d4-tvd01 | I-80 : Bay Bridge West Approach (Fremont St) | I-80 West | bridge, downtown, sf | OK (47 KB) | OK | **sf approach**; clear, gantry over Bay Bridge approach |
| n-us101-alemany | d4-tv308 | US-101 : Alemany / I-280 | US-101 South | freeway, interchange, sf | OK (52 KB) | OK | sharp; shrubs on the left |
| n-bay-bridge-west | d4-tvd33 | I-80 : Bay Bridge SAS Tower West | I-80 Median | bridge, landmark | OK (47 KB) | OK | looks through the SAS tower steelwork; SF skyline far |
| n-bay-bridge-east | d4-tvd35 | I-80 : Bay Bridge East Span Skyway | I-80 West | bridge, landmark | OK (44 KB) | none | bridge deck + steel suspension cables, clear |
| n-maze | d4-tva71 | I-580 : MacArthur Maze (I-80 junction) | I-580 East | interchange, maze, oakland | OK (36 KB) | none | **oakland approach**; excellent: wide interchange, ramps, ramp curve, hills |
| n-ashby | d4-tv121 | I-80 : Ashby Avenue (Berkeley) | I-80 West | freeway, east-bay | OK (9 KB) | OK | dense traffic; small file (9 KB) but clear |
| n-san-pablo | d4-tv510 | I-80 : San Pablo / El Portal | I-80 East | freeway, east-bay | OK (61 KB) | none | dense traffic, concrete gore areas |
| n-richmond-580 | d4-tv521 | I-580 : Richmond Cutting Blvd | I-580 West | freeway, east-bay | OK (5 KB) | OK | nearly empty wide roadway; hazy (5 KB) |
| n-oak-980 | d4-tv103 | SR-24 : I-980 Junction (Oakland) | SR-24 West | freeway, interchange, oakland | OK (8 KB) | OK | **oakland approach**; Oakland skyline, BART tracks, empty flyover; small file but clear |
| n-oak-880 | d4-tv111 | I-880 : Broadway (Oakland) | I-880 South | freeway, downtown, oakland | OK (57 KB) | none | **oakland approach**; wide freeway + curved elevated ramp |
| n-caldecott | d4-tv606 | SR-24 : Caldecott Tunnel East (Gateway Blvd) | SR-24 East | tunnel, freeway, east-bay | OK (48 KB) | none | Caldecott east portal gap between hills; far away |
| n-walnut-creek | d4-tv208 | I-680 : Mt Diablo Blvd (Walnut Creek) | I-680 North | freeway, east-bay | OK (49 KB) | none | overpasses and ramps; hazy |
| n-hayward-238 | d4-tvb17 | I-880 : Hayward / SR-238 | I-880 South | freeway, east-bay | OK (23 KB) | OK | view from an overpass; houses and trees at left |
| n-fremont-84 | d4-tvb11 | I-880 : Fremont / SR-84 | I-880 South | freeway, interchange, east-bay | OK (7 KB) | listed, HTTP 404 | wide freeway, gore area; small file (7 KB) but clear |
| n-sm-bridge | d4-tve04 | SR-92 : San Mateo Bridge (east-bound span) | SR-92 East | bridge, peninsula | OK (14 KB) | none | clear view of the bridge deck over the water, greyscale |
| n-hillsdale | d4-tv425 | US-101 : San Mateo / Hillsdale | US-101 North | freeway, peninsula | OK (26 KB) | listed, HTTP 404 | freeway with marsh/water on the right; a big tree blocks part of the view |
| n-280-canada | d4-tv446 | I-280 : Canada Road (Woodside) | I-280 North | freeway, peninsula | OK (29 KB) | none | **stanford approach**; grassy median, hills; clear |
| n-willow-101 | d4-tv433 | US-101 : Willow Road (Menlo Park) | US-101 North | freeway, peninsula | OK (24 KB) | listed, HTTP 404 | lens scratch across the sky; freeway + street |
| n-dumbarton | d4-tv957 | SR-84 : Dumbarton Bridge Mid-Span | SR-84 | bridge, peninsula | OK (38 KB) | none | very dark (night-vision look), deck only barely visible |
| n-univ-84 | d4-tv949 | SR-84 : University Ave (East Palo Alto) | SR-84 North | freeway, stanford, peninsula | OK (55 KB) | OK | **stanford approach**; flat marsh, bike trail, Dumbarton Bridge on the horizon |
| n-embarcadero-101 | d4-tv437 | US-101 : Embarcadero Road (Palo Alto) | US-101 South | freeway, stanford, peninsula | OK (70 KB) | none | sharp, heavy traffic, Embarcadero overpass; replaced TVC31 (foliage) |
| n-el-camino-emb | d4-t028n | SR-82 : El Camino Real @ Embarcadero (Stanford) | SR-82 North | surface, stanford, peninsula | OK (63 KB) | none | **stanford approach**; oak grove across El Camino Real, crosswalk; Stanford-adjacent |
| n-sj-880-101 | d4-tvc62 | US-101 : I-880 Junction (San Jose) | I-880 South | freeway, interchange, downtown, south-bay | OK (68 KB) | none | **sanjose approach**; wide sharp freeway, trucks |
| n-sj-alameda | d4-tvb76 | I-880 : The Alameda (San Jose) | I-880 South | freeway, downtown, south-bay | OK (70 KB) | OK | **sanjose approach**; dry dirt lot and ramps; clear |
| n-sj-i280 | d4-tvc42 | I-280 : I-880 / SR-17 Junction (San Jose) | I-280 North | freeway, interchange, south-bay | OK (38 KB) | none | **sanjose approach**; sun glare / lens flare over a distant interchange |

### Placement regions

`placement` boxes are normalized to the 320x260 frame (origin top-left). Interpretation used (the FX agent should match): the box is the **ground region where the
figure's feet can land**; the figure extends upward by `scale * frameHeight`. `scale` is figure height as a fraction of frame height at that spot (0.06 far away, 0.2-0.4 in the near foreground).
Boxes sit on road shoulders, medians, gore areas, lanes in the mid-distance, overpass decks, roadside dirt/grass, a tunnel gap (`d4-tve74`, `d4-tv606`), bridge decks and a crosswalk (`d4-t028n`).
All boxes keep out of the bottom timestamp bar. 1-3 boxes per camera. For any camera with a missing/unusable image fall back to `selection.json#defaultPlacement`
(lower-middle area, scale 0.25). No curated camera needed the fallback.

## 5. Gameplay graph (`network.json`)

- **36 nodes**, one per curated camera (every node has a `cameraId`), **48 edges** (29 freeway, 12 bridge, 2 tunnel, 5 surface), ~632 km of edge length.
- Regions: north-bay 9, east-bay 11, sf 5, peninsula 8, south-bay 3. (The two Bay Bridge span nodes are tagged east-bay/sf by which shore they belong to.)
- Edges follow real routes between neighbouring cameras: US-101 Marin / Waldo Tunnel / Golden Gate Bridge, Richmond-San Rafael Bridge (I-580), Carquinez Bridge (I-80),
  I-780 / Benicia-Martinez Bridge (I-680), Caldecott Tunnel (SR-24), Bay Bridge (I-80, three nodes), the MacArthur Maze, I-880, San Mateo Bridge (SR-92),
  Dumbarton Bridge (SR-84), US-101 / I-280 / El Camino Real / Sand Hill Road on the Peninsula, and I-880 / I-280 into San Jose. `lengthKm` = great-circle x 1.2.
  Long edges (e.g. 60 km I-680 Walnut Creek -> Fremont, 45 km I-280) exist because we are limited to ~36 cameras; a travel-time model should clamp or scale by `lengthKm`.
- Degree: 2:16, 3:16, 4:4 nodes. No node above 4. Graph is connected, has **no cut edge and no articulation node**.
- **`tactical` coordinates**: 0..1000 on both axes, **x east, y increasing southward (screen coordinates), so north is at the top**. Hand-placed to keep the Bay recognizable:
  Marin / North Bay top-left, Carquinez-Benicia top-right, the Golden Gate / SF peninsula down the left, Bay Bridge across the middle, Oakland / East Bay on the right,
  Peninsula and San Jose at the bottom. Minimum node spacing is 61 units; no edge passes within 18 units of a non-endpoint node; HQs do not overlap nodes.

### Headquarters (not graph nodes)

A monster on an approach's `fromNode` can attack that approach's door. Three approaches per HQ, from three distinct nodes reached via different corridors:

| HQ | Approach (fromNode -> door) | Corridor it represents |
|---|---|---|
| `hq-stanford` (Stanford Research Park Annex, 37.4275,-122.1697) | `n-el-camino-emb` -> "Palm Drive Main Gate" | El Camino Real / Embarcadero Rd, fed by US-101 and from San Jose via El Camino |
| | `n-univ-84` -> "Bayfront Loading Dock" | SR-84 / University Ave, fed by the Dumbarton Bridge (East Bay) and US-101 |
| | `n-280-canada` -> "Sand Hill Service Gate" | I-280 hills route, via Sand Hill Rd |
| `hq-sf` (Downtown SF Operations Center, 37.7879,-122.4075) | `n-bay-bridge-sf` -> "Embarcadero Freight Dock" | Bay Bridge / East Bay |
| | `n-soma-split` -> "Division Street Roll-Up Door" | US-101 / I-280 from the south |
| | `n-octavia` -> "Van Ness North Gate" | Golden Gate Bridge / Marin |
| `hq-oakland` (Oakland Port Command, 37.8044,-122.2712) | `n-maze` -> "Maze Loading Bay" | Bay Bridge / I-80 from the north |
| | `n-oak-980` -> "Telegraph Service Gate" | SR-24 through the Caldecott Tunnel |
| | `n-oak-880` -> "Jack London Dock Door" | I-880 from the south (Hayward / Fremont / San Mateo Bridge) |
| `hq-sanjose` (San Jose Data Vault, 37.3382,-121.8863) | `n-sj-880-101` -> "North First Street Gate" | US-101 / I-880 from Fremont and the Peninsula |
| | `n-sj-alameda` -> "The Alameda Side Door" | El Camino Real / The Alameda from Palo Alto |
| | `n-sj-i280` -> "Stevens Creek Service Entrance" | I-280 from the Peninsula hills |

### Spawns

`spawnNodes = [n-sr37, n-vallejo, n-san-rafael, n-rsr-bridge]`, all in the North Bay (the only region far from all four HQs in a 36-node graph).

**Hop convention** (the validator enforces it): HQs are not nodes, so `hqHops(node, HQ) = 1 + min over the HQ's approaches of graphHops(node, approach.fromNode)`
(the final +1 is the attack on the door). Required: `hqHops >= 5` from every spawn to every HQ. If the engine prefers to measure to the `fromNode` itself
it will see 4 on four of the sixteen pairs; ask Camera-Research before raising the bar, because that needs 1-2 more nodes.

```
hqHops from spawn      hq-stanford  hq-sf  hq-oakland  hq-sanjose
n-sr37                      7         6        6          6
n-vallejo                   6         7        5          5
n-san-rafael                8         5        6          7
n-rsr-bridge                9         6        5          8
```

Node-disjoint corridors from each spawn to each HQ's approach set (max-flow): 2-3 for every pair (min required 2).

**Design rationale / balance notes**
- Every HQ has three approach nodes with different neighbour sets, so no HQ is a one-entry dead end, and every approach is reachable along at least two node-disjoint routes from every spawn.
- North-bay chokepoints are real bridges: Golden Gate (single edge into SF), Richmond-San Rafael, Carquinez, Benicia-Martinez. Southbound traffic must go through SF (Golden Gate -> Octavia),
  through the Oakland side (Richmond -> Berkeley -> Maze) or around via Benicia / Walnut Creek / Caldecott. Peninsula and San Jose are separated from the East Bay by the San Mateo and Dumbarton bridges.
- **Imbalance to be aware of**: all spawns are in the north, so SF and Oakland are 5-7 hqHops away and Stanford / San Jose are 6-9. Suggested: scale monster speed or pick the spawn per HQ so that the
  expected arrival time is similar (e.g. choose among spawns with the smallest distance for the far HQs).
- The three approach nodes of an HQ are close to each other in the graph (SF's three are mutually adjacent, so are San Jose's, Oakland's Maze touches both others). That is intentional: once a monster is near,
  it can switch doors, forcing the defenders to spread doors/traps.

## 6. Re-running

All scripts are plain Node ESM with no dependencies (Node 18+; developed on 24). From the repo root:

```bash
node scripts/cameras/discover.mjs            # fetch + normalize all D4 cameras -> scripts/cameras/out/d4-all.json
node scripts/cameras/census.mjs [--streams]  # optional: HEAD all snapshots (~1 min), GET all HLS playlists -> out/d4-census.json, out/d4-stream-census.json
node scripts/cameras/curate.mjs [--refresh] [--offline] [--images-dir <dir outside repo>]
                                             # selection.json -> shared/src/data/cameras.json with a real `verified` block
node scripts/cameras/build-network.mjs       # network-design.json + cameras.json -> shared/src/data/network.json
node scripts/cameras/validate-network.mjs    # schema, references, connectivity, degrees, spacing, spawn distances, corridors; exit 1 on failure
```

- Add / swap a camera: edit `selection.json` (code, name, tags, placement), run `curate`, update the node's `code` in `network-design.json`, run `build-network` then `validate-network`.
- `curate` warns about placeholders, non-200 snapshots and non-playable listed streams. `--offline` keeps the previous `verified` blocks when you have no network.
- `cameras.json` records extra (backwards-compatible) `verified` keys: `imageBytes`, `imageIsPlaceholder`, `streamPlayable`. `streamUrl` is the URL Caltrans **publishes**;
  use it only when `verified.streamPlayable` is true (or re-probe at runtime).
- Schema: field names/types follow `docs/CONTRACT.md` exactly; the only additions are the three optional `verified` keys above. `network.json` carries no axis note, so this document is the reference: tactical y grows downward.

## 7. Camera adapter (implemented, wave 2)

Code: `server/src/cameras/` (`caltrans.ts` service, `classify.ts` pure classifier, `simulation.ts`), client `client/src/feeds/`.
Tests: `server/test/cameras.*.test.ts`, `client/src/feeds/__tests__`. The camera system **never decides whether the game is playable**:
it only reports which real imagery is trustworthy; the match runs identically on 36 simulated feeds.

### 7.1 Design

- **No media proxy.** Browsers load Caltrans snapshots/HLS directly (CORS `*`). The server only health-checks (36 snapshot probes + 19 stream probes per ~5 min).
- **`CAMERA_MODE`** (default `auto` when unset): `auto` = LIVE where an HLS stream is verified, else SNAPSHOT, else SIMULATED. `live` = like auto but only verified-live cameras
  show real imagery (the rest SIMULATED). `snapshot` = stills only, HLS never probed. `simulation` = zero network (`SimulationCameraService`). Unknown value -> simulation.
- **Independent of the game.** The service has its own timers, never touches the engine, and every probe is wrapped so a network failure becomes a per-camera status, never an exception.
  Fictional sabotage stays `CameraGameStatus` (engine); real availability is `CameraSourceStatus` (here). The two are separate fields and separate overlays.
- **Polite scheduling.** Each camera/probe kind has its own `nextAt`; healthy cameras are re-checked every `CAMERA_CHECK_INTERVAL_MS` (300 s, +-10 % jitter). At most `CAMERA_CONCURRENCY`
  (3) requests in flight, >= 150 ms between starts (the scheduler starts one probe per 250 ms wake-up), 8 s timeout (`CAMERA_TIMEOUT_MS`). Failing probes back off exponentially
  (snapshots 30 s, 60 s, ... capped 10 min; streams 60 s ... capped 15 min). A **per-host circuit breaker** opens after 6 distinct cameras get no answer from a host (30 s doubling to 5 min;
  half-open = one trial request); any HTTP answer, even 404, proves the host is up (dead stream URLs answer 404 after ~8 s and must not trip it).
- **Snapshot classification** (`classify.ts`): HTTP 2xx, `image/*`, JPEG magic, 1 KB..1.5 MB, decodable (pure-JS `jpeg-js`, <= 4 MP), then pixel metrics over the frame minus the bottom 10 % timestamp bar:
  *placeholder* (13.0-14.1 KB body with >= 50 % near-white pixels, or >= 85 % white with std >= 25), *blank* (>= 90 % white), *black* (>= 90 % dark or mean < 14 and std < 12), *uniform* (std < 8),
  *snow* (high-frequency energy / std > 0.65 and > 20), *stale* (Last-Modified older than 15 min against the response `Date`). Calibrated on 36 curated frames + 6 placeholders + 8 small/odd frames
  (real frames: mean 44-161, std 15-86, hf/std 0.04-0.47; placeholder: mean 239, std 57, 93 % white; "no video": mean 11, std 1).
- **HLS probe**: playlist must be `#EXTM3U`, master -> first variant, media playlist with >= 1 segment and no `#EXT-X-ENDLIST`, then a `Range: bytes=0-187` GET of the last segment must start with the TS sync byte `0x47`
  (a server that ignores Range costs 188 bytes, the body is cancelled). Probed for **every camera with a published stream URL**: curated `streamPlayable` cameras are trusted after 1 success, the others
  (404 at curation time) only after 2 consecutive successes. The client trusts the server's `streamUrl` (runtime-verified) rather than the curation flag.
- **Flap tolerance**: *hard* content evidence (placeholder/black/snow/stale/bad playlist) downgrades at once; *soft* evidence (timeout, HTTP error) needs `failThreshold` = 2 consecutive failures before
  a good source is dropped. A success upgrades immediately (streams: see above).

### 7.2 Status rule (per camera, in `CameraSourceStatus`)

| mode | When | Fields |
|---|---|---|
| `live` | snapshot good AND HLS verified | `snapshotUrl` (`...jpg?v=<Last-Modified s>`, one URL per Caltrans frame), `streamUrl`, `imageAt`, `reason` |
| `snapshot` | snapshot good, no verified stream (or `snapshot` mode) | `snapshotUrl`, `imageAt`, `reason` ("snapshot good (stream playlist HTTP 404)") |
| `simulated` | everything else: placeholder, black, snow, stale, HTTP/timeout, host unreachable, not probed yet, `live` mode without a stream | URLs null, `reason` (human) and `error` (probe kind) |
| `offline` | **never emitted by the service.** Reserved for an explicit operator-disabled card | - |

Why no `offline`: a real-world outage replaced by an "offline" card would be indistinguishable from the in-game `NO POWER`/sabotage look and would leave the player staring at nothing; a labelled SIMULATED
feed keeps the monster compositing and the game readable while being honest. All cameras start `simulated` ("checking Caltrans source...") and are upgraded only after a probe, so nothing real is claimed unverified.
`live` requires a good snapshot too because thumbnails (and the snapshot fallback) need one: a camera whose stream works but whose JPEG is the "Temporarily Unavailable" card is reported `simulated`.
Changes are coalesced (300 ms) and broadcast through the existing `cameras:status` event to everyone (public info).

### 7.3 Ops endpoints

`GET /api/cameras` -> `CameraSourceStatus[]`. `GET /api/cameras?detail=1` -> `{ health, cameras: [{ ...status, name, diagnostics: { snapshot, stream } }] }` (probe state, fails, next check).
`GET /api/health` -> `cameras: { mode, counts, checks, lastCheckAt, hosts: [{ host, breakerOpen, failStreak }] }`.
Env: `CAMERA_MODE`, `CAMERA_CHECK_INTERVAL_MS`, `CAMERA_TIMEOUT_MS`, `CAMERA_CONCURRENCY`, `CAMERA_REFRESH_MS`, and the test hook `CAMERA_PROBE_ORIGIN` (send all probes to another origin, e.g. `http://10.255.255.1:81`, to rehearse an outage).

### 7.4 Client (`client/src/feeds/CameraFeed.tsx`)

- Snapshots: `SnapshotLayer` fetches the next frame off-DOM (`fetch` blob + `decode()`), runs the same pixel check on a 40x32 downscale (a "Temporarily Unavailable" card never replaces a good frame),
  then **cross-fades** (800 ms) it over the current `<img crossOrigin="anonymous">`. Refresh every `refreshMs` (60 s) with a bucket-aligned `&r=` param so every client asks for the same URL; also reloads when the server
  publishes a new `?v=`. Pauses while the tab is hidden or live video covers it. The age shown comes from the response `Last-Modified`.
- Live: only the enlarged **main** feed uses hls.js (lazy `import('hls.js')`, no low-latency, 8 s buffer, short timeouts). Thumbnails stay on snapshots. The badge turns LIVE only once the video is actually `playing`.
- Local fallback without waiting for the server: hls.js 2 fatal errors / 15 s no playback / 12 s stall -> snapshot; image fetch failures (2-3 tries) or a card/black frame -> **simulated**.
- Badges (`data-testid="feed-source-badge"`, `data-source-mode`): **LIVE** (solid red, pulsing), **SNAPSHOT . 4m ago** (cyan; thumbnails show `4m`), **SIMULATED** (dashed amber outline; the FX layer also draws its own watermark),
  **OFFLINE** (grey, server-sent only). Main feeds of real cameras carry "Source: Caltrans CCTV". Badge colour/state never depends on `CameraGameStatus`.

### 7.5 Measured behaviour (2026-10-20, about 17:00-17:15 PDT, real network)

- `CAMERA_MODE=auto`: after about 25 s all 36 cameras were classified: **14 live, 22 snapshot, 0 simulated** (the 5 curated-but-404 streams stayed snapshot; one more flapped to playable once and was held at snapshot
  until its second success). Dead stream URLs answer after ~8 s, i.e. they hit the 8 s timeout: they are retried at 60 s / 120 s / ... only.
- Outage rehearsal (`CAMERA_PROBE_ORIGIN=http://10.255.255.1:81 CAMERA_TIMEOUT_MS=3000`): 36/36 `simulated` ("host unreachable"), 15 requests in total before both breakers opened, SIMULATED badges everywhere,
  match kept ticking. With the browser itself blocked from Caltrans (server still says live/snapshot) the client demoted every feed to SIMULATED within about 8 s.

### 7.6 Still true from the research

- Do not trust `inService`, `recordTimestamp` or the mere presence of `streamingVideoURL`; refresh the discovery feed (`discover.mjs`) on deploy and fail soft to the last good `cameras.json`.
- Never commit/archive Caltrans images; the server keeps nothing but the last probe verdict in memory.
