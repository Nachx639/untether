import { describe, expect, it } from 'vitest';
import {
  budgetLine,
  budgetOver,
  formatBudgetUsd,
  parseBudgetSpec,
  parseBudgetUsd,
  TASK_BUDGET_DEFAULTS,
} from './task-budget.js';

describe('usd budget (model-providers.ts)', () => {
  it('parses dollar amounts', () => {
    expect(parseBudgetUsd('5')).toBe(5);
    expect(parseBudgetUsd('$5')).toBe(5);
    expect(parseBudgetUsd('2.50')).toBe(2.5);
    expect(parseBudgetUsd('10usd')).toBe(10);
    expect(parseBudgetUsd('$0.50')).toBe(0.5);
    expect(parseBudgetUsd('nope')).toBeNaN();
  });

  it('accepts usd= in a budget spec', () => {
    expect(parseBudgetSpec('usd=5').limits.usd).toBe(5);
    expect(parseBudgetSpec('wall=1h,usd=2.5').limits).toMatchObject({ usd: 2.5 });
    expect(parseBudgetSpec('dollars=3').limits.usd).toBe(3);
  });

  it('formats dollars with sensible precision', () => {
    expect(formatBudgetUsd(0)).toBe('$0');
    expect(formatBudgetUsd(12)).toBe('$12.00');
    expect(formatBudgetUsd(0.5)).toBe('$0.500');
    expect(formatBudgetUsd(0.0004)).toBe('$0.0004');
  });

  it('shows usd on the budget line only when it has a limit or spend', () => {
    const base = {
      limits: { ...TASK_BUDGET_DEFAULTS },
      spent: { wall: 0, agent: 0, rounds: 0, tokens: 0, usd: 0 },
    };
    expect(budgetLine(base)).not.toContain('usd');
    const priced = {
      limits: { ...TASK_BUDGET_DEFAULTS, usd: 5 },
      spent: { wall: 0, agent: 0, rounds: 0, tokens: 0, usd: 1.25 },
    };
    expect(budgetLine(priced)).toContain('usd $1.25/$5.00');
  });

  it('cuts a task that spent its usd limit', () => {
    const over = budgetOver({
      limits: { wall: 0, agent: 0, rounds: 0, tokens: 0, usd: 5 },
      spent: { wall: 0, agent: 0, rounds: 0, tokens: 0, usd: 5 },
    });
    expect(over).toContain('usd');
  });
});
