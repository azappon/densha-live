"""Build compact Tokyo network + timetable files for the app.

Source: the published data build of Mini Tokyo 3D (https://minitokyo3d.com, MIT
licensed, data originally from the Public Transportation Open Data Center).

Run:  uv run --no-project python -I tools/build_tokyo.py
"""
import gzip
import json
import math
import sys
import urllib.request
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / 'tools' / '.cache' / 'mt3d'
OUT = ROOT / 'public' / 'data' / 'tokyo'
BASE_URL = 'https://minitokyo3d.com/data/'
FILES = ['features.json.gz', 'railways.json.gz', 'stations.json.gz', 'train-types.json.gz',
         'rail-directions.json.gz', 'timetable-weekday.json.gz', 'timetable-holiday.json.gz']

# Geometry built for this zoom level keeps parallel lines ~100 m apart, which
# reads well from city overview (z11) to street level (z15).
GEOM_ZOOM = 14
SIMPLIFY_M = 2.0
# Service day starts at 03:00: earlier times belong to the previous day
DAY_START_MIN = 180

OPERATORS = {
    'JR-East': ('JR東日本', 'JR East'), 'JR-Central': ('JR東海', 'JR Central'),
    'TokyoMetro': ('東京メトロ', 'Tokyo Metro'), 'Toei': ('都営', 'Toei'),
    'TWR': ('りんかい線', 'TWR'), 'Keio': ('京王', 'Keio'), 'Keikyu': ('京急', 'Keikyu'),
    'Keisei': ('京成', 'Keisei'), 'Hokuso': ('北総鉄道', 'Hokuso'), 'Shibayama': ('芝山鉄道', 'Shibayama'),
    'Tobu': ('東武', 'Tobu'), 'Chichibu': ('秩父鉄道', 'Chichibu'), 'Seibu': ('西武', 'Seibu'),
    'Odakyu': ('小田急', 'Odakyu'), 'OdakyuHakone': ('箱根登山', 'Hakone Tozan'), 'Tokyu': ('東急', 'Tokyu'),
    'Minatomirai': ('みなとみらい線', 'Minatomirai'), 'Sotetsu': ('相鉄', 'Sotetsu'),
    'YokohamaMunicipal': ('横浜市営地下鉄', 'Yokohama Subway'), 'SaitamaRailway': ('埼玉高速鉄道', 'Saitama Railway'),
    'MIR': ('つくばエクスプレス', 'Tsukuba Express'), 'ToyoRapid': ('東葉高速', 'Toyo Rapid'),
    'KantoRailway': ('関東鉄道', 'Kanto Railway'), 'Ryutetsu': ('流鉄', 'Ryutetsu'), 'Kominato': ('小湊鐵道', 'Kominato'),
    'Isumi': ('いすみ鉄道', 'Isumi'), 'Choshi': ('銚子電鉄', 'Choshi'), 'KashimaRinkai': ('鹿島臨海鉄道', 'Kashima Rinkai'),
    'Hitachinaka': ('ひたちなか海浜鉄道', 'Hitachinaka'), 'Moka': ('真岡鐵道', 'Moka'),
    'UtsunomiyaLightRail': ('宇都宮ライトレール', 'Utsunomiya LRT'), 'Enoden': ('江ノ電', 'Enoden'),
    'IzuHakone': ('伊豆箱根', 'Izuhakone'), 'Izukyu': ('伊豆急', 'Izukyu'), 'Fujikyu': ('富士急', 'Fujikyu'),
    'Yamaman': ('山万', 'Yamaman'), 'SaitamaTransit': ('ニューシャトル', 'New Shuttle'),
    'TokyoMonorail': ('東京モノレール', 'Tokyo Monorail'), 'Jomo': ('上毛電鉄', 'Jomo'), 'Joshin': ('上信電鉄', 'Joshin'),
    'WataraseKeikoku': ('わたらせ渓谷鐵道', 'Watarase Keikoku'), 'Yurikamome': ('ゆりかもめ', 'Yurikamome'),
    'YokohamaSeaside': ('シーサイドライン', 'Seaside Line'), 'TamaMonorail': ('多摩モノレール', 'Tama Monorail'),
    'ChibaMonorail': ('千葉モノレール', 'Chiba Monorail'), 'ShonanMonorail': ('湘南モノレール', 'Shonan Monorail'),
}


# Car length in metres where it differs from the usual 20 m
CAR_LENGTH = {
    'Yurikamome': 9, 'SaitamaTransit': 9, 'YokohamaSeaside': 9, 'Yamaman': 9, 'Toei.NipporiToneri': 9,
    'TokyoMonorail': 15, 'TamaMonorail': 15, 'ChibaMonorail': 15, 'ShonanMonorail': 15, 'OdakyuHakone': 15,
    'Toei.Arakawa': 13, 'UtsunomiyaLightRail': 15, 'Enoden': 12,
}
# Vertices deeper than this (Mini Tokyo 3D altitude units, -100 = fully underground) count as tunnel
TUNNEL_ALTITUDE = -50


