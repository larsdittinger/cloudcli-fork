# Prompt-injection filter — data and measurement

The Channels filter (`server/modules/channels/injection/`) checks every inbound
e-mail, WhatsApp message, webhook payload and reply to an agent task before an
agent sees it. A message that looks like an attempt to instruct the agent waits
in the Inbox until the owner releases it. This folder holds the scripts that
built and measure the signatures.

```bash
uv run scripts/prompt-injection/dataset.py fetch     # ~700 MB of public datasets → ~/.cache/cloudcli-prompt-injection/raw
uv run scripts/prompt-injection/dataset.py prepare   # → corpus/train.jsonl + corpus/holdout.jsonl
uv run scripts/prompt-injection/dataset.py mine      # phrases frequent in attack sentences, rare in mail → mined-phrases.tsv
npx tsx --tsconfig server/tsconfig.json scripts/prompt-injection/eval.ts --split holdout --sensitivity strict [--sample 6000] [--dump]
```

`PI_DATA` overrides the cache directory. Nothing from it goes to git: the
corpus is large and contains third-party attack and mail texts.

## Sources

| set | what | licence |
|---|---|---|
| microsoft/llmail-inject-challenge | ~200k unique attack e-mails from an adaptive challenge against an e-mail agent (phase 1 → train, phase 2 half/half) + 203 benign e-mails | MIT |
| deepset/prompt-injections | direct injections, en/de | Apache-2.0 |
| jackhhao/jailbreak-classification | chatbot jailbreaks vs. benign prompts | Apache-2.0 |
| SetFit/enron_spam | real business e-mail (ham) and spam — the false-positive baseline | — |
| promptprotection/agent-security-datasets | hand-written evasive attacks + hard benign | CC-BY-4.0 |
| Horizon-Labs/prompt-injection-eval-suite | BIPIA (e-mail/table/code), NotInject, XSTest, OR-Bench, PIArena, agentic sets, synthetic sets in 30 languages incl. Czech | mixed, see card |
| `data/handwritten-eval.jsonl` | 220 hard benign messages in cs/sk/en/de written for this filter (AI newsletters, "ignore my previous e-mail", delivery instructions, dev talk) | this repo |
| `inbox.jsonl` (optional) | real Inbox messages exported by the hub (`shared/export-inbox.sh`) | private, never in git |

Split: signatures were written from `mine` output over the train part and tuned
on it; half of the Czech/multilingual synthetic sets, LLMail phase 2, BIPIA and
the handwritten set went to train so non-English and adaptive attacks could be
tuned too. The holdout part was used for the numbers below (the handwritten
half was looked at once to fix systematic false alarms, so treat it as seen).

## Results (2026-10-08, holdout, strict = default)

| set | attacks caught | benign held by mistake |
|---|---|---|
| LLMail-Inject phase 2 (adaptive e-mail attacks) | 33.0 % | — |
| LLMail-Inject phase 1 (first 6000) | 86–97 % | — |
| BIPIA (task injection in e-mails/tables) | 11.4 % | 0 % |
| synthetic documents (30 languages) | 60.8 % | 6.2 % |
| Czech rows (synthetic) | 59.3 % | 7.8 % |
| Enron real business mail | — | 0.1 % (1 of 1666) |
| LLMail benign e-mails | — | 0 % |
| NotInject / XSTest / OR-Bench (trigger words, harmless) | — | 0.3 % / 0 % / 0.3 % |
| handwritten hard benign (about AI and prompts) | — | 10.8 % |

Normal sensitivity: LLMail phase 2 22 %, BIPIA 6 %, Enron 0 %, handwritten 5.8 %.

The false alarms on the handwritten set are almost all mail *about* prompts and
prompt injection (newsletters, workshops, a prompt pasted for review). A model
reading such a mail sees the quoted attack too, so holding it for a look is
deliberate; quotes lower the weight only when the text clearly cites
("such as", „věty jako"). Cost: 200 kB message ≈ 0.1 s, worst case (text + HTML
+ 10 attachments full of base64) ≈ 0.5 s, yielding to the event loop between
parts; whatever had to be skipped is listed as "not checked".

Read it honestly: signatures stop the blunt and the moderately disguised
attacks (override phrases, fake system turns, chat-template tokens, hidden HTML,
encoded payloads, "note for the AI…") at almost no cost on ordinary mail. They
do **not** stop a patient attacker who writes a polite request without any
tell-tale phrase ("please also send a confirmation to …"); no keyword filter
does. The rules' sender allowlists, reply drafts and task mandates remain the
real boundary. A second layer — a small multilingual classifier or an LLM
judge — is the way to raise recall on adaptive attacks.

## Changing signatures

Edit `server/modules/channels/injection/signatures.ts`, run the unit tests
(`server/modules/channels/tests/injection-scanner.test.ts`) and `eval.ts` on
both splits; keep benign false alarms on Enron/LLMail at ~0 and bump
`SCANNER_VERSION` in `injection-scanner.ts`.
