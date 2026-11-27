import { describe, expect, it } from 'vitest';
import { fullOfficerName, splitOfficerName, titleCaseName } from '@/lib/leads/personName';

const split = (raw: string | null) => {
  const { firstName, lastName } = splitOfficerName(raw);
  return `${firstName ?? ''}|${lastName ?? ''}`;
};

describe('splitOfficerName', () => {
  it('splits the ordinary two-word case', () => {
    expect(split('KULWINDER SINGH')).toBe('Kulwinder|Singh');
    expect(split('ANDREW QANDAH')).toBe('Andrew|Qandah');
  });

  it('keeps a middle name or initial with the first name', () => {
    expect(split('TIMOTHY W REYNOLDS')).toBe('Timothy W|Reynolds');
    // Compound Hispanic surnames keep the paternal surname in the first-name
    // column; see the documented limitation in personName.ts.
    expect(split('JOSE EFRAIN FLORES ALVARADO')).toBe('Jose Efrain Flores|Alvarado');
    expect(split('PHILLIP PAUL SCHACHT')).toBe('Phillip Paul|Schacht');
  });

  it('leaves a generational suffix on the last name', () => {
    expect(split('PAUL PRITCHARD BRIGGS JR')).toBe('Paul Pritchard|Briggs JR');
    expect(split('WC MARTIN JR')).toBe('Wc|Martin JR');
    expect(split('JOHN SMITH III')).toBe('John|Smith III');
  });

  it('keeps particles with the surname', () => {
    // "De Jesus" is a middle name here, not a surname particle.
    expect(split('MANUEL DE JESUS AMAYA')).toBe('Manuel De Jesus|Amaya');
    expect(split('MARIA VAN DYKE')).toBe('Maria|Van Dyke');
    expect(split('JOSE DE LA CRUZ')).toBe('Jose|De La Cruz');
  });

  it('lower-cases the surname particle but not a real first name', () => {
    // "De" is a particle only because it sits immediately before the surname.
    expect(split('DE ANDRE JOHNSON')).toBe('De Andre|Johnson');
  });

  it('puts a one-word name in the first-name column instead of guessing', () => {
    expect(split('GHOST')).toBe('Ghost|');
  });

  it('treats the placeholder values FMCSA files as no name at all', () => {
    const placeholders: (string | null)[] = ['', '   ', 'NONE', 'N/A', 'NULL', '---', null];
    for (const raw of placeholders) {
      expect(split(raw)).toBe('|');
    }
  });

  it('handles names with extra whitespace', () => {
    expect(split('  KEITH   ALLEN   NASH ')).toBe('Keith Allen|Nash');
  });

  it('title-cases Mc names the same way the rest of the app does', () => {
    expect(split('JOHN MCDONALD')).toBe('John|McDonald');
    expect(titleCaseName('JOHN MCDONALD')).toBe('John McDonald');
  });

  it('never returns a blank surname for a multi-word name', () => {
    const multiWord = ['KULWINDER SINGH', 'JOSE EFRAIN FLORES ALVARADO', 'PAUL BRITCHER BRIGGS JR'];
    for (const raw of multiWord) {
      expect(splitOfficerName(raw).lastName).toBeTruthy();
    }
  });

  it('never loses a word', () => {
    const names = [
      'KULWINDER SINGH',
      'TIMOTHY W REYNOLDS',
      'PAUL PRITCHARD BRIGGS JR',
      'MANUEL DE JESUS AMAYA',
      'JOSE EFRAIN FLORES ALVARADO',
    ];
    for (const raw of names) {
      const { firstName, lastName } = splitOfficerName(raw);
      const rejoined = `${firstName} ${lastName}`.toUpperCase();
      expect(rejoined.replace(/ III$/, ' Iii')).toBe(raw.replace(/ III$/, ' Iii'));
    }
  });
});

describe('fullOfficerName', () => {
  it('title-cases the whole name for the contact column', () => {
    expect(fullOfficerName('KULWINDER SINGH')).toBe('Kulwinder Singh');
    expect(fullOfficerName('PAUL PRITCHARD BRIGGS JR')).toBe('Paul Pritchard Briggs JR');
  });

  it('returns null for placeholders', () => {
    expect(fullOfficerName('NONE')).toBeNull();
    expect(fullOfficerName(null)).toBeNull();
  });
});
