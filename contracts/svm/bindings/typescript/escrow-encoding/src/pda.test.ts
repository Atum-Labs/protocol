/**
 * scripts/lib/pda.mjs: Solana program-derived addresses. The deployed-events check uses it to tie an
 * escrow event's deposit_hash to the deposit account the transaction actually touched.
 */

import { describe, expect, it } from 'vitest';
import { findProgramAddress } from '../scripts/lib/pda.mjs';

describe('findProgramAddress', () => {
  // From mainnet: the deposit account that signed release k5wWgD48... for this deposit_hash.
  it('derives the mainnet deposit PDA from its deposit_hash', () => {
    const hash = Buffer.from(
      '2680b99ebaf8df52171e6e54432c3a8b1b6749e43ebab0ed0fde9fbe139c15aa',
      'hex',
    );
    expect(
      findProgramAddress(
        [Buffer.from('deposit'), hash],
        '5BD9UAUCRCg6Chv6CS5k4sBHGd7CciWpng9u7iJxJFjx',
      ),
    ).toBe('FfBp6yzwS8fZjn4AfBaoTN4YamykeAxz6HhDQdLzVoVN');
  });
});
