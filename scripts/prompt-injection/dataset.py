# /// script
# requires-python = ">=3.11"
# dependencies = ["pandas>=2", "pyarrow>=15"]
# ///
"""
Prompt-injection corpus for the Channels filter.

    uv run scripts/prompt-injection/dataset.py fetch     # download public datasets (~700 MB)
    uv run scripts/prompt-injection/dataset.py prepare   # normalise them into corpus/*.jsonl
    uv run scripts/prompt-injection/dataset.py mine      # rank phrases: frequent in attacks, rare in mail

Then measure the real filter (server/modules/channels/injection) on the held-out part:

    npx tsx scripts/prompt-injection/eval.ts

Everything lands in $PI_DATA (default ~/.cache/cloudcli-prompt-injection), never in git:
the downloads are large and the attack texts are third-party data. The split is fixed so the
numbers stay comparable: signatures are written from `mine` output over the *train* part,
and `eval.ts` reports on the *holdout* part only.

Sources (all public, licences in their cards):
  microsoft/llmail-inject-challenge  ~200k unique e-mail injections from an adaptive challenge (MIT)
  deepset/prompt-injections          direct injections, en/de (Apache-2.0)
  jackhhao/jailbreak-classification  chatbot jailbreaks vs. benign prompts (Apache-2.0)
  SetFit/enron_spam                  real business e-mail (ham) and spam — the false-positive baseline
  promptprotection/agent-security-datasets  hand-written evasive attacks + hard benign (CC-BY-4.0)
  Horizon-Labs/prompt-injection-eval-suite  BIPIA, NotInject, PIArena, agentic sets, 30-language synthetic sets
  data/handwritten-eval.jsonl        hard benign mail in cs/sk/en/de written for this filter (in git)
"""
from __future__ import annotations

import hashlib
import json
import os
import random
import re
import subprocess
import sys
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = Path(os.environ.get("PI_DATA", Path.home() / ".cache" / "cloudcli-prompt-injection"))
RAW = DATA / "raw"
CORPUS = DATA / "corpus"
HF = "https://huggingface.co/datasets"

DOWNLOADS = {
    "llmail/p1.json": "microsoft/llmail-inject-challenge/resolve/main/data/labelled_unique_submissions_phase1.json",
    "llmail/p2.json": "microsoft/llmail-inject-challenge/resolve/main/data/labelled_unique_submissions_phase2.json",
    "llmail/fp.json": "microsoft/llmail-inject-challenge/resolve/main/data/emails_for_fp_tests.json",
    "deepset/train.parquet": "deepset/prompt-injections/resolve/main/data/train-00000-of-00001-9564e8b05b4757ab.parquet",
    "jackhhao/train.csv": "jackhhao/jailbreak-classification/resolve/main/default/jailbreak_dataset_train.csv",
    "enron/train.jsonl": "SetFit/enron_spam/resolve/main/train.jsonl",
    "enron/test.jsonl": "SetFit/enron_spam/resolve/main/test.jsonl",
    "agentsec/attacks.jsonl": "promptprotection/agent-security-datasets/resolve/main/attacks.jsonl",
    "agentsec/benign-hard.jsonl": "promptprotection/agent-security-datasets/resolve/main/benign-hard.jsonl",
    **{
        f"horizon/{name}.parquet": f"Horizon-Labs/prompt-injection-eval-suite/resolve/main/data/{name}.parquet"
        for name in [
            "agentic5k_test", "bipia", "boundary_pairs_test", "deepset_test", "jackhhao_test", "llmail_phase2",
            "neuralchemy_test", "notinject", "orbench_hard", "piarena", "simsonsun_jailbreaks", "slabs_test",
            "synthetic_direct_test", "synthetic_docs_test", "synthetic_v2_test", "xstest",
        ]
    },
}

# Holdout sets that are about mail / documents an agent reads (the threat Channels faces).
# The rest (chatbot jailbreaks, harmful-request look-alikes) are reported separately.
EMAIL_RELEVANT = {
    "llmail_p2", "bipia", "agentsec", "agentic5k", "boundary_pairs", "piarena", "synthetic_docs",
    "synthetic_v2", "enron_test", "llmail_fp", "handwritten", "notinject", "inbox",
}


TUNE_HALF = {"synthetic_direct", "synthetic_docs", "synthetic_v2", "handwritten", "llmail_p2", "bipia"}


