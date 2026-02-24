import { diffStates } from './state-differ.js';

const ACTIVE_PHASES = new Set(['PREFLOP', 'FLOP', 'TURN', 'RIVER']);

/**
 * Process a state SSE event (PlayerView).
 *
 * Diffs the incoming view against context.prevState, returns an array of
 * output objects — one per diff event (type: EVENT) plus an optional
 * action object (YOUR_TURN, HAND_RESULT, etc.).
 *
 * @param {object} view       - The latest PlayerView from the SSE stream
 * @param {object} context    - Mutable context:
 *   { prevState: object|null, prevPhase: string|null }
 * @returns {object[]}        - Array of output objects to write to stdout
 */
export function processStateEvent(view, context) {
  const outputs = [];

  // Diff against previous state — each diff becomes an EVENT line
  const newEvents = diffStates(context.prevState, view);
  for (const message of newEvents) {
    outputs.push({ type: 'EVENT', message });
  }

  // Capture previous phase before updating
  const prevPhase = context.prevPhase;

  // Update context for next call
  context.prevState = view;
  context.prevPhase = view.phase;

  // Reset dedup tracker on phase change (new phase = new actionable state)
  if (view.phase !== prevPhase) {
    context.lastActionType = null;
  }

  // ── Check whether the agent needs to act ──

  // 1. YOUR_TURN — agent must decide an action (always emit, never dedup)
  if (view.isYourTurn) {
    outputs.push({ type: 'YOUR_TURN', state: view });
    context.lastActionType = 'YOUR_TURN';
    return outputs;
  }

  // 2. Hand ended — phase moved from active to SHOWDOWN or WAITING
  const handJustEnded =
    ACTIVE_PHASES.has(prevPhase) &&
    (view.phase === 'SHOWDOWN' || view.phase === 'WAITING');

  if (handJustEnded) {
    if (view.yourChips === 0 && view.canRebuy) {
      outputs.push({ type: 'REBUY_AVAILABLE', state: view });
      context.lastActionType = 'REBUY_AVAILABLE';
    } else {
      outputs.push({ type: 'HAND_RESULT', state: view });
      context.lastActionType = 'HAND_RESULT';
    }
    return outputs;
  }

  // 3. WAITING_FOR_PLAYERS — alone at table, no hand can start
  if (view.phase === 'WAITING' && view.players && view.players.length < 2) {
    if (context.lastActionType !== 'WAITING_FOR_PLAYERS') {
      outputs.push({ type: 'WAITING_FOR_PLAYERS', state: view });
      context.lastActionType = 'WAITING_FOR_PLAYERS';
    }
    return outputs;
  }

  return outputs;
}

/**
 * Process a closed SSE event (table closed by the server).
 *
 * @returns {object[]} - Array with single TABLE_CLOSED object
 */
export function processClosedEvent() {
  return [{ type: 'TABLE_CLOSED' }];
}

// ── Main SSE connection (only when executed directly) ────────────────

async function main() {
  const [, , backendUrl, token, gameId] = process.argv;

  if (!backendUrl || !token || !gameId) {
    emit({ type: 'CONNECTION_ERROR', error: 'Usage: node poker-listener.js <backendUrl> <token> <gameId>' });
    process.exit(1);
  }

  const sseUrl = `${backendUrl}/api/game/${gameId}/stream?token=${token}`;

  let EventSourceClass;
  try {
    const mod = await import('eventsource');
    EventSourceClass = mod.default || mod.EventSource;
  } catch {
    emit({ type: 'CONNECTION_ERROR', error: 'eventsource package not available' });
    process.exit(1);
  }

  const context = { prevState: null, prevPhase: null, lastActionType: null };
  const es = new EventSourceClass(sseUrl);

  es.addEventListener('state', (event) => {
    try {
      const view = JSON.parse(event.data);
      const outputs = processStateEvent(view, context);
      for (const output of outputs) {
        emit(output);
      }
    } catch (err) {
      emit({ type: 'CONNECTION_ERROR', error: `Failed to process state event: ${err.message}` });
      es.close();
      process.exit(1);
    }
  });

  es.addEventListener('closed', () => {
    const outputs = processClosedEvent();
    for (const output of outputs) {
      emit(output);
    }
    es.close();
    process.exit(0);
  });

  es.onerror = (err) => {
    // Emit error but do NOT close/exit — let eventsource auto-reconnect.
    // The consumer tracks consecutive errors and decides when to give up.
    emit({ type: 'CONNECTION_ERROR', error: `SSE connection error: ${err.message || 'unknown'}` });
  };
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// Only run main() when the script is executed directly (not imported for tests)
const isDirectRun =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/.*\//, ''));
if (isDirectRun && process.argv.length > 3) {
  main();
}
