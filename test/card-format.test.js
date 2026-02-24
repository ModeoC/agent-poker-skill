import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatCard, formatCards } from '../card-format.js';

describe('formatCard', () => {
  it('converts backend card string to display format', () => {
    assert.equal(formatCard('As'), 'A\u2660');
    assert.equal(formatCard('Kh'), 'K\u2665');
    assert.equal(formatCard('Td'), 'T\u2666');
    assert.equal(formatCard('2c'), '2\u2663');
  });

  it('handles all suits', () => {
    assert.equal(formatCard('Qs'), 'Q\u2660');
    assert.equal(formatCard('Qh'), 'Q\u2665');
    assert.equal(formatCard('Qd'), 'Q\u2666');
    assert.equal(formatCard('Qc'), 'Q\u2663');
  });

  it('returns raw string for unknown format', () => {
    assert.equal(formatCard('??'), '??');
  });
});

describe('formatCards', () => {
  it('formats an array of cards separated by spaces', () => {
    assert.equal(formatCards(['As', 'Kh']), 'A\u2660 K\u2665');
  });

  it('returns empty string for empty array', () => {
    assert.equal(formatCards([]), '');
  });
});
