import crypto from 'node:crypto';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { SessionStore } from '../core/session-store.js';
import { GeminiQualificationEvaluator } from '../core/gemini-evaluator.js';
import { TwilioSmsClient } from '../core/twilio-client.js';
import { ServiceM8RestClient } from '../core/servicem8-client.js';
import { CachedTenantProvider } from '../core/providers/cached-tenant.provider.js';
import { ITenantProvider, TenantContext } from '../core/types/tenant.js';
import { MessageBufferManager } from '../core/message-buffer.js';
import { EligibilityEngine } from '../core/eligibility/eligibility-engine.js';
import { GeminiBouncerClassifier } from '../core/eligibility/gemini-bouncer.js';
import { processMessageEvent } from '../core/services/message-dispatcher.js';
import { getDb } from '../core/db/index.js';
import { sql } from 'drizzle-orm';
import * as schema from '../core/db/schema.js';

interface DemoChatPayload {
  message?: string;
  isMissedCall?: boolean;
  tenantConfig?: Partial<TenantContext>;
  callerId?: string;
  sessionToken?: string;
  callerPersona?: 'unknown' | 'mum_muted' | 'dave_subbie';
  debounceVersion?: number;
}

interface DemoTimeTravelPayload {
  callerId: string;
  businessId: string;
  offsetMinutes: number; // e.g. -16 (for duplicate call window) or -250 (for 4hr SMS window)
  targetField: 'lastMissedCallAt' | 'lastInteractionAt';
}

