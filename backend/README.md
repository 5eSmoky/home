# Secure verified booking backend

This Cloudflare Worker implements the direct-booking state machine:

`verification_pending -> owner_review -> invoice_creating -> awaiting_payment -> payment_processing -> paid`

Rejected, failed, and conflict/refund states are terminal. The public calendar is changed only after a signed Stripe `invoice.paid` event. A D1 `payment_holds` table provides the private 24-hour payment lock and prevents overlapping invoices.

## Verification rollout mode

The workflow can launch before Truvi onboarding is complete. `wrangler.toml` currently sets:

```toml
VERIFICATION_MODE = "disabled"
```

In this mode, requests go directly to owner review and are prominently labeled **Unverified**. Turnstile, owner approval/rejection, Stripe invoices, payment holds, signed webhooks, email, and paid-only calendar blocking still operate normally.

Email currently uses `MailApp` through the authenticated Google Apps Script endpoint, so the GitHub Pages site does not need a custom sending domain. The Gmail account that owns and deploys the script is the sender. A consumer Gmail account can currently send to 100 recipients per day through Apps Script; Google Workspace accounts have a higher quota.

After Truvi credentials and its account-specific API mapping are confirmed:

1. Change `VERIFICATION_MODE` to `"truvi"` in `wrangler.toml`.
2. Change `verificationEnabled` to `true` in `../calendar-config.js`.
3. Add the Truvi secrets and webhook described below.
4. Deploy and run the verification test cases before publishing the website change.

Both settings must be changed together. The backend remains authoritative and will require screening consent whenever Truvi mode is enabled.

## 1. Rotate exposed credentials first

The old Stripe test key and Airbnb iCal token appeared in repository history. Rotate both in Stripe and Airbnb before deployment. Do not reuse them. The current Apps Script reads sensitive values from Script Properties instead of source code.

## 2. Accounts required

- Cloudflare Workers, D1, and Turnstile
- Truvi with Screening + ID Verification and API access (can be added later)
- Stripe Invoicing
- The existing Google Apps Script and direct-booking calendar

Truvi supplies the production booking endpoint, webhook secret, and exact account payload during onboarding. Its account-specific field mapping is isolated in `src/truvi.js`; confirm those aliases with the documentation Truvi provides before production use.

## 3. Configure Google Apps Script

Replace the deployed script with `../google-apps-script-calendar-sync.gs`. In Apps Script, open **Project Settings -> Script Properties** and add:

- `AIRBNB_ICAL_URL`
- `DIRECT_BOOKING_CALENDAR_ID`
- `OWNER_EMAIL`
- `CALENDAR_COMMAND_TOKEN` (a new random value shared only with the Worker)

Remove any legacy `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_TOKEN` Script Properties. Stripe now communicates only with the signed Worker webhook. Deploy a new web-app version.

## 4. Create and configure the Worker

From this directory:

```sh
npm install
npx wrangler login
npx wrangler d1 create five-elements-smoky-bookings
```

Paste the returned database ID into `wrangler.toml`, then set `PUBLIC_API_URL` and the production site origin. Keep `EMAIL_PROVIDER = "apps_script"`. Apply the schema:

```sh
npm run db:remote
```

Store the secrets needed for the initial verification-disabled launch (never put them in `wrangler.toml`):

```sh
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret put TURNSTILE_SECRET_KEY
npx wrangler secret put CALENDAR_API_URL
npx wrangler secret put CALENDAR_COMMAND_TOKEN
```

Add `TRUVI_API_KEY`, `TRUVI_CREATE_BOOKING_URL`, and `TRUVI_WEBHOOK_SECRET` only when switching `VERIFICATION_MODE` to `truvi`.

Deploy with `npm run deploy`.

## 5. Configure callbacks

- Truvi webhook when verification is enabled: `https://YOUR-WORKER/webhooks/truvi`
- Stripe webhook: `https://YOUR-WORKER/webhooks/stripe`
- Stripe event: `invoice.paid`

Use the signing secret Stripe generates for this specific webhook. The Worker validates the signature and rejects events older than five minutes.

## 6. Connect the website

In `../calendar-config.js`, set:

- `bookingApiUrl` to the Worker URL
- `turnstileSiteKey` to the public Turnstile site key

Keep the Turnstile secret only in the Worker.

## 7. Test before going live

Run `npm test`, deploy using Stripe test mode, and verify all of these cases:

1. Missing/failed verification cannot reach the owner.
2. Approved and flagged verification reaches the owner with the correct report.
3. Merely opening the owner email does not change state.
4. Reject sends no invoice.
5. Approve sends one invoice even after repeated clicks.
6. Overlapping approved requests cannot both get invoices.
7. Dates stay publicly available before payment.
8. A signed `invoice.paid` event creates one calendar block and sends confirmations.
9. Replayed or forged Stripe and Truvi events are rejected or ignored.
10. A calendar conflict produces an automatic refund and owner/guest alerts.

Do not switch Stripe or Truvi to production until the full test matrix passes.
