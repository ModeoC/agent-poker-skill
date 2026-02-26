import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  processStateEvent,
  processClosedEvent,
  parseDirectArgs,
  createEventBatcher,
  buildDecisionPrompt,
  buildSummary,
  readStrategyOverride,
  buildHandResultSummary,
} from '../poker-listener.js';

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

function makeContext(overrides = {}) {
  return { prevState: null, prevPhase: null, lastActionType: null, lastReportedHand: 0, ...overrides };
}

// ─── processStateEvent ───────────────────────────────────────────────

describe('processStateEvent — returns arrays', () => {
  it('returns an array of events when not your turn', () => {
    const ctx = makeContext();
    const view = makeView({ isYourTurn: false });
    const result = processStateEvent(view, ctx);

    assert.ok(Array.isArray(result), 'should return an array');
    // First call with null prevState generates a new-hand EVENT from diffStates
    assert.ok(result.length > 0, 'should have at least one event for new hand');
    assert.equal(result[0].type, 'EVENT');
    assert.ok(result[0].message.includes('**[Hand #'), 'should have bold hand prefix');
    assert.equal(ctx.prevState, view);
  });

  it('returns empty array on duplicate state (no diff)', () => {
    const view = makeView({ isYourTurn: false });
    const ctx = makeContext({ prevState: view, prevPhase: 'PREFLOP' });

    // Same state again — no diffs, not your turn, no phase transition
    const result = processStateEvent(makeView({ isYourTurn: false }), ctx);
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 0);
  });
});

describe('processStateEvent — YOUR_TURN', () => {
  it('includes YOUR_TURN output when isYourTurn is true', () => {
    const ctx = makeContext();

    // First call sets prevState
    processStateEvent(makeView({ isYourTurn: false }), ctx);

    // Second call: your turn
    const view2 = makeView({
      isYourTurn: true,
      availableActions: [{ type: 'CALL', amount: 20 }],
      players: [
        { seat: 0, name: 'Hero', chips: 970, bet: 10, invested: 10, status: 'active', isDealer: true, isCurrentActor: true },
        { seat: 1, name: 'Alice', chips: 940, bet: 60, invested: 60, status: 'active', isDealer: false, isCurrentActor: false },
      ],
    });
    const result = processStateEvent(view2, ctx);

    assert.ok(Array.isArray(result));
    const yourTurn = result.find(o => o.type === 'YOUR_TURN');
    assert.ok(yourTurn, 'should contain a YOUR_TURN output');
    assert.equal(yourTurn.state, view2);
    assert.ok(typeof yourTurn.summary === 'string');
  });
});

describe('processStateEvent — YOUR_TURN dedup reset', () => {
  it('re-fires YOUR_TURN in the same phase after turn passes away and back', () => {
    const ctx = makeContext();

    // 1) Initial state (not our turn)
    processStateEvent(makeView({ handNumber: 2, phase: 'FLOP', isYourTurn: false, boardCards: ['As', '7c', '2d'] }), ctx);

    // 2) Our turn on the flop — should fire YOUR_TURN
    const turn1 = processStateEvent(makeView({ handNumber: 2, phase: 'FLOP', isYourTurn: true, boardCards: ['As', '7c', '2d'], availableActions: [{ type: 'check' }] }), ctx);
    assert.ok(turn1.find(o => o.type === 'YOUR_TURN'), 'first YOUR_TURN should fire');

    // 3) Opponent's turn (not ours) — this should reset lastTurnKey
    processStateEvent(makeView({ handNumber: 2, phase: 'FLOP', isYourTurn: false, boardCards: ['As', '7c', '2d'] }), ctx);
    assert.equal(ctx.lastTurnKey, null, 'lastTurnKey should be null when not our turn');

    // 4) Back to us in the SAME phase (opponent bet, we must respond)
    const turn2 = processStateEvent(makeView({ handNumber: 2, phase: 'FLOP', isYourTurn: true, boardCards: ['As', '7c', '2d'], availableActions: [{ type: 'call', amount: 20 }, { type: 'fold' }] }), ctx);
    assert.ok(turn2.find(o => o.type === 'YOUR_TURN'), 'second YOUR_TURN in same phase should fire after reset');
  });

  it('still deduplicates rapid duplicate YOUR_TURN events in the same turn', () => {
    const ctx = makeContext();

    processStateEvent(makeView({ handNumber: 2, phase: 'FLOP', isYourTurn: false, boardCards: ['As', '7c', '2d'] }), ctx);

    // First YOUR_TURN fires
    const turn1 = processStateEvent(makeView({ handNumber: 2, phase: 'FLOP', isYourTurn: true, boardCards: ['As', '7c', '2d'], availableActions: [{ type: 'check' }] }), ctx);
    assert.ok(turn1.find(o => o.type === 'YOUR_TURN'), 'first should fire');

    // Rapid duplicate (still our turn, no intervening not-our-turn) — should NOT fire
    const turn2 = processStateEvent(makeView({ handNumber: 2, phase: 'FLOP', isYourTurn: true, boardCards: ['As', '7c', '2d'], availableActions: [{ type: 'check' }] }), ctx);
    assert.ok(!turn2.find(o => o.type === 'YOUR_TURN'), 'duplicate YOUR_TURN should be suppressed');
  });
});

