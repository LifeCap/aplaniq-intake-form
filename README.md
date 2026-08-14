# APLANIQ website intake delivery

The intake form creates a client package for website builds, website repair, and marketing deliverables. It starts a Google Drive intake folder, uploads client files directly to Drive with resumable upload sessions, then emails `hello@aplaniq.co` a PDF summary and Drive folder link through SpaceMail SMTP.

## Netlify setup

In Netlify, set these environment variables from `.env.example`:

- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASSWORD`
- `SMTP_FROM`
- `INTAKE_RECIPIENT`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REFRESH_TOKEN`
- `GOOGLE_DRIVE_PARENT_FOLDER_ID`

Use the exact SMTP host and port shown in SpaceMail Manager for the sending mailbox. Do not commit a real `.env` file or SMTP password.

Use the Google account that owns the intake Drive as the one-time OAuth user. The Drive-linked email does not need to be `hello@aplaniq.co`; share the parent intake folder, or the generated client folders, with `hello@aplaniq.co`.

The created Drive structure is:

```text
APLANIQ Intakes/{YYYY}/{APL-YYYYMMDD-XXXXXXXX - Company Name}/
01 Intake Summary/
02 Brand Assets/
03 Website Assets/
04 Documents/
05 References/
```

The audit records live in the `aplaniq-intake-audit` Netlify Blob store. Each record has an ID, timestamp, Drive folder URL, delivery status, SpaceMail message ID, uploaded file statuses, and a SHA-256 hash of the submitted payload.

## File policy

The browser and backend allow up to 20 files, 250 MB each, and 1 GB total. Common business, brand, image, document, spreadsheet, presentation, design, and ZIP files are allowed. Executable and script-like files are blocked.

Do not collect passwords, API keys, private recovery codes, or raw credentials in the form. The agreement step asks clients to coordinate secure access separately.

## Local verification

```sh
npm test
npx netlify dev
```

For a real local end-to-end test, supply the SMTP and Google OAuth environment variables in your shell or a gitignored `.env` file, then submit the form through `http://localhost:8888`.
