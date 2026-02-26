const SUIT_MAP = { s: '♠', h: '♥', d: '♦', c: '♣' };

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