def underground_intervals(coords, cum):
    """Chainage ranges [start, end] in metres where the line runs in a tunnel."""
    out = []
    start = None
    for c, m in zip(coords, cum):
        under = len(c) > 2 and c[2] < TUNNEL_ALTITUDE
        if under and start is None:
            start = m
        elif not under and start is not None:
            out.append([round(start, 1), round(m, 1)])
            start = None
    if start is not None:
        out.append([round(start, 1), round(cum[-1], 1)])
    return out


def fetch():
    CACHE.mkdir(parents=True, exist_ok=True)
    for name in FILES:
        path = CACHE / name
        if not path.exists():
            print('downloading', name)
            req = urllib.request.Request(BASE_URL + name, headers={'User-Agent': 'densha-live-build/0.1'})
            with urllib.request.urlopen(req) as res:
                path.write_bytes(res.read())


def load(name):
    with gzip.open(CACHE / name, 'rt', encoding='utf-8') as f:
        return json.load(f)


def to_xy(lng, lat, lat0):
    k = 111320.0
    return lng * k * math.cos(math.radians(lat0)), lat * 110540.0


def simplify(points, tol):
    """Douglas-Peucker on [(x, y, payload)] returning kept indices."""
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = points[a][0], points[a][1]
        bx, by = points[b][0], points[b][1]
        dx, dy = bx - ax, by - ay
        norm = math.hypot(dx, dy) or 1e-9
        best, best_i = -1.0, -1
        for i in range(a + 1, b):
            px, py = points[i][0], points[i][1]
            d = abs(dy * (px - ax) - dx * (py - ay)) / norm
            if d > best:
                best, best_i = d, i
        if best > tol:
            keep[best_i] = True
            stack.append((a, best_i))
            stack.append((best_i, b))
    return [i for i, k in enumerate(keep) if k]


def haversine_m(a, b):
    lng1, lat1, lng2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2
    return 2 * 6371008.8 * math.asin(math.sqrt(h))


def parse_time(s):
    h, m = s.split(':')
    return int(h) * 60 + int(m)


def build_network():
    features = load('features.json.gz')['features']
    railways = load('railways.json.gz')
    stations = {s['id']: s for s in load('stations.json.gz')}
    train_types = load('train-types.json.gz')
    directions = {d['id']: d for d in load('rail-directions.json.gz')}

    geom = {}
    for f in features:
        p = f['properties']
        if p.get('type') == 0 and p.get('zoom') == GEOM_ZOOM and 'station-offsets' in p:
            geom[p['id'][:-(len(str(GEOM_ZOOM)) + 1)]] = (f['geometry']['coordinates'], p['station-offsets'])

    station_index = {}
    station_list = []

    def station_ref(sid):
        if sid not in station_index:
            s = stations[sid]
            station_index[sid] = len(station_list)
            entry = {'id': sid, 'ja': s['title'].get('ja', ''), 'en': s['title'].get('en', '')}
            if 'coord' in s:
                entry['c'] = [round(s['coord'][0], 5), round(s['coord'][1], 5)]
            station_list.append(entry)
        return station_index[sid]

    lines = []
    total_pts = 0
    for r in railways:
        rid = r['id']
        if rid not in geom:
            print('  no geometry for', rid)
            continue
        coords, offsets = geom[rid]
        lat0 = coords[0][1]
        cum = [0.0]
        for i in range(1, len(coords)):
            cum.append(cum[-1] + haversine_m(coords[i - 1], coords[i]))
        pts = [(*to_xy(c[0], c[1], lat0), i) for i, c in enumerate(coords)]
        kept = simplify(pts, SIMPLIFY_M)
        total_pts += len(kept)
        op = rid.split('.')[0]
        lines.append({
            'id': rid,
            'op': op,
            'ja': r['title'].get('ja', ''),
            'en': r['title'].get('en', ''),
            'color': r['color'],
            'asc': r['ascending'],
            'desc': r['descending'],
            'cars': r.get('carComposition', 0) or 6,
            'carLen': CAR_LENGTH.get(rid, CAR_LENGTH.get(op, 20)),
            'ug': underground_intervals(coords, cum),
            'st': [station_ref(s) for s in r['stations']],
            # station offsets along the line, metres
            'off': [round(o * 1000, 1) for o in offsets],
            'c': [[round(coords[i][0], 5), round(coords[i][1], 5)] for i in kept],
            # cumulative distance at each kept vertex (metres along the unsimplified line)
            'm': [round(cum[i], 1) for i in kept],
        })
    print(f'  {len(lines)} lines, {total_pts} vertices, {len(station_list)} stations')

    type_list = [{'id': t['id'], 'ja': t['title'].get('ja', ''), 'en': t['title'].get('en', '')} for t in train_types]
    dir_titles = {k: {'ja': v['title'].get('ja', ''), 'en': v['title'].get('en', '')} for k, v in directions.items()}
    return lines, station_list, station_ref, type_list, dir_titles


