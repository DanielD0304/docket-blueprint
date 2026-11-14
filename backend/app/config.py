import os
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parents[1]
load_dotenv(BACKEND_DIR / ".env")

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY") or ""
MODEL_FAST = os.getenv("GEMINI_MODEL_FAST", "gemini-4-hydrogen")
MODEL_PRO = os.getenv("GEMINI_MODEL_PRO", "gemini-4-argon")

MAX_CONCURRENCY = int(os.getenv("MAX_CONCURRENCY", "12"))
CHUNK_PAGES = int(os.getenv("CHUNK_PAGES", "20"))
MAX_PAGES_PER_DOC = int(os.getenv("MAX_PAGES_PER_DOC", "200"))

MOCK_LLM = os.getenv("MOCK_LLM", "0") == "1" or not GEMINI_API_KEY
# Seconds of fake latency per mock job, so the live UI can be demoed without a key.
MOCK_DELAY_S = float(os.getenv("MOCK_DELAY_S", "1.5"))

DATA_DIR = (BACKEND_DIR / os.getenv("DATA_DIR", "../data")).resolve()
CASES_DIR = DATA_DIR / "cases"
CASES_DIR.mkdir(parents=True, exist_ok=True)

# Citation verification threshold (rapidfuzz partial_ratio, 0-100).
VERIFY_THRESHOLD = 85

# Demo intake replays an explicitly configured completed case; no new extraction.
DEMO_MODE = os.getenv("DEMO_MODE", "0") == "1"
DEMO_CASE_ID = os.getenv("DEMO_CASE_ID", "atlas-team-reviewed-v1")