describe('processStateEvent — HAND_RESULT', () => {
  it('returns HAND_RESULT when active phase → SHOWDOWN', () => {
    const prevView = makeView({ phase: 'RIVER' });
    const ctx = makeContext({ prevState: prevView, prevPhase: 'RIVER' });

    const nextView = makeView({ phase: 'SHOWDOWN', isYourTurn: false, boardCards: ['As', '7c', '2d', 'Kh', '3s'] });
    const result = processStateEvent(nextView, ctx);

    assert.ok(Array.isArray(result));
    const handResult = result.find(o => o.type === 'HAND_RESULT');
    assert.ok(handResult, 'should contain a HAND_RESULT output');
    assert.equal(handResult.state, nextView);
    assert.equal(handResult.handNumber, 1, 'should include handNumber');
  });

  it('returns HAND_RESULT when active phase → WAITING', () => {
    const prevView = makeView({ phase: 'FLOP' });
    const ctx = makeContext({ prevState: prevView, prevPhase: 'FLOP' });

    const nextView = makeView({ phase: 'WAITING', isYourTurn: false, boardCards: ['As', '7c', '2d'] });
    const result = processStateEvent(nextView, ctx);

    const handResult = result.find(o => o.type === 'HAND_RESULT');
    assert.ok(handResult, 'should contain a HAND_RESULT output');
    assert.equal(handResult.handNumber, 1, 'should include handNumber');
  });

  it('does NOT return HAND_RESULT for WAITING → WAITING', () => {
    const prevView = makeView({ phase: 'WAITING' });
    const ctx = makeContext({ prevState: prevView, prevPhase: 'WAITING' });

    const nextView = makeView({ phase: 'WAITING', isYourTurn: false });
    const result = processStateEvent(nextView, ctx);

    const handResult = result.find(o => o.type === 'HAND_RESULT');
    assert.equal(handResult, undefined);
  });
});

describe('processStateEvent — REBUY_AVAILABLE', () => {
  it('returns REBUY_AVAILABLE when busted and can rebuy', () => {
    const prevView = makeView({ phase: 'RIVER' });
    const ctx = makeContext({ prevState: prevView, prevPhase: 'RIVER' });

    const nextView = makeView({ phase: 'WAITING', isYourTurn: false, yourChips: 0, canRebuy: true });
    const result = processStateEvent(nextView, ctx);

    const rebuy = result.find(o => o.type === 'REBUY_AVAILABLE');
    assert.ok(rebuy, 'should contain a REBUY_AVAILABLE output');
    assert.equal(rebuy.state, nextView);
    assert.equal(rebuy.handNumber, 1, 'should include handNumber');
  });
});

// ─── Hand transition detection ──────────────────────────────────────

describe('processStateEvent — hand transitions', () => {
  it('returns HAND_RESULT when hand number changes (fast transition)', () => {
    const prevView = makeView({ handNumber: 1, phase: 'PREFLOP' });
    const ctx = makeContext({ prevState: prevView, prevPhase: 'PREFLOP' });

    const nextView = makeView({ handNumber: 2, phase: 'PREFLOP' });
    const result = processStateEvent(nextView, ctx);

    const handResult = result.find(o => o.type === 'HAND_RESULT');
    assert.ok(handResult, 'should generate HAND_RESULT on hand number change');
    assert.equal(handResult.handNumber, 1);
  });

  it('does not duplicate HAND_RESULT when phase transition and hand change coincide', () => {
    const prevView = makeView({ handNumber: 1, phase: 'RIVER' });
    const ctx = makeContext({ prevState: prevView, prevPhase: 'RIVER' });

    const nextView = makeView({ handNumber: 2, phase: 'PREFLOP' });
    const result = processStateEvent(nextView, ctx);

    const handResults = result.filter(o => o.type === 'HAND_RESULT');
    assert.equal(handResults.length, 1, 'should have exactly one HAND_RESULT');
    assert.equal(handResults[0].handNumber, 1, 'should report previous hand number');
  });

  it('does not re-emit HAND_RESULT for already-reported hand', () => {
    const prevView = makeView({ handNumber: 1, phase: 'PREFLOP' });
    const ctx = makeContext({ prevState: prevView, prevPhase: 'PREFLOP', lastReportedHand: 1 });

    const nextView = makeView({ handNumber: 2, phase: 'PREFLOP' });
    const result = processStateEvent(nextView, ctx);

    const handResults = result.filter(o => o.type === 'HAND_RESULT');
    assert.equal(handResults.length, 0, 'should not duplicate HAND_RESULT');
  });
});

