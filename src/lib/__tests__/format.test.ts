import { describe, it, expect } from 'vitest';
import {
  satsToBtcString,
  btcStringToSats,
  satsToUsdString,
  chunkAddress,
  InvalidAmountError,
  SATS_PER_BTC,
  MAX_SUPPLY_SATS,
} from '../format';

describe('satsToBtcString', () => {
  it('handles zero, one sat, and whole BTC', () => {
    expect(satsToBtcString(0n)).toBe('0.0');
    expect(satsToBtcString(1n)).toBe('0.00000001');
    expect(satsToBtcString(SATS_PER_BTC)).toBe('1.0');
    expect(satsToBtcString(150_000_000n)).toBe('1.5');
  });

  it('trims trailing zeros but keeps at least one decimal', () => {
    expect(satsToBtcString(120_000_000n)).toBe('1.2');
    expect(satsToBtcString(100_010_000n)).toBe('1.0001');
  });

  it('formats the 21M supply cap', () => {
    expect(satsToBtcString(MAX_SUPPLY_SATS)).toBe('21000000.0');
  });

  it('rejects negatives', () => {
    expect(() => satsToBtcString(-1n)).toThrow(RangeError);
  });
});

describe('btcStringToSats', () => {
  it('round-trips common values', () => {
    expect(btcStringToSats('0')).toBe(0n);
    expect(btcStringToSats('1')).toBe(SATS_PER_BTC);
    expect(btcStringToSats('1.5')).toBe(150_000_000n);
    expect(btcStringToSats('0.00000001')).toBe(1n);
    expect(btcStringToSats('.001')).toBe(100_000n);
    expect(btcStringToSats('21000000')).toBe(MAX_SUPPLY_SATS);
  });

  it('is the inverse of satsToBtcString for representative values', () => {
    for (const sats of [0n, 1n, 546n, 100_000n, SATS_PER_BTC, 150_000_000n, MAX_SUPPLY_SATS]) {
      expect(btcStringToSats(satsToBtcString(sats))).toBe(sats);
    }
  });

  it('rejects more than 8 decimals', () => {
    expect(() => btcStringToSats('0.000000001')).toThrow(InvalidAmountError);
  });

  it('rejects garbage input', () => {
    for (const bad of ['', '.', 'abc', '1.2.3', '-1', '1e5', ' 1 2 ']) {
      expect(() => btcStringToSats(bad)).toThrow(InvalidAmountError);
    }
  });
});

describe('satsToUsdString', () => {
  it('converts using the given price', () => {
    // 1 BTC at $50,000 → $50,000.00
    expect(satsToUsdString(SATS_PER_BTC, 50_000)).toBe('$50,000.00');
    // 100,000 sats (0.001 BTC) at $50,000 → $50.00
    expect(satsToUsdString(100_000n, 50_000)).toBe('$50.00');
  });

  it('supports omitting the symbol', () => {
    expect(satsToUsdString(SATS_PER_BTC, 50_000, { withSymbol: false })).toBe('50,000.00');
  });

  it('rejects bad inputs', () => {
    expect(() => satsToUsdString(-1n, 50_000)).toThrow(RangeError);
    expect(() => satsToUsdString(1n, Number.NaN)).toThrow(RangeError);
    expect(() => satsToUsdString(1n, -5)).toThrow(RangeError);
  });
});

describe('chunkAddress', () => {
  it('groups into 4-char chunks by default', () => {
    expect(chunkAddress('bc1qcr8te4kr609')).toBe('bc1q cr8t e4kr 609');
  });

  it('respects a custom group size and rejects < 1', () => {
    expect(chunkAddress('abcdef', 2)).toBe('ab cd ef');
    expect(() => chunkAddress('abc', 0)).toThrow(RangeError);
  });
});
