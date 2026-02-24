import { formatCard, formatCards } from './card-format.js';

/**
 * Compare two successive PlayerView states and return an array of
 * human-readable event strings describing what changed.
 *
 * @param {object|null|undefined} prev - Previous PlayerView (null/undefined for first state)
 * @param {object} next - Current PlayerView
 * @returns {string[]} Array of event description strings
 */
export function diffStates(prev, next) {
  const events = [];

  // ── 1. New hand (prev is null/undefined, or handNumber changed) ──
  if (!prev || prev.handNumber !== next.handNumber) {
    const cards = formatCards(next.yourCards);
    events.push(`Hand #${next.handNumber} — Your cards: ${cards}`);
    // Don't diff further on new hand — everything is new
    return events;
  }

  // ── Player action diffs (opponents only) ──
  const prevPlayerMap = new Map(prev.players.map((p) => [p.seat, p]));

  for (const nextPlayer of next.players) {
    // Skip our own seat
    if (nextPlayer.seat === next.yourSeat) continue;

    const prevPlayer = prevPlayerMap.get(nextPlayer.seat);
    if (!prevPlayer) continue;

    // 10. All-in (status changed to all_in) — takes priority over bet/raise/call
    if (prevPlayer.status !== 'all_in' && nextPlayer.status === 'all_in') {
      events.push(`${nextPlayer.name} went all-in (${nextPlayer.bet})`);
      continue;
    }

    // 5. Folded (status changed to folded)
    if (prevPlayer.status !== 'folded' && nextPlayer.status === 'folded') {
      events.push(`${nextPlayer.name} folded`);
      continue;
    }

    // Bet changed — classify as bet, raise, or call
    if (nextPlayer.bet > prevPlayer.bet) {
      const betAmount = nextPlayer.bet;

      // Find the highest bet among all players in the PREVIOUS state
      const prevMaxBet = Math.max(...prev.players.map((p) => p.bet));

      if (prevMaxBet === 0 || prevPlayer.bet === prevMaxBet) {
        // No prior bet existed, or this player was already at max — it's a new bet
        // But if others had a bet and this player raised above it, it's a raise
        if (prevMaxBet > 0 && betAmount > prevMaxBet) {
          events.push(`${nextPlayer.name} raised to ${betAmount}`);
        } else if (prevMaxBet === 0) {
          events.push(`${nextPlayer.name} bet ${betAmount}`);
        } else {
          // Was at max and stayed at max — this is a call (shouldn't normally happen)
          events.push(`${nextPlayer.name} called ${betAmount}`);
        }
      } else if (betAmount > prevMaxBet) {
        // Raised above the previous max
        events.push(`${nextPlayer.name} raised to ${betAmount}`);
      } else {
        // Matched the existing bet — call
        events.push(`${nextPlayer.name} called ${betAmount}`);
      }
      continue;
    }

    // 9. Checked (was current actor, no longer is, bet unchanged, still active)
    if (
      prevPlayer.isCurrentActor &&
      !nextPlayer.isCurrentActor &&
      nextPlayer.bet === prevPlayer.bet &&
      nextPlayer.status === 'active'
    ) {
      events.push(`${nextPlayer.name} checked`);
      continue;
    }
  }

  // ── Board card diffs ──
  const prevBoardLen = prev.boardCards.length;
  const nextBoardLen = next.boardCards.length;

  // 2. Flop dealt (0 -> 3)
  if (prevBoardLen === 0 && nextBoardLen >= 3) {
    const flopCards = formatCards(next.boardCards.slice(0, 3));
    events.push(`Flop: ${flopCards} | Pot: ${next.pot}`);
  }

  // 3. Turn dealt (3 -> 4)
  if (prevBoardLen <= 3 && nextBoardLen >= 4 && prevBoardLen < nextBoardLen) {
    // Only report if we hadn't already reported it as part of flop
    if (prevBoardLen === 3) {
      const turnCard = formatCard(next.boardCards[3]);
      events.push(`Turn: ${turnCard} | Pot: ${next.pot}`);
    }
  }

  // 4. River dealt (4 -> 5)
  if (prevBoardLen <= 4 && nextBoardLen >= 5 && prevBoardLen < nextBoardLen) {
    if (prevBoardLen === 4) {
      const riverCard = formatCard(next.boardCards[4]);
      events.push(`River: ${riverCard} | Pot: ${next.pot}`);
    }
  }

  return events;
}
