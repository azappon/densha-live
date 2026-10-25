import {Network, mercatorX, mercatorY} from './network.js';
import {TrainLayer} from './trainlayer.js';
import {TrainLook} from './trainlook.js';
import {basemapStyle, railLayers, applyRailView} from './mapstyle.js';
import {serviceTime, formatClock, formatMinutes} from './clock.js';
import {STR} from './i18n.js';
import {setupTokyo} from './tokyo.js';

const maplibregl = window.maplibregl;

const HOME = {center: [139.735, 35.69], zoom: 11.2};
const DATA_BASE = 'data/tokyo/';

// ---------- settings ----------
const SETTINGS_KEY = 'densha-live:settings';
const defaults = {
    lang: (navigator.language || 'en').startsWith('ja') ? 'ja' : 'en',
    fps: 30,
    underground: false,
    odptKey: '',
    challengeKey: '',
    hiddenOps: []
};
const settings = {...defaults};
try {
    Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
} catch (e) {
    // private mode or corrupted storage: keep defaults
}
function saveSettings() {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) {
        // ignore
    }
}
const S = () => STR[settings.lang];

// ?at=HH:MM shows the timetable at that Japan time today (live feeds are off then)
const timeOffset = (() => {
    const at = new URLSearchParams(location.search).get('at');
    const m = at && at.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) {
        return 0;
    }
    const st = serviceTime(Date.now());
    let target = Number(m[1]) * 60 + Number(m[2]);
    if (target < 180) {
        target += 1440;
    }
    return (target - st.minutes) * 60000;
})();
const clockNow = () => Date.now() + timeOffset;

document.documentElement.lang = settings.lang;

// ---------- map ----------
const map = new maplibregl.Map({
    container: 'map',
    style: basemapStyle(settings.lang),
    center: HOME.center,
    zoom: HOME.zoom,
    minZoom: 5,
    maxZoom: 18,
    pitchWithRotate: false,
    dragRotate: false,
    attributionControl: {compact: true},
    localIdeographFontFamily: '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic", sans-serif',
    fadeDuration: 150
});
map.touchZoomRotate.disableRotation();
map.keyboard.disableRotation();

const trainLayer = new TrainLayer();
trainLayer.setReference(mercatorX(HOME.center[0]), mercatorY(HOME.center[1]));
const look = new TrainLook();

let ctx = null;          // loaded network, providers and feeds
let loadToken = 0;
const selection = {ref: null, provider: null, follow: false};

function installRailLayers() {
    if (!map.getSource('rail-lines')) {
        map.addSource('rail-lines', {type: 'geojson', data: ctx ? ctx.linesGeo : {type: 'FeatureCollection', features: []}});
        map.addSource('rail-stations', {type: 'geojson', data: ctx ? ctx.stationsGeo : {type: 'FeatureCollection', features: []}});
    }
    for (const layer of railLayers(settings.lang, settings.underground)) {
        if (!map.getLayer(layer.id)) {
            map.addLayer(layer);
        }
    }
    applyOperatorFilter();
    if (!map.getLayer('trains')) {
        map.addLayer(trainLayer);
    }
}

map.on('style.load', installRailLayers);

function applyOperatorFilter() {
    if (!map.getLayer('rail-line')) {
        return;
    }
    const hidden = settings.hiddenOps;
    const visible = hidden.length ? ['!', ['in', ['get', 'op'], ['literal', hidden]]] : null;
    for (const [id, part] of [['rail-glow', 0], ['rail-line', 0], ['rail-tunnel', 1], ['rail-tunnel-glow', 1]]) {
        const base = ['==', ['get', 'ug'], part];
        map.setFilter(id, visible ? ['all', base, visible] : base);
    }
}

function restyle() {
    document.documentElement.lang = settings.lang;
    map.setStyle(basemapStyle(settings.lang), {diff: false});
}

// ---------- data loading ----------
async function fetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`${url}: HTTP ${res.status}`);
    }
    return res.json();
}

