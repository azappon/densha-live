# Densha Live

A live 2D map of every train and metro in **Greater Tokyo** (179 lines, 49k trains on a weekday),
built as an installable web app (PWA) for the iPhone home screen.

- Night design: a dark, near-empty city where lines are faint threads of light and trains carry the brightness
- Semantic zoom: far out each train is a point with a soft "city pulse" glow (busy corridors light up); in the middle it
  stretches into a glowing capsule; up close it unfolds into its real number of real-length cars, bending through curves,
  with a headlight in front and a tail light behind
- Light trails along the track behind moving trains, longer when faster
- Underground view (tunnel button): tunnels light up and the surface network fades back; in the normal view tunnels are dashed
  and trains inside them are dimmed
- Smooth accelerate/cruise/brake motion between stops, all drawn on the GPU in one pass
- Tap a train for line, type, destination, next stop, delay and data source; **Follow** keeps it centred
- English / 日本語, Japan time, weekday vs weekend/holiday timetables (Japanese holidays computed)

## Where the positions come from

Every train runs from the full published timetables (49k weekday trains), and live data corrects it wherever an
operator publishes some. Live trains have a gently breathing headlight.

- **Through-running trains are one train.** 15k timetable legs are linked (e.g. Seibu Ikebukuro → Fukutoshin →
  Tokyu Toyoko → Minatomirai), so a train hands over seamlessly at the boundary station, Follow and the details card
  stay with it, the card shows the whole route, and a live delay reported on one operator carries on to the next legs.
- **Per-stop predictions for Toei** from ODPT's GTFS-RT TripUpdates (no key needed): each upcoming stop gets its
  own predicted time, so a train that is catching up or losing time moves accordingly instead of being shifted by
  one fixed delay.

| Operator | Live position | Notes |
|---|---|---|
| Toei Subway | ✅ ODPT, no key | `api-public.odpt.org`, works out of the box |
| Yokohama Subway | ✅ with free ODPT key | Also unlocks line status for Tokyo Metro, TWR, TX, Tama Monorail |
| JR East, Keikyu, Keio, Tobu | ✅ with ODPT **Challenge 2026** key | Contest-only data, available until **12 Mar 2027** |
| Tokyo Metro, Tokyu, Odakyu, Seibu, Keisei, Sotetsu, others | ⏱ timetable | No open live position feed |

This is the same approach as [Mini Tokyo 3D](https://minitokyo3d.com): its live sources are the same ODPT feeds
(Toei, plus Keikyu and Tobu from the Challenge), and the rest follows timetables with delay information.

## Run locally

Requires [uv](https://docs.astral.sh/uv/) (no Node needed).

```bash
uv run --no-project python -I tools/serve.py 8080
```

Open http://localhost:8080. Add `?at=08:15` to see the timetable at another Japan time (live feeds are off in that mode).

## Rebuild the data

```bash
uv run --no-project python -I tools/build_tokyo.py   # downloads Mini Tokyo 3D's published data build
uv run --no-project --with pillow python -I tools/make_icons.py
```

## Deploy (free) and add to the iPhone home screen

The app is plain static files in `public/`, so any HTTPS static host works. All paths are relative,
so it also runs from a sub-path such as `https://<user>.github.io/densha-live/`.

**GitHub Pages** (workflow included in `.github/workflows/pages.yml`):

1. Create an empty repository on GitHub (public, since free Pages needs a public repo) and push this folder to `main`.
2. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. The *Deploy to GitHub Pages* workflow runs on every push; the URL appears in the workflow run and under Settings → Pages.

**Cloudflare Pages** (alternative, works with private repos): **Workers & Pages → Create → Pages → Connect to Git**,
framework *None*, build command empty, **build output directory `public`**.

**On the iPhone:** open the HTTPS URL in **Safari** → Share → **Add to Home Screen**. It then opens full-screen like
an app, and the map, timetables and recently viewed tiles are cached for offline use.

## API keys (optional)

Keys are entered in **Settings** and stored only on the device.

- **ODPT developer key**: free sign-up at https://developer.odpt.org/ (approval usually takes a couple of business days).
- **ODPT Challenge 2026 key**: register for the contest at https://challenge2026.odpt.org/. The data is licensed for the contest and ends 12 Mar 2027.

## Data & licences

- Network and timetables: [Mini Tokyo 3D](https://github.com/nagix/mini-tokyo-3d) (MIT), sourced from the Public Transportation Open Data Center (ODPT)
- Live data: ODPT (Public Transportation Open Data Basic License / CC BY 4.0 / Challenge licence per dataset)
- Basemap: OpenFreeMap, © OpenMapTiles, © OpenStreetMap contributors