// ─── buildHandResultSummary ─────────────────────────────────────────

describe('buildHandResultSummary', () => {
  it('includes bold hand prefix when handNumber is provided', () => {
    const state = {
      yourChips: 1020,
      lastHandResult: {
        winners: [0],
        players: [
          { seat: 0, name: 'Hero', chips: 1020 },
          { seat: 1, name: 'Alice', chips: 980 },
        ],
        potResults: [{ amount: 40 }],
      },
    };
    const result = buildHandResultSummary(state, 3);
    assert.ok(result.includes('**[Hand #3]**'), 'should include bold hand prefix');
    assert.ok(result.includes('Hero won 40'), 'should include winner and pot');
  });

  it('returns null when no lastHandResult', () => {
    const state = { yourChips: 1000, lastHandResult: null };
    assert.equal(buildHandResultSummary(state, 1), null);
  });
});

describe('processClosedEvent', () => {
  it('returns array with TABLE_CLOSED', () => {
    const result = processClosedEvent();
    assert.ok(Array.isArray(result));
    assert.deepStrictEqual(result, [{ type: 'TABLE_CLOSED' }]);
  });
});

// ─── parseDirectArgs ────────────────────────────────────────────────

describe('parseDirectArgs — canonical flags', () => {
  it('parses --channel and --chat-id', () => {
    const argv = ['node', 'poker-listener.js', 'url', 'key', 'table', '--channel', 'telegram', '--chat-id', '7014171428'];
    const result = parseDirectArgs(argv);

    assert.equal(result.enabled, true);
    assert.equal(result.channel, 'telegram');
    assert.equal(result.chatId, '7014171428');
  });

  it('accepts --target as alias for --chat-id', () => {
    const argv = ['node', 'poker-listener.js', 'url', 'key', 'table', '--channel', 'telegram', '--target', '12345'];
    const result = parseDirectArgs(argv);

    assert.equal(result.enabled, true);
    assert.equal(result.chatId, '12345');
  });

  it('accepts --to as alias for --chat-id', () => {
    const argv = ['node', 'poker-listener.js', 'url', 'key', 'table', '--channel', 'telegram', '--to', '12345'];
    const result = parseDirectArgs(argv);

    assert.equal(result.enabled, true);
    assert.equal(result.chatId, '12345');
  });

  it('returns enabled=false when --channel is missing', () => {
    const argv = ['node', 'poker-listener.js', 'url', 'key', 'table', '--chat-id', '12345'];
    const result = parseDirectArgs(argv);

    assert.equal(result.enabled, false);
    assert.equal(result.channel, null);
  });

  it('returns enabled=false when --chat-id is missing', () => {
    const argv = ['node', 'poker-listener.js', 'url', 'key', 'table', '--channel', 'telegram'];
    const result = parseDirectArgs(argv);

    assert.equal(result.enabled, false);
    assert.equal(result.chatId, null);
  });

  it('returns enabled=false when no flags', () => {
    const argv = ['node', 'poker-listener.js', 'url', 'key', 'table'];
    const result = parseDirectArgs(argv);

    assert.equal(result.enabled, false);
  });
});

// ─── createEventBatcher ─────────────────────────────────────────────

describe('createEventBatcher', () => {
  it('batches messages and sends on flush', () => {
    const sent = [];
    const sendFn = (ch, id, text) => sent.push({ ch, id, text });
    const batcher = createEventBatcher('telegram', '123', sendFn);

    batcher.push('event 1');
    batcher.push('event 2');
    batcher.flush();

    assert.equal(sent.length, 1);
    assert.equal(sent[0].ch, 'telegram');
    assert.equal(sent[0].id, '123');
    assert.equal(sent[0].text, 'event 1\nevent 2');
  });

  it('flush is a no-op when buffer is empty', () => {
    const sent = [];
    const sendFn = (ch, id, text) => sent.push({ ch, id, text });
    const batcher = createEventBatcher('telegram', '123', sendFn);

    batcher.flush();
    assert.equal(sent.length, 0);
  });

  it('sends on timer after 2 seconds', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const sent = [];
    const sendFn = (ch, id, text) => sent.push({ ch, id, text });
    const batcher = createEventBatcher('telegram', '123', sendFn);

    batcher.push('event 1');
    assert.equal(sent.length, 0);

    t.mock.timers.tick(2000);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].text, 'event 1');
  });

  it('flush clears pending timer', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const sent = [];
    const sendFn = (ch, id, text) => sent.push({ ch, id, text });
    const batcher = createEventBatcher('telegram', '123', sendFn);

    batcher.push('event 1');
    batcher.flush();
    assert.equal(sent.length, 1);

    // Timer should not fire again
    t.mock.timers.tick(2000);
    assert.equal(sent.length, 1);
  });
});

