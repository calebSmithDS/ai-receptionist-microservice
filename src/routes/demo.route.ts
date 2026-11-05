import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { SessionStore } from '../core/session-store.js';
import { GeminiQualificationEvaluator } from '../core/gemini-evaluator.js';
import { TwilioSmsClient } from '../core/twilio-client.js';
import { ServiceM8RestClient } from '../core/servicem8-client.js';
import { CachedTenantProvider } from '../core/providers/cached-tenant.provider.js';
import { ITenantProvider, TenantContext } from '../core/types/tenant.js';
import { MessageBufferManager } from '../core/message-buffer.js';
import { processMessageEvent } from '../core/services/message-dispatcher.js';

interface DemoChatPayload {
  message?: string;
  isMissedCall?: boolean;
  tenantConfig?: Partial<TenantContext>;
  callerId?: string;
  debounceVersion?: number;
}

export function registerDemoRoutes(
  app: FastifyInstance,
  sessionStore: SessionStore,
  gemini: GeminiQualificationEvaluator,
  twilio: TwilioSmsClient,
  tenantProvider: CachedTenantProvider,
  servicem8: ServiceM8RestClient,
  bufferManager?: MessageBufferManager
) {
  // Direct worker function call - bypasses HTTP / light-my-request entirely!
  async function invokeWorkerDirectly(payload: any) {
    return processMessageEvent(payload, {
      sessionStore,
      gemini,
      twilio,
      tenantProvider,
      servicem8,
      bufferManager,
      logger: app.log,
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
      const { message = '', isMissedCall = false, tenantConfig, callerId = '+61499112233', debounceVersion } = req.body;
      const dialedNumber = '+17372508034';
      const businessId = tenantConfig?.tenantId || 'tenant_caleb_plumbing';

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

        // Cache the custom tenant in Redis so the worker reads this updated profile
        const redisClient = (tenantProvider as any).redis;
        if (redisClient) {
          await redisClient.set(`tenant:config:${dialedNumber}`, fullTenant, { ex: 3600 });
        }
      }

      // If resetting or starting fresh with a missed call
      if (isMissedCall) {
        await sessionStore.deleteSession(businessId, callerId);
        
        // Trigger missed call via internal worker invocation
        await invokeWorkerDirectly({
          eventType: 'MISSED_CALL',
          channel: 'twilio_voice',
          callerNumber: callerId,
          dialedNumber,
          businessId,
          receivedAt: new Date().toISOString(),
        });

        const session = await sessionStore.getSession(businessId, callerId);
        return reply.send({
          success: true,
          session,
          initialGreeting: session?.history[0]?.content || "Hi, this is Caleb's assistant...",
        });
      }

      // Customer sends an SMS message
      // If debounceVersion is provided, drain and evaluate buffer.
      // Otherwise evaluate this message directly.
      const result = await invokeWorkerDirectly({
        eventType: 'INBOUND_SMS',
        channel: 'twilio_sms',
        callerNumber: callerId,
        dialedNumber,
        businessId,
        body: message,
        receivedAt: new Date().toISOString(),
        debounceVersion,
      });

      // If skipped because a newer message arrived in the buffer, return skipped status
      if (result?.data?.status === 'skipped') {
        return reply.send({ success: true, skipped: true });
      }

      const session = await sessionStore.getSession(businessId, callerId);
      const lastReply = session?.history[session.history.length - 1];

      return reply.send({
        success: true,
        session,
        reply: lastReply?.role === 'assistant' ? lastReply.content : null,
      });
    }
  );

  // ── 3. Reset demo session ─────────────────────────────────────────────
  app.post('/api/demo/reset', async (req: FastifyRequest<{ Body: { callerId?: string; businessId?: string } }>, reply: FastifyReply) => {
    const callerId = req.body?.callerId || '+61499112233';
    const businessId = req.body?.businessId || 'tenant_caleb_plumbing';
    await sessionStore.deleteSession(businessId, callerId);
    return reply.send({ success: true });
  });
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
    /* Chat stream */
    .messages-container {
      flex: 1;
      padding: 16px;
      overflow-y: auto;
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
      padding: 4px 10px;
      border-radius: 10px;
      text-align: center;
      margin: 4px 0;
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
    /* Indicator pills */
    .status-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 600;
      margin-top: 4px;
    }
    .badge-qualifying { background: #388bfd33; color: #58a6ff; }
    .badge-completed { background: #23863633; color: #3fb950; }
    .badge-escalated { background: #f8514933; color: #f85149; }
  </style>
</head>
<body>
  <div class="app-container">
    <!-- Header -->
    <div class="ios-header">
      <div style="width: 50px;"></div>
      <div class="header-contact">
        <div class="avatar" id="avatarLetter">C</div>
        <div class="contact-name" id="displayBizName">Caleb's Plumbing</div>
        <div class="contact-status" id="displayStatus">AI Receptionist Active</div>
      </div>
      <button class="btn-toggle-config" onclick="toggleDrawer()">⚙️ Rules</button>
    </div>

    <!-- Messages -->
    <div class="messages-container" id="messagesList">
      <div class="msg-notice">📞 Missed call intercepted (30s ago)</div>
    </div>

    <!-- Input -->
    <div class="chat-input-bar">
      <input type="text" class="chat-input" id="messageInput" placeholder="Text message..." onkeypress="handleKey(event)" />
      <button class="btn-send" onclick="sendMessage()">↑</button>
    </div>

    <!-- Settings Drawer -->
    <div class="config-drawer" id="configDrawer">
      <div class="drawer-title">
        <span>Business Rules & Tenant</span>
        <button onclick="toggleDrawer()" style="background:none; border:none; color:#fff; font-size:20px; cursor:pointer;">✕</button>
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
        <label>Services & Starting Prices (One per line: Service: Price)</label>
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
      <button class="btn-reset" onclick="resetChat()">Reset Conversation</button>
    </div>
  </div>

  <script>
    let callerId = '+61499' + Math.floor(100000 + Math.random() * 900000);

    function toggleDrawer() {
      document.getElementById('configDrawer').classList.toggle('open');
    }

    function addMessage(text, isUser = false) {
      const container = document.getElementById('messagesList');
      const div = document.createElement('div');
      div.className = 'msg ' + (isUser ? 'msg-user' : 'msg-bot');
      div.innerText = text;
      container.appendChild(div);
      container.scrollTop = container.scrollHeight;
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

    async function initGreeting() {
      const res = await fetch('/api/demo/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          isMissedCall: true,
          callerId: callerId,
          tenantConfig: getTenantConfig(),
        }),
      });
      const data = await res.json();
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
        document.getElementById('messagesList').scrollTop = document.getElementById('messagesList').scrollHeight;
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
      
      // Show subtle typing bubble while Gemini processes
      const container = document.getElementById('messagesList');
      const typingEl = document.createElement('div');
      typingEl.id = 'typingBubble';
      typingEl.className = 'msg msg-bot';
      typingEl.style.opacity = '0.7';
      typingEl.innerText = 'typing...';
      container.appendChild(typingEl);
      container.scrollTop = container.scrollHeight;

      const res = await fetch('/api/demo/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: pendingMessageBuffer.join('\\n'),
          callerId: callerId,
          tenantConfig: getTenantConfig(),
        }),
      });
      pendingMessageBuffer = [];
      const data = await res.json();
      
      const el = document.getElementById('typingBubble');
      if (el) el.remove();

      if (data.reply) {
        addMessage(data.reply, false);
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

      // Reset debounce timer on every new message!
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

    async function applySettingsAndRestart() {
      toggleDrawer();
      document.getElementById('messagesList').innerHTML = '<div class="msg-notice">🔄 Rules Updated. Starting fresh missed call...</div>';
      callerId = '+61499' + Math.floor(100000 + Math.random() * 900000);
      document.getElementById('displayBizName').innerText = document.getElementById('cfgBizName').value;
      document.getElementById('avatarLetter').innerText = (document.getElementById('cfgOwnerName').value[0] || 'T').toUpperCase();
      await initGreeting();
    }

    async function resetChat() {
      toggleDrawer();
      document.getElementById('messagesList').innerHTML = '<div class="msg-notice">🔄 Session Reset. Fresh missed call...</div>';
      callerId = '+61499' + Math.floor(100000 + Math.random() * 900000);
      await initGreeting();
    }

    // Auto-init on page load
    initGreeting();
  </script>
</body>
</html>`;
}

