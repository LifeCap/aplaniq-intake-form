# APLANIQ intake delivery

The form posts to a Netlify Function. The function creates a PDF, emails it through SpaceMail SMTP, and writes a minimal delivery audit record to Netlify Blobs.

## Netlify setup

In Netlify, set these environment variables from `.env.example`:

- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASSWORD`
- `SMTP_FROM`
- `INTAKE_RECIPIENT`

Use the exact SMTP host and port shown in SpaceMail Manager for the sending mailbox. Do not commit a real `.env` file or SMTP password.

The audit records live in the `aplaniq-intake-audit` Netlify Blob store. Each record has an ID, Eastern Time timestamp, recipient, delivery status, SpaceMail message ID, and SHA-256 hash of the submitted payload. Full intake answers remain only in the emailed PDF.

## Local verification

```sh
npm test
npx netlify dev
```

For a real local email test, supply the environment variables in your shell or a gitignored `.env` file, then submit the form through `http://localhost:8888`.
