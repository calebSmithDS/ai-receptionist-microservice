import { createInitialSession } from '../contracts/session-state.contract.js';
import { transition } from '../core/state-machine.js';

async function testStateMachine() {
  console.log('🧪 Testing Formal State Machine & Transition Table...\n');

  const businessId = 'biz_test_plumber';
  const callerNumber = '+61411112222';

  // 1. Initial State (INIT)
  let session = createInitialSession({ businessId, callerNumber });
  console.log(`1️⃣ Initial State: [${session.status}]`);
  if (session.status !== 'INIT') throw new Error('Expected INIT');

  // 2. DISPATCH_GREETING: INIT -> AWAITING_REPLY
  console.log('2️⃣ Event: DISPATCH_GREETING');
  let result = transition(session, { type: 'DISPATCH_GREETING' });
  if (!result.isTransitionValid || result.nextState.status !== 'AWAITING_REPLY') {
    throw new Error(`Failed transition: expected AWAITING_REPLY, got ${result.nextState.status}`);
  }
  if (result.actions[0]?.type !== 'SEND_GREETING_SMS') {
    throw new Error('Expected action SEND_GREETING_SMS');
  }
  session = result.nextState;
  console.log(`   ✅ State: [${session.status}], Action: ${result.actions[0].type}`);

  // 3. CUSTOMER_MESSAGE: AWAITING_REPLY -> QUALIFYING
  console.log('3️⃣ Event: CUSTOMER_MESSAGE ("Hot water system is leaking in Coogee")');
  result = transition(session, {
    type: 'CUSTOMER_MESSAGE',
    text: 'Hot water system is leaking in Coogee',
  });
  if (!result.isTransitionValid || result.nextState.status !== 'QUALIFYING') {
    throw new Error(`Expected QUALIFYING, got ${result.nextState.status}`);
  }
  if (result.actions[0]?.type !== 'EVALUATE_WITH_LLM') {
    throw new Error('Expected action EVALUATE_WITH_LLM');
  }
  session = result.nextState;
  console.log(`   ✅ State: [${session.status}], Action: ${result.actions[0].type}`);

  // 4. Incomplete qualification: stays in QUALIFYING, follow-up asked
  console.log('4️⃣ Event: EVALUATION_COMPLETED (missing name/urgency)');
  result = transition(session, {
    type: 'EVALUATION_COMPLETED',
    extracted: { suburb: 'Coogee', issue: 'Leaking hot water system' },
    isFullyQualified: false,
    followUpQuestion: 'Got it! Is it leaking urgently right now, and who am I speaking with?',
  });
  if (!result.isTransitionValid || result.nextState.status !== 'QUALIFYING') {
    throw new Error(`Expected to stay in QUALIFYING, got ${result.nextState.status}`);
  }
  if (result.actions[0]?.type !== 'SEND_FOLLOWUP_SMS') {
    throw new Error('Expected action SEND_FOLLOWUP_SMS');
  }
  session = result.nextState;
  console.log(`   ✅ State: [${session.status}], Follow-up dispatched: "${(result.actions[0] as any).text}"`);

  // 5. Complete qualification: QUALIFYING -> COMPLETED
  console.log('5️⃣ Event: EVALUATION_COMPLETED (all 3 fields: suburb, issue, urgency)');
  result = transition(session, {
    type: 'EVALUATION_COMPLETED',
    extracted: {
      customerName: 'Sarah',
      suburb: 'Coogee',
      issue: 'Leaking hot water system',
      urgency: 'HIGH',
    },
    isFullyQualified: true,
  });
  if (!result.isTransitionValid || result.nextState.status !== 'COMPLETED') {
    throw new Error(`Expected COMPLETED, got ${result.nextState.status}`);
  }
  const actionTypes = result.actions.map(a => a.type);
  if (!actionTypes.includes('DISPATCH_LEAD_TO_OWNER') || !actionTypes.includes('SEND_COMPLETION_SMS')) {
    throw new Error(`Expected lead dispatch & completion actions, got ${actionTypes.join(', ')}`);
  }
  session = result.nextState;
  console.log(`   ✅ State: [${session.status}], Actions: ${actionTypes.join(' & ')}`);
  console.log(`      Extracted Lead:`, JSON.stringify(session.collectedData));

  // 6. Test Illegal Transition Guard: Trying to DISPATCH_GREETING from COMPLETED
  console.log('\n6️⃣ Testing Illegal Transition Guard...');
  const invalidResult = transition(session, { type: 'DISPATCH_GREETING' });
  if (invalidResult.isTransitionValid) {
    throw new Error('Illegal transition was accepted unexpectedly!');
  }
  console.log(`   ✅ Illegal transition cleanly rejected: isTransitionValid = false (State remains [${invalidResult.nextState.status}])`);

  console.log('\n🎉 Formal Transition Table verified successfully!');
}

testStateMachine().catch(err => {
  console.error('\n❌ State machine test failed:', err);
  process.exit(1);
});

