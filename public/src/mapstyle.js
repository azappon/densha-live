// Quiet basemap (OpenFreeMap / OpenMapTiles schema) so rail lines and trains carry the colour.

const PALETTES = {
    light: {
        bg: '#f3f2ee', water: '#c9dcea', waterLine: '#b5cde0', park: '#e1ead6', wood: '#d9e5cf',
        landuse: '#eceae4', building: '#e4e1da', buildingLine: '#d8d4cc', road: '#ffffff', roadCase: '#e2ded6',
        major: '#fdfcfa', majorCase: '#d9d4ca', motorway: '#f7f1e6', motorwayCase: '#d6cdbd',
        boundary: '#c9c3b8', label: '#5f646c', labelHalo: '#f3f2ee', water_label: '#6f8ba3', airport: '#e9e7e1'
    },
    dark: {
        bg: '#14161b', water: '#0b1823', waterLine: '#10222f', park: '#16201a', wood: '#152019',
        landuse: '#171a20', building: '#1c2027', buildingLine: '#232831', road: '#22262e', roadCase: '#1a1d23',
        major: '#2a2f38', majorCase: '#1d2027', motorway: '#323743', motorwayCase: '#1f232a',
        boundary: '#3a3f4a', label: '#9097a3', labelHalo: '#14161b', water_label: '#4f6e88', airport: '#1b1e24'
    }
};

