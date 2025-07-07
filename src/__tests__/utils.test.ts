import { describe, it, expect } from 'vitest';
import { serializeIpfs } from '../utils.js';

describe('serializeIpfs', () => {
  it('returns empty string for falsy', () => {
    expect(serializeIpfs('')).toBe('');
  });

  it('shortens long hashes', () => {
    const hash = 'Qmabcdef1234567890';
    expect(serializeIpfs(hash)).toBe('Qmab...7890');
  });
});
