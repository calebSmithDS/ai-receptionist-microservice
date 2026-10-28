import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { SessionStore } from '../core/session-store.js';
import { transition } from '../core/state-machine.js';
import { GeminiQualificationEvaluator } from '../core/gemini-evaluator.js';
import { TwilioSmsClient } from '../core/twilio-client.js';
import { ITenantProvider, TenantContext } from '../core/types/tenant.js';
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

export function registerProcessMessageWorkerRoute(
  app: FastifyInstance,
  sessionStore: SessionStore,
  gemini: GeminiQualificationEvaluator,
  twilio: TwilioSmsClient,
  tenantProvider: ITenantProvider
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

      // 1. Resolve Tenant Config & Rules (Cached in Redis -> Source in Sanity CMS)
      let tenant = await tenantProvider.getTenantByPhoneNumber(dialedNumber);
      if (!tenant) {
        req.log.warn({ dialedNumber }, 'Tenant not found in Sanity/Cache; falling back to default tenant config');
        tenant = {
          tenantId: `tenant_${dialedNumber.replace(/[^0-9]/g, '')}`,
          businessName: env.DEFAULT_BUSINESS_NAME,
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

      req.log.info(
        { eventType, businessId, businessName, callerNumber },
        'Worker picked up asynchronous message processing task'
      );

      // 2. Hydrate Session State from Redis
      const { session } = await sessionStore.getOrCreateSession({
        businessId,
        callerNumber,
        callSid: payload.callSid,
      });

      // -------------------------------------------------------------
      // Case A: MISSED CALL TRIGGER
      // -------------------------------------------------------------
      if (eventType === 'MISSED_CALL') {
        const transitionResult = transition(session, { type: 'DISPATCH_GREETING' });

        if (!transitionResult.isTransitionValid) {
          req.log.info(
            { currentStatus: session.status },
            'Ignoring missed call greeting: session is already past INIT'
          );
          return reply.status(200).send({ status: 'ignored', reason: 'Already initialized' });
        }

        const greetingText = `Hi, thanks for calling ${businessName}! Sorry we missed your call, we're currently on a job. How can we help you today? Feel free to reply here.`;

        // Send Outbound Greeting SMS via Twilio
        await twilio.sendSms({
          from: dialedNumber,
          to: callerNumber,
          body: greetingText,
        });

        // Record outgoing turn into conversation tape
        transitionResult.nextState.history.push({
          role: 'assistant',
          content: greetingText,
          channel: 'twilio_sms',
          timestamp: new Date().toISOString(),
        });

        // Dehydrate to Redis
        await sessionStore.saveSession(transitionResult.nextState);
        req.log.info({ nextStatus: transitionResult.nextState.status }, 'Missed call greeting dispatched');

        return reply.status(200).send({ success: true, status: transitionResult.nextState.status });
      }

      // -------------------------------------------------------------
      // Case B: INBOUND CUSTOMER SMS
      // -------------------------------------------------------------
      if (eventType === 'INBOUND_SMS') {
        // Step 1: Transition machine with incoming customer message
        const step1 = transition(session, {
          type: 'CUSTOMER_MESSAGE',
          text: body,
          mediaUrls,
        });

        let currentSession = step1.nextState;

        // Append incoming customer turn to history
        currentSession.history.push({
          role: 'customer',
          content: body,
          channel: 'twilio_sms',
          timestamp: new Date().toISOString(),
          mediaUrls,
        });

        // If the session was already completed or escalated, route to owner and exit
        if (session.status === 'COMPLETED' || session.status === 'ESCALATED') {
          req.log.info({ status: session.status }, 'Customer texted after completion/escalation; forwarding to owner');
          await twilio.sendSms({
            from: dialedNumber,
            to: env.BUSINESS_OWNER_PHONE,
            body: `[Follow-up from ${callerNumber}]: "${body}"`,
          });
          await sessionStore.saveSession(currentSession);
          return reply.status(200).send({ status: session.status, forwarded: true });
        }

        // Step 2: Evaluate with Gemini using full multi-turn conversation tape & tenant rules
        req.log.info({ tenantName: tenant.businessName }, 'Evaluating multi-turn context with Gemini...');
        const evalOutput = await gemini.evaluate({
          tenant,
          history: currentSession.history.slice(0, -1), // History before this turn
          latestMessage: body,
          mediaUrls,
          previouslyCollected: currentSession.collectedData,
        });

        // Step 3: Handle Escalation if detected by Gemini
        if (evalOutput.isEscalated) {
          const stepEscalate = transition(currentSession, {
            type: 'ESCALATION_DETECTED',
            reason: evalOutput.escalationReason || 'HUMAN_REQUEST',
          });

          await twilio.sendSms({
            from: dialedNumber,
            to: ownerPhone,
            body: `🚨 ESCALATION ALERT (${businessName}): Customer ${callerNumber} needs human attention.\nReason: ${evalOutput.escalationReason}\nLast Message: "${body}"`,
          });

          const escalateReply = `No problem! I have alerted our team lead directly. They will call you as soon as possible.`;
          await twilio.sendSms({
            from: dialedNumber,
            to: callerNumber,
            body: escalateReply,
          });

          stepEscalate.nextState.history.push({
            role: 'assistant',
            content: escalateReply,
            channel: 'twilio_sms',
            timestamp: new Date().toISOString(),
          });

          await sessionStore.saveSession(stepEscalate.nextState);
          return reply.status(200).send({ status: 'ESCALATED' });
        }

        // Step 4: Feed Gemini findings into State Machine Transition
        const step2 = transition(currentSession, {
          type: 'EVALUATION_COMPLETED',
          extracted: evalOutput.extracted,
          isFullyQualified: evalOutput.isFullyQualified,
          followUpQuestion: evalOutput.replyText,
        });

        currentSession = step2.nextState;

        // Step 5: Execute Side Effects
        for (const action of step2.actions) {
          switch (action.type) {
            case 'SEND_FOLLOWUP_SMS': {
              await twilio.sendSms({
                from: dialedNumber,
                to: callerNumber,
                body: action.text,
              });

              currentSession.history.push({
                role: 'assistant',
                content: action.text,
                channel: 'twilio_sms',
                timestamp: new Date().toISOString(),
              });
              break;
            }

            case 'DISPATCH_LEAD_TO_OWNER': {
              const lead = action.lead;
              const leadBrief = `🎯 NEW QUALIFIED LEAD (${businessName}):\nName: ${lead.customerName || 'Not specified'}\nSuburb: ${lead.suburb}\nIssue: ${lead.issue}\nUrgency: ${lead.urgency}\nPhone: ${callerNumber}`;
              
              await twilio.sendSms({
                from: dialedNumber,
                to: ownerPhone,
                body: leadBrief,
              });
              req.log.info({ lead, ownerPhone }, 'Dispatched qualified job brief to business owner');
              break;
            }

            case 'SEND_COMPLETION_SMS': {
              const closingMessage = `Thanks ${currentSession.collectedData.customerName || ''}! I've logged your request and alerted the team at ${businessName}. They will be in touch shortly to confirm arrival.`.trim();

              await twilio.sendSms({
                from: dialedNumber,
                to: callerNumber,
                body: closingMessage,
              });

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

        // Step 6: Dehydrate to Redis
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

