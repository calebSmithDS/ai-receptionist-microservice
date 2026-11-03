import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { SessionStore } from '../core/session-store.js';
import { transition } from '../core/state-machine.js';
import { GeminiQualificationEvaluator } from '../core/gemini-evaluator.js';
import { TwilioSmsClient } from '../core/twilio-client.js';
import { ServiceM8RestClient } from '../core/servicem8-client.js';
import { ITenantProvider, TenantContext } from '../core/types/tenant.js';
import { CollectedJobDetails } from '../contracts/session-state.contract.js';
import { env } from '../config/env.js';

export interface ProcessMessagePayload {
  eventType: 'MISSED_CALL' | 'INBOUND_SMS';
  channel: 'twilio_voice' | 'twilio_sms';
  callerNumber: string;
  dialedNumber: string;
  callSid?: string;
  messageSid?: string;
  body?: string;
  mediaUrls?: string[];
  businessId?: string;
  receivedAt: string;
}

/**
 * Returns the fields still missing from a collected lead.
 * Used by the anti-loop ultimatum to tell the customer exactly what we need.
 */
function getMissingFields(data: CollectedJobDetails): string[] {
  const missing: string[] = [];
  if (!data.customerName) missing.push('your name');
  if (!data.suburb) missing.push('your suburb');
  if (!data.issue) missing.push('what needs fixing');
  return missing;
}