async function loadData() {
    const token = ++loadToken;
    if (ctx) {
        ctx.feeds.forEach(f => f.stop());
    }
    clearSelection();
    $('statsText').textContent = S().loading;
    const network = new Network(await fetchJSON(DATA_BASE + 'network.json'));
    const st = serviceTime(clockNow());
    const city = await setupTokyo({
        network, base: DATA_BASE, settings, dayType: st.dayType, fetchJSON,
        onUpdate: () => {
            renderPanel();
            renderAlerts();
        }
    });
    if (token !== loadToken) {
        city.feeds.forEach(f => f.stop());
        return;
    }
    ctx = {
        network, ...city, dayKey: st.key, refX: trainLayer.refX, refY: trainLayer.refY,
        linesGeo: network.linesGeoJSON(), stationsGeo: network.stationsGeoJSON()
    };
    if (map.getSource('rail-lines')) {
        map.getSource('rail-lines').setData(ctx.linesGeo);
        map.getSource('rail-stations').setData(ctx.stationsGeo);
    }
    if (!timeOffset) {
        ctx.feeds.forEach(f => f.start());
    }
    renderPanel();
    renderAlerts();
}

// ---------- per-frame simulation ----------
// pos holds head and tail (mercator) of every train for hit testing and follow mode
let pos = new Float64Array(4 * 8192);
let refs = new Array(8192);
let count = 0, liveCount = 0, frameSec = 1 / 30;
const ends = new Float64Array(4);

function emit(line, s, dir, kind, alpha, ref) {
    if (alpha <= 0.01) {
        return;
    }
    if (settings.hiddenOps.length && settings.hiddenOps.includes(line.op)) {
        return;
    }
    if (count * 4 >= pos.length) {
        const np = new Float64Array(pos.length * 2);
        np.set(pos);
        pos = np;
        refs.length = refs.length * 2;
    }
    // Speed (m/s) from frame-to-frame movement, smoothed; drives the trail length
    if (ref._s === undefined || ref._line !== line || Math.abs(s - ref._s) > 2000) {
        ref._v = 0;
        ref._phase = Math.random() * 6.28;
    } else {
        ref._v += (Math.abs(s - ref._s) / frameSec - ref._v) * 0.2;
    }
    ref._s = s;
    ref._line = line;
    look.add(line, s, dir, kind === 1, alpha, ref._v, ref === selection.ref, ends, ref._phase);
    pos.set(ends, count * 4);
    refs[count] = {ref, provider: currentProvider};
    if (kind === 1) {
        liveCount++;
    }
    count++;
}

let currentProvider = null;
let lastFrame = 0, lastHud = 0, selectedPos = null;

function frame(ts) {
    requestAnimationFrame(frame);
    if (!ctx || document.hidden) {
        return;
    }
    const interval = 1000 / settings.fps;
    if (ts - lastFrame < interval - 3) {
        return;
    }
    const dt = lastFrame ? Math.min(ts - lastFrame, 1000) : interval;
    lastFrame = ts;
    frameSec = dt / 1000;
    const now = Date.now();
    const st = serviceTime(now + timeOffset);
    if (st.key !== ctx.dayKey && !ctx.reloading) {
        // New service day (03:00 JST): reload the right timetable
        ctx.reloading = true;
        loadData();
        return;
    }
    count = 0;
    liveCount = 0;
    selectedPos = null;
    look.begin(map, ctx.refX, ctx.refY, settings.underground, ts / 1000);
    for (const p of ctx.providers) {
        currentProvider = p;
        p.update(st.minutes, now, dt, emit);
    }
    for (let i = 0; i < count; i++) {
        if (refs[i].ref === selection.ref) {
            selectedPos = [pos[i * 4], pos[i * 4 + 1]];
            break;
        }
    }
    trainLayer.setLists(look.lists);
    if (selection.follow && selectedPos && !map.isMoving()) {
        map.jumpTo({center: mercatorToLngLat(selectedPos[0], selectedPos[1])});
    }
    map.triggerRepaint();
    if (now - lastHud > 500) {
        lastHud = now;
        updateHud(now, st);
    }
}
requestAnimationFrame(frame);

function mercatorToLngLat(x, y) {
    const lng = x * 360 - 180;
    const lat = 360 / Math.PI * Math.atan(Math.exp((1 - y * 2) * Math.PI)) - 90;
    return [lng, lat];
}

// ---------- HUD ----------
const $ = id => document.getElementById(id);