export function basemapStyle(theme, lang) {
    const c = PALETTES[theme];
    const name = lang === 'ja'
        ? ['coalesce', ['get', 'name:ja'], ['get', 'name']]
        : ['coalesce', ['get', 'name:en'], ['get', 'name:latin'], ['get', 'name']];
    const font = ['Noto Sans Regular'];
    const roadWidth = (base) => ['interpolate', ['exponential', 1.6], ['zoom'], 10, base * 0.4, 14, base * 2.2, 18, base * 14];
    return {
        version: 8,
        name: `densha-${theme}`,
        glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
        sources: {
            omt: {type: 'vector', url: 'https://tiles.openfreemap.org/planet', attribution: '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" target="_blank">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>'}
        },
        layers: [
            {id: 'bg', type: 'background', paint: {'background-color': c.bg}},
            {id: 'landuse', type: 'fill', source: 'omt', 'source-layer': 'landuse', minzoom: 11,
                filter: ['in', ['get', 'class'], ['literal', ['residential', 'commercial', 'industrial', 'retail', 'railway', 'school', 'university', 'hospital']]],
                paint: {'fill-color': c.landuse, 'fill-opacity': 0.7}},
            {id: 'wood', type: 'fill', source: 'omt', 'source-layer': 'landcover',
                filter: ['in', ['get', 'class'], ['literal', ['wood', 'forest']]], paint: {'fill-color': c.wood, 'fill-opacity': 0.8}},
            {id: 'grass', type: 'fill', source: 'omt', 'source-layer': 'landcover',
                filter: ['in', ['get', 'class'], ['literal', ['grass', 'farmland']]], paint: {'fill-color': c.park, 'fill-opacity': 0.5}},
            {id: 'park', type: 'fill', source: 'omt', 'source-layer': 'park', paint: {'fill-color': c.park}},
            {id: 'aeroway', type: 'fill', source: 'omt', 'source-layer': 'aeroway', minzoom: 10,
                filter: ['==', ['geometry-type'], 'Polygon'], paint: {'fill-color': c.airport}},
            {id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', paint: {'fill-color': c.water}},
            {id: 'waterway', type: 'line', source: 'omt', 'source-layer': 'waterway', minzoom: 9,
                paint: {'line-color': c.water, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.5, 15, 3]}},
            {id: 'building', type: 'fill', source: 'omt', 'source-layer': 'building', minzoom: 14,
                paint: {'fill-color': c.building, 'fill-outline-color': c.buildingLine,
                    'fill-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0, 15, 1]}},
            {id: 'road-minor-case', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 13,
                filter: ['in', ['get', 'class'], ['literal', ['minor', 'service', 'tertiary']]],
                layout: {'line-cap': 'round', 'line-join': 'round'},
                paint: {'line-color': c.roadCase, 'line-width': roadWidth(0.9), 'line-gap-width': 0}},
            {id: 'road-minor', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 12,
                filter: ['in', ['get', 'class'], ['literal', ['minor', 'service', 'tertiary']]],
                layout: {'line-cap': 'round', 'line-join': 'round'},
                paint: {'line-color': c.road, 'line-width': roadWidth(0.6)}},
            {id: 'road-major', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 8,
                filter: ['in', ['get', 'class'], ['literal', ['primary', 'secondary', 'trunk']]],
                layout: {'line-cap': 'round', 'line-join': 'round'},
                paint: {'line-color': c.major, 'line-width': roadWidth(0.9)}},
            {id: 'road-motorway', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 7,
                filter: ['==', ['get', 'class'], 'motorway'],
                layout: {'line-cap': 'round', 'line-join': 'round'},
                paint: {'line-color': c.motorway, 'line-width': roadWidth(1.1)}},
            {id: 'boundary', type: 'line', source: 'omt', 'source-layer': 'boundary',
                filter: ['<=', ['get', 'admin_level'], 4],
                paint: {'line-color': c.boundary, 'line-dasharray': [2, 2], 'line-width': 0.8}},
            {id: 'water-label', type: 'symbol', source: 'omt', 'source-layer': 'water_name', minzoom: 10,
                layout: {'text-field': name, 'text-font': font, 'text-size': 11, 'text-letter-spacing': 0.1},
                paint: {'text-color': c.water_label, 'text-halo-color': c.labelHalo, 'text-halo-width': 1.2}},
            {id: 'place-minor', type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 12,
                filter: ['in', ['get', 'class'], ['literal', ['suburb', 'quarter', 'neighbourhood']]],
                layout: {'text-field': name, 'text-font': font, 'text-size': ['interpolate', ['linear'], ['zoom'], 12, 10, 16, 13],
                    'text-padding': 6},
                paint: {'text-color': c.label, 'text-halo-color': c.labelHalo, 'text-halo-width': 1.4, 'text-opacity': 0.75}},
            {id: 'place-major', type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 6, maxzoom: 14,
                filter: ['in', ['get', 'class'], ['literal', ['city', 'town']]],
                layout: {'text-field': name, 'text-font': font,
                    'text-size': ['interpolate', ['linear'], ['zoom'], 6, 11, 12, 15], 'text-padding': 8},
                paint: {'text-color': c.label, 'text-halo-color': c.labelHalo, 'text-halo-width': 1.6}}
        ]
    };
}

// Rail line, station and label layers drawn on top of the basemap
export function railLayers(theme, lang) {
    const c = PALETTES[theme];
    const lineWidth = ['interpolate', ['linear'], ['zoom'], 8, 1.1, 11, 2.2, 13, 3.4, 15, 5, 17, 7];
    return [
        {id: 'rail-case', type: 'line', source: 'rail-lines',
            layout: {'line-cap': 'round', 'line-join': 'round'},
            paint: {'line-color': c.bg, 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 2, 11, 3.6, 13, 5.4, 15, 8, 17, 11]}},
        {id: 'rail-line', type: 'line', source: 'rail-lines',
            layout: {'line-cap': 'round', 'line-join': 'round'},
            paint: {'line-color': ['get', 'color'], 'line-width': lineWidth,
                'line-opacity': ['case', ['boolean', ['feature-state', 'dim'], false], 0.18, 0.92]}},
        {id: 'stations', type: 'circle', source: 'rail-stations', minzoom: 11.5,
            filter: ['==', ['get', 'kind'], 'dot'],
            paint: {
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 11.5, 1.6, 13, 3, 16, 5.5],
                'circle-color': theme === 'dark' ? '#0f1115' : '#ffffff',
                'circle-stroke-color': theme === 'dark' ? '#e8eaee' : '#30343b',
                'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 11.5, 0.8, 14, 1.4],
                'circle-opacity': ['interpolate', ['linear'], ['zoom'], 11.5, 0, 12, 1],
                'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'], 11.5, 0, 12, 1]
            }},
        {id: 'station-labels', type: 'symbol', source: 'rail-stations', minzoom: 12.5,
            filter: ['==', ['get', 'kind'], 'label'],
            layout: {
                'text-field': ['get', lang === 'ja' ? 'ja' : 'en'],
                'text-font': ['Noto Sans Bold'],
                'text-size': ['interpolate', ['linear'], ['zoom'], 12.5, 10, 16, 13],
                'text-offset': [0, 0.9], 'text-anchor': 'top', 'text-padding': 4,
                'symbol-sort-key': ['-', 0, ['get', 'lines']]
            },
            paint: {
                'text-color': theme === 'dark' ? '#d5d9e0' : '#2b2f36',
                'text-halo-color': c.bg, 'text-halo-width': 1.6,
                'text-opacity': ['interpolate', ['linear'], ['zoom'], 12.5, 0, 13, 1]
            }}
    ];
}

export const THEME_BG = {light: PALETTES.light.bg, dark: PALETTES.dark.bg};
