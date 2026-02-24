import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { diffStates } from '../state-differ.js';

/**
 * Factory to build a PlayerView with sensible defaults.
 * Pass overrides to customize specific fields.
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
      {
        seat: 2,
        name: 'Bob',
        chips: 1000,
        bet: 0,
        invested: 0,
        status: 'active',
        isDealer: false,
        isCurrentActor: false,
      },
    ],
    dealerSeat: 0,
    numSeats: 6,
    forcedBets: { smallBlind: 10, bigBlind: 20, ante: 0 },
    sidePots: [],
    currentPlayerToAct: 1,
    timeoutAt: null,
  };

  // Deep merge: handle nested players array and other objects
  const result = { ...base, ...overrides };

  // If players was overridden, use it directly (don't merge arrays)
  if (overrides.players !== undefined) {
    result.players = overrides.players;
  }

  return result;
}

/**
 * Helper to clone a view and apply overrides to a specific player by seat.
 */
function withPlayerUpdate(view, seat, playerOverrides) {
  const cloned = { ...view, players: view.players.map((p) => ({ ...p })) };
  const player = cloned.players.find((p) => p.seat === seat);
  if (player) {
    Object.assign(player, playerOverrides);
  }
  return cloned;
}

// ─── 1. New hand started ─────────────────────────────────────────────

