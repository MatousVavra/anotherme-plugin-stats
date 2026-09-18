function statsPlugin() {
    return {
        overview: null,
        tokenData: { daily: [] },
        tokenTotals: null,
        tokenPeriod: '7d',
        resources: null,
        folderSizes: [],
        tableCounts: [],
        latencyList: [],
        chartState: 'loading',
        _chart: null,
        _chartLibSettled: false,
        _refreshTimer: null,
        _pollTimer: null,
        _lastEventTs: null,
        _relevantEvents: ['diary_saved', 'memory_updated'],

        async init() {
            const dataLoaded = Promise.all([this.loadOverview(), this.loadTokens(), this.loadResources()]);
            await this._loadChartLib();
            this._chartLibSettled = true;
            this._updateChartState();
            if (this.chartState === 'ready') this.$nextTick(() => this._renderChart());
            await dataLoaded;
            this._startLiveRefresh();
            AM.onCleanup(() => this._teardown());
        },

        _teardown() {
            if (this._chart) { this._chart.destroy(); this._chart = null; }
            if (this._refreshTimer) { clearTimeout(this._refreshTimer); this._refreshTimer = null; }
            if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
        },

        _loadChartLib() {
            return new Promise((resolve) => {
                if (window.Chart) { resolve(); return; }
                const existing = document.getElementById('chartjs-cdn');
                if (existing) {
                    if (window.Chart) { resolve(); return; }
                    if (existing.dataset.failed === 'true') { resolve(); return; }
                    existing.addEventListener('load', () => resolve());
                    existing.addEventListener('error', () => resolve());
                    return;
                }
                const script = document.createElement('script');
                script.id = 'chartjs-cdn';
                script.src = 'https://cdn.jsdelivr.net/npm/chart.js';
                script.onload = () => resolve();
                script.onerror = () => { script.dataset.failed = 'true'; resolve(); };
                document.head.appendChild(script);
            });
        },

        _startLiveRefresh() {
            for (const name of this._relevantEvents) {
                AM.events.on(name, () => this._queueRefresh());
            }
            const raw = parseInt((AM.plugin && AM.plugin.config && AM.plugin.config.refresh_interval) || 30, 10);
            const seconds = Math.min(300, Math.max(5, raw || 30));
            this._pollTimer = setInterval(() => this._pollEvents(), seconds * 1000);
        },

        async _pollEvents() {
            try {
                const url = '/plugins/events/poll' + (this._lastEventTs ? '?since=' + encodeURIComponent(this._lastEventTs) : '');
                const resp = await fetch(url);
                if (!resp || !resp.ok) return;
                const events = await resp.json();
                if (!Array.isArray(events)) return;
                for (const e of events) {
                    if (e.timestamp && e.timestamp > (this._lastEventTs || '')) this._lastEventTs = e.timestamp;
                    if (this._relevantEvents.includes(e.event) && AM.events._dispatch) {
                        AM.events._dispatch(e.event, e.payload || {});
                    }
                }
            } catch (e) { }
        },

        _queueRefresh() {
            if (this._refreshTimer) clearTimeout(this._refreshTimer);
            this._refreshTimer = setTimeout(() => {
                this._refreshTimer = null;
                Promise.all([this.loadOverview(), this.loadTokens(), this.loadResources()]);
            }, 2000);
        },

        async loadOverview() {
            try {
                const resp = await AM.fetch('/plugins/stats/');
                if (!resp) return;
                if (!resp.ok) { AM.toast('Failed to load overview', 'error'); return; }
                const data = await resp.json();
                this.overview = {
                    conversations: data.conversations || 0,
                    notes: data.notes || 0,
                    people: data.people || 0,
                    facts: data.facts || 0,
                };
            } catch (e) {
                AM.toast('Failed to load overview', 'error');
            }
        },

        async loadTokens() {
            try {
                const resp = await AM.fetch('/plugins/stats/tokens?period=' + this.tokenPeriod);
                if (!resp) return;
                if (!resp.ok) { AM.toast('Failed to load token stats', 'error'); return; }
                const data = await resp.json();
                this.tokenData = { daily: data.daily || [] };
                let prompt = 0, completion = 0, total = 0;
                for (const d of this.tokenData.daily) {
                    prompt += d.prompt_tokens || 0;
                    completion += d.completion_tokens || 0;
                    total += d.total_tokens || 0;
                }
                this.tokenTotals = { prompt, completion, total };
                this._updateChartState();
                if (this.chartState === 'ready') this.$nextTick(() => this._renderChart());
            } catch (e) {
                AM.toast('Failed to load token stats', 'error');
            }
        },

        async loadResources() {
            try {
                const resp = await AM.fetch('/plugins/stats/resources');
                if (!resp) return;
                if (!resp.ok) { AM.toast('Failed to load resources', 'error'); return; }
                const data = await resp.json();
                this.resources = {
                    vault_size_bytes: data.vault_size_bytes || 0,
                    vault_folder_sizes: data.vault_folder_sizes || {},
                    db_size_bytes: data.db_size_bytes || 0,
                    table_counts: data.table_counts || {},
                };
                this.folderSizes = Object.entries(this.resources.vault_folder_sizes)
                    .map(([name, size]) => ({ name, size: size || 0 }))
                    .sort((a, b) => b.size - a.size);
                this.tableCounts = Object.entries(this.resources.table_counts)
                    .map(([name, count]) => ({ name, count: count || 0 }))
                    .sort((a, b) => a.name.localeCompare(b.name));
                const latency = data.latency || {};
                this.latencyList = Object.entries(latency)
                    .map(([plugin, v]) => ({
                        plugin,
                        avg_ms: v.avg_ms || 0,
                        min_ms: v.min_ms || 0,
                        max_ms: v.max_ms || 0,
                        count: v.count || 0,
                    }))
                    .sort((a, b) => b.avg_ms - a.avg_ms);
            } catch (e) {
                AM.toast('Failed to load resources', 'error');
            }
        },

        setPeriod(period) {
            if (this.tokenPeriod === period) return;
            this.tokenPeriod = period;
            this.loadTokens();
        },

        _updateChartState() {
            if (!window.Chart) { this.chartState = this._chartLibSettled ? 'unavailable' : 'loading'; return; }
            if (!this.tokenData.daily || this.tokenData.daily.length === 0) { this.chartState = 'empty'; return; }
            this.chartState = 'ready';
        },

        _renderChart() {
            if (!window.Chart) return;
            if (this._chart) { this._chart.destroy(); this._chart = null; }
            const daily = this.tokenData.daily;
            if (!daily || daily.length === 0) return;

            const dates = [...new Set(daily.map(d => d.date))].sort();
            const plugins = [...new Set(daily.map(d => d.plugin))];

            const css = getComputedStyle(document.documentElement);
            const palette = [
                css.getPropertyValue('--accent').trim() || '#c4b8e0',
                css.getPropertyValue('--warm').trim() || '#f5cc89',
                css.getPropertyValue('--success').trim() || '#89c4a1',
                css.getPropertyValue('--error').trim() || '#d97d86',
                '#7fb3d5',
                '#b89cce',
            ];
            const textColor = css.getPropertyValue('--text').trim() || '#ebe4da';
            const mutedColor = css.getPropertyValue('--muted').trim() || '#948fa8';
            const borderColor = css.getPropertyValue('--border').trim() || 'rgba(196,184,224,0.08)';

            const datasets = plugins.map((plugin, i) => ({
                label: plugin,
                data: dates.map(date => {
                    const row = daily.find(d => d.date === date && d.plugin === plugin);
                    return row ? (row.total_tokens || 0) : 0;
                }),
                backgroundColor: palette[i % palette.length],
                borderRadius: 3,
                borderSkipped: false,
            }));

            const canvas = document.getElementById('tokenChart');
            if (!canvas) return;
            const ctx = canvas.getContext('2d');

            this._chart = new Chart(ctx, {
                type: 'bar',
                data: { labels: dates, datasets },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    interaction: { mode: 'index', intersect: false },
                    scales: {
                        x: {
                            stacked: true,
                            grid: { display: false },
                            ticks: { color: mutedColor, font: { size: 10 } },
                            border: { color: borderColor },
                        },
                        y: {
                            stacked: true,
                            beginAtZero: true,
                            grid: { color: 'rgba(148,143,168,0.1)' },
                            ticks: { color: mutedColor, font: { size: 10 } },
                            border: { display: false },
                        },
                    },
                    plugins: {
                        legend: {
                            labels: { color: textColor, boxWidth: 10, boxHeight: 10, font: { size: 11 } },
                        },
                        tooltip: {
                            mode: 'index',
                            intersect: false,
                        },
                    },
                },
            });
        },

        fmtNum(value) {
            if (value === null || value === undefined) return '\u2014';
            return value.toLocaleString();
        },

        overviewValue(key) {
            if (this.overview === null) return null;
            return this.overview[key];
        },

        formatBytes(bytes) {
            if (bytes === null || bytes === undefined) return '\u2014';
            if (!bytes || bytes === 0) return '0 B';
            const units = ['B', 'KB', 'MB', 'GB', 'TB'];
            const i = Math.floor(Math.log(bytes) / Math.log(1024));
            const val = bytes / Math.pow(1024, i);
            return val.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
        },

        folderPct(size) {
            const total = (this.resources && this.resources.vault_size_bytes) || 0;
            if (!total) return 0;
            return Math.round((size / total) * 100);
        },

        goTo(tab) {
            if (AM.isPluginEnabled(tab)) AM.navigate(tab);
        },
    };
}
