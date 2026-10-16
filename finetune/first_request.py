"""Sample one short response from a base model (cheap inference check)."""
import os
from contextlib import closing

import river_client as river

from riverenv import api_key

MODEL = os.environ.get("RIVER_MODEL", "Qwen/Qwen3.5-9B")

with closing(river.Client(api_key=api_key())) as client:
    samples = client.sample(
        "Explain supervised fine-tuning in one sentence.",
        base_model=MODEL,
        max_tokens=256,
    )
    print(f"model: {MODEL}")
    print(samples[0].text)
