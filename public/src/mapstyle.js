// Night basemap (OpenFreeMap / OpenMapTiles schema): a dark, almost empty city so the
// rail network reads as faint threads of light and the trains carry the brightness.

export const NIGHT = {
    bg: '#07090D', water: '#0A121A', park: '#0A100E', building: '#0D1016', buildingLine: '#12161D',
    minor: '#0F1217', major: '#13171D', motorway: '#181C24', boundary: '#1C2129',
    label: '#5E6572', labelStrong: '#7D8491', halo: '#07090D', stationFill: '#11141A', stationRing: '#4A515D'
};

export function basemapStyle(lang) {
    const c = NIGHT;
    const name = lang === 'ja'
        ? ['coalesce', ['get', 'name:ja'], ['get', 'name']]
        : ['coalesce', ['get', 'name:en'], ['get', 'name:latin'], ['get', 'name']];
    const font = ['Noto Sans Regular'];
    const roadWidth = base => ['interpolate', ['exponential', 1.6], ['zoom'], 10, base * 0.4, 14, base * 2, 18, base * 12];
    return {
        version: 8,
        name: 'densha-night',
        glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
        sources: {
            omt: {type: 'vector', url: 'https://tiles.openfreemap.org/planet', attribution: '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" target="_blank">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>'}
        },
        layers: [
            {id: 'bg', type: 'background', paint: {'background-color': c.bg}},
            {id: 'park', type: 'fill', source: 'omt', 'source-layer': 'park', paint: {'fill-color': c.park}},
            {id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', paint: {'fill-color': c.water}},
            {id: 'waterway', type: 'line', source: 'omt', 'source-layer': 'waterway', minzoom: 10,
                paint: {'line-color': c.water, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.6, 15, 3]}},
            {id: 'building', type: 'fill', source: 'omt', 'source-layer': 'building', minzoom: 14.5,
                paint: {'fill-color': c.building, 'fill-outline-color': c.buildingLine,
                    'fill-opacity': ['interpolate', ['linear'], ['zoom'], 14.5, 0, 15.5, 1]}},
            {id: 'road-minor', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 13,
                filter: ['in', ['get', 'class'], ['literal', ['minor', 'service', 'tertiary']]],
                layout: {'line-cap': 'round', 'line-join': 'round'},
                paint: {'line-color': c.minor, 'line-width': roadWidth(0.6)}},
            {id: 'road-major', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 9,
                filter: ['in', ['get', 'class'], ['literal', ['primary', 'secondary', 'trunk']]],
                layout: {'line-cap': 'round', 'line-join': 'round'},
                paint: {'line-color': c.major, 'line-width': roadWidth(0.8)}},
            {id: 'road-motorway', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 8,
                filter: ['==', ['get', 'class'], 'motorway'],
                layout: {'line-cap': 'round', 'line-join': 'round'},
                paint: {'line-color': c.motorway, 'line-width': roadWidth(1)}},
            {id: 'boundary', type: 'line', source: 'omt', 'source-layer': 'boundary',
                filter: ['<=', ['get', 'admin_level'], 4],
                paint: {'line-color': c.boundary, 'line-dasharray': [2, 3], 'line-width': 0.7}},
            {id: 'place-minor', type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 13,
                filter: ['in', ['get', 'class'], ['literal', ['suburb', 'quarter', 'neighbourhood']]],
                layout: {'text-field': name, 'text-font': font, 'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10, 16, 12],
                    'text-letter-spacing': 0.04, 'text-padding': 8},
                paint: {'text-color': c.label, 'text-halo-color': c.halo, 'text-halo-width': 1.2, 'text-opacity': 0.8}},
            {id: 'place-major', type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 6, maxzoom: 13,
                filter: ['in', ['get', 'class'], ['literal', ['city', 'town']]],
                layout: {'text-field': name, 'text-font': font, 'text-letter-spacing': 0.08,
                    'text-size': ['interpolate', ['linear'], ['zoom'], 6, 11, 12, 13], 'text-padding': 10},
                paint: {'text-color': c.label, 'text-halo-color': c.halo, 'text-halo-width': 1.4}}
        ]
    };
}

