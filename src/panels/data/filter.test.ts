import { describe, expect, it } from 'vitest';
import { parseFilter } from './filter';

const p = (t: string, tone = 'numeric') => {
  const f = parseFilter(t, tone, 2);
  return f && { op: f.op, value: f.value };
};

describe('column filter parser', () => {
  it('parses comparisons on numbers', () => {
    expect(p('> 5')).toEqual({ op: 'gt', value: '5' });
    expect(p('>=5')).toEqual({ op: 'gte', value: '5' });
    expect(p('!= 3')).toEqual({ op: 'neq', value: '3' });
    expect(p('42')).toEqual({ op: 'eq', value: '42' });
    expect(p('abc')).toBeNull();
  });

  it('parses ranges', () => {
    expect(p('1 .. 10')).toEqual({ op: 'between', value: ['1', '10'] });
    expect(p('-5 - 5')).toEqual({ op: 'between', value: ['-5', '5'] });
    expect(p('2024-01-01 .. 2024-02-01', 'date')).toEqual({ op: 'between', value: ['2024-01-01', '2024-02-01'] });
  });

  it('treats text as contains unless an exact operator is used', () => {
    expect(p('budapest', 'text')).toEqual({ op: 'contains', value: 'budapest' });
    expect(p('= Pécs', 'text')).toEqual({ op: 'eq', value: 'Pécs' });
    expect(p('> x', 'text')).toEqual({ op: 'contains', value: '> x' });
  });

  it('understands missing values', () => {
    expect(p('NA', 'text')).toEqual({ op: 'isna', value: undefined });
    expect(p('!na')).toEqual({ op: 'notna', value: undefined });
    expect(p('   ')).toBeNull();
  });
});
