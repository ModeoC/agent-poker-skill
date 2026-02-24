const SUIT_MAP = { s: '\u2660', h: '\u2665', d: '\u2666', c: '\u2663' };

export function formatCard(card) {
  if (card.length !== 2) return card;
  const rank = card[0];
  const suit = SUIT_MAP[card[1]];
  if (!suit) return card;
  return rank + suit;
}

export function formatCards(cards) {
  return cards.map(formatCard).join(' ');
}
