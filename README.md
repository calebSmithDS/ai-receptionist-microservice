# AI Receptionist & Missed-Call Text-Back Microservice

A multi-tenant conversational microservice designed for boutique trades Website-as-a-Service (WaaS) platforms (plumbers, electricians, HVAC) and standalone SaaS operations.

## Architecture Highlights
- **Missed Call Forwarding & Failover**: Forwards inbound calls to the tradesperson's mobile (`publicPhone`). If unanswered after 18s, triggers an automated SMS text-back to the customer and alert to the tradie.
- **Multi-Tenant CMS Integration**: Resolves tenant business details, service area boundaries, business hours, and pricing rules directly from Sanity CMS (`mc1571jp`).
- **Hallucination-Proof AI Receptionist**: Uses low-temperature OpenAI function calling (`complete_lead_capture`) to qualify customers, answer questions using strictly grounded Sanity data, and decline out-of-area jobs.
- **Spam & Budget Safeguards**: Hard caps conversation turns (max 6), truncates long inputs, and auto-completes state once key lead data is captured.
- **Provider Agnostic**: Seamlessly toggle between **Twilio** or **Telnyx** (40–50% cheaper SMS/voice in AU) via environment config.
- **Lead Dispatch**: Sends qualified leads with full chat transcripts back to the parent Astro SSR site (`POST /api/submit-lead`).

## Getting Started

### 1. Configure Environment Variables
Copy `.env.example` to `.env` and fill in credentials:
```bash
cp .env.example .env
```

### 2. Run Locally
```bash
npm run dev
```

### 3. Expose via Webhook Tunnel
For testing with Twilio/Telnyx webhooks:
```bash
ngrok http 3000
```
Point your phone number's incoming voice URL to `https://<your-ngrok-url>/voice/inbound` and SMS webhook to `https://<your-ngrok-url>/sms/inbound`.
