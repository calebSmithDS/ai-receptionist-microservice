import { SessionStore } from '../session-store.js';
import { transition } from '../state-machine.js';
import { GeminiQualificationEvaluator } from '../gemini-evaluator.js';
import { TwilioSmsClient } from '../twilio-client.js';
import { ServiceM8RestClient } from '../servicem8-client.js';
import { ITenantProvider } from '../types/tenant.js';
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
    logger?: any;
  }
): Promise<{ statusCode: number; data: any }> {
  const { sessionStore, gemini, twilio, tenantProvider, servicem8 } = deps;
  const logger = deps.logger || console;
  const { callerNumber, dialedNumber, eventType, body = '', mediaUrls = [] } = payload;

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

  // Case A: MISSED CALL
  if (eventType === 'MISSED_CALL') {
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
    return { statusCode: 200, data: { success: true, status: transitionResult.nextState.status } };
  }

  // Case B: INBOUND CUSTOMER SMS
  if (eventType === 'INBOUND_SMS') {
    const step1 = transition(session, { type: 'CUSTOMER_MESSAGE', text: body, mediaUrls });
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
      return { statusCode: 200, data: { status: ultimatumResult.nextState.status, antiLoop: 'ultimatum' } };
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
          await twilio.sendSms({
            from: dialedNumber,
            to: ownerPhone,
            body: `🚨 [ESCALATION ALERT - ${reason}]\nCustomer: ${callerNumber}\nLatest Msg: "${body}"${leadSummary}\nAction: Contact customer immediately.`,
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
