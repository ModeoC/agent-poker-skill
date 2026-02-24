import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { processStateEvent, processClosedEvent, buildSummary } from '../poker-listener.js';

/**
 * Factory to build a PlayerView with sensible defaults.
 */
function makeView(overrides = {}) {
  const base = {
    gameId: 'game-1',
    handNumber: 1,
    phase: 'PREFLOP',
    pot: 30,
    boardCards: [],
    yourSeat: 0,
    yourCards: ['As', 'Kh'],
    yourChips: 970,
    yourBet: 10,
    isYourTurn: false,
    canRebuy: false,
    availableActions: [],
    players: [
      {
        seat: 0,
        name: 'Hero',
        chips: 970,
        bet: 10,
        invested: 10,
        status: 'active',
        isDealer: true,
        isCurrentActor: false,
      },
      {
        seat: 1,
        name: 'Alice',
        chips: 980,
        bet: 20,
        invested: 20,
        status: 'active',
        isDealer: false,
        isCurrentActor: true,
      },
    ],
    dealerSeat: 0,
    numSeats: 6,
    forcedBets: { smallBlind: 10, bigBlind: 20, ante: 0 },
    sidePots: [],
    currentPlayerToAct: 1,
    timeoutAt: null,
  };

  const result = { ...base, ...overrides };
  if (overrides.players !== undefined) {
    result.players = overrides.players;
  }
  return result;
}

/**
 * Create a fresh context for processStateEvent calls.
 */
function makeContext(overrides = {}) {
  return {
    prevState: null,
    prevPhase: null,
    ...overrides,
  };
}

/** Find an output of a given type in the outputs array. */
function findOutput(outputs, type) {
  return outputs.find((o) => o.type === type);
}

/** Get all EVENT messages from outputs. */
function eventMessages(outputs) {
  return outputs.filter((o) => o.type === 'EVENT').map((o) => o.message);
}

// ─── 1. Returns EVENT outputs for state diffs ────────────────────────

describe('processStateEvent — EVENT outputs', () => {
  it('returns EVENT output for new hand diff', () => {
    const ctx = makeContext();
    const view = makeView({ isYourTurn: false });

    const outputs = processStateEvent(view, ctx);

    const events = eventMessages(outputs);
    assert.ok(events.length > 0, 'should have at least one EVENT');
    assert.ok(events[0].includes('Hand #1'), 'first event should be hand start');
    // prevState should be updated
    assert.equal(ctx.prevState, view);
  });

  it('returns empty array when nothing changed', () => {
    const view = makeView();
    const ctx = makeContext({ prevState: view, prevPhase: 'PREFLOP' });

    const outputs = processStateEvent(view, ctx);

    assert.equal(outputs.length, 0);
  });
});

// ─── 2. Returns YOUR_TURN after EVENT outputs ────────────────────────

describe('processStateEvent — YOUR_TURN', () => {
  it('returns EVENT + YOUR_TURN with summary when isYourTurn is true', () => {
    const ctx = makeContext();
    const view = makeView({
      isYourTurn: true,
      availableActions: [{ type: 'CALL', amount: 20 }],
    });

    const outputs = processStateEvent(view, ctx);

    // Should have EVENT(s) from the new hand diff, then YOUR_TURN
    const events = eventMessages(outputs);
    assert.ok(events.length > 0, 'should have EVENT outputs');

    const yourTurn = findOutput(outputs, 'YOUR_TURN');
    assert.ok(yourTurn, 'should have YOUR_TURN output');
    assert.equal(yourTurn.state, view);
    assert.ok(typeof yourTurn.summary === 'string', 'should have summary string');
    assert.ok(yourTurn.summary.includes('PREFLOP'), 'summary should include phase');
    assert.ok(yourTurn.summary.includes('As Kh'), 'summary should include cards');
  });

  it('YOUR_TURN appears after EVENT outputs (ordering)', () => {
    const ctx = makeContext();
    const view = makeView({ isYourTurn: true });

    const outputs = processStateEvent(view, ctx);

    const lastOutput = outputs[outputs.length - 1];
    assert.equal(lastOutput.type, 'YOUR_TURN');
  });
});

// ─── 3. Returns HAND_RESULT for active -> SHOWDOWN ───────────────────

