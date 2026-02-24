import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { processStateEvent, processClosedEvent } from '../poker-listener.js';

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
    eventBuffer: [],
    ...overrides,
  };
}

// ─── 1. Buffers events and returns null when not your turn ──────────

describe('processStateEvent — buffering', () => {
  it('buffers events and returns null when not your turn', () => {
    const ctx = makeContext();
    const view = makeView({ isYourTurn: false });

    const result = processStateEvent(view, ctx);

    assert.equal(result, null);
    // Events from diffStates should be in the buffer (new hand event)
    assert.ok(ctx.eventBuffer.length > 0);
    // prevState should be updated
    assert.equal(ctx.prevState, view);
  });
});

// ─── 2. Returns YOUR_TURN when isYourTurn is true ───────────────────

describe('processStateEvent — YOUR_TURN', () => {
  it('returns YOUR_TURN with events and state when isYourTurn is true', () => {
    const ctx = makeContext();

    // First call: buffer some events (not our turn yet)
    const view1 = makeView({ isYourTurn: false });
    processStateEvent(view1, ctx);

    // Second call: now it is our turn
    const view2 = makeView({
      isYourTurn: true,
      phase: 'PREFLOP',
      availableActions: [{ type: 'CALL', amount: 20 }],
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
    const result = processStateEvent(view2, ctx);

    assert.notEqual(result, null);
    assert.equal(result.type, 'YOUR_TURN');
    assert.ok(Array.isArray(result.events));
    assert.ok(result.events.length > 0);
    assert.equal(result.state, view2);
  });
});

// ─── 3. Returns HAND_RESULT for active -> SHOWDOWN ──────────────────

describe('processStateEvent — HAND_RESULT (SHOWDOWN)', () => {
  it('returns HAND_RESULT when phase transitions from active to SHOWDOWN', () => {
    // Set up context with a previous active phase
    const prevView = makeView({ phase: 'RIVER' });
    const ctx = makeContext({ prevState: prevView, prevPhase: 'RIVER' });

    const nextView = makeView({
      phase: 'SHOWDOWN',
      isYourTurn: false,
      boardCards: ['As', '7c', '2d', 'Kh', '3s'],
    });

    const result = processStateEvent(nextView, ctx);

    assert.notEqual(result, null);
    assert.equal(result.type, 'HAND_RESULT');
    assert.ok(Array.isArray(result.events));
    assert.equal(result.state, nextView);
  });
});

// ─── 4. Returns HAND_RESULT for active -> WAITING ───────────────────

describe('processStateEvent — HAND_RESULT (WAITING)', () => {
  it('returns HAND_RESULT when phase transitions from active to WAITING', () => {
    const prevView = makeView({ phase: 'FLOP' });
    const ctx = makeContext({ prevState: prevView, prevPhase: 'FLOP' });

    const nextView = makeView({
      phase: 'WAITING',
      isYourTurn: false,
      boardCards: ['As', '7c', '2d'],
    });

    const result = processStateEvent(nextView, ctx);

    assert.notEqual(result, null);
    assert.equal(result.type, 'HAND_RESULT');
  });
});

// ─── 5. Does NOT return HAND_RESULT for WAITING -> WAITING ──────────

describe('processStateEvent — no false HAND_RESULT', () => {
  it('does NOT return HAND_RESULT when phase is WAITING and was already WAITING', () => {
    const prevView = makeView({ phase: 'WAITING' });
    const ctx = makeContext({ prevState: prevView, prevPhase: 'WAITING' });

    const nextView = makeView({
      phase: 'WAITING',
      isYourTurn: false,
    });

    const result = processStateEvent(nextView, ctx);

    assert.equal(result, null);
  });
});

// ─── 6. Returns REBUY_AVAILABLE ─────────────────────────────────────

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

    const result = processStateEvent(nextView, ctx);

    assert.notEqual(result, null);
    assert.equal(result.type, 'REBUY_AVAILABLE');
    assert.ok(Array.isArray(result.events));
    assert.equal(result.state, nextView);
  });
});

// ─── 7. Flushes event buffer on return ──────────────────────────────

describe('processStateEvent — buffer flushing', () => {
  it('flushes event buffer on return, subsequent call starts empty', () => {
    const ctx = makeContext();

    // First call buffers events (new hand)
    const view1 = makeView({ isYourTurn: false });
    processStateEvent(view1, ctx);
    assert.ok(ctx.eventBuffer.length > 0, 'buffer should have events after first call');

    // Second call triggers YOUR_TURN — buffer should be returned and flushed
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
    const result = processStateEvent(view2, ctx);
    assert.notEqual(result, null);
    assert.ok(result.events.length > 0, 'result should include buffered events');

    // Buffer should now be empty
    assert.equal(ctx.eventBuffer.length, 0, 'buffer should be empty after flush');

    // Third call: buffer starts fresh
    const view3 = makeView({ isYourTurn: false, handNumber: 2, yourCards: ['Tc', '9d'] });
    processStateEvent(view3, ctx);
    // Events should only be from view3, not from previous calls
    assert.ok(ctx.eventBuffer.length > 0, 'new events should be buffered');
    assert.ok(
      ctx.eventBuffer.every((e) => !e.includes('A♠ K♥')),
      'buffer should not contain events from previous hand',
    );
  });
});

// ─── 8. Returns WAITING_FOR_PLAYERS when alone at table ─────────────

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

    const result = processStateEvent(view, ctx);

    assert.notEqual(result, null);
    assert.equal(result.type, 'WAITING_FOR_PLAYERS');
    assert.ok(Array.isArray(result.events));
    assert.equal(result.state, view);
  });

  it('does NOT return WAITING_FOR_PLAYERS when WAITING with 2 players (one busted)', () => {
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

    const result = processStateEvent(view, ctx);

    // Should return null (buffering) — opponent can still rebuy
    assert.equal(result, null);
  });
});

// ─── 9. processClosedEvent returns TABLE_CLOSED ─────────────────────

describe('processClosedEvent', () => {
  it('returns TABLE_CLOSED', () => {
    const result = processClosedEvent();
    assert.deepStrictEqual(result, { type: 'TABLE_CLOSED' });
  });
});
