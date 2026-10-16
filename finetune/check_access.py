"""Check that your River key works and list the models it can train and sample."""
from contextlib import closing

import river_client as river

from riverenv import api_key

with closing(river.Client(api_key=api_key())) as client:
    print("healthy:", client.health_check())
    print("available models for this key:")
    capabilities = client.get_capabilities()
    for name in capabilities:
        print(" -", name)
    if not capabilities:
        print(" (none) Ask River support for access: support@river.ai or the River Discord.")
