# Recorded AI answers

`recorded.json` holds real answers from Claude Haiku 5.5 (`claude-haiku-5-5`) for
the 11 demo leads: one API call per lead, made once on 2026-11-16. `npm run demo`
and the tests replay them, so they need no API key and cost nothing.

Each answer is stored with the token counts the API reported. The cost comes from
those tokens and the prices in `config/pricing.json` (checked on the official
pricing page the same day).

## How they were recorded

```bash
npm run ai:record -- --dry-run   # shows what would be sent; no call
npm run ai:record                # needs ANTHROPIC_API_KEY in .env
```

Output of the recording run (2026-11-16):

```
lead-01  1120 in   89 out  $0.000157  buy/high/en confidence 0.95
lead-02  1108 in   79 out  $0.000150  buy/high/en confidence 0.6
lead-03  1100 in   80 out  $0.000150  buy/high/en confidence 0.9
lead-04  1101 in   87 out  $0.000154  rent/high/en confidence 0.93
lead-05  1107 in   92 out  $0.000157  spam/low/en confidence 0.97
lead-06  1133 in   84 out  $0.000155  vendor/low/en confidence 0.95
lead-07  1120 in   89 out  $0.000157  rent/low/es confidence 0.85
lead-08  1094 in   84 out  $0.000151  sell/low/en confidence 0.85
lead-09  1097 in   82 out  $0.000151  sell/high/en confidence 0.9
lead-10  1093 in   91 out  $0.000155  sell/medium/en confidence 0.8
lead-11  1094 in   84 out  $0.000151  buy/medium/en confidence 0.85

11 calls to claude-haiku-5-5: 12167 input + 941 output tokens = $0.001687
(prices from config/pricing.json, checked 2026-11-16)
```

Each answer is found by a key made from the model, the system prompt and the lead's
message. If any of them changes, the old answer no longer matches: the lead goes to
manual review in the demo until it is recorded again. Running `npm run ai:record`
again only calls the API for leads with no answer yet.

## Reply drafts

`drafts.json` holds real reply drafts from the same model for the 8 demo leads that
get one (buyers, sellers and renters; not the spam, the vendor or the lead sent to
manual review): one call per lead, recorded on 2026-11-16 by the same command. The
AI writes `{first_name}`; the code fills in the name, so the AI never sees it. Every
draft also passes the guard in `src/ai/draft.ts` (no amount, day or time the lead did
not mention, no claim of availability, no links, emails or phone numbers).

Output of the recording run (2026-11-16), drafts part:

```
lead-01   827 in  130 out  $0.000148  passes the guard
lead-02  no draft (manual_review)
lead-03   807 in  140 out  $0.000151  passes the guard
lead-04   797 in  121 out  $0.000140  passes the guard
lead-05  no draft (archive)
lead-06  no draft (general_inbox)
lead-07   822 in  184 out  $0.000174  passes the guard
lead-08   792 in  129 out  $0.000144  passes the guard
lead-09   804 in  105 out  $0.000133  passes the guard
lead-10   792 in  135 out  $0.000147  passes the guard
lead-11   794 in  131 out  $0.000145  passes the guard

Drafts: 8 calls to claude-haiku-5-5: 6435 input + 1075 output tokens = $0.001181
(prices from config/pricing.json, checked 2026-11-16)
```
