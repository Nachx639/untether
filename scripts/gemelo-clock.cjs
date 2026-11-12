// Fixed clock for the rich twin (scripts/gemelo.sh … --rich), loaded with node --require.
//
// The seeded tasks and sessions carry fixed dates so that screenshots never change. With the real
// clock those dates grow old and the server acts on it (budgets cut working tasks, overdue ones
// are marked missed), so the server starts at the seed's "now" and time goes on from there.
'use strict';

const start = Number(process.env.UTT_GEMELO_CLOCK);
if (Number.isFinite(start) && start > 0) {
  const RealDate = Date;
  const offset = start - RealDate.now();
  const now = () => RealDate.now() + offset;
  class TwinDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(now());
      else super(...args);
    }
    static now() {
      return now();
    }
  }
  globalThis.Date = TwinDate;
}
