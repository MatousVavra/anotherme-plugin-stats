import sqlite3
from unittest.mock import MagicMock

from conftest import load_plugin_module
from fake_plugin_context import FakePluginContext


class _DbModule:
    def __init__(self, conn):
        self._conn = conn

    def get_db(self):
        return self._conn


def _make_plugin(conn):
    vault = MagicMock()
    vault.list_all_notes = lambda name: []
    ctx = FakePluginContext(vault_manager=vault, db_module=_DbModule(conn))
    plugin = load_plugin_module().Plugin()
    plugin.on_load(ctx)
    return plugin


def test_stats_survives_missing_chat_table():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    plugin = _make_plugin(conn)
    stats = plugin._build_stats("main")
    assert stats["conversations"] == 0


def test_stats_counts_chat_threads_when_present():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE chat_threads (id INTEGER PRIMARY KEY, vault_name TEXT)")
    conn.execute("INSERT INTO chat_threads (vault_name) VALUES ('main')")
    plugin = _make_plugin(conn)
    stats = plugin._build_stats("main")
    assert stats["conversations"] == 1
