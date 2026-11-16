# Fixtures

Fictional webhooks from the channels of **Juniper Lane Realty**, a made-up real estate agency.
Every name, email (`.test` domain) and phone number (`555-01xx`, reserved for fiction) is invented.

`webhooks/<source>/<name>.json` is the exact body a channel would send. A `.txt` file is a deliberately broken body.
`demo.json` is the order `npm run demo` sends them in.

| # | Channel | Fixture | The hard case it covers |
|---|---|---|---|
| 1 | form | `lead-01` | Emily asks about a house. Email with capitals, phone as `(212) 555-0147` |
| 2 | whatsapp | `lead-02` | Emily again, phone as the WhatsApp sender id `12125550147` |
| 3 | portal | `lead-03` | Emily again, phone as `+1 212.555.0147` |
| 4 | form | `lead-01` | The provider resends webhook 1 |
| 5 | whatsapp | `lead-04` | Marcus: phone only, no email |
| 6 | form | `lead-05` | Spam from an SEO bot |
| 7 | email | `lead-06` | A vendor (photography studio), not a lead |
| 8 | portal | `lead-07` | Sofía writes in Spanish |
| 9 | form | `lead-08` | Daniel: email only |
| 10 | whatsapp | `lead-09` | "Dan B": phone only, so at first a different contact |
| 11 | portal | `lead-10` | Daniel with both email and phone: merges 9 and 10 |
| 12 | form | `lead-11` | Another Emily Carter: same name, different person |
| 13 | form | `broken-01` | Broken JSON with a valid signature |

Send one to the running gateway:

```bash
npm run send -- form lead-01
```
