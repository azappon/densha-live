// Tokyo live data from the Public Transportation Open Data Center (ODPT).
//  - api-public.odpt.org: no key needed (Toei)
//  - api.odpt.org: free developer key (Yokohama Subway, line status of most metros)
//  - api-challenge.odpt.org: Open Data Challenge 2026 key (JR East, Keikyu, Keio, Tobu) — until 2027-03-12

const PUBLIC_API = 'https://api-public.odpt.org/api/v4/';
const ODPT_API = 'https://api.odpt.org/api/v4/';
const CHALLENGE_API = 'https://api-challenge.odpt.org/api/v4/';

const ops = list => list.map(o => `odpt.Operator:${o}`).join(',');

export const ODPT_TRAIN_SOURCES = [
    {id: 'public', base: PUBLIC_API, key: null, operators: ['Toei']},
    {id: 'odpt', base: ODPT_API, key: 'odptKey', operators: ['YokohamaMunicipal', 'TokyoMetro', 'TWR', 'MIR', 'TamaMonorail', 'Yurikamome', 'TokyoMonorail']},
    {id: 'challenge', base: CHALLENGE_API, key: 'challengeKey', operators: ['JR-East', 'Keikyu', 'Keio', 'Tobu', 'Tokyu', 'Odakyu', 'Seibu', 'Sotetsu']}
];

const STATUS_SOURCES = [
    {id: 'public', base: PUBLIC_API, key: null, operators: ['Toei']},
    {id: 'odpt', base: ODPT_API, key: 'odptKey', operators: ['TokyoMetro', 'Toei', 'TWR', 'YokohamaMunicipal', 'MIR', 'TamaMonorail']},
    {id: 'challenge', base: CHALLENGE_API, key: 'challengeKey', operators: ['jre-is', 'Tokyu', 'Keikyu', 'Tobu', 'Seibu', 'Keio']}
];

const strip = (id, prefix) => (id || '').replace(prefix, '');

export class OdptFeed {
    constructor({network, timetable, live, settings, onUpdate}) {
        this.network = network;
        this.timetable = timetable;
        this.live = live;
        this.settings = settings;
        this.onUpdate = onUpdate;
        this.state = {};       // per source id: {ok, error, count, at}
        this.liveOps = new Map(); // operator id -> number of live trains
        this.status = [];      // disrupted lines
        this.timer = null;
        this.statusTimer = null;
    }

    start() {
        this.stop();
        const tick = () => this.poll().finally(() => {
            this.timer = setTimeout(tick, 20000);
        });
        const statusTick = () => this.pollStatus().finally(() => {
            this.statusTimer = setTimeout(statusTick, 120000);
        });
        tick();
        statusTick();
    }

    stop() {
        clearTimeout(this.timer);
        clearTimeout(this.statusTimer);
    }

    url(src, type) {
        const key = src.key ? this.settings[src.key] : null;
        if (src.key && !key) {
            return null;
        }
        let url = `${src.base}${type}?odpt:operator=${ops(src.operators)}`;
        if (key) {
            url += `&acl:consumerKey=${encodeURIComponent(key)}`;
        }
        return url;
    }

    async poll() {
        const now = Date.now();
        const seen = new Set();
        const perOp = new Map();
        await Promise.all(ODPT_TRAIN_SOURCES.map(async src => {
            const url = this.url(src, 'odpt:Train');
            if (!url) {
                this.state[src.id] = {ok: false, disabled: true};
                return;
            }
            try {
                const res = await fetch(url, {cache: 'no-store'});
                if (!res.ok) {
                    throw new Error(`HTTP ${res.status}`);
                }
                const items = await res.json();
                const reports = [];
                for (const item of items) {
                    const r = this.handle(item, now, seen, perOp);
                    if (r) {
                        reports.push(r);
                    }
                }
                this.live.ingest(reports, now);
                this.state[src.id] = {ok: true, count: items.length, at: now};
            } catch (e) {
                this.state[src.id] = {ok: false, error: String(e.message || e), at: now};
            }
        }));
        this.live.retire('odpt:', seen, now);
        this.liveOps = perOp;
        this.onUpdate && this.onUpdate();
    }

    handle(item, now, seen, perOp) {
        const net = this.network;
        const lineId = strip(item['odpt:railway'], 'odpt.Railway:');
        const line = net.lineById.get(lineId);
        if (!line) {
            return null;
        }
        const op = strip(item['odpt:operator'], 'odpt.Operator:');
        perOp.set(op, (perOp.get(op) || 0) + 1);
        const number = item['odpt:trainNumber'];
        const delayMin = (item['odpt:delay'] || 0) / 60;
        if (this.timetable && this.timetable.setLiveDelay(lineId, number, delayMin, now)) {
            return null;
        }
        // Not in the timetable (extra or rescheduled train): place it from the reported stations
        const fromId = strip(item['odpt:fromStation'], 'odpt.Station:');
        const toId = strip(item['odpt:toStation'], 'odpt.Station:');
        const fromSt = net.stationById.get(fromId);
        if (fromSt === undefined) {
            return null;
        }
        const from = this.live.stationIndex(line, fromSt);
        if (from < 0) {
            return null;
        }
        let to = -1;
        if (toId) {
            const toSt = net.stationById.get(toId);
            to = toSt === undefined ? -1 : this.live.stationIndex(line, toSt, from);
        }
        const key = `odpt:${lineId}:${number}`;
        seen.add(key);
        const typeId = strip(item['odpt:trainType'], 'odpt.TrainType:');
        const type = net.types.find(t => t.id === typeId);
        const destId = strip((item['odpt:destinationStation'] || [])[0], 'odpt.Station:');
        const destIdx = net.stationById.get(destId);
        const dirAsc = strip(item['odpt:railDirection'], 'odpt.RailDirection:') === line.asc;
        return {
            key, line, from, to, dir: dirAsc ? 1 : -1,
            info: {
                number, delay: Math.round(delayMin), feed: 'ODPT',
                typeJa: type && type.ja, typeEn: type && type.en,
                destJa: destIdx !== undefined ? net.stations[destIdx].ja : '',
                destEn: destIdx !== undefined ? net.stations[destIdx].en : ''
            }
        };
    }

    async pollStatus() {
        const out = [];
        await Promise.all(STATUS_SOURCES.map(async src => {
            const url = this.url(src, 'odpt:TrainInformation');
            if (!url) {
                return;
            }
            try {
                const res = await fetch(url, {cache: 'no-store'});
                if (!res.ok) {
                    return;
                }
                for (const item of await res.json()) {
                    const status = item['odpt:trainInformationStatus'];
                    const text = item['odpt:trainInformationText'];
                    if (!status || !text) {
                        continue;
                    }
                    const lineId = strip(item['odpt:railway'], 'odpt.Railway:');
                    out.push({
                        line: this.network.lineById.get(lineId) || null,
                        operator: strip(item['odpt:operator'], 'odpt.Operator:'),
                        status: {ja: status.ja, en: status.en || status.ja},
                        text: {ja: text.ja, en: text.en || text.ja}
                    });
                }
            } catch (e) {
                // status is best effort
            }
        }));
        this.status = out;
        this.onUpdate && this.onUpdate();
    }
}