function updateHud(now, st) {
    const s = S();
    $('clock').textContent = formatClock(now + timeOffset);
    $('dayType').textContent = st.dayType === 'weekday' ? s.weekday : s.holiday;
    $('statsText').textContent = liveCount ? `${s.trains(count)} · ${s.live(liveCount)}` : s.trains(count);
    document.querySelector('#stats .dot').classList.toggle('live', liveCount > 0);
    if (selection.ref) {
        if (!selectedPos) {
            clearSelection();
        } else {
            renderSheet(st.minutes);
        }
    }
}

$('home').addEventListener('click', () => {
    map.flyTo({center: HOME.center, zoom: HOME.zoom, duration: 1200, essential: true});
});

// Underground view: tunnels light up, the surface network dims
function updateUnderground() {
    $('btnUnder').classList.toggle('on', settings.underground);
    $('btnUnder').setAttribute('aria-pressed', String(settings.underground));
    applyRailView(map, settings.underground);
}

$('btnUnder').addEventListener('click', () => {
    settings.underground = !settings.underground;
    saveSettings();
    updateUnderground();
});
updateUnderground();

// ---------- selection ----------
map.on('click', e => {
    if (!ctx || !count) {
        return;
    }
    const zoom = map.getZoom();
    const world = 512 * Math.pow(2, zoom);
    const cx = mercatorX(e.lngLat.lng), cy = mercatorY(e.lngLat.lat);
    // Distance (px) from the tap to each train's head-tail segment
    const tol = 22;
    let best = -1, bestD = tol * tol;
    for (let i = 0; i < count; i++) {
        const ax = (pos[i * 4] - cx) * world, ay = (pos[i * 4 + 1] - cy) * world;
        const bx = (pos[i * 4 + 2] - cx) * world, by = (pos[i * 4 + 3] - cy) * world;
        const ex = bx - ax, ey = by - ay, l2 = ex * ex + ey * ey;
        const t = l2 > 0 ? Math.max(0, Math.min(1, -(ax * ex + ay * ey) / l2)) : 0;
        const px = ax + ex * t, py = ay + ey * t;
        const d = px * px + py * py;
        if (d < bestD) {
            bestD = d;
            best = i;
        }
    }
    if (best >= 0) {
        selection.ref = refs[best].ref;
        selection.provider = refs[best].provider;
        selection.follow = false;
        renderSheet(serviceTime(clockNow()).minutes);
        $('sheet').hidden = false;
        document.body.classList.add('sheet-open');
        closePanel();
        // On phones the sheet covers the lower map: keep the train visible above it
        const sheetH = $('sheet').offsetHeight;
        if (window.innerWidth < 700 && e.point.y > window.innerHeight - sheetH - 40) {
            map.easeTo({center: mercatorToLngLat(pos[best * 4], pos[best * 4 + 1]), padding: {bottom: sheetH}, duration: 600});
        } else if (window.innerWidth < 700) {
            map.setPadding({top: 0, bottom: sheetH, left: 0, right: 0});
        }
    } else {
        clearSelection();
    }
});

map.on('dragstart', () => {
    if (selection.follow) {
        selection.follow = false;
        renderSheet(serviceTime(clockNow()).minutes);
    }
});

function clearSelection() {
    const had = selection.ref;
    selection.ref = null;
    selection.provider = null;
    selection.follow = false;
    $('sheet').hidden = true;
    document.body.classList.remove('sheet-open');
    if (had && map.getPadding().bottom) {
        map.setPadding({top: 0, bottom: 0, left: 0, right: 0});
    }
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);

