function statsPlugin() {
    return {
        overview: { conversations: 0, notes: 0, people: 0, facts: 0 },
        tokenData: { daily: [] },
        tokenTotals: { prompt: 0, completion: 0, total: 0 },
        resources: { vault_size_bytes: 0, vault_folder_sizes: {}, db_size_bytes: 0, table_counts: {} },
        folderSizes: [],
        tableCounts: [],
        latencyList: [],
        latency: {},
        _chart: null,

        async init() {
            await this._loadChartLib();
            await Promise.all([this.loadOverview(), this.loadTokens(), this.loadResources()]);
            AM.onCleanup(() => {
                if (this._chart) { this._chart.destroy(); this._chart = null; }
            });
        },

        _loadChartLib() {
            return new Promise((resolve) => {
                if (window.Chart) { resolve(); return; }
                const existing = document.getElementById('chartjs-cdn');
                if (existing) {
                    if (window.Chart) { resolve(); return; }
                    existing.addEventListener('load', () => resolve());
                    existing.addEventListener('error', () => resolve());
                    return;
                }
                const script = document.createElement('script');
                script.id = 'chartjs-cdn';
                script.src = 'https://cdn.jsdelivr.net/npm/chart.js';
                script.onload = () => resolve();
                script.onerror = () => resolve();
                document.head.appendChild(script);
            });
        },

        async loadOverview() {
            try {
                const resp = await AM.fetch('/plugins/stats/');
                if (!resp) return;
                const data = await resp.json();
                this.overview = {
                    conversations: data.conversations || 0,
                    notes: data.notes || 0,
                    people: data.people || 0,
                    facts: data.facts || 0,
                };
            } catch (e) { console.error('Stats loadOverview', e); }
        },

        async loadTokens() {
            try {
                const resp = await AM.fetch('/plugins/stats/tokens?period=7d');
                if (!resp) return;
                this.tokenData = await resp.json();
                if (!this.tokenData.daily) this.tokenData.daily = [];
                let prompt = 0, completion = 0, total = 0;
                for (const d of this.tokenData.daily) {
                    prompt += d.prompt_tokens || 0;
                    completion += d.completion_tokens || 0;
                    total += d.total_tokens || 0;
                }
                this.tokenTotals = { prompt, completion, total };
                this.$nextTick(() => this._renderChart());
            } catch (e) { console.error('Stats loadTokens', e); }
        },

        async loadResources() {
            try {
                const resp = await AM.fetch('/plugins/stats/resources');
                if (!resp) return;
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
                this.latency = data.latency || {};
                this.latencyList = Object.entries(this.latency)
                    .map(([plugin, v]) => ({
                        plugin,
                        avg_ms: v.avg_ms || 0,
                        min_ms: v.min_ms || 0,
                        max_ms: v.max_ms || 0,
                        count: v.count || 0,
                    }))
                    .sort((a, b) => b.avg_ms - a.avg_ms);
            } catch (e) { console.error('Stats loadResources', e); }
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

        formatBytes(bytes) {
            if (!bytes || bytes === 0) return '0 B';
            const units = ['B', 'KB', 'MB', 'GB', 'TB'];
            const i = Math.floor(Math.log(bytes) / Math.log(1024));
            const val = bytes / Math.pow(1024, i);
            return val.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
        },

        folderPct(size) {
            const total = this.resources.vault_size_bytes || 0;
            if (!total) return 0;
            return Math.round((size / total) * 100);
        },
    };
}
