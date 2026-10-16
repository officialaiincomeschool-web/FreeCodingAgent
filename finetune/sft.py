"""First SFT run: teach a model to prefix every word with 'test-'.

Adapted from https://docs.river.ai/guides/sft/ so it reads the key from ../.env.
This trains a LoRA adapter for 15 steps. Check Console -> Billing -> Pricing
before running so you know what training costs on your account.
"""
import os
from contextlib import closing

import river_client as river

from riverenv import api_key

BASE = os.environ.get("RIVER_SFT_MODEL", "Qwen/Qwen3.6-35B-A3B-FP8")


def target_for(text):
    return " ".join("test-" + word for word in text.split())


def render(text):
    return f"Input: {text}\nOutput:"


def main():
    from transformers import AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(BASE)
    eos = tokenizer.eos_token_id

    train_inputs = [
        "hello world",
        "good morning sunshine",
        "the quick brown fox",
        "i love programming",
        "open the pod bay doors",
        "river flows to the sea",
    ]

    def make_datum(text):
        prompt_ids = tokenizer(render(text), add_special_tokens=False)["input_ids"]
        completion_ids = tokenizer(" " + target_for(text), add_special_tokens=False)["input_ids"] + [eos]
        ids = prompt_ids + completion_ids
        target_tokens = ids[1:] + [eos]
        weights = [0.0] * (len(prompt_ids) - 1) + [1.0] * (len(completion_ids) + 1)
        return {"input_ids": ids, "target_tokens": target_tokens, "weights": weights}

    batch = [make_datum(text) for text in train_inputs]

    with closing(river.Client(api_key=api_key())) as client:
        with client.session(project="sft-prefix") as session:
            model = session.create_model(base_model=BASE, lora=river.LoraConfig(rank=32))
            print("model_id:", model.model_id)

            for step in range(15):
                fb = model.forward_backward(batch, loss_fn="cross_entropy")
                model.optim_step(lr=2e-4, grad_clip_norm=1.0)
                print(f"step {model.step:2d}  loss={fb.metrics['loss']:.4f}")

            for text in ["hello world", "the lazy dog sleeps"]:
                out = model.sample(render(text), max_tokens=16, temperature=0.0, stop=["\n"])
                print(f"{text!r} -> {out[0][0].text!r}")

            checkpoint = model.save_weights("prefix", mode="inference")
            print("saved checkpoint:", checkpoint.path)

            for text in ["hello world", "the lazy dog sleeps"]:
                out = session.sample(render(text), base_model=BASE, checkpoint=checkpoint, max_tokens=16, temperature=0.0, stop=["\n"])
                print(f"from checkpoint: {text!r} -> {out[0][0].text!r}")


if __name__ == "__main__":
    main()
