
/* Germany Over Lab 1.0 — model statystyczny.
 * Dane: data/all_matches.json, format scripts/update_germany.py.
 * Nie pobiera kursów i nie podejmuje decyzji o zakładach.
 */
(function (global) {
  'use strict';

  const LEAGUES = Object.freeze({
    D1: 'Bundesliga',
    D2: '2. Bundesliga'
  });

  const clamp = (x, lo, hi) =>
    Math.min(hi, Math.max(lo, x));

  const mean = (a) =>
    a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;

  const over = (m) =>
    Number(m.home_goals) + Number(m.away_goals) >= 3 ? 1 : 0;

  const sameDay = (m, date) => m.date < date;

  const isValid = (m) =>
    m &&
    LEAGUES[m.league] &&
    /^\d{4}-\d{2}-\d{2}$/.test(m.date) &&
    typeof m.home === 'string' &&
    typeof m.away === 'string' &&
    m.home !== m.away &&
    Number.isInteger(m.home_goals) &&
    Number.isInteger(m.away_goals) &&
    m.home_goals >= 0 &&
    m.away_goals >= 0;

  function normalize(raw) {
    if (!Array.isArray(raw)) {
      throw new Error('Baza musi być tablicą meczów.');
    }

    const seen = new Set();

    return raw
      .filter(isValid)
      .filter(m => {
        const key = [
          m.league, m.date, m.home, m.away
        ].join('|');

        if (seen.has(key)) return false;

        seen.add(key);
        return true;
      })
      .slice()
      .sort((a, b) =>
        a.date.localeCompare(b.date) ||
        a.league.localeCompare(b.league)
      );
  }

  function poissonOver25(lambda) {
    if (!Number.isFinite(lambda) || lambda < 0) {
      return null;
    }

    return clamp(
      1 - Math.exp(-lambda) *
      (1 + lambda + lambda * lambda / 2),
      0,
      1
    );
  }

  function prior(matches) {
    if (!matches.length) return null;

    return {
      home: mean(matches.map(m => m.home_goals)),
      away: mean(matches.map(m => m.away_goals)),
      rate: mean(matches.map(over))
    };
  }

  // Prognoza korzysta wyłącznie z wcześniejszych dni.
  function forecast(all, league, home, away, date, opts = {}) {
    if (!LEAGUES[league]) {
      throw new Error('Nieobsługiwana liga: ' + league);
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error('Data musi mieć format RRRR-MM-DD.');
    }

    const n = [5, 10, 15, 20].includes(opts.lastN)
      ? opts.lastN
      : 10;

    const blend = clamp(
      Number.isFinite(opts.poissonWeight)
        ? opts.poissonWeight
        : 1,
      0,
      1
    );

    const past = all.filter(
      m => m.league === league && sameDay(m, date)
    );

    const base = prior(past);

    if (!base || past.length < 60) {
      return {
        eligible: false,
        reason: 'Za mało danych ligowych',
        league, home, away, date
      };
    }

    const h = past.filter(m => m.home === home).slice(-n);
    const a = past.filter(m => m.away === away).slice(-n);

    const homeVenue = past.filter(m => m.home === home);
    const awayVenue = past.filter(m => m.away === away);

    const minVenue = Number.isInteger(opts.minVenue)
      ? Math.max(1, opts.minVenue)
      : 30;

    if (
      homeVenue.length < minVenue ||
      awayVenue.length < minVenue ||
      h.length < 3 ||
      a.length < 3
    ) {
      return {
        eligible: false,
        reason: 'Za mało meczów gospodarzy/gości',
        league, home, away, date,
        sample: {
          home: homeVenue.length,
          away: awayVenue.length
        }
      };
    }

    // Wygładzanie małych próbek do średniej ligowej.
    const strength = (teamMatches, goalsKey, leagueAverage) =>
      (
        teamMatches.reduce(
          (s, m) => s + m[goalsKey], 0
        ) + 5 * leagueAverage
      ) /
      (teamMatches.length + 5) /
      Math.max(leagueAverage, 0.1);

    const homeAttack = strength(
      h, 'home_goals', base.home
    );

    const homeDefense = strength(
      h, 'away_goals', base.away
    );

    const awayAttack = strength(
      a, 'away_goals', base.away
    );

    const awayDefense = strength(
      a, 'home_goals', base.home
    );

    const lambdaHome = clamp(
      base.home * homeAttack * awayDefense,
      0.1, 4.5
    );

    const lambdaAway = clamp(
      base.away * awayAttack * homeDefense,
      0.1, 4.5
    );

    const pPoisson = poissonOver25(
      lambdaHome + lambdaAway
    );

    const pHistory = base.rate;

    const probability =
      blend * pPoisson +
      (1 - blend) * pHistory;

    return {
      eligible: true,
      league, home, away, date,
      probability,
      poisson: pPoisson,
      historical: pHistory,
      expectedGoals: lambdaHome + lambdaAway,
      sample: {
        home: homeVenue.length,
        away: awayVenue.length,
        league: past.length
      },
      parameters: {
        lastN: n,
        poissonWeight: blend
      }
    };
  }

  function score(predictions) {
    if (!predictions.length) return null;

    return {
      count: predictions.length,

      brier: mean(
        predictions.map(r => (r.p - r.y) ** 2)
      ),

      logLoss: mean(
        predictions.map(r => -(
          r.y * Math.log(
            clamp(r.p, 1e-6, 1 - 1e-6)
          ) +
          (1 - r.y) * Math.log(
            clamp(1 - r.p, 1e-6, 1 - 1e-6)
          )
        ))
      ),

      meanPrediction: mean(
        predictions.map(r => r.p)
      ),

      actualOver25: mean(
        predictions.map(r => r.y)
      )
    };
  }

  function evaluatePeriod(all, league, target, opts) {
    const rows = [];

    for (const m of target) {
      const f = forecast(
        all, league, m.home, m.away, m.date, opts
      );

      if (f.eligible) {
        rows.push({
          p: f.probability,
          y: over(m),
          date: m.date
        });
      }
    }

    return score(rows);
  }

  function backtest(all, league) {
    if (!LEAGUES[league]) {
      throw new Error('Nieobsługiwana liga.');
    }

    const matches = all.filter(
      m => m.league === league
    );

    const days = [
      ...new Set(matches.map(m => m.date))
    ].sort();

    if (days.length < 90) {
      return {
        ok: false,
        reason: 'Za mało dni meczowych'
      };
    }

    // Podział chronologiczny według dni:
    // 60% historia, 20% walidacja, 20% test.
    const validationStart =
      days[Math.floor(days.length * 0.6)];

    const testStart =
      days[Math.floor(days.length * 0.8)];

    const validation = matches.filter(
      m => m.date >= validationStart &&
           m.date < testStart
    );

    const test = matches.filter(
      m => m.date >= testStart
    );

    const candidates = [];

    for (const lastN of [5, 10, 15, 20]) {
      for (const poissonWeight of [
        0, 0.25, 0.5, 0.75, 1
      ]) {
        const options = {
          lastN,
          poissonWeight,
          minVenue: 10
        };

        const result = evaluatePeriod(
          all, league, validation, options
        );

        if (result && result.count >= 30) {
          candidates.push({ options, result });
        }
      }
    }

    if (!candidates.length) {
      return {
        ok: false,
        reason: 'Za mało prognoz na walidacji'
      };
    }

    candidates.sort(
      (a, b) =>
        a.result.brier - b.result.brier ||
        a.result.logLoss - b.result.logLoss
    );

    const best = candidates[0];

    return {
      ok: true,
      league,
      validationStart,
      testStart,
      selectedOnValidation: best.options,
      validation: best.result,

      test: {
        selected: evaluatePeriod(
          all, league, test, best.options
        ),

        historical: evaluatePeriod(
          all, league, test, {
            lastN: 10,
            poissonWeight: 0,
            minVenue: 10
          }
        ),

        poisson: evaluatePeriod(
          all, league, test, {
            lastN: 10,
            poissonWeight: 1,
            minVenue: 10
          }
        )
      },

      note:
        'Pojedynczy podział czasowy; wynik nie potwierdza ' +
        'dodatniego EV. W teście minVenue=10, ' +
        'w typowaniu domyślnie 30.'
    };
  }

  async function load(url = './data/all_matches.json') {
    const response = await fetch(
      url,
      { cache: 'no-store' }
    );

    if (!response.ok) {
      throw new Error(
        'Nie można pobrać bazy: HTTP ' + response.status
      );
    }

    return normalize(await response.json());
  }

  global.GermanyOverLab = Object.freeze({
    LEAGUES,
    load,
    normalize,
    forecast,
    backtest,
    poissonOver25
  });

})(window);