function renderSheet(T) {
    if (!selection.ref || !ctx) {
        return;
    }
    const s = S(), lang = settings.lang;
    const d = selection.provider.describe(selection.ref, T, lang);
    const line = d.line;
    const opNames = ctx.network.operators[line.op] || {};
    const lineName = lang === 'ja' ? line.ja : line.en;
    const badge = d.source === 'live' ? `<span class="badge live"><span class="dot live"></span>${s.sourceLive}</span>`
        : `<span class="badge">${s.sourceTimetable}</span>`;
    const title = [d.trainName, d.typeName].filter(Boolean).join(' · ') || lineName;
    let delayText = s.unknownDelay, delayClass = '';
    if (d.delay !== null && d.delay !== undefined) {
        if (d.delay <= 0) {
            delayText = s.onTime;
            delayClass = 'ok';
        } else {
            delayText = s.late(d.delay);
            delayClass = d.delay >= 10 ? 'bad' : 'late';
        }
    } else if (d.source === 'timetable') {
        delayText = s.scheduled;
        delayClass = 'dim';
    }
    const next = d.next ? `${esc(d.next.name)}${d.next.time != null ? ` <span class="muted">${formatMinutes(d.next.time + (d.delay > 0 ? d.delay : 0))}</span>` : ''}` : '—';
    const textColor = contrastText(line.color);
    $('sheetBody').innerHTML = `
        <div class="train-head">
            <span class="line-chip" style="background:${line.color};color:${textColor}">${esc(lineName)}</span>
            ${badge}
        </div>
        <div class="train-title">${esc(title)}</div>
        <div class="train-sub">${d.dest ? esc(s.bound(d.dest)) + ' · ' : ''}${esc(lang === 'ja' ? opNames.ja : opNames.en)}</div>
        <div class="train-grid">
            <div class="cell"><div class="k">${d.next && d.next.atStation ? s.stoppedAt : s.next}</div><div class="v">${next}</div></div>
            <div class="cell"><div class="k">${s.delay}</div><div class="v ${delayClass}">${esc(delayText)}</div></div>
            ${d.number ? `<div class="cell"><div class="k">${s.train}</div><div class="v">${esc(d.number)}</div></div>` : ''}
            ${d.cars ? `<div class="cell"><div class="k">${s.cars}</div><div class="v">${esc(d.cars)}</div></div>` : ''}
        </div>
        <div class="sheet-actions">
            <button class="btn ${selection.follow ? 'primary' : ''}" data-act="follow">${selection.follow ? s.following : s.follow}</button>
            <button class="btn" data-act="close">${s.close}</button>
        </div>`;
}

function contrastText(hex) {
    const n = parseInt(hex.slice(1), 16);
    const r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) > 186 ? '#16181d' : '#ffffff';
}

$('sheet').addEventListener('click', e => {
    const act = e.target.closest('[data-act]');
    if (!act) {
        return;
    }
    if (act.dataset.act === 'close') {
        clearSelection();
    } else if (act.dataset.act === 'follow') {
        selection.follow = !selection.follow;
        if (selection.follow && selectedPos) {
            map.easeTo({center: mercatorToLngLat(...selectedPos), zoom: Math.max(map.getZoom(), 14), duration: 800});
        }
        renderSheet(serviceTime(clockNow()).minutes);
    }
});

// ---------- panel (data + settings) ----------
let panelTab = 'data';

function openPanel() {
    clearSelection();
    $('panel').hidden = false;
    document.body.classList.add('sheet-open');
    renderPanel();
}

function closePanel() {
    if (!$('panel').hidden) {
        $('panel').hidden = true;
        document.body.classList.remove('sheet-open');
    }
}

$('btnPanel').addEventListener('click', openPanel);
$('panelClose').addEventListener('click', closePanel);
$('alerts').addEventListener('click', () => {
    panelTab = 'data';
    openPanel();
});

document.querySelector('.tabs').addEventListener('click', e => {
    const t = e.target.closest('.tab');
    if (t) {
        panelTab = t.dataset.tab;
        renderPanel();
    }
});

