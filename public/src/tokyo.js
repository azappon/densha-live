// Tokyo: every train from published timetables, corrected by ODPT live data.

import {TimetableProvider} from './timetable.js';
import {LiveSegmentProvider} from './live.js';
import {OdptFeed} from './feeds/odpt.js';

// Operators with a live position feed in ODPT, and which key unlocks it
const LIVE_SOURCES = {
    Toei: 'public',
    YokohamaMunicipal: 'odpt',
    'JR-East': 'challenge',
    Keikyu: 'challenge',
    Keio: 'challenge',
    Tobu: 'challenge'
};

const NOTES = {
    en: {
        public: 'Live via ODPT open data (no key needed)',
        odpt: 'Live with a free ODPT developer key',
        challenge: 'Live with an ODPT Challenge 2026 key (until 12 Mar 2027)',
        reporting: n => `${n} trains reporting live via ODPT`,
        error: e => `Live feed error (${e}) — showing timetable`
    },
    ja: {
        public: 'ODPTオープンデータでリアルタイム（キー不要）',
        odpt: 'ODPT開発者キーでリアルタイム',
        challenge: 'ODPTチャレンジ2026キーでリアルタイム（2027年3月12日まで）',
        reporting: n => `${n}本がODPTでリアルタイム配信中`,
        error: e => `リアルタイム取得エラー（${e}）— 時刻表で表示`
    }
};

export async function setupTokyo({network, base, settings, dayType, onUpdate, fetchJSON}) {
    const tt = await fetchJSON(`${base}tt-${dayType}.json`);
    const timetable = new TimetableProvider(network, tt.trains);
    const live = new LiveSegmentProvider(network);
    const feed = new OdptFeed({network, timetable, live, settings, onUpdate});
    const lineCount = new Map();
    for (const l of network.lines) {
        lineCount.set(l.op, (lineCount.get(l.op) || 0) + 1);
    }

    return {
        providers: [timetable, live],
        feeds: [feed],
        alerts: () => feed.status,
        coverage(lang, S) {
            const note = NOTES[lang];
            const rows = Object.entries(network.operators).map(([op, names]) => {
                const n = feed.liveOps.get(op) || 0;
                const src = LIVE_SOURCES[op];
                const state = src ? feed.state[src] : null;
                let status = n > 0 ? 'live' : 'timetable', detail;
                if (n > 0) {
                    detail = note.reporting(n);
                } else if (src && state && state.error) {
                    status = 'error';
                    detail = note.error(state.error);
                } else if (src) {
                    detail = `${S.timetableNote}. ${note[src]}`;
                } else {
                    detail = S.timetableNote;
                }
                return {op, name: lang === 'ja' ? names.ja : names.en, status, detail, lines: lineCount.get(op) || 0};
            });
            const rank = {live: 0, error: 1, timetable: 2};
            rows.sort((a, b) => rank[a.status] - rank[b.status] || b.lines - a.lines);
            return rows;
        }
    };
}
