"""Test isolation: every test session gets its own DATA_DIR and runs without a Gemini key.

This runs before any `app.*` import, so `app.config` never touches the developer's real
~/DocketBlueprintData and never calls the paid API.
"""
import os
import tempfile

TEST_DATA_PREFIX = "docket-blueprint-test-"
os.environ["DATA_DIR"] = tempfile.mkdtemp(prefix=TEST_DATA_PREFIX)
os.environ["MOCK_LLM"] = "1"
os.environ["MOCK_DELAY_S"] = "0"
# Empty (not unset): python-dotenv never overrides an existing variable, so backend/.env stays out.
os.environ["GEMINI_API_KEY"] = ""
os.environ["GOOGLE_API_KEY"] = ""
