import os
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parents[1]
load_dotenv(BACKEND_DIR / ".env")

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY") or ""
MODEL_FAST = os.getenv("GEMINI_MODEL_FAST", "")
MODEL_PRO = os.getenv("GEMINI_MODEL_PRO", "")

# Number of parallel extractor agents (job workers) and the cap on simultaneous Gemini calls.
MAX_CONCURRENCY = int(os.getenv("MAX_CONCURRENCY", "32"))
CHUNK_PAGES = int(os.getenv("CHUNK_PAGES", "20"))
MAX_PAGES_PER_DOC = int(os.getenv("MAX_PAGES_PER_DOC", "200"))

MOCK_LLM = os.getenv("MOCK_LLM", "0") == "1" or not GEMINI_API_KEY
# Seconds of fake latency per mock job, so the live UI can be demoed without a key.
MOCK_DELAY_S = float(os.getenv("MOCK_DELAY_S", "1.5"))

# Dockets + case outputs (GBs). Default lives in the user's home, outside the repo and outside
# synced folders like OneDrive. Override with DATA_DIR (absolute, or relative to backend/).
DATA_DIR = (BACKEND_DIR / os.getenv("DATA_DIR", str(Path.home() / "DocketBlueprintData"))).resolve()
DOCKETS_DIR = DATA_DIR / "dockets"
CASES_DIR = DATA_DIR / "cases"  # created on first write (CaseStore.create), never at import time

# This is a local workstation tool without auth. Keep it that way: browsers may only call it from the
# dev UI, and POST /api/cases/local may only read folders below these roots (os.pathsep separated).
CORS_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",") if o.strip()]
LOCAL_CASE_ROOTS = [DATA_DIR] + [Path(p).expanduser().resolve() for p in os.getenv("LOCAL_CASE_ROOTS", "").split(os.pathsep) if p.strip()]

# Citation verification threshold (rapidfuzz partial_ratio, 0-100).
VERIFY_THRESHOLD = 85

# Demo intake replays an explicitly configured completed case; no new extraction.
DEMO_MODE = os.getenv("DEMO_MODE", "0") == "1"
DEMO_CASE_ID = os.getenv("DEMO_CASE_ID", "atlas-team-reviewed-v1")