function renderPanel() {
    const s = S(), lang = settings.lang;
    $('tabData').textContent = s.data;
    $('tabSettings').textContent = s.settings;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === panelTab));
    document.querySelectorAll('.tab-page').forEach(p => {
        p.hidden = p.dataset.page !== panelTab;
    });
    $('lblLang').textContent = s.language;
    $('lblMotion').textContent = s.animation;
    document.querySelectorAll('.chips').forEach(ch => {
        const key = ch.dataset.setting;
        ch.querySelectorAll('button').forEach(b => b.classList.toggle('active', String(settings[key]) === b.dataset.value));
    });
    for (const key of ['odptKey', 'challengeKey']) {
        if (document.activeElement !== $(key)) {
            $(key).value = settings[key];
        }
    }
    if ($('panel').hidden || !ctx || panelTab !== 'data') {
        return;
    }
    const rows = ctx.coverage(lang, s);
    const label = {live: s.statusLive, timetable: s.statusTimetable, error: s.statusError};
    const badgeClass = {live: 'live', error: 'warn', timetable: ''};
    const alerts = (ctx.alerts && ctx.alerts()) || [];
    $('coverage').innerHTML = `
        <div class="legend">
            <span><i class="live"></i>${s.legendLive}</span>
            <span><i></i>${s.legendSched}</span>
        </div>
        ${alerts.length ? `<div class="cov-city">${s.disruptions}</div><div class="status-list">${alerts.map(a => `
            <div class="status-item"><b>${esc(a.line ? (lang === 'ja' ? a.line.ja : a.line.en) : a.operator)} — ${esc(a.status[lang] || a.status.ja)}</b><br>${esc(a.text[lang] || a.text.ja)}</div>`).join('')}</div>` : ''}
        <div class="cov-city">${s.region}</div>
        ${rows.map(r => `
            <div class="cov-row">
                <button class="toggle-op ${settings.hiddenOps.includes(r.op) ? '' : 'on'}" data-op="${esc(r.op)}" aria-label="toggle">${settings.hiddenOps.includes(r.op) ? '' : '✓'}</button>
                <div class="cov-name"><b>${esc(r.name)}</b><small>${esc(r.detail)}</small></div>
                <span class="badge ${badgeClass[r.status]}">${label[r.status]}</span>
            </div>`).join('')}`;
}

$('coverage').addEventListener('click', e => {
    const b = e.target.closest('.toggle-op');
    if (!b) {
        return;
    }
    const op = b.dataset.op;
    const i = settings.hiddenOps.indexOf(op);
    if (i >= 0) {
        settings.hiddenOps.splice(i, 1);
    } else {
        settings.hiddenOps.push(op);
    }
    saveSettings();
    applyOperatorFilter();
    renderPanel();
});

document.querySelectorAll('.chips').forEach(ch => ch.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) {
        return;
    }
    const key = ch.dataset.setting;
    const value = key === 'fps' ? Number(b.dataset.value) : b.dataset.value;
    if (settings[key] === value) {
        return;
    }
    settings[key] = value;
    saveSettings();
    if (key === 'lang') {
        restyle();
    }
    renderPanel();
    renderAlerts();
}));

for (const key of ['odptKey', 'challengeKey']) {
    $(key).addEventListener('change', e => {
        settings[key] = e.target.value.trim();
        saveSettings();
        if (ctx && !timeOffset) {
            ctx.feeds.forEach(f => f.start());
        }
    });
}

function renderAlerts() {
    const alerts = ctx && ctx.alerts ? ctx.alerts() : [];
    const lines = new Set(alerts.map(a => a.line ? a.line.id : a.operator));
    $('alerts').hidden = lines.size === 0;
    $('alerts').textContent = S().disrupted(lines.size);
}

// ---------- location ----------
let userMarker = null, watchId = null, firstFix = true;
$('btnLocate').addEventListener('click', () => {
    if (!navigator.geolocation) {
        return;
    }
    if (watchId !== null && userMarker) {
        map.flyTo({center: userMarker.getLngLat(), zoom: Math.max(map.getZoom(), 14), duration: 1000});
        return;
    }
    $('btnLocate').classList.add('on');
    firstFix = true;
    watchId = navigator.geolocation.watchPosition(p => {
        const ll = [p.coords.longitude, p.coords.latitude];
        if (!userMarker) {
            const el = document.createElement('div');
            el.className = 'user-dot';
            userMarker = new maplibregl.Marker({element: el}).setLngLat(ll).addTo(map);
        } else {
            userMarker.setLngLat(ll);
        }
        if (firstFix) {
            firstFix = false;
            map.flyTo({center: ll, zoom: Math.max(map.getZoom(), 14), duration: 1400});
        }
    }, () => {
        $('btnLocate').classList.remove('on');
        watchId = null;
    }, {enableHighAccuracy: true, maximumAge: 10000});
});

// ---------- boot ----------
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
        lastFrame = 0;
    }
});
loadData().catch(err => {
    console.error(err);
    $('statsText').textContent = String(err.message || err);
});

// Offline cache; skipped on localhost so edits show up immediately (add ?sw=1 to test it)
const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
if ('serviceWorker' in navigator && (!isLocal || location.search.includes('sw=1'))) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Exposed for debugging in the console
window.densha = {map, settings, get ctx() {
    return ctx;
}, get T() {
    return serviceTime(clockNow()).minutes;
}};