def resolve_indices(line_station_ids, stop_ids, ascending):
    """Map stops to positions in the line's station list.

    Loop lines list their first station twice; pick occurrences so the train
    moves monotonically in its direction of travel.
    """
    occ = {}
    for i, sid in enumerate(line_station_ids):
        occ.setdefault(sid, []).append(i)
    result = []
    prev = None
    for sid in stop_ids:
        cands = occ.get(sid)
        if not cands:
            return None
        if prev is None or len(cands) == 1:
            pick = cands[0]
            if prev is None and len(cands) > 1:
                pick = cands[0] if ascending else cands[-1]
        else:
            if ascending:
                fwd = [c for c in cands if c > prev]
                pick = min(fwd) if fwd else cands[0]
            else:
                back = [c for c in cands if c < prev]
                pick = max(back) if back else cands[-1]
        result.append(pick)
        prev = pick
    return result


def build_timetable(name, lines, station_ref, type_list):
    data = load(name)
    line_idx = {l['id']: i for i, l in enumerate(lines)}
    line_station_ids = {l['id']: None for l in lines}
    railways = {r['id']: r for r in load('railways.json.gz')}
    type_idx = {t['id']: i for i, t in enumerate(type_list)}
    trains = []
    skipped = Counter()
    for tr in data:
        rid = tr['r']
        if rid not in line_idx:
            skipped['line'] += 1
            continue
        if line_station_ids[rid] is None:
            line_station_ids[rid] = railways[rid]['stations']
        line = lines[line_idx[rid]]
        ascending = tr['d'] == line['asc']
        stops = tr['tt']
        idx = resolve_indices(line_station_ids[rid], [s['s'] for s in stops], ascending)
        if idx is None or len(stops) < 2:
            skipped['stations'] += 1
            continue
        times = []
        last = None
        for s in stops:
            a = parse_time(s['a']) if 'a' in s else None
            d = parse_time(s['d']) if 'd' in s else None
            for_check = a if a is not None else d
            if last is None and for_check < DAY_START_MIN:
                a = a + 1440 if a is not None else None
                d = d + 1440 if d is not None else None
            elif last is not None:
                while a is not None and a < last - 600:
                    a += 1440
                while d is not None and d < last - 600:
                    d += 1440
            last = d if d is not None else a
            times.append((a, d))
        t0 = times[0][1] if times[0][1] is not None else times[0][0]
        flat = []
        for i, (a, d) in zip(idx, times):
            flat += [i, -1 if a is None else a - t0, -1 if d is None else d - t0]
        dest = tr.get('ds') or []
        dest_ref = station_ref(dest[0]) if dest and dest[0] in STATIONS_ALL else -1
        nm = tr.get('nm')
        train_name = ''
        if nm:
            title = nm[0]
            train_name = title.get('ja', '') + '|' + title.get('en', '')
        trains.append([line_idx[rid], type_idx.get(tr['y'], -1), 0 if ascending else 1, tr['n'],
                       dest_ref, train_name, t0, flat, 0, tr.get('pt') or [], tr.get('nt') or [], tr['id']])
    # Through service: link each train to the one it continues as (first link when a train splits/joins).
    # bit 1: continues from a previous train, bit 2: continues as a next train
    index = {rec[11]: i for i, rec in enumerate(trains)}
    linked = 0
    for rec in trains:
        prev = next((index[p] for p in rec[9] if p in index), -1)
        nxt = next((index[n] for n in rec[10] if n in index), -1)
        rec[8] = (1 if prev >= 0 else 0) | (2 if nxt >= 0 else 0)
        rec[9], rec[10] = prev, nxt
        del rec[11]
        linked += nxt >= 0
    print(f'  {name}: {len(trains)} trains, {linked} through-service links, skipped {dict(skipped)}')
    return trains


STATIONS_ALL = set()


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    fetch()
    STATIONS_ALL.update(s['id'] for s in load('stations.json.gz'))
    lines, station_list, station_ref, type_list, dir_titles = build_network()
    OUT.mkdir(parents=True, exist_ok=True)
    timetables = {}
    for day in ('weekday', 'holiday'):
        timetables[day] = build_timetable(f'timetable-{day}.json.gz', lines, station_ref, type_list)
    used_ops = sorted({l['op'] for l in lines})
    network = {
        'city': 'tokyo',
        'source': 'Mini Tokyo 3D (MIT) / Public Transportation Open Data Center',
        'operators': {op: {'ja': OPERATORS.get(op, (op, op))[0], 'en': OPERATORS.get(op, (op, op))[1]} for op in used_ops},
        'types': type_list,
        'directions': dir_titles,
        'lines': lines,
        'stations': station_list,
    }
    for name, obj in [('network.json', network), ('tt-weekday.json', {'trains': timetables['weekday']}),
                      ('tt-holiday.json', {'trains': timetables['holiday']})]:
        text = json.dumps(obj, ensure_ascii=False, separators=(',', ':'))
        (OUT / name).write_text(text, encoding='utf-8')
        print(f'  wrote {name}: {len(text.encode()) / 1e6:.1f} MB raw, {len(gzip.compress(text.encode())) / 1e6:.1f} MB gzip')


if __name__ == '__main__':
    main()
