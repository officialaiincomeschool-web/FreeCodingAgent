import os
from pathlib import Path


def api_key():
    """Read the River key from the environment or the repo's .env file."""
    key = os.environ.get("RIVER_API_KEY")
    if key and key != "replace_with_your_river_key":
        return key
    env = Path(__file__).resolve().parent.parent / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            name, _, value = line.partition("=")
            if name.strip() == "RIVER_API_KEY" and value.strip():
                return value.strip()
    raise SystemExit("RIVER_API_KEY not found: set it in the environment or in ../.env")
