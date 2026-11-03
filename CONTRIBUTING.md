# Contributing

Thanks for helping. Bug reports from different Samsung models are especially welcome, since every unit
reports a slightly different set of SmartThings capabilities.

## Reporting a bug

1. Run `npx homebridge-paperclip status > status.json`. It prints your unit's raw SmartThings status and
   contains no tokens.
2. Open an issue with your AC model, Homebridge version, the relevant log lines (with debug mode on) and
   `status.json`.

## Making a change

```bash
npm install
npm run check   # lint + typecheck + tests + build; CI runs the same thing
```

- Keep HomeKit mapping logic in `src/ac/mapping.ts` and `src/ac/profile.ts`. They are pure functions, so add a test.
- New switches belong in `PaperclipAirConditioner.setupExtras()`. Gate each one on a capability the unit reports.
- Never write secrets to `config.json` or the log.

Open a pull request against `main` and describe what you tested on real hardware, if anything.