export function registerProcessMessageWorkerRoute(
  app: FastifyInstance,
  sessionStore: SessionStore,
  gemini: GeminiQualificationEvaluator,
  twilio: TwilioSmsClient,
  tenantProvider: ITenantProvider,
  servicem8: ServiceM8RestClient
) {
  app.post(
    '/api/workers/process-message',
    async (req: FastifyRequest<{ Body: ProcessMessagePayload }>, reply: FastifyReply) => {
      const payload = req.body;
      const { callerNumber, dialedNumber, eventType, body = '', mediaUrls = [] } = payload;

      if (!callerNumber || !dialedNumber) {
        req.log.warn({ payload }, 'Worker received payload with missing phone numbers');
        return reply.status(400).send({ error: 'Missing callerNumber or dialedNumber' });
      }

      // ── 1. Resolve Tenant Config (Redis cache → Sanity CMS) ───────────────
      let tenant = await tenantProvider.getTenantByPhoneNumber(dialedNumber);
      if (!tenant) {
        req.log.warn({ dialedNumber }, 'Tenant not found — using default config');
        tenant = {
          tenantId: `tenant_${dialedNumber.replace(/[^0-9]/g, '')}`,
          businessName: env.DEFAULT_BUSINESS_NAME,
          tradeType: 'plumber',
          publicPhone: env.BUSINESS_OWNER_PHONE,
          twilioForwardingNumber: dialedNumber,
          serviceArea: env.DEFAULT_SERVICE_AREA,
          services: [],
          aiCustomInstructions: 'Be friendly and gather customer name, suburb, issue, and urgency.',
        };
      }

      const businessId = payload.businessId || tenant.tenantId;
      const businessName = tenant.businessName;
      const ownerPhone = tenant.publicPhone || env.BUSINESS_OWNER_PHONE;

      req.log.info({ eventType, businessId, businessName, callerNumber }, 'Worker processing message');

      // ── 2. Hydrate Session State from Redis ───────────────────────────────
      const { session } = await sessionStore.getOrCreateSession({
        businessId,
        callerNumber,
        callSid: payload.callSid,
      });

      // ── GLOBAL GUARD: TERMINATED & ABANDONED sessions are permanent sinks ─
      // These states exist precisely to make the worker's first action be
      // a Redis read + immediate drop. No Gemini, no Twilio, no cost.
      if (session.status === 'TERMINATED') {
        req.log.info({ callerNumber }, 'Session is TERMINATED (spam). Dropping webhook at zero cost.');
        return reply.status(200).send({ status: 'TERMINATED', dropped: true });
      }
      if (session.status === 'ABANDONED') {
        req.log.info({ callerNumber }, 'Session is ABANDONED (anti-loop). Dropping webhook silently.');
        return reply.status(200).send({ status: 'ABANDONED', dropped: true });
      }

      // ═════════════════════════════════════════════════════════════════════
      // Case A: MISSED CALL TRIGGER
      // ═════════════════════════════════════════════════════════════════════
      if (eventType === 'MISSED_CALL') {
        const transitionResult = transition(session, { type: 'DISPATCH_GREETING' });

        if (!transitionResult.isTransitionValid) {
          req.log.info(
            { currentStatus: session.status },
            'Ignoring missed call: session already past INIT (duplicate webhook)'
          );
          return reply.status(200).send({ status: 'ignored', reason: 'Already initialized' });
        }

        // Requirement 1: static, assumption-free greeting.
        // The old greeting said "Hi, thanks for calling…" which:
        //   (a) assumes a positive calling experience
        //   (b) doesn't establish the AI persona clearly
        // The new text sets context: they called a real business, a real person
        // is busy, and an assistant has picked up. This dramatically reduces
        // the "is this a robot?" friction in the first reply.
        // Use explicit ownerFirstName from Sanity CMS when provided, else fallback to businessName
        const tradieName = tenant.ownerFirstName || businessName;
        const greetingText = `Hi, this is ${tradieName}'s assistant. He's on the tools right now. How can we help you today?`;

        await twilio.sendSms({ from: dialedNumber, to: callerNumber, body: greetingText });

        transitionResult.nextState.history.push({
          role: 'assistant',
          content: greetingText,
          channel: 'twilio_sms',
          timestamp: new Date().toISOString(),
        });

        await sessionStore.saveSession(transitionResult.nextState);
        req.log.info({ nextStatus: transitionResult.nextState.status }, 'Greeting dispatched');
        return reply.status(200).send({ success: true, status: transitionResult.nextState.status });
      }

      // ═════════════════════════════════════════════════════════════════════
      // Case B: INBOUND CUSTOMER SMS
      // ═════════════════════════════════════════════════════════════════════
      if (eventType === 'INBOUND_SMS') {
        // ── Step 1: Record customer message, advance turn counters ─────────
        const step1 = transition(session, { type: 'CUSTOMER_MESSAGE', text: body, mediaUrls });
        let currentSession = step1.nextState;

        currentSession.history.push({
          role: 'customer',
          content: body,
          channel: 'twilio_sms',
          timestamp: new Date().toISOString(),
          mediaUrls,
        });

        // ── Forward-only guard (latching states) ───────────────────────────
        if (session.status === 'COMPLETED' || session.status === 'ESCALATED') {
          req.log.info({ status: session.status }, 'Customer texted after completion/escalation — forwarding to owner');
          await twilio.sendSms({
            from: dialedNumber,
            to: ownerPhone,
            body: `[Follow-up from ${callerNumber}]: "${body}"`,
          });
          await sessionStore.saveSession(currentSession);
          return reply.status(200).send({ status: session.status, forwarded: true });
        }

        // ── Step 2: Call Gemini for evaluation FIRST ─────────────────────
        // Evaluating Gemini first ensures that whatever the customer just said
        // (e.g. their suburb, name, or issue) is immediately extracted and acknowledged.
        // The anti-loop stall check runs AFTER extraction so cooperative customers
        // are NEVER penalized or ignored.
        req.log.info({ tenantName: businessName }, 'Sending to Gemini for evaluation...');
        const evalOutput = await gemini.evaluate({
          tenant,
          history: currentSession.history.slice(0, -1), // history before this turn
          latestMessage: body,
          mediaUrls,
          previouslyCollected: currentSession.collectedData,
        });

        // ── SPAM SINKHOLE ─────────────────────────────────────────────────
        // Gemini classified this as solicitation or spam.
        // The SPAM_DETECTED event is valid from both AWAITING_REPLY and
        // QUALIFYING. The state latches to TERMINATED immediately.
        // No outbound SMS is sent — $0 cost.
        if (evalOutput.intent === 'solicitation' || evalOutput.intent === 'spam') {
          const spamResult = transition(currentSession, { type: 'SPAM_DETECTED' });
          await sessionStore.saveSession(spamResult.nextState);
          req.log.info({ callerNumber, intent: evalOutput.intent }, 'Spam/solicitation detected — session TERMINATED');
          return reply.status(200).send({ status: 'TERMINATED', intent: evalOutput.intent });
        }

        // ── STALL DETECTION (Progress-Based Anti-Loop) ─────────────────────
        // Did this turn yield any new qualification data?
        const madeProgress =
          (!currentSession.collectedData.customerName && !!evalOutput.extracted.customerName) ||
          (!currentSession.collectedData.suburb && !!evalOutput.extracted.suburb) ||
          (!currentSession.collectedData.issue && !!evalOutput.extracted.issue) ||
          (!currentSession.collectedData.urgency && !!evalOutput.extracted.urgency);

        if (madeProgress) {
          // Customer provided useful data -> reset stall counter to 0!
          currentSession.metadata.stallCount = 0;
        } else if (!evalOutput.isFullyQualified) {
          // Unqualified and no new data was extracted this turn -> increment stall count
          currentSession.metadata.stallCount = (currentSession.metadata.stallCount ?? 0) + 1;
        }

        const currentStallCount = currentSession.metadata.stallCount ?? 0;

        // If customer has stalled 4+ consecutive turns without providing data -> ABANDON
        if (currentStallCount >= 4) {
          const abandonResult = transition(currentSession, { type: 'SESSION_ABANDONED' });
          await sessionStore.saveSession(abandonResult.nextState);
          req.log.info({ callerNumber, stallCount: currentStallCount }, 'Session ABANDONED after 4 stalled turns');
          return reply.status(200).send({ status: 'ABANDONED' });
        }

        // Merge newly extracted fields before checking what is still missing
        const mergedPreview: CollectedJobDetails = {
          ...currentSession.collectedData,
          ...evalOutput.extracted,
        };

        // If customer has stalled 3 consecutive turns -> Send hardcoded ultimatum with TRUE missing fields
        if (currentStallCount === 3 && !evalOutput.isFullyQualified) {
          const missing = getMissingFields(mergedPreview);
          if (missing.length > 0) {
            const ultimatumText = `To get this sorted, I just need ${missing.join(' and ')}. Can you send that through?`;
            const ultResult = transition(currentSession, {
              type: 'ULTIMATUM_SENT',
              missingFields: missing,
            });
            currentSession = ultResult.nextState;
            currentSession.collectedData = mergedPreview;

            await twilio.sendSms({ from: dialedNumber, to: callerNumber, body: ultimatumText });
            currentSession.history.push({
              role: 'assistant',
              content: ultimatumText,
              channel: 'twilio_sms',
              timestamp: new Date().toISOString(),
            });

            await sessionStore.saveSession(currentSession);
            req.log.info({ callerNumber, stallCount: currentStallCount, missing }, 'Anti-loop ultimatum sent');
            return reply.status(200).send({ status: 'QUALIFYING', ultimatumSent: true });
          }
        }

        // ── Step 3: Escalation ────────────────────────────────────────────
        if (evalOutput.isEscalated) {
          const stepEscalate = transition(currentSession, {
            type: 'ESCALATION_DETECTED',
            reason: evalOutput.escalationReason || 'HUMAN_REQUEST',
          });

          await twilio.sendSms({
            from: dialedNumber,
            to: ownerPhone,
            body: `🚨 ESCALATION (${businessName}): ${callerNumber} needs human attention.\nReason: ${evalOutput.escalationReason}\nLast message: "${body}"`,
          });

          // If Gemini generated a specific safety reply (e.g. 000 hazard warning), send that; otherwise standard handoff
          const escalateReply =
            evalOutput.replyText ||
            `No worries — I've flagged this for the team directly. They'll call you as soon as they can.`;
          await twilio.sendSms({ from: dialedNumber, to: callerNumber, body: escalateReply });

          stepEscalate.nextState.history.push({
            role: 'assistant',
            content: escalateReply,
            channel: 'twilio_sms',
            timestamp: new Date().toISOString(),
          });

          await sessionStore.saveSession(stepEscalate.nextState);
          return reply.status(200).send({ status: 'ESCALATED' });
        }

        // ── Step 4: Feed Gemini result into state machine ─────────────────
        const step2 = transition(currentSession, {
          type: 'EVALUATION_COMPLETED',
          extracted: evalOutput.extracted,
          isFullyQualified: evalOutput.isFullyQualified,
          followUpQuestion: evalOutput.replyText,
        });

        currentSession = step2.nextState;

        // ── Step 5: Execute side effects ──────────────────────────────────
        for (const action of step2.actions) {
          switch (action.type) {
            case 'SEND_FOLLOWUP_SMS': {
              await twilio.sendSms({ from: dialedNumber, to: callerNumber, body: action.text });
              currentSession.history.push({
                role: 'assistant',
                content: action.text,
                channel: 'twilio_sms',
                timestamp: new Date().toISOString(),
              });
              break;
            }

            case 'DISPATCH_LEAD_TO_SERVICEM8': {
              // Requirement 7: Push to ServiceM8 inbox (not a hard calendar booking).
              // The CrmSyncDetails in the session tracks the result for observability.
              const sm8Result = await servicem8.dispatchLead({
                lead: action.lead,
                callerPhone: callerNumber,
                businessName,
              });

              currentSession.crmSync = sm8Result.success
                ? { status: 'SYNCED', provider: 'servicem8', externalJobId: sm8Result.jobUuid, syncedAt: new Date().toISOString() }
                : { status: 'FAILED', provider: 'servicem8', error: sm8Result.error };

              req.log.info({ sm8Result, callerNumber }, 'ServiceM8 dispatch complete');
              break;
            }

            case 'DISPATCH_LEAD_TO_OWNER': {
              // Belt-and-suspenders SMS alert to owner alongside ServiceM8
              const lead = action.lead;
              const sm8Status = currentSession.crmSync?.status === 'SYNCED' ? '✅ In ServiceM8' : '⚠️ ServiceM8 sync failed';
              await twilio.sendSms({
                from: dialedNumber,
                to: ownerPhone,
                body: `🎯 NEW LEAD (${businessName}) ${sm8Status}\nName: ${lead.customerName || '?'}\nSuburb: ${lead.suburb || '?'}\nIssue: ${lead.issue || '?'}\nUrgency: ${lead.urgency || '?'}\nPhone: ${callerNumber}`,
              });
              req.log.info({ lead, ownerPhone }, 'Lead alert dispatched to owner');
              break;
            }

            case 'SEND_COMPLETION_SMS': {
              const name = currentSession.collectedData.customerName || '';
              const closingMessage =
                action.customMessage ||
                `Thanks ${name}! We've logged your request and the team at ${businessName} will be in touch shortly to confirm.`.trim();

              await twilio.sendSms({ from: dialedNumber, to: callerNumber, body: closingMessage });
              currentSession.history.push({
                role: 'assistant',
                content: closingMessage,
                channel: 'twilio_sms',
                timestamp: new Date().toISOString(),
              });
              break;
            }
          }
        }

        // ── Step 6: Persist to Redis ───────────────────────────────────────
        await sessionStore.saveSession(currentSession);

        return reply.status(200).send({
          success: true,
          status: currentSession.status,
          collected: currentSession.collectedData,
        });
      }

      return reply.status(400).send({ error: `Unknown eventType: ${eventType}` });
    }
  );
}
