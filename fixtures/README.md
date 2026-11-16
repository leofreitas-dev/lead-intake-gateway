# Fixtures

Fictional webhooks from the channels of **Juniper Lane Realty**, a made-up real estate agency.
Every name, email (`.test` domain) and phone number (`555-01xx`, reserved for fiction) is invented.

`fixtures/webhooks/<source>/<name>.json` is the exact body a channel would send.
A `.txt` file is a deliberately broken body.

Send one to the running gateway:

```bash
npm run send -- form lead-01
```
