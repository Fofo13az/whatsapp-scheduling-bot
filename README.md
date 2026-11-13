# WhatsApp Scheduling Bot

A production WhatsApp assistant that lets patients book, reschedule, and cancel medical appointments on their own, 24/7, for a private practice with two locations in Mexico City.

**Live since August 2026: 263+ appointments booked for 220+ patients, plus 71 patients on the waitlist.**

> This is a sanitized public copy of a private production repo. The practice's name, locations, contact details, and internal operations notes were removed or replaced with fictional data. The code and architecture are unchanged.

## What it does

- **Conversational booking** in natural Mexican Spanish, using WhatsApp interactive buttons and lists, with a free-text fallback (a rule-based classifier understands replies like "quiero cancelar mi cita del martes" or "en la del norte porfa").
- **Rescheduling and cancellation** through the same chat, with the doctor notified of each event.
- **Nightly reminders** sent with Meta-approved message templates, with tracking of delivery failures and of patients who don't reply.
- **Waitlist:** when a slot frees up, the bot offers it to waitlisted patients after the doctor approves it.
- **Two-way calendar sync** with Apple Calendar (CalDAV) and Google Calendar. The bot never offers a slot that someone already blocked by hand in either calendar, and it detects manual changes made in the calendars.
- **Doctor notifications** through her personal WhatsApp, each one switchable with a `NOTIFY_*` toggle.

## Architecture

```
WhatsApp Cloud API ──webhook──▶ Express server ──▶ message router
  (HMAC-SHA256 verified)                                │
                                ┌───────────────────────┼─────────────────────┐
                                ▼                       ▼                     ▼
                        Conversation flows      Waitlist service      Status handler
                        (state machines:        (offers, doctor      (Meta delivery
                         book / reschedule /     approval)             statuses)
                         cancel)
                                │                       │
                                ▼                       ▼
                     MySQL (source of truth) ◀──▶ Calendar layer ──▶ iCloud (CalDAV)
                                                  (provider routing) ──▶ Google Calendar
                                                                         (service account)
node-cron scheduler ──▶ nightly reminders · no-reply follow-ups · calendar sync
```

**Key design decisions:**

- **MySQL is the source of truth; calendars come second.** Every write goes to the database first. If a calendar provider fails, booking keeps working on MySQL only, and the event syncs later.
- **Provider-agnostic calendar layer.** Each location is routed to iCloud or Google with environment variables. A failure in one provider is isolated, so the other location keeps working.
- **Global availability.** An event in any calendar blocks that time at both locations, because the doctor can't be in two places at once.
- **Conversation state lives in MySQL**, so the bot survives restarts and deploys without losing a half-finished booking.
- **Verified webhooks.** Every incoming request is checked with HMAC-SHA256 against the Meta App Secret before any processing.
- **Templates for messages sent outside the 24-hour window.** Meta only allows business-initiated messages through pre-approved templates. Nine were designed and approved (see [`docs/TEMPLATES.md`](./docs/TEMPLATES.md)).

## Stack

Node.js 20 · Express · MySQL · WhatsApp Cloud API (Graph API through native `fetch`, with no SDK or intermediary) · `tsdav` (CalDAV) · Google Calendar API (service-account JWT) · `node-cron` · `zod` (validation of env vars and payloads) · `pino` (structured logs) · Docker · Railway (continuous deployment with health checks)

The messaging layer was originally built on Twilio. I migrated it mid-project to Meta's Cloud API, which removed the intermediary and its per-message cost.

## Project structure

```
src/
  config/       env var loading and validation (zod) — the app fails fast on bad config
  webhook/      Meta webhook: verification handshake + HMAC signature check
  handlers/     routers for messages, confirmations, waitlist, delivery statuses
  flows/        conversation state machines (appointment, reschedule, cancellation)
  services/     WhatsApp client, calendar providers, classifier, repositories
  scheduler/    node-cron jobs (reminders, no-reply checks)
  data/         static config: locations, consultation types, all user-facing copy
  db/           schema, migrations, connection pool
scripts/        smoke-test suites + DB init
docs/           deploy guide, Google Calendar setup, Meta template specs
```

## Testing

The project includes 12 smoke-test suites (`scripts/smoke-*.js`). They cover the message builder, the free-text classifier, ICS generation, the full booking, rescheduling, and cancellation flows, the waitlist, pagination, delivery statuses, and calendar sync. All of them run against a live MySQL database.

```bash
npm run smoke
```

## Running locally

Requirements: Node.js ≥ 20, MySQL, and a tunnel such as ngrok to expose the webhook to Meta.

```bash
npm install
cp .env.example .env      # fill in Meta, MySQL, and calendar credentials
npm run db:init           # creates the tables (idempotent)
npm run dev
```

Then register `https://<your-tunnel>/webhook/whatsapp` in your Meta app (WhatsApp → Configuration) with the same `WHATSAPP_VERIFY_TOKEN`. Production deployment is described in [`docs/DEPLOY.md`](./docs/DEPLOY.md).

## Built with AI-assisted development

I built this project with Claude Code as a pair programmer. [`CLAUDE.md`](./CLAUDE.md) is the project brief the agent reads in every session: scope rules, security constraints, code conventions, and when it has to stop and ask for confirmation. I owned the requirements, the architecture decisions, and the verification. Every change was smoke-tested before deployment.

## Author

**Adolfo Hernández Sánchez**, sole developer (requirements, architecture, implementation, deployment, and production support).