describe('processStateEvent — HAND_RESULT (SHOWDOWN)', () => {
  it('returns HAND_RESULT when phase transitions from active to SHOWDOWN', () => {
    const prevView = makeView({ phase: 'RIVER' });
    const ctx = makeContext({ prevState: prevView, prevPhase: 'RIVER' });

    const nextView = makeView({
      phase: 'SHOWDOWN',
      isYourTurn: false,
      boardCards: ['As', '7c', '2d', 'Kh', '3s'],
    });

    const outputs = processStateEvent(nextView, ctx);

    const handResult = findOutput(outputs, 'HAND_RESULT');
    assert.ok(handResult, 'should have HAND_RESULT output');
    assert.equal(handResult.state, nextView);
  });
});

// ─── 4. Returns HAND_RESULT for active -> WAITING ────────────────────

describe('processStateEvent — HAND_RESULT (WAITING)', () => {
  it('returns HAND_RESULT when phase transitions from active to WAITING', () => {
    const prevView = makeView({ phase: 'FLOP' });
    const ctx = makeContext({ prevState: prevView, prevPhase: 'FLOP' });

    const nextView = makeView({
      phase: 'WAITING',
      isYourTurn: false,
      boardCards: ['As', '7c', '2d'],
    });

    const outputs = processStateEvent(nextView, ctx);

    const handResult = findOutput(outputs, 'HAND_RESULT');
    assert.ok(handResult, 'should have HAND_RESULT output');
  });
});

// ─── 5. Does NOT return HAND_RESULT for WAITING -> WAITING ───────────

describe('processStateEvent — no false HAND_RESULT', () => {
  it('does NOT return HAND_RESULT when phase is WAITING and was already WAITING', () => {
    const prevView = makeView({ phase: 'WAITING' });
    const ctx = makeContext({ prevState: prevView, prevPhase: 'WAITING' });

    const nextView = makeView({
      phase: 'WAITING',
      isYourTurn: false,
    });

    const outputs = processStateEvent(nextView, ctx);

    const handResult = findOutput(outputs, 'HAND_RESULT');
    assert.equal(handResult, undefined, 'should NOT have HAND_RESULT');
  });
});

// ─── 6. Returns REBUY_AVAILABLE ──────────────────────────────────────

describe('processStateEvent — REBUY_AVAILABLE', () => {
  it('returns REBUY_AVAILABLE when hand ended and yourChips === 0 and canRebuy', () => {
    const prevView = makeView({ phase: 'RIVER' });
    const ctx = makeContext({ prevState: prevView, prevPhase: 'RIVER' });

    const nextView = makeView({
      phase: 'WAITING',
      isYourTurn: false,
      yourChips: 0,
      canRebuy: true,
    });

    const outputs = processStateEvent(nextView, ctx);

    const rebuy = findOutput(outputs, 'REBUY_AVAILABLE');
    assert.ok(rebuy, 'should have REBUY_AVAILABLE output');
    assert.equal(rebuy.state, nextView);
  });
});

// ─── 7. Each state update produces independent outputs ───────────────

describe('processStateEvent — independent outputs per call', () => {
  it('each call returns its own outputs, no accumulation across calls', () => {
    const ctx = makeContext();

    // First call: new hand diff
    const view1 = makeView({ isYourTurn: false });
    const outputs1 = processStateEvent(view1, ctx);
    assert.ok(outputs1.length > 0, 'first call should have outputs');

    // Second call: YOUR_TURN with opponent action diff
    const view2 = makeView({
      isYourTurn: true,
      players: [
        {
          seat: 0,
          name: 'Hero',
          chips: 970,
          bet: 10,
          invested: 10,
          status: 'active',
          isDealer: true,
          isCurrentActor: true,
        },
        {
          seat: 1,
          name: 'Alice',
          chips: 940,
          bet: 60,
          invested: 60,
          status: 'active',
          isDealer: false,
          isCurrentActor: false,
        },
      ],
    });
    const outputs2 = processStateEvent(view2, ctx);

    // outputs2 should NOT contain the hand-start event from outputs1
    const events2 = eventMessages(outputs2);
    assert.ok(
      events2.every((e) => !e.includes('Hand #1')),
      'second call should not repeat first call events',
    );
  });
});

