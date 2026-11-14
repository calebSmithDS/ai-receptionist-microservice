import { SessionStore } from '../session-store.js';
import { transition } from '../state-machine.js';
import { GeminiQualificationEvaluator } from '../gemini-evaluator.js';
import { TwilioSmsClient } from '../twilio-client.js';
import { ServiceM8RestClient } from '../servicem8-client.js';
import { ITenantProvider } from '../types/tenant.js';
import { MessageBufferManager } from '../message-buffer.js';
import { EligibilityEngine } from '../eligibility/eligibility-engine.js';
import { GeminiBouncerClassifier } from '../eligibility/gemini-bouncer.js';
import { CollectedJobDetails } from '../../contracts/session-state.contract.js';
import { env } from '../../config/env.js';

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
  debounceVersion?: number;
}

function getMissingFields(data: CollectedJobDetails): string[] {
  const missing: string[] = [];
  if (!data.customerName) missing.push('your name');
  if (!data.suburb) missing.push('your suburb');
  if (!data.issue) missing.push('what needs fixing');
  return missing;
}

export async function processMessageEvent(
  payload: ProcessMessagePayload,
  deps: {
    sessionStore: SessionStore;
    gemini: GeminiQualificationEvaluator;
    twilio: TwilioSmsClient;
    tenantProvider: ITenantProvider;
    servicem8: ServiceM8RestClient;
    bufferManager?: MessageBufferManager;
    eligibilityEngine?: EligibilityEngine;
    bouncerClassifier?: GeminiBouncerClassifier;
    logger?: any;
  }
): Promise<{ statusCode: number; data: any }> {
  const { sessionStore, gemini, twilio, tenantProvider, servicem8, bufferManager, eligibilityEngine, bouncerClassifier } = deps;
  const logger = deps.logger || console;
  let { callerNumber, dialedNumber, eventType, body = '', mediaUrls = [], debounceVersion } = payload;

  if (!callerNumber || !dialedNumber) {
    logger.warn({ payload }, 'Worker received payload with missing phone numbers');
    return { statusCode: 400, data: { error: 'Missing callerNumber or dialedNumber' } };
  }

  // 1. Resolve Tenant Config
  let tenant = await tenantProvider.getTenantByPhoneNumber(dialedNumber);
  if (!tenant) {
    logger.warn({ dialedNumber }, 'Tenant not found — using default config');
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

  // ── DEBOUNCE DRAIN: If triggered with a debounceVersion, drain the buffer ────
  if (eventType === 'INBOUND_SMS' && debounceVersion !== undefined && bufferManager) {
    const drained = await bufferManager.drainIfLatest(businessId, callerNumber, debounceVersion);
    if (!drained) {
      logger.info(
        { callerNumber, debounceVersion },
        'Debounce timer fired, but a newer message arrived or buffer was already consumed. Skipping evaluation.'
      );
      return { statusCode: 200, data: { status: 'skipped', reason: 'stale_debounce_version' } };
    }

    // Replace the single body with the full combined stream from the customer
    body = drained.combinedText;
    mediaUrls = drained.combinedMediaUrls;
    logger.info(
      { callerNumber, messageCount: drained.messageCount, combinedBody: body },
      'Drained multi-message burst buffer into single prompt turn'
    );
  }

  logger.info({ eventType, businessId, businessName, callerNumber }, 'Worker processing message');

  // 2. Hydrate Session State from Redis
  const { session } = await sessionStore.getOrCreateSession({
    businessId,
    callerNumber,
    callSid: payload.callSid,
  });

  // Global Guards
  if (session.status === 'TERMINATED') {
    logger.info({ callerNumber }, 'Session is TERMINATED (spam). Dropping webhook at zero cost.');
    return { statusCode: 200, data: { status: 'TERMINATED', dropped: true } };
  }
  if (session.status === 'ABANDONED') {
    logger.info({ callerNumber }, 'Session is ABANDONED (anti-loop). Dropping webhook silently.');
    return { statusCode: 200, data: { status: 'ABANDONED', dropped: true } };
  }

  // Case A: MISSED CALL (Integrated with Allium Pre-Flight Eligibility Engine)
  if (eventType === 'MISSED_CALL') {
    // 1. Run deterministic eligibility check before touching FSM or sending SMS
    if (eligibilityEngine) {
      const decision = await eligibilityEngine.evaluateMissedCall(businessId, callerNumber);
      logger.info({ callerNumber, action: decision.action, reason: decision.reason }, 'Eligibility engine evaluated missed call');

      // Outcome 1: SUPPRESS ($0 gate)
      if (decision.action === 'suppress') {
        logger.info({ callerNumber, reason: decision.reason }, 'Missed call text-back suppressed by eligibility engine');
        return { statusCode: 200, data: { status: 'suppressed', reason: decision.reason, eligibility: decision } };
      }

      // Outcome 2: NEUTRAL_SMS (Uncertain relationship / single first-name contact)
      if (decision.action === 'neutral_sms') {
        const tradieName = tenant.ownerFirstName || businessName;
        const neutralText = `G'day, you've reached ${tradieName}'s business. He's tied up at the moment, but I can pass on a message or help with a work enquiry. What can I help with?`;
        await twilio.sendSms({ from: dialedNumber, to: callerNumber, body: neutralText });

        session.history.push({
          role: 'assistant',
          content: neutralText,
          channel: 'twilio_sms',
          timestamp: new Date().toISOString(),
        });
        await sessionStore.saveSession(session);

        // Generate asynchronous 1-Tap Magic Mute link token for the tradie
        let muteUrl: string | undefined;
        try {
          const token = Math.random().toString(36).substring(2, 10);
          await eligibilityEngine.repo.createMagicLinkToken(token, businessId, callerNumber);
          muteUrl = `/m/${token}`;
        } catch (e: any) {
          logger.warn({ err: e.message }, 'Failed to create magic mute link on neutral SMS');
        }

        logger.info({ callerNumber, muteUrl }, 'Dispatched neutral SMS to uncertain contact');
        return {
          statusCode: 200,
          data: {
            status: 'neutral_sms_dispatched',
            reason: decision.reason,
            eligibility: decision,
            muteUrl,
          },
        };
      }
    }

    // Outcome 3: STANDARD_SMS (Standard qualification flow)
    const transitionResult = transition(session, { type: 'DISPATCH_GREETING' });

    if (!transitionResult.isTransitionValid) {
      logger.info({ currentStatus: session.status }, 'Ignoring missed call: already past INIT');
      return { statusCode: 200, data: { status: 'ignored', reason: 'Already initialized' } };
    }

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
    logger.info({ nextStatus: transitionResult.nextState.status }, 'Greeting dispatched');
    return {
      statusCode: 200,
      data: {
        success: true,
        status: transitionResult.nextState.status,
        eligibility: { action: 'standard_sms', reason: 'unknown_caller', evaluatedAt: new Date().toISOString() },
      },
    };
  }

  // Case B: INBOUND CUSTOMER SMS
  if (eventType === 'INBOUND_SMS') {
    // ── 1. PRE-FLIGHT GATEWAY: Check active IntentSession in Neon ───────────
    if (eligibilityEngine) {
      const intentSession = await eligibilityEngine.repo.getIntentSession(businessId, callerNumber);

      // Defensive Guard: If IntentSession is already resolved as personal, keep AI receptionist completely silent
      // and forward personal message directly to tradie owner so communication isn't dropped.
      if (intentSession && intentSession.status === 'resolved_personal') {
        logger.info({ callerNumber }, 'IntentSession already resolved_personal — enforcing bot silence and forwarding to owner');
        const contact = await eligibilityEngine.repo.getContact(businessId, callerNumber);
        const contactName = contact?.displayName || callerNumber;
        await twilio.sendSms({
          from: dialedNumber,
          to: ownerPhone,
          body: `[Personal Chat from ${contactName}]: "${body}"`,
        });

        session.status = 'TERMINATED';
        session.history.push({
          role: 'customer',
          content: body,
          channel: 'twilio_sms',
          timestamp: new Date().toISOString(),
        });
        await sessionStore.saveSession(session);

        return {
          statusCode: 200,
          data: {
            status: 'TERMINATED',
            silenced: true,
            forwardedToOwner: true,
            reason: 'resolved_personal',
          },
        };
      }

      if (intentSession && intentSession.status === 'awaiting_intent') {
        logger.info({ callerNumber }, 'Active awaiting_intent session found in Neon — running Bouncer Classifier');

        const bouncer = bouncerClassifier || new GeminiBouncerClassifier();
        const classification = await bouncer.classify(body, tenant.tradeType || 'tradie');
        logger.info({ callerNumber, classification: classification.classification, reasoning: classification.reasoning }, 'Bouncer classification complete');

        if (classification.classification === 'PERSONAL') {
          // Rule BouncerClassifiesPersonalReply:
          // 1. Mark intent session as resolved_personal (session-level silence)
          await eligibilityEngine.repo.saveIntentSession({
            ...intentSession,
            status: 'resolved_personal',
            incomingReplyText: body,
            classificationResult: 'personal',
          });

          // 2. Generate 1-Tap Magic Mute confirmation token (allows tradie to permanently mute contact forever)
          let muteUrl: string | undefined;
          try {
            const token = Math.random().toString(36).substring(2, 10);
            await eligibilityEngine.repo.createMagicLinkToken(token, businessId, callerNumber);
            muteUrl = `/m/${token}`;
          } catch (e: any) {
            logger.warn({ err: e.message }, 'Failed to create magic mute link on personal reply');
          }

          // 3. Forward text directly to Tradie mobile with permanent mute option
          const contact = await eligibilityEngine.repo.getContact(businessId, callerNumber);
          const contactName = contact?.displayName || callerNumber;
          await twilio.sendSms({
            from: dialedNumber,
            to: ownerPhone,
            body: `[Personal Chat from ${contactName}]: "${body}"\n\n🛡️ Bot silenced for this chat.\nNever want bot to text them? Tap to Mute Forever: ${muteUrl || 'N/A'}`,
          });

          // Explicitly enter terminal TERMINATED state to silence future bot interactions
          session.status = 'TERMINATED';
          session.history.push({
            role: 'customer',
            content: body,
            channel: 'twilio_sms',
            timestamp: new Date().toISOString(),
          });
          await sessionStore.saveSession(session);

          return {
            statusCode: 200,
            data: {
              status: 'TERMINATED',
              intentStatus: 'resolved_personal',
              autoMuted: false,
              forwardedToOwner: true,
              silenced: true,
              muteUrl,
              contactName,
              message: 'Personal chat detected. Active session silenced; permanent mute link sent to owner.',
            },
          };
        } else {
          // Classification is SERVICE:
          // Resolve intent session and hand off to Lead Receptionist FSM!
          await eligibilityEngine.repo.saveIntentSession({
            ...intentSession,
            status: 'resolved_service',
            incomingReplyText: body,
            classificationResult: 'service',
          });
          logger.info({ callerNumber }, 'Bouncer classified as SERVICE — handing off to Lead Receptionist FSM');
        }
      }
    }

    // ── 2. LEAD RECEPTIONIST FSM QUALIFICATION ─────────────────────────────
    // If session is still in INIT (e.g. from a neutral_sms handoff), dispatch greeting transition first
    let startingSession = session;
    if (startingSession.status === 'INIT') {
      const initGreeting = transition(startingSession, { type: 'DISPATCH_GREETING' });
      startingSession = initGreeting.nextState;
    }

    const step1 = transition(startingSession, { type: 'CUSTOMER_MESSAGE', text: body, mediaUrls });
    let currentSession = step1.nextState;

    currentSession.history.push({
      role: 'customer',
      content: body,
      channel: 'twilio_sms',
      timestamp: new Date().toISOString(),
      mediaUrls,
    });

    if (session.status === 'COMPLETED' || session.status === 'ESCALATED') {
      logger.info({ status: session.status }, 'Customer texted after completion/escalation — forwarding to owner');
      await twilio.sendSms({
        from: dialedNumber,
        to: ownerPhone,
        body: `[Follow-up from ${callerNumber}]: "${body}"`,
      });
      await sessionStore.saveSession(currentSession);
      return { statusCode: 200, data: { status: session.status, forwarded: true } };
    }

    logger.info({ tenantName: businessName }, 'Sending to Gemini for evaluation...');
    const evalOutput = await gemini.evaluate({
      tenant,
      history: currentSession.history.slice(0, -1),
      latestMessage: body,
      mediaUrls,
      previouslyCollected: currentSession.collectedData,
    });

    if (evalOutput.intent === 'solicitation' || evalOutput.intent === 'spam') {
      const spamResult = transition(currentSession, { type: 'SPAM_DETECTED' });
      await sessionStore.saveSession(spamResult.nextState);
      logger.info({ callerNumber, intent: evalOutput.intent }, 'Spam detected — session TERMINATED');
      return { statusCode: 200, data: { status: 'TERMINATED', intent: evalOutput.intent } };
    }

    const madeProgress =
      (!currentSession.collectedData.customerName && !!evalOutput.extracted.customerName) ||
      (!currentSession.collectedData.suburb && !!evalOutput.extracted.suburb) ||
      (!currentSession.collectedData.issue && !!evalOutput.extracted.issue) ||
      (!currentSession.collectedData.urgency && !!evalOutput.extracted.urgency);

    if (madeProgress) {
      currentSession.metadata.stallCount = 0;
    } else if (!evalOutput.isFullyQualified) {
      currentSession.metadata.stallCount = (currentSession.metadata.stallCount || 0) + 1;
    }

    const currentStallCount = currentSession.metadata.stallCount || 0;

    if (currentStallCount === 3) {
      const missing = getMissingFields(currentSession.collectedData);
      const missingStr = missing.length > 0 ? missing.join(' and ') : 'the job details';
      const ultimatumMsg = `To get this sorted, I just need ${missingStr}. Can you send that through?`;

      await twilio.sendSms({ from: dialedNumber, to: callerNumber, body: ultimatumMsg });
      currentSession.history.push({
        role: 'assistant',
        content: ultimatumMsg,
        channel: 'twilio_sms',
        timestamp: new Date().toISOString(),
      });

      const ultimatumResult = transition(currentSession, { type: 'ULTIMATUM_SENT', missingFields: missing });
      await sessionStore.saveSession(ultimatumResult.nextState);
      return { statusCode: 200, data: { status: ultimatumResult.nextState.status, antiLoop: 'ultimatum', ultimatumSent: true } };
    }

    if (currentStallCount >= 4) {
      const abandonResult = transition(currentSession, { type: 'SESSION_ABANDONED' });
      await sessionStore.saveSession(abandonResult.nextState);
      return { statusCode: 200, data: { status: 'ABANDONED', dropped: true } };
    }

    let step2Event: Parameters<typeof transition>[1];
    if (evalOutput.isEscalated) {
      step2Event = {
        type: 'ESCALATION_DETECTED',
        reason: evalOutput.escalationReason || 'HUMAN_REQUEST',
      };
    } else {
      step2Event = {
        type: 'EVALUATION_COMPLETED',
        extracted: evalOutput.extracted,
        isFullyQualified: evalOutput.isFullyQualified,
        followUpQuestion: evalOutput.replyText,
      };
    }

    const step2 = transition(currentSession, step2Event);
    currentSession = step2.nextState;

    for (const action of step2.actions) {
      switch (action.type) {
        case 'TERMINATE_SILENTLY':
          break;

        case 'SEND_FOLLOWUP_SMS': {
          const replyText =
            evalOutput.replyText ||
            "Thanks for the details! Could you also let us know your address or suburb so we can get someone out to you?";
          await twilio.sendSms({ from: dialedNumber, to: callerNumber, body: replyText });
          currentSession.history.push({
            role: 'assistant',
            content: replyText,
            channel: 'twilio_sms',
            timestamp: new Date().toISOString(),
          });
          break;
        }

        case 'ALERT_OWNER_ESCALATION': {
          const reason = action.reason;
          const replyMsg =
            evalOutput.replyText ||
            "I've flagged this directly for our team lead, who will reach out to you shortly.";
          await twilio.sendSms({ from: dialedNumber, to: callerNumber, body: replyMsg });
          currentSession.history.push({
            role: 'assistant',
            content: replyMsg,
            channel: 'twilio_sms',
            timestamp: new Date().toISOString(),
          });

          const extractedInfo = Object.entries(currentSession.collectedData)
            .filter(([k, v]) => v && k !== 'mediaUrls')
            .map(([k, v]) => `${k}: ${v}`)
            .join(', ');

          const leadSummary = extractedInfo ? `\nDetails: ${extractedInfo}` : '';

          let muteOption = '';
          if (eligibilityEngine) {
            try {
              const muteToken = Math.random().toString(36).substring(2, 10);
              await eligibilityEngine.repo.createMagicLinkToken(muteToken, businessId, callerNumber);
              muteOption = `\nNot a customer? Tap to mute: /m/${muteToken}`;
            } catch (e: any) {
              logger.warn({ err: e.message }, 'Failed to create mute link on escalation');
            }
          }

          await twilio.sendSms({
            from: dialedNumber,
            to: ownerPhone,
            body: `🚨 [ESCALATION ALERT - ${reason}]\nCustomer: ${callerNumber}\nLatest Msg: "${body}"${leadSummary}\nAction: Contact customer immediately.${muteOption}`,
          });
          break;
        }

        case 'DISPATCH_LEAD_TO_SERVICEM8': {
          const sm8Result = await servicem8.dispatchLead({
            lead: action.lead,
            callerPhone: callerNumber,
            businessName,
          });

          currentSession.crmSync = sm8Result.success
            ? { status: 'SYNCED', provider: 'servicem8', externalJobId: sm8Result.jobUuid, syncedAt: new Date().toISOString() }
            : { status: 'FAILED', provider: 'servicem8', error: sm8Result.error };
          break;
        }

        case 'DISPATCH_LEAD_TO_OWNER': {
          const lead = action.lead;
          const sm8Status = currentSession.crmSync?.status === 'SYNCED' ? '✅ In ServiceM8' : '⚠️ ServiceM8 sync failed';
          await twilio.sendSms({
            from: dialedNumber,
            to: ownerPhone,
            body: `🎯 NEW LEAD (${businessName}) ${sm8Status}\nName: ${lead.customerName || '?'}\nSuburb: ${lead.suburb || '?'}\nIssue: ${lead.issue || '?'}\nUrgency: ${lead.urgency || '?'}\nPhone: ${callerNumber}`,
          });
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

    await sessionStore.saveSession(currentSession);
    return {
      statusCode: 200,
      data: {
        success: true,
        status: currentSession.status,
        collected: currentSession.collectedData,
      },
    };
  }

  return { statusCode: 400, data: { error: `Unknown eventType: ${eventType}` } };
}
