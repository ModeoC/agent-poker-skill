import { execFile, exec } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffStates } from './state-differ.js';

const ACTIVE_PHASES = new Set(['PREFLOP', 'FLOP', 'TURN', 'RIVER']);

export function buildSummary(view) {
  const cards = view.yourCards?.join(' ') || '??';
  const board = view.boardCards?.length ? view.boardCards.join(' ') : '';
  const phase = view.phase;
  const pot = view.pot;
  const stack = view.yourChips;
  const active = view.players?.filter(p => p.status === 'active').length || 0;
  const actions = (view.availableActions || []).map(a => {
    if (a.type === 'fold' || a.type === 'check' || a.type === 'call') return a.amount ? `${a.type} ${a.amount}` : a.type;
    if (a.minAmount != null) return `${a.type} ${a.minAmount}-${a.maxAmount}`;
    return a.type;
  }).join(', ');
  return board
    ? `${phase} | Board: ${board} | ${cards} | Pot:${pot} | Stack:${stack} | ${active} active | Actions: ${actions}`
    : `${phase} | ${cards} | Pot:${pot} | Stack:${stack} | ${active} active | Actions: ${actions}`;
}

export function buildHandResultSummary(state, handNumber) {
  const result = state.lastHandResult;
  const hdr = handNumber ? `**[Hand #${handNumber}]**` : '';
  if (!result) return null;
  const winners = result.players
    ?.filter(p => result.winners?.includes(p.seat))
    .map(p => p.name) || [];
  const pot = result.potResults?.[0]?.amount || 0;
  const myStack = result.players?.find(p => p.name)?.chips || state.yourChips;
  return `${hdr} ${winners.join(', ')} won ${pot}. Stack: ${myStack}.`;
}

export function processStateEvent(view, context) {
  const outputs = [];

  // ── Detect fast hand transition (hand N → N+1 without SHOWDOWN) ──
  const handChanged = context.prevState != null
    && context.prevState.handNumber !== view.handNumber;

  if (handChanged) {
    const prevHandNum = context.prevState.handNumber;
    if (prevHandNum > (context.lastReportedHand || 0)) {
      // ── Detect folds from atomic hand transition ──
      // If prevPhase was active (not SHOWDOWN/WAITING), the hand ended
      // without reaching showdown — meaning opponents folded.
      const prevPhase = context.prevState.phase;
      if (ACTIVE_PHASES.has(prevPhase)) {
        const prevHdr = `**[Hand #${prevHandNum}]**`;
        const winners = new Set(view.lastHandResult?.winners || []);
        for (const p of context.prevState.players || []) {
          if (p.seat === context.prevState.yourSeat) continue;
          if (p.status === 'active' && !winners.has(p.seat)) {
            outputs.push({ type: 'EVENT', message: `${prevHdr} ${p.name} folded`, handNumber: prevHandNum });
          }
        }
      }

      outputs.push({ type: 'HAND_RESULT', state: view, handNumber: prevHandNum });
      context.lastReportedHand = prevHandNum;
    }
  }

  const newEvents = diffStates(context.prevState, view);
  for (const message of newEvents) {
    outputs.push({ type: 'EVENT', message, handNumber: view.handNumber });
  }

  const prevPhase = context.prevPhase;

  context.prevState = view;
  context.prevPhase = view.phase;

  if (view.phase !== prevPhase) {
    context.lastActionType = null;
    context.lastTurnKey = null;
  }

  if (view.isYourTurn) {
    const turnKey = `${view.handNumber}:${view.phase}`;
    if (turnKey !== context.lastTurnKey) {
      context.lastTurnKey = turnKey;
      outputs.push({ type: 'YOUR_TURN', state: view, summary: buildSummary(view) });
      context.lastActionType = 'YOUR_TURN';
    }
    return outputs;
  }

  // Reset turnKey when it's not our turn, so re-entry in the same phase
  // (e.g., check → opponent bets → back to us) triggers a fresh decision.
  context.lastTurnKey = null;

  // Phase-based hand end — only if hand did NOT change (avoid double)
  if (!handChanged) {
    const handJustEnded =
      ACTIVE_PHASES.has(prevPhase) &&
      (view.phase === 'SHOWDOWN' || view.phase === 'WAITING');

    if (handJustEnded) {
      const handNum = view.handNumber;
      if (handNum > (context.lastReportedHand || 0)) {
        if (view.yourChips === 0 && view.canRebuy) {
          outputs.push({ type: 'REBUY_AVAILABLE', state: view, handNumber: handNum });
          context.lastActionType = 'REBUY_AVAILABLE';
        } else {
          outputs.push({ type: 'HAND_RESULT', state: view, handNumber: handNum });
          context.lastActionType = 'HAND_RESULT';
        }
        context.lastReportedHand = handNum;
      }
      return outputs;
    }
  }

  if (view.phase === 'WAITING' && view.players && view.players.length < 2) {
    if (context.lastActionType !== 'WAITING_FOR_PLAYERS') {
      outputs.push({ type: 'WAITING_FOR_PLAYERS', state: view });
      context.lastActionType = 'WAITING_FOR_PLAYERS';
    }
    return outputs;
  }

  return outputs;
}