describe('diffStates — new hand started', () => {
  it('returns hand start event when prev is null', () => {
    const next = makeView({ handNumber: 1, yourCards: ['As', 'Kh'] });
    const events = diffStates(null, next);
    assert.deepStrictEqual(events, ['Hand #1 — Your cards: A\u2660 K\u2665']);
  });

  it('returns hand start event when handNumber changed', () => {
    const prev = makeView({ handNumber: 1 });
    const next = makeView({ handNumber: 2, yourCards: ['Tc', '9d'] });
    const events = diffStates(prev, next);
    assert.deepStrictEqual(events, ['Hand #2 — Your cards: T\u2663 9\u2666']);
  });

  it('does not produce other events when hand just started', () => {
    const prev = makeView({ handNumber: 1, boardCards: [] });
    const next = makeView({
      handNumber: 2,
      boardCards: ['As', '7c', '2d'],
      yourCards: ['Qh', 'Js'],
    });
    // Only the hand-start event, nothing about the flop
    const events = diffStates(prev, next);
    assert.equal(events.length, 1);
    assert.match(events[0], /^Hand #2/);
  });
});

// ─── 2. Flop dealt ───────────────────────────────────────────────────

describe('diffStates — flop dealt', () => {
  it('reports flop with cards and pot', () => {
    const prev = makeView({ boardCards: [], pot: 30 });
    const next = makeView({
      boardCards: ['As', '7c', '2d'],
      pot: 42,
      phase: 'FLOP',
    });
    const events = diffStates(prev, next);
    assert.ok(events.includes('Flop: A\u2660 7\u2663 2\u2666 | Pot: 42'));
  });
});

// ─── 3. Turn dealt ───────────────────────────────────────────────────

describe('diffStates — turn dealt', () => {
  it('reports turn card and pot', () => {
    const prev = makeView({
      boardCards: ['As', '7c', '2d'],
      pot: 42,
      phase: 'FLOP',
    });
    const next = makeView({
      boardCards: ['As', '7c', '2d', 'Kh'],
      pot: 80,
      phase: 'TURN',
    });
    const events = diffStates(prev, next);
    assert.ok(events.includes('Turn: K\u2665 | Pot: 80'));
  });
});

// ─── 4. River dealt ──────────────────────────────────────────────────

describe('diffStates — river dealt', () => {
  it('reports river card and pot', () => {
    const prev = makeView({
      boardCards: ['As', '7c', '2d', 'Kh'],
      pot: 80,
      phase: 'TURN',
    });
    const next = makeView({
      boardCards: ['As', '7c', '2d', 'Kh', '3s'],
      pot: 120,
      phase: 'RIVER',
    });
    const events = diffStates(prev, next);
    assert.ok(events.includes('River: 3\u2660 | Pot: 120'));
  });
});

// ─── 5. Opponent folded ──────────────────────────────────────────────

describe('diffStates — opponent folded', () => {
  it('reports when an opponent folds', () => {
    const prev = makeView();
    const next = withPlayerUpdate({ ...makeView() }, 1, {
      status: 'folded',
      isCurrentActor: false,
    });
    const events = diffStates(prev, next);
    assert.ok(events.includes('Alice folded'));
  });

  it('does NOT report when our own seat folds', () => {
    const prev = makeView();
    const next = withPlayerUpdate({ ...makeView() }, 0, { status: 'folded' });
    const events = diffStates(prev, next);
    assert.ok(!events.some((e) => e.includes('Hero folded')));
  });
});

// ─── 6. Opponent bet ─────────────────────────────────────────────────

describe('diffStates — opponent bet', () => {
  it('reports when opponent makes first bet (no prior bets)', () => {
    const prev = makeView({
      phase: 'FLOP',
      players: [
        {
          seat: 0,
          name: 'Hero',
          chips: 970,
          bet: 0,
          invested: 20,
          status: 'active',
          isDealer: true,
          isCurrentActor: false,
        },
        {
          seat: 1,
          name: 'Alice',
          chips: 980,
          bet: 0,
          invested: 20,
          status: 'active',
          isDealer: false,
          isCurrentActor: true,
        },
        {
          seat: 2,
          name: 'Bob',
          chips: 1000,
          bet: 0,
          invested: 0,
          status: 'active',
          isDealer: false,
          isCurrentActor: false,
        },
      ],
    });
    const next = {
      ...prev,
      pot: 65,
      players: prev.players.map((p) => ({ ...p })),
    };
    next.players[1] = {
      ...next.players[1],
      chips: 955,
      bet: 25,
      isCurrentActor: false,
    };
    next.currentPlayerToAct = 2;
    const events = diffStates(prev, next);
    assert.ok(events.includes('Alice bet 25'));
  });
});

// ─── 7. Opponent raised ──────────────────────────────────────────────

describe('diffStates — opponent raised', () => {
  it('reports when opponent raises above existing bet', () => {
    // Preflop: Hero SB 10, Alice BB 20, Bob has bet 0
    // Bob raises to 50
    const prev = makeView(); // Alice bet=20 is highest
    const next = {
      ...makeView(),
      pot: 80,
      players: makeView().players.map((p) => ({ ...p })),
    };
    next.players[2] = {
      ...next.players[2],
      name: 'Bob',
      chips: 950,
      bet: 50,
      isCurrentActor: false,
    };
    next.currentPlayerToAct = 0;
    const events = diffStates(prev, next);
    assert.ok(events.includes('Bob raised to 50'));
  });
});

// ─── 8. Opponent called ──────────────────────────────────────────────

describe('diffStates — opponent called', () => {
  it('reports when opponent calls existing bet', () => {
    // Alice has bet 20 (BB). Bob calls 20.
    const prev = makeView(); // Bob bet=0, Alice bet=20
    const next = {
      ...makeView(),
      pot: 50,
      players: makeView().players.map((p) => ({ ...p })),
    };
    next.players[2] = {
      ...next.players[2],
      name: 'Bob',
      chips: 980,
      bet: 20,
      isCurrentActor: false,
    };
    next.currentPlayerToAct = 0;
    const events = diffStates(prev, next);
    assert.ok(events.includes('Bob called 20'));
  });
});

// ─── 9. Opponent checked ─────────────────────────────────────────────

describe('diffStates — opponent checked', () => {
  it('reports when opponent checks (was actor, bet unchanged, still active)', () => {
    const prev = makeView({
      phase: 'FLOP',
      players: [
        {
          seat: 0,
          name: 'Hero',
          chips: 970,
          bet: 0,
          invested: 20,
          status: 'active',
          isDealer: true,
          isCurrentActor: false,
        },
        {
          seat: 1,
          name: 'Alice',
          chips: 980,
          bet: 0,
          invested: 20,
          status: 'active',
          isDealer: false,
          isCurrentActor: true,
        },
        {
          seat: 2,
          name: 'Bob',
          chips: 1000,
          bet: 0,
          invested: 0,
          status: 'active',
          isDealer: false,
          isCurrentActor: false,
        },
      ],
    });
    const next = {
      ...prev,
      players: prev.players.map((p) => ({ ...p })),
    };
    next.players[1] = {
      ...next.players[1],
      isCurrentActor: false,
    };
    next.currentPlayerToAct = 2;
    const events = diffStates(prev, next);
    assert.ok(events.includes('Alice checked'));
  });

  it('does NOT report check for our own seat', () => {
    const prev = makeView({
      phase: 'FLOP',
      players: [
        {
          seat: 0,
          name: 'Hero',
          chips: 970,
          bet: 0,
          invested: 20,
          status: 'active',
          isDealer: true,
          isCurrentActor: true,
        },
        {
          seat: 1,
          name: 'Alice',
          chips: 980,
          bet: 0,
          invested: 20,
          status: 'active',
          isDealer: false,
          isCurrentActor: false,
        },
      ],
    });
    const next = {
      ...prev,
      players: prev.players.map((p) => ({ ...p })),
    };
    next.players[0] = { ...next.players[0], isCurrentActor: false };
    next.currentPlayerToAct = 1;
    const events = diffStates(prev, next);
    assert.ok(!events.some((e) => e.includes('Hero checked')));
  });
});

// ─── 10. Opponent went all-in ────────────────────────────────────────

describe('diffStates — opponent went all-in', () => {
  it('reports when opponent goes all-in with bet amount', () => {
    const prev = makeView();
    const next = {
      ...makeView(),
      pot: 1010,
      players: makeView().players.map((p) => ({ ...p })),
    };
    next.players[1] = {
      ...next.players[1],
      chips: 0,
      bet: 1000,
      status: 'all_in',
      isCurrentActor: false,
    };
    const events = diffStates(prev, next);
    assert.ok(events.includes('Alice went all-in (1000)'));
  });

  it('does NOT report all-in for our own seat', () => {
    const prev = makeView();
    const next = {
      ...makeView(),
      players: makeView().players.map((p) => ({ ...p })),
    };
    next.players[0] = {
      ...next.players[0],
      chips: 0,
      bet: 970,
      status: 'all_in',
    };
    const events = diffStates(prev, next);
    assert.ok(!events.some((e) => e.includes('Hero went all-in')));
  });
});

// ─── 11. No changes ──────────────────────────────────────────────────

describe('diffStates — no changes', () => {
  it('returns empty array for identical states', () => {
    const view = makeView();
    const events = diffStates(view, view);
    assert.deepStrictEqual(events, []);
  });

  it('returns empty array when states are structurally identical copies', () => {
    const prev = makeView();
    const next = makeView();
    const events = diffStates(prev, next);
    assert.deepStrictEqual(events, []);
  });
});

// ─── Edge cases ──────────────────────────────────────────────────────

describe('diffStates — edge cases', () => {
  it('handles multiple events in one diff (e.g. fold + board card)', () => {
    const prev = makeView({
      boardCards: [],
      pot: 40,
      players: [
        {
          seat: 0,
          name: 'Hero',
          chips: 970,
          bet: 20,
          invested: 20,
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
          isCurrentActor: false,
        },
        {
          seat: 2,
          name: 'Bob',
          chips: 980,
          bet: 20,
          invested: 20,
          status: 'active',
          isDealer: false,
          isCurrentActor: false,
        },
      ],
    });
    const next = {
      ...prev,
      boardCards: ['As', '7c', '2d'],
      phase: 'FLOP',
      pot: 60,
      players: prev.players.map((p) => ({ ...p })),
    };
    // Bob folded between prev and next
    next.players[2] = { ...next.players[2], status: 'folded' };
    const events = diffStates(prev, next);
    assert.ok(events.includes('Bob folded'));
    assert.ok(events.includes('Flop: A\u2660 7\u2663 2\u2666 | Pot: 60'));
  });

  it('handles prev with undefined prev (first state)', () => {
    const next = makeView({ handNumber: 1, yourCards: ['Ac', 'Kc'] });
    const events = diffStates(undefined, next);
    assert.deepStrictEqual(events, ['Hand #1 — Your cards: A\u2663 K\u2663']);
  });

  it('returns empty array when prev is null and yourCards is empty (WAITING phase reconnect)', () => {
    const next = makeView({ handNumber: 1, yourCards: [], phase: 'WAITING' });
    const events = diffStates(null, next);
    assert.deepStrictEqual(events, []);
  });

  it('returns empty array when prev is null and yourCards is undefined', () => {
    const next = makeView({ handNumber: 1, phase: 'WAITING' });
    delete next.yourCards;
    const events = diffStates(null, next);
    assert.deepStrictEqual(events, []);
  });

  it('all-in takes priority over bet/raise/call reporting', () => {
    // If status changed to all_in AND bet changed, report all-in not bet
    const prev = makeView();
    const next = {
      ...makeView(),
      players: makeView().players.map((p) => ({ ...p })),
    };
    next.players[2] = {
      ...next.players[2],
      name: 'Bob',
      chips: 0,
      bet: 1000,
      status: 'all_in',
      isCurrentActor: false,
    };
    const events = diffStates(prev, next);
    // Should have all-in but NOT also bet/raise
    const allInEvents = events.filter((e) => e.includes('all-in'));
    const betEvents = events.filter(
      (e) => e.includes('bet') || e.includes('raised') || e.includes('called'),
    );
    assert.equal(allInEvents.length, 1);
    assert.equal(betEvents.length, 0);
  });
});
