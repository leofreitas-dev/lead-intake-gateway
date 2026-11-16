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
