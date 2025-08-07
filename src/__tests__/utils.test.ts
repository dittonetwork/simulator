import { describe, it, expect } from 'vitest';
import { serializeIpfs } from '../utils.js';

describe('serializeIpfs', () => {
  it('returns empty string for falsy', () => {
    expect(serializeIpfs('')).toBe('');
  });

  it('returns the full hash', () => {
    const hash = 'Qmabcdef1234567890';
    expect(serializeIpfs(hash)).toBe(hash);
  });
});