// ─── 8. Returns WAITING_FOR_PLAYERS when alone at table ──────────────

describe('processStateEvent — WAITING_FOR_PLAYERS', () => {
  it('returns WAITING_FOR_PLAYERS when phase is WAITING and only 1 player', () => {
    const ctx = makeContext();
    const view = makeView({
      phase: 'WAITING',
      isYourTurn: false,
      players: [
        {
          seat: 0,
          name: 'Hero',
          chips: 555,
          bet: 0,
          invested: 0,
          status: 'active',
          isDealer: true,
          isCurrentActor: false,
        },
      ],
    });

    const outputs = processStateEvent(view, ctx);

    const waiting = findOutput(outputs, 'WAITING_FOR_PLAYERS');
    assert.ok(waiting, 'should have WAITING_FOR_PLAYERS output');
    assert.equal(waiting.state, view);
  });

  it('does NOT return WAITING_FOR_PLAYERS when WAITING with 2 players', () => {
    const ctx = makeContext();
    const view = makeView({
      phase: 'WAITING',
      isYourTurn: false,
      yourChips: 555,
      players: [
        {
          seat: 0,
          name: 'Hero',
          chips: 555,
          bet: 0,
          invested: 0,
          status: 'active',
          isDealer: true,
          isCurrentActor: false,
        },
        {
          seat: 1,
          name: 'Opponent',
          chips: 0,
          bet: 0,
          invested: 0,
          status: 'active',
          isDealer: false,
          isCurrentActor: false,
        },
      ],
    });

    const outputs = processStateEvent(view, ctx);

    const waiting = findOutput(outputs, 'WAITING_FOR_PLAYERS');
    assert.equal(waiting, undefined, 'should NOT have WAITING_FOR_PLAYERS');
  });
});

// ─── 9. processClosedEvent returns TABLE_CLOSED array ────────────────

describe('processClosedEvent', () => {
  it('returns array with TABLE_CLOSED', () => {
    const outputs = processClosedEvent();
    assert.ok(Array.isArray(outputs));
    assert.equal(outputs.length, 1);
    assert.deepStrictEqual(outputs[0], { type: 'TABLE_CLOSED' });
  });
});

// ─── 10. buildSummary formats decision context ───────────────────────

describe('buildSummary', () => {
  it('includes phase, cards, pot, stack, active count, and actions', () => {
    const view = makeView({
      phase: 'FLOP',
      yourCards: ['Ah', 'Kd'],
      pot: 50,
      yourChips: 450,
      boardCards: ['Qs', '9h', '3c'],
      availableActions: [
        { type: 'fold' },
        { type: 'check' },
        { type: 'bet', minAmount: 10, maxAmount: 450 },
      ],
    });

    const summary = buildSummary(view);

    assert.ok(summary.includes('FLOP'), 'should include phase');
    assert.ok(summary.includes('Ah Kd'), 'should include cards');
    assert.ok(summary.includes('Pot:50'), 'should include pot');
    assert.ok(summary.includes('Stack:450'), 'should include stack');
    assert.ok(summary.includes('2 active'), 'should include active count');
    assert.ok(summary.includes('fold'), 'should include fold action');
    assert.ok(summary.includes('check'), 'should include check action');
    assert.ok(summary.includes('bet 10-450'), 'should include bet range');
  });

  it('shows call amount', () => {
    const view = makeView({
      availableActions: [
        { type: 'fold' },
        { type: 'call', amount: 20 },
        { type: 'raise', minAmount: 40, maxAmount: 970 },
      ],
    });

    const summary = buildSummary(view);

    assert.ok(summary.includes('call 20'), 'should show call with amount');
    assert.ok(summary.includes('raise 40-970'), 'should show raise range');
  });

  it('handles missing cards gracefully', () => {
    const view = makeView({ yourCards: undefined });
    const summary = buildSummary(view);
    assert.ok(summary.includes('??'), 'should show ?? for missing cards');
  });

  it('handles empty available actions', () => {
    const view = makeView({ availableActions: [] });
    const summary = buildSummary(view);
    assert.ok(summary.includes('Actions: '), 'should have empty actions');
  });
});