def fetch() -> None:
    for rel, url in DOWNLOADS.items():
        target = RAW / rel
        if target.exists() and target.stat().st_size > 0:
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        print(f"↓ {rel}", flush=True)
        subprocess.run(["curl", "-sfL", "--retry", "4", "--retry-all-errors", f"{HF}/{url}", "-o", str(target)], check=True)
    print(f"ok: {RAW}")


def _llmail_split(text: str) -> tuple[str, str]:
    """LLMail rows are one string: 'Subject of the email: … Body: …'."""
    match = re.match(r"\s*Subject of the email:\s*(.*?)\.?\s+Body:\s*(.*)\Z", text, re.S)
    return (match.group(1).strip(), match.group(2).strip()) if match else ("", text)


def _row(source: str, split: str, label: int, text: str, subject: str = "", lang: str = "en", html: str = "") -> dict:
    return {"source": source, "split": split, "label": label, "lang": lang or "en", "subject": subject, "text": text, "html": html}


def prepare() -> None:
    import pandas as pd

    rows: list[dict] = []
    rng = random.Random(20261008)

    # --- train: what the signatures are mined from -----------------------------------------
    for phase, split, source in (("p1", "train", "llmail_p1"), ("p2", "holdout", "llmail_p2")):
        data = json.loads((RAW / f"llmail/{phase}.json").read_text())
        for text, meta in data.items():
            # 'True' = the judge saw an attack attempt or the attack reached send_email; 'Unclear'/'False' are noise.
            if str(meta.get("attack_attempt")) != "True":
                continue
            subject, body = _llmail_split(text)
            rows.append(_row(source, split, 1, body, subject))
    for text in json.loads((RAW / "llmail/fp.json").read_text()):
        subject, body = _llmail_split(text)
        rows.append(_row("llmail_fp", "holdout", 0, body, subject))

    deepset = pd.read_parquet(RAW / "deepset/train.parquet")
    for item in deepset.itertuples():
        rows.append(_row("deepset", "train", int(item.label), str(item.text), lang=""))

    jack = pd.read_csv(RAW / "jackhhao/train.csv")
    for item in jack.itertuples():
        rows.append(_row("jackhhao", "train", 1 if item.type == "jailbreak" else 0, str(item.prompt)))

    def enron(path: Path, split: str, source: str, limit: int | None) -> None:
        items = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
        rng.shuffle(items)
        for item in items[:limit]:
            subject = str(item.get("subject") or "")
            text = str(item.get("message") or item.get("text") or "")
            rows.append(_row(f"{source}_{'spam' if item.get('label') == 1 else 'ham'}" if source == "enron_train" else source, split, 0, text, subject))

    enron(RAW / "enron/train.jsonl", "train", "enron_train", None)
    enron(RAW / "enron/test.jsonl", "holdout", "enron_test", None)

    # --- holdout: never looked at while writing signatures ------------------------------------
    for line in (RAW / "agentsec/attacks.jsonl").read_text().splitlines():
        item = json.loads(line)
        rows.append(_row("agentsec", "holdout", int(item.get("label", 1)), item["text"]))
    for line in (RAW / "agentsec/benign-hard.jsonl").read_text().splitlines():
        item = json.loads(line)
        rows.append(_row("agentsec", "holdout", 0, item["text"]))

    for path in sorted((RAW / "horizon").glob("*.parquet")):
        name = path.stem.removesuffix("_test")
        if name == "llmail_phase2":
            continue  # a sample of llmail_p2, already in
        frame = pd.read_parquet(path)
        for item in frame.itertuples():
            rows.append(_row(name, "holdout", int(item.label), str(item.text), lang=str(item.lang)))

    for line in (HERE / "data/handwritten-eval.jsonl").read_text().splitlines():
        if not line.strip():
            continue
        item = json.loads(line)
        rows.append(_row("handwritten", "holdout", 1 if item["label"] == "attack" else 0, item["text"], item.get("subject", ""), item.get("lang", ""), item.get("html", "")))

    # Real inbox mail exported from the instances (benign unless an owner said otherwise) — see export-inbox.sh.
    inbox = DATA / "inbox.jsonl"
    if inbox.exists():
        for line in inbox.read_text().splitlines():
            if line.strip():
                item = json.loads(line)
                rows.append(_row("inbox", "holdout", 0, item.get("text", ""), item.get("subject", ""), "", item.get("html", "")))

    # Non-English attacks and hard benign mail exist only in these sets; half of each goes to
    # train so signatures can be tuned on Czech/Slovak/German too, the other half stays unseen.
    for row in rows:
        if row["source"] in TUNE_HALF and int(hashlib.md5(row["text"].encode()).hexdigest(), 16) % 2 == 0:
            row["split"] = "train"

    # Exact duplicates across sources would leak train into holdout.
    seen_train = {(r["subject"] + "\n" + r["text"]).strip() for r in rows if r["split"] == "train"}
    rows = [r for r in rows if r["split"] == "train" or (r["subject"] + "\n" + r["text"]).strip() not in seen_train]

    CORPUS.mkdir(parents=True, exist_ok=True)
    counts: Counter = Counter()
    with (CORPUS / "train.jsonl").open("w") as train, (CORPUS / "holdout.jsonl").open("w") as holdout:
        for row in rows:
            (train if row["split"] == "train" else holdout).write(json.dumps(row) + "\n")
            counts[(row["split"], row["source"], row["label"])] += 1
    for (split, source, label), count in sorted(counts.items()):
        print(f"{split:8} {source:22} {'attack' if label else 'benign':6} {count:7}")
    print(f"ok: {CORPUS}")


