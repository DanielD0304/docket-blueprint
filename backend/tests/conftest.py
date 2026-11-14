"""Test isolation: every test session gets its own DATA_DIR and runs without a Gemini key.

This runs before any `app.*` import, so `app.config` never touches the developer's real
~/DocketBlueprintData and never calls the paid API.
"""
import os
import socket
import sys
import tempfile
import threading
import unittest

TEST_DATA_PREFIX = "docket-blueprint-test-"
os.environ["DATA_DIR"] = tempfile.mkdtemp(prefix=TEST_DATA_PREFIX)
os.environ["MOCK_LLM"] = "1"
os.environ["MOCK_DELAY_S"] = "0"
# Empty (not unset): python-dotenv never overrides an existing variable, so backend/.env stays out.
os.environ["GEMINI_API_KEY"] = ""
os.environ["GOOGLE_API_KEY"] = ""


# --- Sandboxes without loopback networking -------------------------------------------------------
# On Windows, every asyncio event loop (asyncio.run, FastAPI's TestClient) creates its self-pipe with
# socket.socketpair(), which Python emulates over a 127.0.0.1 TCP connection (no AF_UNIX there).
# Some sandboxes block loopback, and socketpair() then blocks forever in accept(). Probe once; if it
# cannot complete, make socketpair() raise SkipTest so async tests are skipped with a clear reason
# instead of each hanging until the timeout. Normal machines and CI (Linux, native AF_UNIX) are unaffected.

LOOPBACK_SKIP = "loopback sockets are blocked here; asyncio on Windows needs them for socketpair()"


def _loopback_socketpair_works(timeout_s: float = 3.0) -> bool:
    if os.environ.get("DOCKET_TEST_SIMULATE_NO_LOOPBACK") == "1":
        return False
    ok: list[bool] = []

    def probe() -> None:
        try:
            a, b = socket.socketpair()
            a.close(), b.close()
            ok.append(True)
        except OSError:
            pass

    t = threading.Thread(target=probe, daemon=True)
    t.start()
    t.join(timeout_s)
    return bool(ok)


if (sys.platform == "win32" or os.environ.get("DOCKET_TEST_SIMULATE_NO_LOOPBACK") == "1") \
        and not _loopback_socketpair_works():
    def _blocked_socketpair(*_args, **_kwargs):
        raise unittest.SkipTest(LOOPBACK_SKIP)

    socket.socketpair = _blocked_socketpair
    print(f"\n[conftest] {LOOPBACK_SKIP}: async tests will be skipped", file=sys.stderr)