// ─── 11. Opponent actions produce EVENT outputs ──────────────────────

describe('processStateEvent — opponent action events', () => {
  it('produces EVENT for opponent raise between calls', () => {
    const view1 = makeView({ isYourTurn: false });
    const ctx = makeContext();
    processStateEvent(view1, ctx);

    // Opponent raised
    const view2 = makeView({
      isYourTurn: true,
      players: [
        {
          seat: 0,
          name: 'Hero',
          chips: 970,
          bet: 10,
          invested: 10,
          status: 'active',
          isDealer: true,
          isCurrentActor: true,
        },
        {
          seat: 1,
          name: 'Alice',
          chips: 940,
          bet: 60,
          invested: 60,
          status: 'active',
          isDealer: false,
          isCurrentActor: false,
        },
      ],
    });
    const outputs = processStateEvent(view2, ctx);

    const events = eventMessages(outputs);
    assert.ok(
      events.some((e) => e.includes('Alice') && e.includes('60')),
      'should have EVENT for Alice raise',
    );

    const yourTurn = findOutput(outputs, 'YOUR_TURN');
    assert.ok(yourTurn, 'should also have YOUR_TURN');
  });
});

// ─── 12. Dedup: WAITING_FOR_PLAYERS not re-emitted on repeated state ─

describe('processStateEvent — WAITING_FOR_PLAYERS dedup', () => {
  it('does NOT re-emit WAITING_FOR_PLAYERS on repeated WAITING state with 1 player', () => {
    const ctx = makeContext();
    const view = makeView({
      phase: 'WAITING',
      isYourTurn: false,
      players: [
        {
          seat: 0,
          name: 'Hero',
          chips: 555,
          bet: 0,
          invested: 0,
          status: 'active',
          isDealer: true,
          isCurrentActor: false,
        },
      ],
    });

    // First call: should emit WAITING_FOR_PLAYERS
    const outputs1 = processStateEvent(view, ctx);
    const waiting1 = findOutput(outputs1, 'WAITING_FOR_PLAYERS');
    assert.ok(waiting1, 'first call should have WAITING_FOR_PLAYERS');

    // Second call with same state: should NOT re-emit
    const outputs2 = processStateEvent(view, ctx);
    const waiting2 = findOutput(outputs2, 'WAITING_FOR_PLAYERS');
    assert.equal(waiting2, undefined, 'second call should NOT have WAITING_FOR_PLAYERS');
  });

  it('re-emits WAITING_FOR_PLAYERS after phase changes and returns to WAITING', () => {
    const ctx = makeContext();
    const alonePlayer = [
      {
        seat: 0,
        name: 'Hero',
        chips: 555,
        bet: 0,
        invested: 0,
        status: 'active',
        isDealer: true,
        isCurrentActor: false,
      },
    ];

    // 1. WAITING alone → WAITING_FOR_PLAYERS emitted
    const waitingView1 = makeView({ phase: 'WAITING', isYourTurn: false, players: alonePlayer });
    processStateEvent(waitingView1, ctx);

    // 2. Phase changes to PREFLOP (someone joined, new hand)
    const preflopView = makeView({ phase: 'PREFLOP', handNumber: 2 });
    processStateEvent(preflopView, ctx);

    // 3. PREFLOP → WAITING triggers HAND_RESULT (hand ended), not WAITING_FOR_PLAYERS
    const waitingView2 = makeView({ phase: 'WAITING', isYourTurn: false, handNumber: 2, players: alonePlayer });
    const handEndOutputs = processStateEvent(waitingView2, ctx);
    const handResult = findOutput(handEndOutputs, 'HAND_RESULT');
    assert.ok(handResult, 'PREFLOP→WAITING should produce HAND_RESULT');

    // 4. Subsequent WAITING update (same phase) → now WAITING_FOR_PLAYERS fires
    const waitingView3 = makeView({ phase: 'WAITING', isYourTurn: false, handNumber: 2, players: alonePlayer });
    const outputs = processStateEvent(waitingView3, ctx);
    const waiting = findOutput(outputs, 'WAITING_FOR_PLAYERS');
    assert.ok(waiting, 'should re-emit WAITING_FOR_PLAYERS after hand result cleared');
  });
});