# --- mining ---------------------------------------------------------------------------------

_WORD = re.compile(r"[a-z0-9]+(?:'[a-z]+)?")


def _norm(text: str) -> str:
    text = unicodedata.normalize("NFKD", text.lower())
    return "".join(ch for ch in text if not unicodedata.combining(ch))


def _ngrams(text: str, sizes=(2, 3, 4, 5)) -> set[str]:
    words = _WORD.findall(_norm(text))
    out: set[str] = set()
    for n in sizes:
        for i in range(len(words) - n + 1):
            out.add(" ".join(words[i : i + n]))
    return out


_SENTENCE = re.compile(r"(?<=[.!?:;])\s+|\n+")


def _sentences(text: str) -> set[str]:
    return {" ".join(_WORD.findall(_norm(part))) for part in _SENTENCE.split(text) if len(part) > 12}


def mine(top: int = 3000) -> None:
    """Phrases frequent in attack *sentences* and almost never in mail.

    Counted over unique sentences, not documents: LLMail attackers resubmitted the same
    scenario e-mail (a Q2 budget memo) thousands of times with a different payload, and
    per-document counts ranked the memo above the payload. Output is a review list, not
    signatures: LLMail targets one scenario (contact@contact.com, "confirmation"), so
    scenario words still score high and are dropped by hand when writing signatures.
    """
    attack_sentences: set[str] = set()
    benign_sentences: set[str] = set()
    with (CORPUS / "train.jsonl").open() as handle:
        for line in handle:
            row = json.loads(line)
            target = attack_sentences if row["label"] == 1 else benign_sentences
            target.update(_sentences(row["subject"] + ". " + row["text"]))

    def frequency(sentences: set[str]) -> Counter:
        counter: Counter = Counter()
        for sentence in sentences:
            words = sentence.split()
            counter.update({" ".join(words[i : i + n]) for n in (2, 3, 4, 5) for i in range(len(words) - n + 1)})
        return counter

    attack_df = frequency(attack_sentences)
    benign_df = frequency(benign_sentences)
    n_attack, n_benign = len(attack_sentences), len(benign_sentences)

    scored = []
    for gram, hits in attack_df.items():
        if hits < 25:
            continue
        benign_rate = benign_df[gram] / max(n_benign, 1)
        if benign_rate > 5e-4:
            continue
        scored.append((hits, gram, benign_df[gram]))
    scored.sort(reverse=True)
    out = DATA / "mined-phrases.tsv"
    with out.open("w") as handle:
        handle.write("attack_sentences\tbenign_sentences\tphrase\n")
        for hits, gram, benign in scored[:top]:
            handle.write(f"{hits}\t{benign}\t{gram}\n")
    print(f"attack sentences={n_attack} benign sentences={n_benign} candidates={len(scored)} → {out}")


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    {"fetch": fetch, "prepare": prepare, "mine": mine}.get(command, lambda: sys.exit(__doc__))()