export function processClosedEvent() {
  return [{ type: 'TABLE_CLOSED' }];
}

// ── Direct delivery args ─────────────────────────────────────────────

const CHANNEL_ALIASES = new Set(['--channel']);
const CHAT_ID_ALIASES = new Set(['--chat-id', '--target', '--to']);

export function parseDirectArgs(argv) {
  let channel = null;
  let chatId = null;

  for (let i = 0; i < argv.length; i++) {
    if (CHANNEL_ALIASES.has(argv[i]) && argv[i + 1]) channel = argv[i + 1];
    if (CHAT_ID_ALIASES.has(argv[i]) && argv[i + 1]) chatId = argv[i + 1];
  }

  const enabled = !!(channel && chatId);
  return { enabled, channel, chatId };
}

// ── Event batcher ────────────────────────────────────────────────────

export function createEventBatcher(channel, chatId, sendFn) {
  let buffer = [];
  let timer = null;

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (buffer.length === 0) return;
    const text = buffer.join('\n');
    buffer = [];
    sendFn(channel, chatId, text);
  }

  function push(message) {
    buffer.push(message);
    if (!timer) {
      timer = setTimeout(flush, 2000);
    }
  }

  return { push, flush };
}

// ── CLI send helpers ─────────────────────────────────────────────────

let currentHandNumber = null;
let currentPhase = null;
let lastSend = Promise.resolve();
let warmupDone = Promise.resolve();
let decisionSeq = 0;
let lastDecision = Promise.resolve();
let decisionPending = false;
let eventBuffer = [];
let gameStartedEmitted = false;
let recentEvents = [];
let lastDecisionInfo = null;
let foldedInHand = null;

function doSend(channel, chatId, text) {
  return new Promise(resolve => {
    exec(
      `openclaw message send --channel ${channel} --target ${chatId} --message "$POKER_MSG" --json`,
      { env: { ...process.env, POKER_MSG: text }, timeout: 10000 },
      (err) => {
        if (err) emit({ type: 'SEND_ERROR', error: err.message });
        resolve();
      }
    );
  });
}

function flushEventBuffer() {
  for (const evt of eventBuffer) {
    lastSend = lastSend.then(() => doSend(evt.channel, evt.chatId, evt.text));
  }
  eventBuffer = [];
}

export function sendMessage(channel, chatId, text) {
  if (decisionPending) {
    eventBuffer.push({ channel, chatId, text });
    return;
  }
  lastSend = lastSend.then(() => doSend(channel, chatId, text));
}

