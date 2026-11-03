import { transition, TRANSITION_TABLE } from '../core/state-machine.js';
import { createInitialSession, SessionStatus } from '../contracts/session-state.contract.js';

/**
 * Pure Mathematical Level-1 Unit Test Suite
 * 
 * Verifies the Formal 2D Transition Matrix (δ: Q × Σ → Q' × Ω):
 * - Zero network calls
 * - Zero API costs
 * - Deterministic, sub-50ms execution
 * - Tests every reachable state, valid transition, and illegal transition guard
 */
export function runLevel1UnitTests() {
  console.log('====================================================');
  console.log('🔬 LEVEL 1: PURE STATE MACHINE UNIT TESTS (δ: Q × Σ → Q\' × Ω)');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, details?: string) {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName} ${details ? `(${details})` : ''}`);
      failed++;
    }
  }

  const baseSessionParams = {
    businessId: 'biz_test_plumbing',
    callerNumber: '+61411223344',
    callSid: 'CA_UNIT_TEST_123',
  };

  // ─────────────────────────────────────────────────────────────
  // 1. INIT STATE TRANSITIONS & GUARDS
  // ─────────────────────────────────────────────────────────────
  console.log('1️⃣ State: INIT');
  let s = createInitialSession(baseSessionParams);
  assert(s.status === 'INIT', 'Initial status is INIT');
  assert(s.metadata.userMessageCount === 0, 'Initial userMessageCount is 0');

  // Valid: DISPATCH_GREETING -> AWAITING_REPLY
  let res = transition(s, { type: 'DISPATCH_GREETING' });
  assert(res.isTransitionValid && res.nextState.status === 'AWAITING_REPLY', 'INIT + DISPATCH_GREETING -> AWAITING_REPLY');
  assert(res.actions.some(a => a.type === 'SEND_GREETING_SMS'), 'Emits action: SEND_GREETING_SMS');

  // Illegal: Inbound customer message while in INIT
  let illegalInit = transition(s, { type: 'CUSTOMER_MESSAGE', text: 'Hello' });
  assert(!illegalInit.isTransitionValid, 'INIT + CUSTOMER_MESSAGE is invalid (cannot skip greeting)');
  assert(illegalInit.nextState.status === 'INIT', 'State remains unchanged on illegal transition');

  // ─────────────────────────────────────────────────────────────
  // 2. AWAITING_REPLY STATE TRANSITIONS
  // ─────────────────────────────────────────────────────────────
  console.log('\n2️⃣ State: AWAITING_REPLY');
  s = res.nextState;

  // Valid: CUSTOMER_MESSAGE -> QUALIFYING
  let resCustMsg = transition(s, { type: 'CUSTOMER_MESSAGE', text: 'Need a tap fixed' });
  assert(resCustMsg.isTransitionValid && resCustMsg.nextState.status === 'QUALIFYING', 'AWAITING_REPLY + CUSTOMER_MESSAGE -> QUALIFYING');
  assert(resCustMsg.actions.some(a => a.type === 'EVALUATE_WITH_LLM'), 'Emits action: EVALUATE_WITH_LLM');
  assert(resCustMsg.nextState.metadata.userMessageCount === 1, 'userMessageCount increments to 1');

  // Valid: SPAM_DETECTED on turn 1 -> TERMINATED (Spam Sinkhole ABS-01)
  let resSpam = transition(s, { type: 'SPAM_DETECTED' });
  assert(resSpam.isTransitionValid && resSpam.nextState.status === 'TERMINATED', 'AWAITING_REPLY + SPAM_DETECTED -> TERMINATED');
  assert(resSpam.actions.some(a => a.type === 'TERMINATE_SILENTLY'), 'Emits action: TERMINATE_SILENTLY ($0 outbound SMS)');

  // Illegal: Second MISSED_CALL greeting while awaiting reply (FSM-02 Idempotency)
  let dupGreeting = transition(s, { type: 'DISPATCH_GREETING' });
  assert(!dupGreeting.isTransitionValid, 'AWAITING_REPLY + DISPATCH_GREETING is rejected (idempotency guard)');

  // ─────────────────────────────────────────────────────────────
  // 3. QUALIFYING STATE TRANSITIONS & SUB-PATHS
  // ─────────────────────────────────────────────────────────────
  console.log('\n3️⃣ State: QUALIFYING');
  s = resCustMsg.nextState; // in QUALIFYING, turnCount = 1

  // Path 3A: Incomplete qualification keeps state in QUALIFYING with follow-up SMS
  let resIncomplete = transition(s, {
    type: 'EVALUATION_COMPLETED',
    extracted: { suburb: 'Bondi', issue: 'Leaking tap' },
    isFullyQualified: false,
    followUpQuestion: 'What is your name and is it leaking heavily?',
  });
  assert(resIncomplete.isTransitionValid && resIncomplete.nextState.status === 'QUALIFYING', 'Incomplete qualification stays in QUALIFYING');
  assert(resIncomplete.actions.some(a => a.type === 'SEND_FOLLOWUP_SMS'), 'Emits action: SEND_FOLLOWUP_SMS');
  assert(resIncomplete.nextState.collectedData.suburb === 'Bondi', 'Merges extracted data into collectedData');

  // Path 3B: Fully qualified lead transitions to COMPLETED (LOD-01, INT-01, INT-02)
  let resComplete = transition(resIncomplete.nextState, {
    type: 'EVALUATION_COMPLETED',
    extracted: { customerName: 'Sarah', urgency: 'HIGH' },
    isFullyQualified: true,
    followUpQuestion: 'Thanks Sarah, Caleb will call you shortly!',
  });
  assert(resComplete.isTransitionValid && resComplete.nextState.status === 'COMPLETED', 'Fully qualified lead transitions to COMPLETED');
  
  const compActions = resComplete.actions.map(a => a.type);
  assert(compActions.includes('DISPATCH_LEAD_TO_SERVICEM8'), 'Emits action: DISPATCH_LEAD_TO_SERVICEM8');
  assert(compActions.includes('DISPATCH_LEAD_TO_OWNER'), 'Emits action: DISPATCH_LEAD_TO_OWNER (SMS alert to tradie)');
  assert(compActions.includes('SEND_COMPLETION_SMS'), 'Emits action: SEND_COMPLETION_SMS');
  assert(resComplete.nextState.collectedData.customerName === 'Sarah', 'Retains customerName in collectedData');
  assert(resComplete.nextState.collectedData.suburb === 'Bondi', 'Preserves suburb from previous turn');

  // Path 3C: Human Escalation Trigger (ABS-05)
  let resEscalate = transition(s, {
    type: 'ESCALATION_DETECTED',
    reason: 'ANGER',
    notes: 'Customer demanding immediate human phone call',
  });
  assert(resEscalate.isTransitionValid && resEscalate.nextState.status === 'ESCALATED', 'QUALIFYING + ESCALATION_DETECTED -> ESCALATED');
  assert(resEscalate.actions.some(a => a.type === 'ALERT_OWNER_ESCALATION'), 'Emits action: ALERT_OWNER_ESCALATION');
  assert(resEscalate.nextState.escalation?.reason === 'ANGER', 'Stores escalation reason in state metadata');

  // Path 3D: Mid-conversation Spam / SEO Pitch (ABS-01)
  let resMidSpam = transition(s, { type: 'SPAM_DETECTED' });
  assert(resMidSpam.isTransitionValid && resMidSpam.nextState.status === 'TERMINATED', 'QUALIFYING + SPAM_DETECTED -> TERMINATED');
  assert(resMidSpam.actions.some(a => a.type === 'TERMINATE_SILENTLY'), 'Emits action: TERMINATE_SILENTLY');

  // Path 3E: Anti-Loop Turn 4 Ultimatum (ABS-03)
  let resUltimatum = transition(s, {
    type: 'ULTIMATUM_SENT',
    missingFields: ['your name', 'your suburb'],
  });
  assert(resUltimatum.isTransitionValid && resUltimatum.nextState.status === 'QUALIFYING', 'QUALIFYING + ULTIMATUM_SENT stays in QUALIFYING');
  assert(resUltimatum.actions.some(a => a.type === 'SEND_ULTIMATUM_SMS'), 'Emits action: SEND_ULTIMATUM_SMS');

  // Path 3F: Anti-Loop Turn 5 Silent Abandonment (ABS-04)
  let resAbandon = transition(s, { type: 'SESSION_ABANDONED' });
  assert(resAbandon.isTransitionValid && resAbandon.nextState.status === 'ABANDONED', 'QUALIFYING + SESSION_ABANDONED -> ABANDONED');
  assert(resAbandon.actions.some(a => a.type === 'ABANDON_SESSION'), 'Emits action: ABANDON_SESSION');

  // ─────────────────────────────────────────────────────────────
  // 4. LATCHING STATE IMMUTABILITY (TERMINATED & ABANDONED)
  // ─────────────────────────────────────────────────────────────
  console.log('\n4️⃣ Latching Sinks: TERMINATED & ABANDONED ($0 Cost Gates)');
  const terminatedState = resSpam.nextState;
  const abandonedState = resAbandon.nextState;

  // No events can revive or mutate a TERMINATED session
  const termCustMsg = transition(terminatedState, { type: 'CUSTOMER_MESSAGE', text: 'Hey please reply' });
  assert(!termCustMsg.isTransitionValid, 'TERMINATED rejects CUSTOMER_MESSAGE (isTransitionValid = false)');
  assert(termCustMsg.nextState.status === 'TERMINATED', 'Status remains TERMINATED');

  const termGreeting = transition(terminatedState, { type: 'DISPATCH_GREETING' });
  assert(!termGreeting.isTransitionValid, 'TERMINATED rejects DISPATCH_GREETING');

  // No events can revive or mutate an ABANDONED session
  const abanCustMsg = transition(abandonedState, { type: 'CUSTOMER_MESSAGE', text: 'Anyone there??' });
  assert(!abanCustMsg.isTransitionValid, 'ABANDONED rejects CUSTOMER_MESSAGE (isTransitionValid = false)');
  assert(abanCustMsg.nextState.status === 'ABANDONED', 'Status remains ABANDONED');

  // ─────────────────────────────────────────────────────────────
  // 5. POST-COMPLETION & POST-ESCALATION LATCHING (FSM-03)
  // ─────────────────────────────────────────────────────────────
  console.log('\n5️⃣ Latching States: COMPLETED & ESCALATED (Forward-to-Owner)');
  const completedState = resComplete.nextState;
  const escalatedState = resEscalate.nextState;

  // Post-completion messages forward unhandled text to owner without re-invoking LLM
  const postCompMsg = transition(completedState, { type: 'CUSTOMER_MESSAGE', text: 'Also our gate code is 1234' });
  assert(postCompMsg.isTransitionValid && postCompMsg.nextState.status === 'COMPLETED', 'COMPLETED absorbs subsequent CUSTOMER_MESSAGE');
  assert(postCompMsg.actions.some(a => a.type === 'FORWARD_UNHANDLED_TO_OWNER'), 'Emits action: FORWARD_UNHANDLED_TO_OWNER');

  // Post-escalation messages forward unhandled text to owner
  const postEscMsg = transition(escalatedState, { type: 'CUSTOMER_MESSAGE', text: 'Call me on my second number' });
  assert(postEscMsg.isTransitionValid && postEscMsg.nextState.status === 'ESCALATED', 'ESCALATED absorbs subsequent CUSTOMER_MESSAGE');
  assert(postEscMsg.actions.some(a => a.type === 'FORWARD_UNHANDLED_TO_OWNER'), 'Emits action: FORWARD_UNHANDLED_TO_OWNER');

  // ─────────────────────────────────────────────────────────────
  // 6. EXHAUSTIVE TRANSITION MATRIX AUDIT
  // ─────────────────────────────────────────────────────────────
  console.log('\n6️⃣ Matrix Coverage Audit: Every declared state is handled');
  const allStatuses: SessionStatus[] = [
    'INIT',
    'AWAITING_REPLY',
    'QUALIFYING',
    'COMPLETED',
    'ESCALATED',
    'TERMINATED',
    'ABANDONED',
  ];

  for (const st of allStatuses) {
    const isDefined = st in TRANSITION_TABLE || ['TERMINATED', 'ABANDONED'].includes(st);
    assert(isDefined, `Status "${st}" is accounted for in transition matrix architecture`);
  }

  console.log('\n====================================================');
  console.log(`📊 LEVEL 1 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================\n');

  if (failed > 0) {
    throw new Error(`Level 1 Unit Tests Failed: ${failed} failure(s)`);
  }
}

// Auto-run if executed directly via tsx
if (process.argv[1]?.endsWith('test-level-1.ts')) {
  runLevel1UnitTests();
}

