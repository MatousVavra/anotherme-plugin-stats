import asyncio

from fastapi import APIRouter


class Plugin:
    def on_load(self, ctx):
        self._vault = ctx.vault_manager
        self._db = ctx.db_module
        self._ctx = ctx

        router = APIRouter()

        @router.get("")
        async def stats():
            vn = self._ctx.vault_name
            return await asyncio.to_thread(self._build_stats, vn)

        @router.get("/tokens")
        async def token_stats(period: str = "7d"):
            return await asyncio.to_thread(self._build_token_stats, period)

        @router.get("/resources")
        async def resource_stats():
            vn = self._ctx.vault_name
            return await asyncio.to_thread(self._build_resource_stats, vn)

        ctx.register_router(router)

    def _build_stats(self, vault_name: str) -> dict:
        conn = self._db.get_db()
        conversations = conn.execute(
            "SELECT COUNT(*) FROM chat_threads WHERE vault_name = ?", (vault_name,)
        ).fetchone()[0]
        notes = len(self._vault.list_all_notes(vault_name))

        people_count = 0
        facts_count = 0
        memory_api = self._ctx.get_plugin_api("memory")
        if memory_api:
            people_count = len(memory_api.get_people(vault_name))
            facts_count = len(memory_api.get_facts(vault_name))

        return {
            "conversations": conversations,
            "notes": notes,
            "people": people_count,
            "facts": facts_count,
        }

    def _build_token_stats(self, period: str) -> dict:
        conn = self._db.get_db()
        days = 7 if period == "7d" else 30 if period == "30d" else 7
        rows = conn.execute(
            """SELECT DATE(timestamp) as date, plugin,
                      SUM(prompt_tokens) as prompt_tokens,
                      SUM(completion_tokens) as completion_tokens,
                      SUM(total_tokens) as total_tokens
               FROM llm_usage
               WHERE timestamp >= datetime('now', ?)
               GROUP BY date, plugin
               ORDER BY date""",
            (f"-{days} days",),
        ).fetchall()
        return {"daily": [dict(r) for r in rows]}

    def _build_resource_stats(self, vault_name: str) -> dict:
        import os as _os
        conn = self._db.get_db()
        vault_path = self._vault.vault_path(vault_name)
        vault_size = 0
        folder_sizes = {}
        for folder in ("Diary", "Stories", "Projects", "People", "Notes", "Inbox"):
            d = vault_path / folder
            if d.is_dir():
                size = sum(f.stat().st_size for f in d.rglob("*") if f.is_file())
                folder_sizes[folder] = size
                vault_size += size
            else:
                folder_sizes[folder] = 0
        db_path = _os.environ.get("DB_PATH", "/data/anotherme.db")
        db_size = _os.path.getsize(db_path) if _os.path.exists(db_path) else 0
        table_counts = {}
        tables = conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        for t in tables:
            name = t[0]
            count = conn.execute(f"SELECT COUNT(*) FROM [{name}]").fetchone()[0]
            table_counts[name] = count
        latency_rows = conn.execute(
            """SELECT plugin, AVG(latency_ms) as avg_ms, MIN(latency_ms) as min_ms,
                      MAX(latency_ms) as max_ms, COUNT(*) as count
               FROM llm_usage
               WHERE timestamp >= datetime('now', '-7 days')
               GROUP BY plugin""",
        ).fetchall()
        latency = {}
        for r in latency_rows:
            latency[r["plugin"]] = {
                "avg_ms": int(r["avg_ms"]) if r["avg_ms"] else 0,
                "min_ms": r["min_ms"] or 0,
                "max_ms": r["max_ms"] or 0,
                "count": r["count"],
            }
        return {
            "vault_size_bytes": vault_size,
            "vault_folder_sizes": folder_sizes,
            "db_size_bytes": db_size,
            "table_counts": table_counts,
            "latency": latency,
        }