export function sendDecision(channel, chatId, tableId, prompt, backendUrl, apiKey) {
  const mySeq = ++decisionSeq;
  const myHandNumber = currentHandNumber;
  decisionPending = true;

  lastDecision = lastDecision.then(() => warmupDone).then(() => {
    if (mySeq !== decisionSeq) {
      emit({ type: 'DECISION_STALE', skipped: mySeq, current: decisionSeq });
      return;
    }

    return new Promise(resolve => {
      execFile('openclaw', [
        'agent', '--local',
        '--session-id', `poker-${tableId}`,
        '--message', prompt,
        '--thinking', 'low',
        '--timeout', '45',
        '--json',
      ], { timeout: 55000 }, (err, stdout) => {
        if (mySeq !== decisionSeq) {
          emit({ type: 'DECISION_STALE', skipped: mySeq, current: decisionSeq });
          lastSend = lastSend.then(() => doSend(channel, chatId, 'Took too long \u2014 timed out on that hand.'));
          decisionPending = false;
          flushEventBuffer();
          resolve();
          return;
        }

        if (err) {
          lastSend = lastSend.then(() => doSend(channel, chatId, 'Timed out deciding \u2014 auto-folded.'));
          decisionPending = false;
          flushEventBuffer();
          resolve();
          return;
        }

        let decision;
        try {
          // Strip model warning lines (e.g. "web_search:") before JSON
          stdout = stdout.replace(/^[^\n{]*\n/, '');
          // Extract agent response text from --json envelope
          const jsonStart = stdout.indexOf('{');
          const jsonEnd = stdout.lastIndexOf('}');
          const json = jsonStart >= 0 && jsonEnd > jsonStart
            ? stdout.slice(jsonStart, jsonEnd + 1)
            : stdout;
          const result = JSON.parse(json);
          const payloads = result?.payloads || result?.result?.payloads || [];
          const agentText = payloads.findLast(p => p.text)?.text || '';

          // Parse the agent's structured decision from the text
          const decStart = agentText.indexOf('{');
          const decEnd = agentText.lastIndexOf('}');
          if (decStart >= 0 && decEnd > decStart) {
            decision = JSON.parse(agentText.slice(decStart, decEnd + 1));
          }
        } catch (e) {
          emit({ type: 'DECISION_PARSE_ERROR', error: e.message, stdout: stdout.slice(0, 300) });
        }

        if (!decision?.action) {
          emit({ type: 'DECISION_NO_ACTION', stdout: stdout.slice(0, 300) });
          decisionPending = false;
          flushEventBuffer();
          resolve();
          return;
        }

        lastDecisionInfo = {
          action: decision.action,
          amount: decision.amount || null,
          narration: decision.narration || null,
        };

        if (decision.action === 'fold') {
          foldedInHand = myHandNumber;
        }

        // Submit action to poker server — but first check if hand moved on
        if (currentHandNumber !== myHandNumber) {
          emit({ type: 'DECISION_STALE_HAND', decidedHand: myHandNumber, currentHand: currentHandNumber, action: decision.action });
          lastSend = lastSend.then(() => doSend(channel, chatId,
            `Hand moved on while deciding — skipped ${decision.action}.`));
          decisionPending = false;
          flushEventBuffer();
          resolve();
          return;
        }

        const body = decision.amount != null
          ? { action: decision.action, amount: decision.amount }
          : { action: decision.action };

        fetch(`${backendUrl}/api/game/${tableId}/action`, {
          method: 'POST',
          headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(5000),
        }).then(resp => {
          if (resp.ok) {
            // Send narration only after action is confirmed
            if (decision.narration) {
              const narrationMsg = decision.narration;
              lastSend = lastSend.then(() => doSend(channel, chatId, narrationMsg));
              recentEvents.push(narrationMsg);
              if (recentEvents.length > 20) recentEvents.shift();
            }
          } else {
            resp.text().then(reason => {
              emit({ type: 'ACTION_REJECTED', status: resp.status, action: decision.action, reason });
              lastSend = lastSend.then(() => doSend(channel, chatId,
                `Action rejected (${resp.status}): ${reason || 'unknown reason'}`));
            }).catch(() => {
              emit({ type: 'ACTION_REJECTED', status: resp.status, action: decision.action, reason: null });
              lastSend = lastSend.then(() => doSend(channel, chatId,
                `Action rejected (${resp.status}) — could not read reason.`));
            });
          }
        }).catch(actionErr => {
          emit({ type: 'ACTION_SUBMIT_ERROR', error: actionErr.message, action: decision.action });
        }).finally(() => {
          decisionPending = false;
          if (decision.action === 'fold') {
            eventBuffer = [];
          } else {
            flushEventBuffer();
          }
          resolve();
        });
      });
    });
  }).catch(e => {
    decisionPending = false;
    flushEventBuffer();
    emit({ type: 'DECISION_CHAIN_ERROR', error: e.message });
  });
}

// ── Strategy override ────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

export function readStrategyOverride() {
  try {
    return readFileSync(join(__dirname, 'poker-strategy-override.txt'), 'utf8').trim();
  } catch {
    return '';
  }
}

// ── Game context file ────────────────────────────────────────────────

const CONTEXT_FILE = join(__dirname, 'poker-game-context.json');
const CONTEXT_TMP  = join(__dirname, '.poker-game-context.json.tmp');

export function writeGameContext(view, tableId, extraFields = {}) {
  const strategyOverride = readStrategyOverride() || null;
  const context = {
    active: true,
    tableId,
    lastUpdated: new Date().toISOString(),
    hand: view ? {
      number: view.handNumber,
      phase: view.phase,
      yourCards: view.yourCards || [],
      board: view.boardCards || [],
      pot: view.pot,
      stack: view.yourChips,
      players: (view.players || []).map(p => ({
        name: p.name, seat: p.seat, chips: p.chips, status: p.status,
      })),
    } : null,
    recentEvents: recentEvents.slice(-20),
    lastDecision: lastDecisionInfo,
    strategyOverride,
    ...extraFields,
  };
  try {
    writeFileSync(CONTEXT_TMP, JSON.stringify(context, null, 2));
    renameSync(CONTEXT_TMP, CONTEXT_FILE);
  } catch (err) {
    emit({ type: 'CONTEXT_WRITE_ERROR', error: err.message });
  }
}

// ── Crash handlers ──────────────────────────────────────────────────

process.on('uncaughtException', (err) => {
  try {
    writeFileSync(CONTEXT_TMP, JSON.stringify({ active: false, error: err.message, lastUpdated: new Date().toISOString() }));
    renameSync(CONTEXT_TMP, CONTEXT_FILE);
  } catch { /* best effort */ }
  emit({ type: 'CRASH', error: err.message });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  try {
    writeFileSync(CONTEXT_TMP, JSON.stringify({ active: false, error: msg, lastUpdated: new Date().toISOString() }));
    renameSync(CONTEXT_TMP, CONTEXT_FILE);
  } catch { /* best effort */ }
  emit({ type: 'CRASH', error: msg });
  process.exit(1);
});

// ── Decision prompt builder ──────────────────────────────────────────

export function buildDecisionPrompt(summary, backendUrl, apiKey, tableId, strategyOverride) {
  let strategySection = '';
  if (strategyOverride) {
    strategySection = `\n\nUser Strategy Override (prioritize this):\n${strategyOverride}`;
  }

  return `You are playing No-Limit Hold'em poker. It is your turn to act.

Situation: ${summary}

Strategy:
- Preflop: AA/KK/QQ raise 3x BB. JJ/TT/AKo/AKs/AQs/AJs/KQs/99/88 raise 2.5x BB. Small pairs/suited connectors: fold unless late position. Everything else: fold.
- Facing a raise: 3-bet QQ+/AK, call JJ/TT/AK, fold rest.
- Postflop: Strong hand (top pair good kicker+) bet 50-66% pot. Draw: call only if pot odds > 4:1. Nothing: check-fold. Monster (set+): bet for value.
- Under 10 BB: shove or fold only.${strategySection}

IMPORTANT: If raising, your amount MUST be within the range shown in Actions (e.g., 'raise 40-970' means amount between 40 and 970). Never raise below the minimum or above the maximum.

Respond with ONLY a JSON object, no other text:
{"action": "fold|check|call|raise|all_in", "amount": <number if raise/bet, omit otherwise>, "narration": "<one sentence: what you did and why>"}

Example: {"action": "raise", "amount": 25, "narration": "Raising to 25 — AK suited on the button."}`;
}

// ── Main SSE connection ──────────────────────────────────────────────

async function main() {
  const [, , backendUrl, apiKey, tableId] = process.argv;

  if (!backendUrl || !apiKey || !tableId) {
    emit({ type: 'CONNECTION_ERROR', error: 'Usage: node poker-listener.js <backendUrl> <apiKey> <tableId> [--channel <name> --chat-id <id>]' });
    process.exit(1);
  }

  const direct = parseDirectArgs(process.argv);
  const mode = direct.enabled ? 'direct' : 'stdout';

  emit({ type: 'DELIVERY_MODE', mode, channel: direct.channel, chatId: direct.chatId ? '***' : null });

  const sseUrl = `${backendUrl}/api/game/${tableId}/stream?token=${apiKey}`;

  let EventSourceClass;
  try {
    const mod = await import('eventsource');
    EventSourceClass = mod.default || mod.EventSource;
  } catch {
    emit({ type: 'CONNECTION_ERROR', error: 'eventsource package not available' });
    process.exit(1);
  }

  const context = { prevState: null, prevPhase: null, lastActionType: null, lastReportedHand: 0 };
  const es = new EventSourceClass(sseUrl);

  es.onopen = () => {
    if (mode === 'direct') {
      warmupDone = new Promise(resolve => {
        execFile('openclaw', [
          'agent', '--local',
          '--session-id', `poker-${tableId}`,
          '--message', '(system: session warmup — no action needed)',
          '--thinking', 'low',
          '--timeout', '15',
          '--json',
        ], { timeout: 20000 }, () => resolve());
      });
    }
  };

  es.addEventListener('state', (event) => {
    try {
      const view = JSON.parse(event.data);
      const handJustChanged = view.handNumber !== currentHandNumber;
      currentHandNumber = view.handNumber;
      currentPhase = view.phase;
      const outputs = processStateEvent(view, context);

      for (const output of outputs) {
        if (mode === 'direct') {
          const outputHand = output.handNumber || currentHandNumber;
          if (foldedInHand != null && outputHand === foldedInHand
              && output.type !== 'YOUR_TURN' && output.type !== 'REBUY_AVAILABLE') {
            continue;
          }
          switch (output.type) {
            case 'EVENT':
              if (!gameStartedEmitted && output.message.includes('[Hand #')) {
                emit({ type: 'GAME_STARTED' });
                gameStartedEmitted = true;
              }
              sendMessage(direct.channel, direct.chatId, output.message);
              recentEvents.push(output.message);
              if (recentEvents.length > 20) recentEvents.shift();
              break;

            case 'YOUR_TURN': {
              const override = readStrategyOverride();
              const prompt = buildDecisionPrompt(output.summary, backendUrl, apiKey, tableId, override);
              sendDecision(direct.channel, direct.chatId, tableId, prompt, backendUrl, apiKey);
              break;
            }

            case 'HAND_RESULT': {
              const summary = buildHandResultSummary(output.state, output.handNumber || currentHandNumber);
              const msg = summary || 'Hand complete.';
              sendMessage(direct.channel, direct.chatId, msg);
              recentEvents.push(msg);
              if (recentEvents.length > 20) recentEvents.shift();
              break;
            }

            case 'WAITING_FOR_PLAYERS':
              sendMessage(direct.channel, direct.chatId,
                'All opponents left. Want me to keep waiting or leave?');
              writeGameContext(output.state, tableId, { waitingForPlayers: true });
              break;

            case 'REBUY_AVAILABLE': {
              const amt = output.state?.rebuyAmount || 'the default amount';
              sendMessage(direct.channel, direct.chatId,
                `Out of chips! Rebuy for ${amt}? Say "rebuy" or "leave".`);
              writeGameContext(output.state, tableId, { rebuyAvailable: true });
              break;
            }

            default:
              emit(output);
          }
        } else {
          emit(output);
        }
      }

      if (handJustChanged) {
        foldedInHand = null;
      }

      if (mode === 'direct') {
        writeGameContext(view, tableId);
      }
    } catch (err) {
      emit({ type: 'CONNECTION_ERROR', error: `Failed to process state event: ${err.message}` });
      es.close();
      process.exit(1);
    }
  });

  es.addEventListener('closed', () => {
    if (mode === 'direct') {
      sendMessage(direct.channel, direct.chatId, 'Table closed.');
      writeGameContext(context.prevState, tableId, { active: false, tableClosed: true });
      lastSend.then(() => { es.close(); process.exit(0); });
    } else {
      const outputs = processClosedEvent();
      for (const output of outputs) emit(output);
      es.close();
      process.exit(0);
    }
  });

  es.onerror = (err) => {
    emit({ type: 'CONNECTION_ERROR', error: `SSE connection error: ${err.message || 'unknown'}` });
  };

}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const isDirectRun =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/.*\//, ''));
if (isDirectRun && process.argv.length > 3) {
  main();
}