// Paint values for the rail layers in surface view and underground view
// Tunnels are faint solid threads far out and dashed from mid zoom
const TUNNEL_DASH = ['step', ['zoom'], ['literal', [1, 0]], 12.5, ['literal', [1.6, 1.6]]];
const VIEW = {
    surface: {glow: 0.12, line: 0.5, tunnel: 0.3, tunnelGlow: 0, tunnelDash: TUNNEL_DASH},
    underground: {glow: 0.02, line: 0.1, tunnel: 0.75, tunnelGlow: 0.16, tunnelDash: ['literal', [1, 0]]}
};

export function railLayers(lang, underground) {
    const v = VIEW[underground ? 'underground' : 'surface'];
    const width = ['interpolate', ['linear'], ['zoom'], 8, 0.6, 11, 1.1, 13, 1.8, 15, 2.6, 17, 3.4];
    const glowWidth = ['interpolate', ['linear'], ['zoom'], 8, 2, 11, 4, 13, 7, 15, 11, 17, 16];
    const glowBlur = ['interpolate', ['linear'], ['zoom'], 8, 1.2, 11, 2.4, 13, 4.2, 15, 6.6, 17, 9.6];
    const surface = ['==', ['get', 'ug'], 0], tunnel = ['==', ['get', 'ug'], 1];
    return [
        {id: 'rail-glow', type: 'line', source: 'rail-lines', filter: surface,
            layout: {'line-cap': 'round', 'line-join': 'round'},
            paint: {'line-color': ['get', 'color'], 'line-width': glowWidth, 'line-blur': glowBlur, 'line-opacity': v.glow}},
        {id: 'rail-tunnel-glow', type: 'line', source: 'rail-lines', filter: tunnel,
            layout: {'line-cap': 'round', 'line-join': 'round'},
            paint: {'line-color': ['get', 'color'], 'line-width': glowWidth, 'line-blur': glowBlur, 'line-opacity': v.tunnelGlow}},
        {id: 'rail-tunnel', type: 'line', source: 'rail-lines', filter: tunnel,
            layout: {'line-join': 'round'},
            paint: {'line-color': ['get', 'color'], 'line-width': width, 'line-opacity': v.tunnel, 'line-dasharray': v.tunnelDash}},
        {id: 'rail-line', type: 'line', source: 'rail-lines', filter: surface,
            layout: {'line-cap': 'round', 'line-join': 'round'},
            paint: {'line-color': ['get', 'color'], 'line-width': width, 'line-opacity': v.line}},
        {id: 'stations', type: 'circle', source: 'rail-stations', minzoom: 12,
            filter: ['==', ['get', 'kind'], 'dot'],
            paint: {
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 1.3, 14, 2.4, 17, 4],
                'circle-color': NIGHT.stationFill,
                'circle-stroke-color': NIGHT.stationRing,
                'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 12, 0.6, 15, 1.1],
                'circle-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0, 12.6, 1],
                'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0, 12.6, 1]
            }},
        {id: 'station-labels', type: 'symbol', source: 'rail-stations', minzoom: 13,
            filter: ['==', ['get', 'kind'], 'label'],
            layout: {
                'text-field': ['get', lang === 'ja' ? 'ja' : 'en'],
                'text-font': ['Noto Sans Regular'],
                'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10, 16, 12],
                'text-letter-spacing': 0.03,
                'text-offset': [0, 0.95], 'text-anchor': 'top', 'text-padding': 6,
                'symbol-sort-key': ['-', 0, ['get', 'lines']]
            },
            paint: {
                'text-color': NIGHT.labelStrong, 'text-halo-color': NIGHT.halo, 'text-halo-width': 1.4,
                'text-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0, 13.6, 1]
            }}
    ];
}

// Switch emphasis between surface and tunnels without rebuilding the layers
export function applyRailView(map, underground) {
    const v = VIEW[underground ? 'underground' : 'surface'];
    const set = (id, prop, value) => map.getLayer(id) && map.setPaintProperty(id, prop, value);
    set('rail-glow', 'line-opacity', v.glow);
    set('rail-line', 'line-opacity', v.line);
    set('rail-tunnel', 'line-opacity', v.tunnel);
    set('rail-tunnel', 'line-dasharray', v.tunnelDash);
    set('rail-tunnel-glow', 'line-opacity', v.tunnelGlow);
}
