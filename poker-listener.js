import { diffStates } from './state-differ.js';

// Phases where the hand is actively in progress (cards being dealt / bets being made)
const ACTIVE_PHASES = new Set(['PREFLOP', 'FLOP', 'TURN', 'RIVER']);

/**
 * Process a state SSE event (PlayerView).
 *
 * Diffs the incoming view against context.prevState, appends events to the
 * buffer, then checks whether the agent needs to act. If so, returns a
 * result object and flushes the buffer. Otherwise returns null.
 *
 * @param {object} view       - The latest PlayerView from the SSE stream
 * @param {object} context    - Mutable context:
 *   { prevState: object|null, prevPhase: string|null, eventBuffer: string[] }
 * @returns {object|null}     - Action descriptor or null
 */
export function processStateEvent(view, context) {
  // Diff against previous state and append new events to the buffer
  const newEvents = diffStates(context.prevState, view);
  context.eventBuffer.push(...newEvents);

  // Capture previous phase before updating
  const prevPhase = context.prevPhase;

  // Update context for next call
  context.prevState = view;
  context.prevPhase = view.phase;

  // ── Check whether the agent needs to act ──

  // 1. YOUR_TURN — agent must decide an action
  if (view.isYourTurn) {
    return flushAndReturn(context, { type: 'YOUR_TURN', state: view });
  }

  // 2. Hand ended — phase moved from active to SHOWDOWN or WAITING
  const handJustEnded =
    ACTIVE_PHASES.has(prevPhase) &&
    (view.phase === 'SHOWDOWN' || view.phase === 'WAITING');

  if (handJustEnded) {
    // 3. REBUY_AVAILABLE takes priority over HAND_RESULT when busted
    if (view.yourChips === 0 && view.canRebuy) {
      return flushAndReturn(context, { type: 'REBUY_AVAILABLE', state: view });
    }
    return flushAndReturn(context, { type: 'HAND_RESULT', state: view });
  }

  // Nothing actionable yet — keep buffering
  return null;
}

/**
 * Process a closed SSE event (table closed by the server).
 *
 * @returns {{ type: 'TABLE_CLOSED' }}
 */
export function processClosedEvent() {
  return { type: 'TABLE_CLOSED' };
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Flush the event buffer into a result object and clear it.
 */
function flushAndReturn(context, result) {
  result.events = [...context.eventBuffer];
  context.eventBuffer.length = 0;
  return result;
}

// ── Main SSE connection (only when executed directly) ────────────────

async function main() {
  const [, , backendUrl, token, gameId] = process.argv;

  if (!backendUrl || !token || !gameId) {
    const msg = JSON.stringify({
      type: 'CONNECTION_ERROR',
      error: 'Usage: node poker-listener.js <backendUrl> <token> <gameId>',
    });
    process.stdout.write(msg + '\n');
    process.exit(1);
  }

  const sseUrl = `${backendUrl}/api/game/${gameId}/stream?token=${token}`;

  let EventSourceClass;
  try {
    const mod = await import('eventsource');
    EventSourceClass = mod.default || mod.EventSource;
  } catch {
    const msg = JSON.stringify({
      type: 'CONNECTION_ERROR',
      error: 'eventsource package not available',
    });
    process.stdout.write(msg + '\n');
    process.exit(1);
  }

  const context = { prevState: null, prevPhase: null, eventBuffer: [] };
  const es = new EventSourceClass(sseUrl);

  es.addEventListener('state', (event) => {
    try {
      const view = JSON.parse(event.data);
      const result = processStateEvent(view, context);
      if (result) {
        process.stdout.write(JSON.stringify(result) + '\n');
        es.close();
        process.exit(0);
      }
    } catch (err) {
      const msg = JSON.stringify({
        type: 'CONNECTION_ERROR',
        error: `Failed to process state event: ${err.message}`,
      });
      process.stdout.write(msg + '\n');
      es.close();
      process.exit(1);
    }
  });

  es.addEventListener('closed', () => {
    const result = processClosedEvent();
    process.stdout.write(JSON.stringify(result) + '\n');
    es.close();
    process.exit(0);
  });

  es.onerror = (err) => {
    const msg = JSON.stringify({
      type: 'CONNECTION_ERROR',
      error: `SSE connection error: ${err.message || 'unknown'}`,
    });
    process.stdout.write(msg + '\n');
    es.close();
    process.exit(1);
  };
}

// Only run main() when the script is executed directly (not imported for tests)
const isDirectRun =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/.*\//, ''));
if (isDirectRun && process.argv.length > 3) {
  main();
}
