import { describe, expect, it } from 'vitest';
import { allocateMonthlyLeads } from '@/lib/lead-quota';

const ids = (n: number) => new Set(Array.from({ length: n }, (_, i) => String(i + 1)));

describe('monthly unique lead quota policy', () => {
  it('counts a DOT once even when zero-padded or repeated', () => {
    const result = allocateMonthlyLeads({ plan: 'monthly', accountSeen: new Set(), ipSeen: new Set(), requested: ['00123', '123', '456'] });
    expect(result.allowed).toEqual(['123', '456']);
    expect(result.newAccountIds).toEqual(['123', '456']);
  });
  it('allows already seen carriers after the account limit is reached', () => {
    const result = allocateMonthlyLeads({ plan: 'free', accountSeen: ids(200), ipSeen: ids(200), requested: ['1', '201'] });
    expect(result.allowed).toEqual(['1']);
    expect(result.denied).toEqual(['201']);
  });
  it('enforces a shared IP budget for new free carriers across accounts', () => {
    const result = allocateMonthlyLeads({ plan: 'free', accountSeen: new Set(), ipSeen: ids(200), requested: ['1', '201'] });
    expect(result.allowed).toEqual(['1']);
    expect(result.denied).toEqual(['201']);
    expect(result.newIpIds).toEqual([]);
  });
  it('limits the monthly paid tier to 5000 and does not apply the free IP limit', () => {
    const result = allocateMonthlyLeads({ plan: 'monthly', accountSeen: ids(4999), ipSeen: ids(200), requested: ['5000', '5001'] });
    expect(result.allowed).toEqual(['5000']);
    expect(result.denied).toEqual(['5001']);
  });
  it('does not limit unlimited accounts', () => {
    const result = allocateMonthlyLeads({ plan: 'unlimited', accountSeen: ids(5000), ipSeen: ids(200), requested: ['5001'] });
    expect(result.allowed).toEqual(['5001']);
  });
  it('counts carriers again when the caller supplies a fresh month', () => {
    const result = allocateMonthlyLeads({ plan: 'free', accountSeen: new Set(), ipSeen: new Set(), requested: ['1'] });
    expect(result.newAccountIds).toEqual(['1']);
    expect(result.newIpIds).toEqual(['1']);
  });
  it('rejects non-carrier IDs', () => {
    expect(() => allocateMonthlyLeads({ plan: 'free', accountSeen: new Set(), ipSeen: new Set(), requested: ['0'] })).toThrow();
    expect(() => allocateMonthlyLeads({ plan: 'free', accountSeen: new Set(), ipSeen: new Set(), requested: ['not-a-dot'] })).toThrow();
  });
});
