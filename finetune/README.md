# Fine-tuning with River (experimental)

These scripts use River's training platform (`river-client`, Python) — separate from the chat app. The chat app only *serves* models; training teaches a model from examples and is billed separately from inference. Check **Console → Billing → Pricing** for current training rates and your balance.

## Setup

Requires **Python 3.12 or newer** (`river-client` enforces this). On this machine Python 3.12 was installed with:

```powershell
winget install -e --id Python.Python.3.12
```

Then:

```powershell
cd finetune
py -3.12 -m pip install -r requirements.txt   # or the full path to python.exe
```

If `py` is not available, use `%LOCALAPPDATA%\Programs\Python\Python312\python.exe` directly. The `RIVER_API_KEY` is read from the environment or from `../.env` automatically.

## Steps (all verified working)

1. **Access check** — free, no training:

   ```powershell
   py -3.12 check_access.py
   ```

   This key can currently sample and train 16 models (Qwen3.5/3.6/3.8, Kimi-K2.6, GLM-5.2, MiMo V2.6 Flash/Pro RL, DeepSeek-V4-Flash, Nemotron). Ask River support or the River Discord if you need more.

2. **One short sample** — tiny inference cost:

   ```powershell
   py -3.12 first_request.py
   ```

   Defaults to `Qwen/Qwen3.5-9B`; override with `RIVER_MODEL`.

3. **First SFT run** — trains a LoRA (rank 32) for 15 steps on a toy task ("prefix every word with `test-`"), samples before/after, saves a checkpoint:

   ```powershell
   py -3.12 sft.py
   ```

   Defaults to `Qwen/Qwen3.6-35B-A3B-FP8`; override with `RIVER_SFT_MODEL`. It worked here: loss fell from ~51 to ~0, the model generalized to new inputs, and the saved checkpoint (`river://.../sampler_weights/prefix`) reproduced the behavior.

## What to train next

- **Your own style/domain**: export conversations from the chat app (browser localStorage, key `riverchat.chats.v2`) and build `(prompt, completion)` pairs for real SFT.
- **Fixed output formats**: JSON shapes, templates, tags — easy to verify and low-risk.
- **RL**: you supply a reward function and the model improves by trying (`docs.river.ai/guides/rl-sync/`). MiMo V2.6 Flash/Pro RL are purpose-built for this.
- **Deploy a checkpoint**: `docs.river.ai/guides/deployments/`.

References: https://docs.river.ai/guides/sft/ · https://docs.river.ai/guides/rl-sync/ · https://docs.river.ai/guides/deployments/