// ─── buildDecisionPrompt ────────────────────────────────────────────

describe('buildDecisionPrompt', () => {
  it('includes summary and asks for structured JSON output', () => {
    const prompt = buildDecisionPrompt('PREFLOP | As Kh | Pot:30', 'https://example.com', 'key123', 'table-1', '');

    assert.ok(prompt.includes('PREFLOP | As Kh | Pot:30'));
    assert.ok(prompt.includes('Respond with ONLY a JSON object'));
    assert.ok(prompt.includes('"action"'));
    assert.ok(prompt.includes('"narration"'));
    // Should NOT contain curl or API key (listener submits the action now)
    assert.ok(!prompt.includes('curl'));
    assert.ok(!prompt.includes('key123'));
  });

  it('includes strategy override section when present', () => {
    const prompt = buildDecisionPrompt('PREFLOP | As Kh', 'https://example.com', 'key', 'table-1', 'Play aggressively');

    assert.ok(prompt.includes('User Strategy Override (prioritize this):'));
    assert.ok(prompt.includes('Play aggressively'));
  });

  it('omits strategy override section when empty', () => {
    const prompt = buildDecisionPrompt('PREFLOP | As Kh', 'https://example.com', 'key', 'table-1', '');

    assert.ok(!prompt.includes('User Strategy Override'));
  });
});

// ─── buildSummary — board cards ─────────────────────────────────────

describe('buildSummary — board cards', () => {
  it('includes board cards on flop', () => {
    const view = makeView({
      phase: 'FLOP',
      boardCards: ['6d', 'Ad', 'Js'],
      yourCards: ['6c', '6h'],
      pot: 40,
      yourChips: 940,
      availableActions: [{ type: 'check' }],
    });
    const result = buildSummary(view);
    assert.ok(result.includes('Board: 6d Ad Js'), `should include board cards, got: ${result}`);
    assert.ok(result.includes('6c 6h'), 'should include hole cards');
    assert.ok(result.startsWith('FLOP |'), 'should start with phase');
  });

  it('includes board cards on turn', () => {
    const view = makeView({
      phase: 'TURN',
      boardCards: ['6d', 'Ad', 'Js', '3c'],
      yourCards: ['6c', '6h'],
      pot: 80,
      yourChips: 900,
      availableActions: [{ type: 'check' }, { type: 'raise', minAmount: 20, maxAmount: 900 }],
    });
    const result = buildSummary(view);
    assert.ok(result.includes('Board: 6d Ad Js 3c'), `should include 4 board cards, got: ${result}`);
  });

  it('includes board cards on river', () => {
    const view = makeView({
      phase: 'RIVER',
      boardCards: ['6d', 'Ad', 'Js', '3c', '9h'],
      yourCards: ['6c', '6h'],
      pot: 160,
      yourChips: 820,
      availableActions: [{ type: 'check' }],
    });
    const result = buildSummary(view);
    assert.ok(result.includes('Board: 6d Ad Js 3c 9h'), `should include 5 board cards, got: ${result}`);
  });

  it('omits board section preflop (no board cards)', () => {
    const view = makeView({
      phase: 'PREFLOP',
      boardCards: [],
      yourCards: ['As', 'Kh'],
      pot: 30,
      yourChips: 970,
      availableActions: [{ type: 'call', amount: 20 }, { type: 'fold' }],
    });
    const result = buildSummary(view);
    assert.ok(!result.includes('Board:'), `should not include Board: preflop, got: ${result}`);
    assert.ok(result.startsWith('PREFLOP | As Kh'), 'should go straight to hole cards');
  });

  it('omits board section when boardCards is undefined', () => {
    const view = makeView({
      phase: 'PREFLOP',
      yourCards: ['As', 'Kh'],
      pot: 30,
      yourChips: 970,
      availableActions: [{ type: 'fold' }],
    });
    delete view.boardCards;
    const result = buildSummary(view);
    assert.ok(!result.includes('Board:'), 'should not include Board: when undefined');
  });
});

// ─── readStrategyOverride ───────────────────────────────────────────

describe('readStrategyOverride', () => {
  it('returns empty string when file is missing', () => {
    const result = readStrategyOverride();
    assert.equal(result, '');
  });
});
