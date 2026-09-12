"""Stats plugin integration tests (moved from the AnotherMe host repo,
tests/test_stats_tokens.py + tests/test_plugins/test_remaining_plugins.py)."""
import os
from pathlib import Path

import pytest


@pytest.fixture
def client(make_client):
    return make_client()


def _insert_usage(conn, plugin, prompt_t, completion_t, total_t, latency_ms, ts):
    conn.execute(
        "INSERT INTO llm_usage (timestamp, plugin, model, prompt_tokens, completion_tokens, total_tokens, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (ts, plugin, "test-model", prompt_t, completion_t, total_t, latency_ms),
    )
    conn.commit()


def test_tokens_route_returns_data(client):
    import src.database
    from src.database import now_utc
    conn = src.database.get_db()
    _insert_usage(conn, "chat", 100, 50, 150, 500, now_utc())
    _insert_usage(conn, "diary", 200, 100, 300, 800, now_utc())

    resp = client.get("/plugins/stats/tokens?period=7d")
    assert resp.status_code == 200
    data = resp.json()
    assert "daily" in data
    assert len(data["daily"]) >= 1
    entry = data["daily"][0]
    assert "date" in entry
    assert "plugin" in entry
    assert "prompt_tokens" in entry
    assert "completion_tokens" in entry
    assert "total_tokens" in entry


def test_tokens_route_empty(client):
    resp = client.get("/plugins/stats/tokens?period=7d")
    assert resp.status_code == 200
    data = resp.json()
    assert data["daily"] == []


def test_resources_route_returns_data(client):
    resp = client.get("/plugins/stats/resources")
    assert resp.status_code == 200
    data = resp.json()
    assert "vault_size_bytes" in data
    assert "vault_folder_sizes" in data
    assert "db_size_bytes" in data
    assert "table_counts" in data
    assert "latency" in data
    assert isinstance(data["vault_folder_sizes"], dict)
    assert isinstance(data["table_counts"], dict)


def test_resources_route_latency(client):
    import src.database
    from src.database import now_utc
    conn = src.database.get_db()
    _insert_usage(conn, "chat", 100, 50, 150, 500, now_utc())
    _insert_usage(conn, "chat", 200, 100, 300, 1000, now_utc())

    resp = client.get("/plugins/stats/resources")
    assert resp.status_code == 200
    data = resp.json()
    latency = data["latency"]
    assert "chat" in latency
    assert latency["chat"]["avg_ms"] == 750
    assert latency["chat"]["min_ms"] == 500
    assert latency["chat"]["max_ms"] == 1000
    assert latency["chat"]["count"] == 2


class FakeMemoryApi:
    def __init__(self, people=None, facts=None):
        self._people = people or []
        self._facts = facts or []

    def get_people(self, vault_name):
        return self._people

    def get_facts(self, vault_name):
        return self._facts


def test_stats_plugin_listed(client):
    names = {p["name"] for p in client.get("/plugins").json()}
    assert "stats" in names


def test_stats_returns_counts(client):
    vault_dir = Path(os.environ["VAULTS_DIR"]) / "test-main"
    (vault_dir / "Notes" / "TestNote.md").write_text("# Test\n", encoding="utf-8")

    fake_api = FakeMemoryApi(
        people=[{"name": "Alice"}, {"name": "Bob"}],
        facts=[{"key": "name", "value": "User"}],
    )

    import src.main
    registry = src.main.plugin_manager.get_registry()
    original = registry.get_api("memory")
    registry._apis["memory"] = fake_api

    try:
        resp = client.get("/plugins/stats")
    finally:
        registry._apis["memory"] = original

    assert resp.status_code == 200
    data = resp.json()
    assert data["conversations"] == 0
    assert data["notes"] == 1
    assert data["people"] == 2
    assert data["facts"] == 1