export function registerDemoRoutes(
  app: FastifyInstance,
  sessionStore: SessionStore,
  gemini: GeminiQualificationEvaluator,
  twilio: TwilioSmsClient,
  tenantProvider: CachedTenantProvider,
  servicem8: ServiceM8RestClient,
  bufferManager?: MessageBufferManager,
  eligibilityEngine?: EligibilityEngine,
  bouncerClassifier?: GeminiBouncerClassifier
) {
  // Demo Sandbox Mock: Intercepts and silences outbound Twilio SMS calls during web demo sessions
  // so external users playing with the demo don't incur Twilio balance charges or trigger alerts to the business owner
  const demoTwilioClient: TwilioSmsClient = {
    sendSms: async (params: { from: string; to: string; body: string }) => {
      app.log.info({ mockSms: params }, '[Demo Sandbox] Intercepted outbound SMS (Simulated $0 dispatch)');
      return { success: true, messageSid: 'SIMULATED_DEMO_' + Date.now() };
    },
  } as unknown as TwilioSmsClient;

  // Direct worker function call - bypasses HTTP / light-my-request entirely!
  async function invokeWorkerDirectly(payload: any, scopedLogger?: any) {
    const traceId = payload.traceId || crypto.randomUUID();
    return processMessageEvent({ ...payload, traceId }, {
      sessionStore,
      gemini,
      twilio: demoTwilioClient,
      tenantProvider,
      servicem8,
      bufferManager,
      eligibilityEngine,
      bouncerClassifier,
      logger: scopedLogger || app.log,
    });
  }

  // ── 1. Serve the interactive mobile phone simulator UI ─────────────────
  app.get('/demo', async (_req: FastifyRequest, reply: FastifyReply) => {
    reply.type('text/html');
    return getDemoHtml();
  });

  // ── 2. Handle interactive chat turns directly through the worker pipeline ──
  app.post(
    '/api/demo/chat',
    async (req: FastifyRequest<{ Body: DemoChatPayload }>, reply: FastifyReply) => {
      const {
        message = '',
        isMissedCall = false,
        tenantConfig,
        callerId = '+61499112233',
        sessionToken,
        callerPersona = 'unknown',
        debounceVersion,
      } = req.body;

      const dialedNumber = '+17372508034';
      // Isolate multi-client sessions using sessionToken namespace
      const tokenSuffix = sessionToken ? `_${sessionToken}` : '';
      const businessId = (tenantConfig?.tenantId || 'demo_caleb_plumbing') + tokenSuffix;

      // Allow on-the-fly tenant customization from the UI drawer
      if (tenantConfig) {
        const fullTenant: TenantContext = {
          tenantId: businessId,
          businessName: tenantConfig.businessName || "Caleb's Emergency Plumbing & Gas",
          ownerFirstName: tenantConfig.ownerFirstName || "Caleb",
          tradeType: tenantConfig.tradeType || 'plumber',
          publicPhone: tenantConfig.publicPhone || '+61481880277',
          twilioForwardingNumber: dialedNumber,
          serviceArea: tenantConfig.serviceArea || 'Adelaide Metro, Glenelg, Brighton, Norwood',
          businessHours: 'Monday to Friday 7am-5pm. 24/7 Emergency call-outs.',
          aiCustomInstructions: tenantConfig.aiCustomInstructions || 'Friendly Aussie tradie tone.',
          emergencyTriageAdvice: tenantConfig.emergencyTriageAdvice || 'Advise customer to locate and turn off their main water meter isolation tap.',
          services: tenantConfig.services || [
            { title: 'Blocked Drains', startingPrice: 'From $150' },
            { title: 'Burst Pipe Repair', startingPrice: 'From $180 call-out' },
            { title: 'Hot Water Replacement', startingPrice: 'Quote on site' },
          ],
          excludedServices: tenantConfig.excludedServices || ['Commercial roofing', 'Solar hot water panels'],
        };

        const redisClient = (tenantProvider as any).redis;
        if (redisClient) {
          await redisClient.set(`tenant:config:${dialedNumber}`, fullTenant, { ex: 3600 });
        }
      }

      // Pre-seed Persona in Neon DB if requested for deterministic demonstration
      // Note: We use onConflictDoNothing() so we don't overwrite user-applied
      // actions like 1-Tap Mute or Unmute if the contact already exists!
      const db = getDb();
      if (db && isMissedCall) {
        const contactId = `${businessId}:${callerId}`;
        if (callerPersona === 'mum_muted') {
          await db
            .insert(schema.contacts)
            .values({
              id: contactId,
              businessId,
              phoneNumber: callerId,
              displayName: 'Mum',
              category: 'explicit_excluded',
              isMuted: true,
            })
            .onConflictDoNothing();
        } else if (callerPersona === 'dave_subbie') {
          await db
            .insert(schema.contacts)
            .values({
              id: contactId,
              businessId,
              phoneNumber: callerId,
              displayName: 'Dave',
              category: 'single_first_name',
              isMuted: false,
            })
            .onConflictDoNothing();
        }
      }

      // If resetting or starting fresh with a missed call
      if (isMissedCall) {
        await sessionStore.deleteSession(businessId, callerId);

        // Trigger missed call via internal worker invocation
        const workerResult = await invokeWorkerDirectly({
          traceId: req.telemetryContext?.traceId,
          eventType: 'MISSED_CALL',
          channel: 'twilio_voice',
          callerNumber: callerId,
          dialedNumber,
          businessId,
          receivedAt: new Date().toISOString(),
        }, req.telemetry);

        const session = await sessionStore.getSession(businessId, callerId);
        const lastMsg = session?.history[session.history.length - 1];

        return reply.send({
          success: true,
          session,
          initialGreeting: lastMsg?.content || null,
          workerResult: workerResult?.data,
          eligibility: workerResult?.data?.eligibility,
        });
      }

      // Customer sends an SMS message
      const result = await invokeWorkerDirectly({
        traceId: req.telemetryContext?.traceId,
        eventType: 'INBOUND_SMS',
        channel: 'twilio_sms',
        callerNumber: callerId,
        dialedNumber,
        businessId,
        body: message,
        receivedAt: new Date().toISOString(),
        debounceVersion,
      }, req.telemetry);

      if (result?.data?.status === 'skipped') {
        return reply.send({ success: true, skipped: true });
      }

      const session = await sessionStore.getSession(businessId, callerId);
      const lastReply = session?.history[session.history.length - 1];
      const isForwardedToOwner = result?.data?.forwarded === true;

      return reply.send({
        success: true,
        session,
        forwardedToOwner: isForwardedToOwner,
        reply: lastReply?.role === 'assistant' ? lastReply.content : null,
        workerResult: result?.data,
      });
    }
  );

  // ── 3. Tab-Safe Reset: Wipes only THIS browser tab's demo data ───────────
  app.post(
    '/api/demo/reset-tab',
    async (req: FastifyRequest<{ Body: { callerId?: string; sessionToken?: string; businessId?: string } }>, reply: FastifyReply) => {
      const { callerId, sessionToken } = req.body || {};
      const tokenSuffix = sessionToken ? `_${sessionToken}` : '';
      const businessId = (req.body?.businessId || 'demo_caleb_plumbing') + tokenSuffix;

      if (callerId) {
        await sessionStore.deleteSession(businessId, callerId);
      }

      // Clean up tab records from Neon DB
      const db = getDb();
      if (db && sessionToken) {
        try {
          await db.execute(sql`DELETE FROM eligibility_decisions WHERE business_id = ${businessId};`);
          await db.execute(sql`DELETE FROM intent_sessions WHERE business_id = ${businessId};`);
          await db.execute(sql`DELETE FROM mute_magic_links WHERE business_id = ${businessId};`);
          await db.execute(sql`DELETE FROM contacts WHERE business_id = ${businessId};`);
        } catch (e: any) {
          app.log.warn({ err: e.message }, 'Failed to delete tab DB records on reset');
        }
      }

      return reply.send({ success: true, message: 'Tab session reset successfully' });
    }
  );

  // ── 4. Time-Travel Simulation for 15-Minute & 4-Hour Rules ────────────────
  app.post(
    '/api/demo/time-travel',
    async (req: FastifyRequest<{ Body: DemoTimeTravelPayload }>, reply: FastifyReply) => {
      const { callerId, businessId, offsetMinutes, targetField } = req.body;
      const db = getDb();
      if (!db) {
        return reply.status(400).send({ error: 'Database not connected' });
      }

      const targetTime = new Date(Date.now() + offsetMinutes * 60 * 1000);
      const contactId = `${businessId}:${callerId}`;

      try {
        if (targetField === 'lastMissedCallAt') {
          await db.execute(
            sql`UPDATE contacts SET last_missed_call_at = ${targetTime} WHERE id = ${contactId};`
          );
        } else if (targetField === 'lastInteractionAt') {
          await db.execute(
            sql`UPDATE contacts SET last_interaction_at = ${targetTime} WHERE id = ${contactId};`
          );
        }
        return reply.send({ success: true, adjustedTime: targetTime.toISOString() });
      } catch (err: any) {
        return reply.status(500).send({ error: err.message });
      }
    }
  );
}

function getDemoHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Tradie AI Receptionist - Mobile Preview</title>
  <style>
    :root {
      --bg: #0d1117;
      --card-bg: #161b22;
      --border: #30363d;
      --bubble-tradie: #238636;
      --bubble-user: #1f6feb;
      --bubble-bot: #21262d;
      --text: #f0f6fc;
      --text-muted: #8b949e;
      --pill-green: #238636;
      --pill-amber: #d29922;
      --pill-purple: #8957e5;
      --pill-blue: #1f6feb;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 10px;
    }
    .app-container {
      width: 100%;
      max-width: 440px;
      height: 90vh;
      max-height: 840px;
      background: #000;
      border-radius: 44px;
      border: 6px solid #2d333b;
      box-shadow: 0 25px 70px rgba(0,0,0,0.8), 0 0 0 1px rgba(255,255,255,0.1);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      position: relative;
    }
    /* iOS Status & Header */
    .ios-header {
      padding: 18px 20px 12px;
      background: rgba(22, 27, 34, 0.95);
      backdrop-filter: blur(20px);
      border-bottom: 1px solid rgba(255,255,255,0.1);
      display: flex;
      align-items: center;
      justify-content: space-between;
      z-index: 10;
    }
    .header-contact {
      display: flex;
      flex-direction: column;
      align-items: center;
      flex: 1;
    }
    .avatar {
      width: 38px;
      height: 38px;
      border-radius: 50%;
      background: #238636;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 16px;
      margin-bottom: 4px;
    }
    .contact-name { font-size: 14px; font-weight: 600; }
    .contact-status { font-size: 11px; color: var(--text-muted); }
    .btn-toggle-config {
      background: #21262d;
      border: 1px solid var(--border);
      color: var(--text);
      padding: 6px 12px;
      border-radius: 14px;
      font-size: 12px;
      cursor: pointer;
    }
    /* Diagnostic Bar */
    .diag-bar {
      display: none;
      background: #161b22;
      border-bottom: 1px solid var(--border);
      padding: 8px 14px;
      font-size: 11px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      z-index: 9;
    }
    .diag-pill {
      padding: 3px 8px;
      border-radius: 12px;
      font-weight: 600;
      font-size: 10.5px;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }
    .diag-pill.standard { background: rgba(35, 134, 54, 0.2); color: #3fb950; border: 1px solid #238636; }
    .diag-pill.suppressed { background: rgba(210, 153, 34, 0.2); color: #d29922; border: 1px solid #d29922; }
    .diag-pill.muted { background: rgba(137, 87, 229, 0.2); color: #a371f7; border: 1px solid #8957e5; }
    .diag-pill.neutral { background: rgba(31, 111, 235, 0.2); color: #58a6ff; border: 1px solid #1f6feb; }
    .diag-meta { color: var(--text-muted); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 170px; }
    .diag-action-btn {
      background: #21262d;
      border: 1px solid var(--border);
      color: var(--text);
      border-radius: 8px;
      padding: 3px 8px;
      font-size: 10px;
      cursor: pointer;
    }
    /* Chat stream */
    .messages-container {
      flex: 1;
      min-height: 0;
      padding: 16px;
      overflow-y: auto;
      overflow-x: hidden;
      -webkit-overflow-scrolling: touch;
      overscroll-behavior-y: contain;
      scroll-behavior: smooth;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .msg {
      max-width: 80%;
      padding: 10px 15px;
      border-radius: 18px;
      font-size: 14.5px;
      line-height: 1.35;
      word-wrap: break-word;
      animation: popIn 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275);
    }
    @keyframes popIn {
      from { opacity: 0; transform: scale(0.95) translateY(10px); }
      to { opacity: 1; transform: scale(1) translateY(0); }
    }
    .msg-user {
      align-self: flex-end;
      background: var(--bubble-user);
      color: #fff;
      border-bottom-right-radius: 4px;
    }
    .msg-bot {
      align-self: flex-start;
      background: var(--bubble-bot);
      color: #fff;
      border-bottom-left-radius: 4px;
      border: 1px solid rgba(255,255,255,0.06);
    }
    .msg-notice {
      align-self: center;
      font-size: 11px;
      color: var(--text-muted);
      background: rgba(255,255,255,0.05);
      padding: 5px 12px;
      border-radius: 10px;
      text-align: center;
      margin: 4px 0;
      line-height: 1.4;
    }
    /* Bottom bar */
    .chat-input-bar {
      padding: 10px 14px 20px;
      background: rgba(22, 27, 34, 0.95);
      border-top: 1px solid rgba(255,255,255,0.1);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .chat-input {
      flex: 1;
      background: #0d1117;
      border: 1px solid var(--border);
      color: #fff;
      padding: 10px 16px;
      border-radius: 20px;
      font-size: 14.5px;
      outline: none;
    }
    .chat-input:focus { border-color: #58a6ff; }
    .btn-send {
      background: #238636;
      border: none;
      color: #fff;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
      font-weight: 700;
    }
    /* Drawer Config Panel */
    .config-drawer {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      background: #161b22;
      z-index: 100;
      padding: 24px 20px;
      overflow-y: auto;
      transform: translateY(100%);
      transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .config-drawer.open { transform: translateY(0); }
    .drawer-title { font-size: 18px; font-weight: 700; margin-bottom: 16px; display: flex; justify-content: space-between; align-items: center; }
    .form-group { margin-bottom: 14px; }
    .form-group label { display: block; font-size: 12px; color: var(--text-muted); margin-bottom: 5px; font-weight: 600; text-transform: uppercase; }
    .form-control {
      width: 100%;
      background: #0d1117;
      border: 1px solid var(--border);
      color: #fff;
      padding: 8px 12px;
      border-radius: 10px;
      font-size: 13.5px;
    }
    .btn-apply {
      width: 100%;
      background: #238636;
      border: none;
      color: #fff;
      padding: 12px;
      border-radius: 12px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      margin-top: 10px;
    }
    .btn-reset {
      width: 100%;
      background: #21262d;
      border: 1px solid var(--border);
      color: #f85149;
      padding: 10px;
      border-radius: 12px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      margin-top: 8px;
    }
    .time-travel-box {
      background: #0d1117;
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 12px;
      margin: 14px 0;
    }
    .time-travel-title {
      font-size: 12px;
      font-weight: 600;
      color: #58a6ff;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .btn-time-travel {
      background: #21262d;
      border: 1px solid #388bfd;
      color: #58a6ff;
      padding: 6px 10px;
      border-radius: 8px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      margin-right: 6px;
      margin-top: 4px;
    }
  </style>
</head>
<body>
  <div class="app-container">
    <!-- Header -->
    <div class="ios-header">
      <div style="width: 50px;">
        <button id="btnDebugToggle" onclick="toggleDebugMode()" style="background:none; border:none; color:var(--text-muted); font-size:16px; cursor:pointer;" title="Toggle Developer Diagnostics">🛡️</button>
      </div>
      <div class="header-contact">
        <div class="avatar" id="avatarLetter">C</div>
        <div class="contact-name" id="displayBizName">Caleb's Plumbing</div>
        <div class="contact-status" id="displayStatus">AI Receptionist Active</div>
      </div>
      <button class="btn-toggle-config" onclick="toggleDrawer()">⚙️ Rules</button>
    </div>

    <!-- Diagnostic Pill Bar (Visible in debug mode) -->
    <div class="diag-bar" id="diagBar">
      <div style="display:flex; align-items:center; gap:6px;">
        <span class="diag-pill standard" id="diagPill">STANDARD</span>
        <span class="diag-meta" id="diagReason">unknown_caller</span>
      </div>
      <button class="diag-action-btn" id="btnSimulateCall" onclick="simulateMissedCall()">📞 Test Call</button>
    </div>

    <!-- Messages -->
    <div class="messages-container" id="messagesList">
      <div class="msg-notice">📞 Missed call intercepted</div>
    </div>

    <!-- Input -->
    <div class="chat-input-bar">
      <input type="text" class="chat-input" id="messageInput" placeholder="Text message..." onkeypress="handleKey(event)" />
      <button class="btn-send" onclick="sendMessage()">↑</button>
    </div>

    <!-- Settings Drawer -->
    <div class="config-drawer" id="configDrawer">
      <div class="drawer-title">
        <span>Settings & Diagnostics</span>
        <button onclick="toggleDrawer()" style="background:none; border:none; color:#fff; font-size:20px; cursor:pointer;">✕</button>
      </div>

      <!-- Caller Persona Selector -->
      <div class="form-group">
        <label>Caller Persona (Pre-Flight Gate Test)</label>
        <select class="form-control" id="cfgPersona" onchange="handlePersonaChange()">
          <option value="unknown" selected>🆕 Unknown Customer (Standard Qualification)</option>
          <option value="mum_muted">👩 Mum / Family (Muted - $0 Silent Suppression)</option>
          <option value="dave_subbie">🔨 Dave / Subbie (Single First Name - Neutral SMS)</option>
        </select>
      </div>

      <div class="form-group">
        <label>Caller Phone Number (Auto-Assigned & Isolated)</label>
        <div style="display:flex; align-items:center; gap:8px;">
          <input type="text" class="form-control" id="cfgCallerId" readonly style="opacity:0.75; cursor:not-allowed; background:#090d13; color:#58a6ff; font-family:monospace; font-weight:600;" />
          <span style="font-size:11px; color:var(--text-muted); white-space:nowrap;">🔒 Sandbox</span>
        </div>
        <p style="font-size:10.5px; color:var(--text-muted); margin-top:4px;">Each persona is automatically assigned a safe +61499... sandbox number isolated to your browser tab.</p>
      </div>

      <!-- Time-Travel Sandbox Simulation -->
      <div class="time-travel-box">
        <div class="time-travel-title">⏳ Time-Travel Sandbox (Skip Waiting Windows)</div>
        <button class="btn-time-travel" onclick="timeTravel(-16, 'lastMissedCallAt')">⏩ +16 Mins (Clear Duplicate Window)</button>
        <button class="btn-time-travel" onclick="timeTravel(-250, 'lastInteractionAt')">⏩ +4.2 Hrs (Clear SMS Window)</button>
      </div>

      <div class="form-group">
        <label>Tradie First Name</label>
        <input type="text" class="form-control" id="cfgOwnerName" value="Caleb" />
      </div>

      <div class="form-group">
        <label>Business Name</label>
        <input type="text" class="form-control" id="cfgBizName" value="Caleb's Emergency Plumbing & Gas" />
      </div>

      <div class="form-group">
        <label>Trade Specialty (Ontology)</label>
        <select class="form-control" id="cfgTradeType" onchange="handleTradeChange()">
          <option value="plumber" selected>Plumber & Gas Fitter</option>
          <option value="electrician">Electrician</option>
          <option value="hvac">Air Conditioning & Refrigeration (HVAC)</option>
          <option value="locksmith">Locksmith</option>
          <option value="roofer">Roofer</option>
        </select>
      </div>

      <div class="form-group">
        <label>Services & Starting Prices (Service: Price)</label>
        <textarea class="form-control" id="cfgServices" rows="3">Blocked Drains: From $150
Burst Pipe Repair: From $180 call-out
Hot Water Replacement: Quote on site</textarea>
      </div>

      <div class="form-group">
        <label>Emergency Triage Advice</label>
        <textarea class="form-control" id="cfgTriage" rows="2">Advise customer to locate and turn off their main water meter isolation tap at the front of the house.</textarea>
      </div>

      <div class="form-group">
        <label>Excluded Work (Blacklist)</label>
        <input type="text" class="form-control" id="cfgExcluded" value="Commercial roofing, Solar hot water panels, New construction" />
      </div>

      <button class="btn-apply" onclick="applySettingsAndRestart()">Apply & Start New Chat</button>
      <button class="btn-reset" onclick="resetThisTab()">🧹 Reset Tab & Wipe Test Records</button>
    </div>
  </div>

  <script>
    // Tab-scoped isolated session token
    let sessionToken = sessionStorage.getItem('tradie_demo_token');
    if (!sessionToken) {
      sessionToken = Math.random().toString(36).substring(2, 7);
      sessionStorage.setItem('tradie_demo_token', sessionToken);
    }

    // Persona-based caller numbers isolated to this session
    function getCallerIdForPersona(persona) {
      const baseSuffix = sessionToken.replace(/[^0-9]/g, '8').padEnd(4, '0').slice(0, 4);
      if (persona === 'mum_muted') return '+6149920' + baseSuffix;
      if (persona === 'dave_subbie') return '+6149930' + baseSuffix;
      return '+6149910' + baseSuffix; // unknown
    }

    let currentPersona = 'unknown';
    let callerId = getCallerIdForPersona(currentPersona);
    document.getElementById('cfgCallerId').value = callerId;

    // Check if debug mode enabled via URL (?debug=true) or toggle
    let isDebugMode = window.location.search.includes('debug=true');
    function updateDebugVisibility() {
      const bar = document.getElementById('diagBar');
      bar.style.display = isDebugMode ? 'flex' : 'none';
      document.getElementById('btnDebugToggle').style.color = isDebugMode ? '#58a6ff' : 'var(--text-muted)';
    }
    function toggleDebugMode() {
      isDebugMode = !isDebugMode;
      updateDebugVisibility();
    }
    updateDebugVisibility();

    function toggleDrawer() {
      document.getElementById('configDrawer').classList.toggle('open');
    }

    function scrollToBottom(smooth = true) {
      const container = document.getElementById('messagesList');
      if (!container) return;
      requestAnimationFrame(() => {
        container.scrollTo({
          top: container.scrollHeight,
          behavior: smooth ? 'smooth' : 'auto'
        });
      });
    }

    function addMessage(text, isUser = false) {
      const container = document.getElementById('messagesList');
      const div = document.createElement('div');
      div.className = 'msg ' + (isUser ? 'msg-user' : 'msg-bot');
      div.innerText = text;
      container.appendChild(div);
      scrollToBottom(true);
    }

    function updateEligibilityBadge(eligibility) {
      if (!eligibility) return;
      console.log('🛡️ [Eligibility Engine Decision]:', eligibility);

      const pill = document.getElementById('diagPill');
      const reasonEl = document.getElementById('diagReason');

      pill.className = 'diag-pill ' + (
        eligibility.action === 'standard_sms' ? 'standard' :
        eligibility.action === 'suppress' ? (eligibility.reason === 'personal_exclusion' ? 'muted' : 'suppressed') :
        'neutral'
      );
      pill.innerText = eligibility.action.replace('_sms', '').toUpperCase();
      reasonEl.innerText = eligibility.reason || 'processed';
    }

    function handlePersonaChange() {
      currentPersona = document.getElementById('cfgPersona').value;
      callerId = getCallerIdForPersona(currentPersona);
      document.getElementById('cfgCallerId').value = callerId;
    }

    function handleTradeChange() {
      const trade = document.getElementById('cfgTradeType').value;
      const ownerInput = document.getElementById('cfgOwnerName');
      const bizInput = document.getElementById('cfgBizName');
      const servicesInput = document.getElementById('cfgServices');
      const triageInput = document.getElementById('cfgTriage');
      const excludedInput = document.getElementById('cfgExcluded');

      if (trade === 'hvac') {
        ownerInput.value = 'Liam';
        bizInput.value = "Liam's Air Conditioning & Heating";
        servicesInput.value = "Split System Service / Regas: From $180\\nDucted AC Breakdown Diagnostic: From $220\\nNew Split System Supply & Install: From $1,650\\nEvaporative Cooler Repair: From $195";
        triageInput.value = "If your AC unit is leaking water into light fixtures, turn off the AC isolation switch on your switchboard immediately.";
        excludedInput.value = "Commercial ammonia refrigeration, Automotive AC repairs, Plumbing drain snaking";
      } else if (trade === 'electrician') {
        ownerInput.value = 'Jack';
        bizInput.value = "Volt Pro Electrical & Solar";
        servicesInput.value = "Emergency Switchboard Callout: From $220\\nSafety Switch Tripping Fault-Find: From $150\\nPowerpoint & Light Installation: From $120\\nEV Charger Install: From $850";
        triageInput.value = "If you smell burning plastic or see sparking, turn off the main switch immediately. For life hazards, contact 000.";
        excludedInput.value = "Plumbing, Roofing, Painting";
      } else if (trade === 'locksmith') {
        ownerInput.value = 'Marcus';
        bizInput.value = "Adelaide Rapid Locksmiths";
        servicesInput.value = "Emergency Lockout Gain Entry: From $140\\nDeadbolt Installation: From $180\\nLock Rekey / Key Cutting: From $95\\nDigital Smart Lock Install: From $250";
        triageInput.value = "If you are locked out in an unsafe area or with a young child inside, please call 000 immediately.";
        excludedInput.value = "Automotive ignition programming, Safe cracking";
      } else if (trade === 'roofer') {
        ownerInput.value = 'Mick';
        bizInput.value = "Top Notch Roofing & Gutters";
        servicesInput.value = "Emergency Roof Leak Callout: From $250\\nGutter Cleaning & Flush: From $180\\nTile Replacement & Valley Repair: Quote on site\\nRe-bedding & Pointing: Quote on site";
        triageInput.value = "Do not climb onto the roof during active rain or storms. Place buckets under active ceiling leaks.";
        excludedInput.value = "Electrical rewiring, Gas repairs";
      } else {
        ownerInput.value = 'Caleb';
        bizInput.value = "Caleb's Emergency Plumbing & Gas";
        servicesInput.value = "Blocked Drains: From $150\\nBurst Pipe Repair: From $180 call-out\\nHot Water Replacement: Quote on site";
        triageInput.value = "Advise customer to locate and turn off their main water meter isolation tap at the front of the house.";
        excludedInput.value = "Commercial roofing, Solar hot water panels, New construction";
      }
    }

    function getTenantConfig() {
      const rawServices = document.getElementById('cfgServices').value.split('\\n');
      const parsedServices = rawServices
        .map(line => {
          const parts = line.split(':');
          if (parts.length >= 2) {
            return { title: parts[0].trim(), startingPrice: parts.slice(1).join(':').trim() };
          }
          return { title: line.trim() };
        })
        .filter(s => s.title.length > 0);

      return {
        ownerFirstName: document.getElementById('cfgOwnerName').value.trim(),
        businessName: document.getElementById('cfgBizName').value.trim(),
        tradeType: document.getElementById('cfgTradeType').value,
        emergencyTriageAdvice: document.getElementById('cfgTriage').value.trim(),
        services: parsedServices,
        excludedServices: document.getElementById('cfgExcluded').value.split(',').map(s => s.trim()).filter(Boolean),
      };
    }

    async function simulateMissedCall() {
      const container = document.getElementById('messagesList');
      const notice = document.createElement('div');
      notice.className = 'msg-notice';
      notice.innerHTML = '📞 <i>Missed call from ' + callerId + '...</i>';
      container.appendChild(notice);
      scrollToBottom(true);

      const res = await fetch('/api/demo/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          isMissedCall: true,
          callerId: callerId,
          sessionToken: sessionToken,
          callerPersona: currentPersona,
          tenantConfig: getTenantConfig(),
        }),
      });
      const data = await res.json();

      updateEligibilityBadge(data.eligibility);

      if (data.eligibility && data.eligibility.action === 'suppress') {
        const supNotice = document.createElement('div');
        supNotice.className = 'msg-notice';
        supNotice.style.background = 'rgba(210, 153, 34, 0.15)';
        supNotice.style.color = '#d29922';
        supNotice.innerHTML = '🛡️ <b>Text-Back Suppressed ($0 Cost)</b><br><span style="font-size:10px;">Reason: ' + data.eligibility.reason + '</span>';
        container.appendChild(supNotice);
        scrollToBottom(true);
        return;
      }

      if (data.initialGreeting) {
        addMessage(data.initialGreeting, false);
      }
    }

    let debounceTimer = null;
    let debounceCountdown = 10;
    let countdownInterval = null;

    function updateDebounceBanner(count) {
      let banner = document.getElementById('debounceNotice');
      if (count > 0) {
        if (!banner) {
          banner = document.createElement('div');
          banner.id = 'debounceNotice';
          banner.className = 'msg-notice';
          document.getElementById('messagesList').appendChild(banner);
        }
        banner.innerHTML = '💬 <i>Waiting for you to finish typing... (' + count + 's)</i> <button onclick="triggerImmediateEvaluation()" style="background:#238636; border:none; color:#fff; border-radius:6px; padding:2px 8px; font-size:11px; margin-left:6px; cursor:pointer;">Send Now ⚡</button>';
        scrollToBottom(true);
      } else if (banner) {
        banner.remove();
      }
    }

    async function triggerImmediateEvaluation() {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
      }
      updateDebounceBanner(0);
      await executeEvaluationTurn();
    }

    async function executeEvaluationTurn() {
      if (pendingMessageBuffer.length === 0) return;
      
      const container = document.getElementById('messagesList');
      const typingEl = document.createElement('div');
      typingEl.id = 'typingBubble';
      typingEl.className = 'msg msg-bot';
      typingEl.style.opacity = '0.7';
      typingEl.innerText = 'typing...';
      container.appendChild(typingEl);
      scrollToBottom(true);

      const res = await fetch('/api/demo/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: pendingMessageBuffer.join('\\n'),
          callerId: callerId,
          sessionToken: sessionToken,
          callerPersona: currentPersona,
          tenantConfig: getTenantConfig(),
        }),
      });
      pendingMessageBuffer = [];
      const data = await res.json();
      
      const el = document.getElementById('typingBubble');
      if (el) el.remove();

      if (data.workerResult?.status === 'resolved_personal') {
        const ownerName = getTenantConfig().ownerFirstName || 'the tradie';
        const muteUrl = data.workerResult.muteUrl;
        const noticeEl = document.createElement('div');
        noticeEl.className = 'msg-notice';
        noticeEl.style.background = 'rgba(137, 87, 229, 0.15)';
        noticeEl.style.borderColor = '#8957e5';
        noticeEl.style.color = '#a371f7';
        noticeEl.innerHTML = '🛡️ <b>Personal Chat Detected — Auto-Muted!</b><br><span style="font-size:10px; color:#c9d1d9;">Bot silenced at $0 cost. Forwarded to ' + ownerName + ' to reply personally.</span>' +
          (muteUrl ? '<br><a href="' + muteUrl + '" target="_blank" style="color:#58a6ff; font-weight:600; text-decoration:underline; font-size:10px; display:inline-block; margin-top:4px;">🔓 Mistake? Tap to Unmute (' + muteUrl + ')</a>' : '');
        document.getElementById('messagesList').appendChild(noticeEl);
        updateStatusBadge('RESOLVED_PERSONAL');
        scrollToBottom(true);
        return;
      }

      if (data.reply) {
        addMessage(data.reply, false);
      } else if (data.forwardedToOwner) {
        const ownerName = getTenantConfig().ownerFirstName || 'the tradie';
        const noticeEl = document.createElement('div');
        noticeEl.className = 'msg-notice';
        noticeEl.style.background = 'rgba(56, 139, 253, 0.15)';
        noticeEl.style.borderColor = '#388bfd';
        noticeEl.style.color = '#58a6ff';
        noticeEl.innerHTML = '📲 <b>Forwarded to ' + ownerName + '</b><br><span style="font-size:10px; color:#8b949e;">Lead already qualified. Follow-up forwarded to ' + ownerName + ' to answer directly.</span>';
        document.getElementById('messagesList').appendChild(noticeEl);
        scrollToBottom(true);
      }

      if (data.session) {
        updateStatusBadge(data.session.status);
      }
    }

    let pendingMessageBuffer = [];

    async function sendMessage() {
      const input = document.getElementById('messageInput');
      const text = input.value.trim();
      if (!text) return;

      addMessage(text, true);
      pendingMessageBuffer.push(text);
      input.value = '';

      if (debounceTimer) clearTimeout(debounceTimer);
      if (countdownInterval) clearInterval(countdownInterval);

      debounceCountdown = 10;
      updateDebounceBanner(debounceCountdown);

      countdownInterval = setInterval(() => {
        debounceCountdown--;
        if (debounceCountdown > 0) {
          updateDebounceBanner(debounceCountdown);
        } else {
          clearInterval(countdownInterval);
          countdownInterval = null;
        }
      }, 1000);

      debounceTimer = setTimeout(async () => {
        updateDebounceBanner(0);
        await executeEvaluationTurn();
      }, 10000);
    }

    function updateStatusBadge(status) {
      const statusEl = document.getElementById('displayStatus');
      statusEl.innerText = 'State: ' + status;
    }

    function handleKey(e) {
      if (e.key === 'Enter') sendMessage();
    }

    async function timeTravel(offsetMinutes, targetField) {
      const res = await fetch('/api/demo/time-travel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callerId: callerId,
          businessId: 'demo_caleb_plumbing_' + sessionToken,
          offsetMinutes: offsetMinutes,
          targetField: targetField,
        }),
      });
      const data = await res.json();
      if (data.success) {
        alert('⏳ Time-travel complete! ' + targetField + ' set to ' + offsetMinutes + ' mins ago.');
      } else {
        alert('Time-travel failed: ' + (data.error || 'Check Neon DB connection'));
      }
    }

    async function applySettingsAndRestart() {
      toggleDrawer();
      document.getElementById('messagesList').innerHTML = '<div class="msg-notice">🔄 Rules Updated. Starting fresh missed call...</div>';
      document.getElementById('displayBizName').innerText = document.getElementById('cfgBizName').value;
      document.getElementById('avatarLetter').innerText = (document.getElementById('cfgOwnerName').value[0] || 'T').toUpperCase();
      await simulateMissedCall();
    }

    async function resetThisTab() {
      toggleDrawer();
      document.getElementById('messagesList').innerHTML = '<div class="msg-notice">🧹 Tab Session Reset. Neon test data purged.</div>';
      await fetch('/api/demo/reset-tab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callerId: callerId,
          sessionToken: sessionToken,
          businessId: 'demo_caleb_plumbing',
        }),
      });
      await simulateMissedCall();
    }

    // Auto-init on page load
    simulateMissedCall();
  </script>
</body>
</html>`;
}
