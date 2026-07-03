/**
 * Expression grading — CAS equivalence with graceful degradation
 * (supplement §5, CONVENTIONS "expression"). Pure function: no I/O, no clock,
 * deterministic sampling. When the CAS cannot decide reliably, the outcome is
 * `indeterminate` and the UI falls back to self-assessment — the user is
 * never hard-failed by tooling limits.
 */
import { create, all } from 'mathjs';
import type { FactoryFunctionMap, MathNode } from 'mathjs';
import type { ExpressionAnswer, Scoring } from '../model/question.js';
import type { ExpressionSubmission, GradeOutcome } from './types.js';
import { latexToMathjs } from './latex.js';

/**
 * One shared mathjs instance (default 'number' config) for the module.
 * mathjs types `all` through a Record destructure, so noUncheckedIndexedAccess
 * widens it with `undefined` — it is always defined at runtime.
 */
const math = create(all as FactoryFunctionMap);

/* ------------------------------------------------------------------ *
 * Tolerances (spec'd): agreement is relative 1e-9 with absolute 1e-9
 * near zero; a counterexample needs a relative diff > 1e-6 so numeric
 * noise can never flip an equivalent answer to "incorrect".
 * ------------------------------------------------------------------ */
const AGREE_TOL = 1e-9;
const COUNTEREXAMPLE_TOL = 1e-6;

/**
 * Deterministic per-variable sample values: mixed negative (-3..-0.5) and
 * positive (0.1..7.3) ranges, ≥12 points, deliberately avoiding 0 and ±1.
 * Positive-heavy so sqrt/log-domain expressions still reach the
 * 8-valid-points threshold after negatives drop out as complex.
 */
const SAMPLE_VALUES = [
  -3, -2.3, -1.6, -1.1, -0.5, 0.1, 0.3, 0.5, 0.9, 1.2, 1.7, 2.3, 2.9, 3.7, 5.1, 7.3,
];
/** Minimum agreeing valid points for sampling alone to declare "correct". */
const MIN_VALID_POINTS = 8;

/* ------------------------------------------------------------------ *
 * Normalization helpers.
 * ------------------------------------------------------------------ */

/** Flatten subscripts the same way latex.ts does: x_n → xn, x_{max} → xmax. */
function flattenSubscripts(s: string): string {
  return s.replace(/_\{([^}]*)\}/g, (_, inner: string) => inner.replace(/[^A-Za-z0-9]/g, '')).replace(/_/g, '');
}

/**
 * Strip an optional single left-hand side like `f(x)=`, `y=`, `A(t)=`.
 * Only a plain `=` counts — `==`, `<=`, `>=` comparisons are left alone.
 */
function stripLeftHandSide(s: string): string {
  return s.replace(
    /^\s*[A-Za-z][A-Za-z0-9_]*\s*(?:\(\s*[A-Za-z][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z][A-Za-z0-9_]*)*\s*\))?\s*=(?![=<>])/,
    '',
  );
}

/**
 * Decimal-comma heuristic: a comma can be a German decimal separator OR a
 * function-argument separator (nthRoot(x,3)). Argument commas can only occur
 * inside a *call* — parentheses opened directly after an identifier char.
 * If no comma sits inside a call, every comma is a decimal → replace with '.'.
 * Otherwise leave all commas untouched (ambiguous inputs may then fail to
 * parse → indeterminate, which is the safe fallback).
 */
function normalizeDecimalCommas(s: string): string {
  if (!s.includes(',')) return s;
  const callStack: boolean[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '(') {
      // Peek at the previous non-space char: a letter/underscore means a
      // function call (a digit before "(" is implicit multiplication).
      let j = i - 1;
      while (j >= 0 && s[j] === ' ') j--;
      callStack.push(j >= 0 && /[A-Za-z_]/.test(s[j]!));
    } else if (ch === ')') {
      callStack.pop();
    } else if (ch === ',' && callStack.some(Boolean)) {
      return s; // at least one comma may be an argument separator
    }
  }
  return s.replace(/,/g, '.');
}

/**
 * Light implicit-multiplication insertion:
 *  - number token followed by identifier/paren:  2x → 2*x, 1.03(x) → 1.03*(x)
 *    (lookbehind keeps identifiers like log10( intact; scientific notation
 *    like 2e3 is matched as one number token first)
 *  - close-paren followed by identifier/number/paren: (x-2)(x+2) → (x-2)*(x+2)
 */
function insertImplicitMultiplication(s: string): string {
  return s
    .replace(/(?<![\w.])(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*(?=[A-Za-z(])/g, '$1*')
    .replace(/\)\s*(?=[\w(])/g, ')*');
}

/** `x(x+1)` where x is a known VARIABLE means multiplication, not a call. */
function separateVarCalls(s: string, vars: string[]): string {
  let out = s;
  for (const v of vars) {
    out = out.replace(new RegExp(`(?<![\\w.])${v}\\s*\\(`, 'g'), `${v}*(`);
  }
  return out;
}

/** Map unicode math input (−·×÷√) to ASCII mathjs operators. */
function normalizeUnicode(s: string): string {
  return s
    .replace(/[−–]/g, '-')
    .replace(/[·×]/g, '*')
    .replace(/÷/g, '/')
    .replace(/√\s*\(/g, 'sqrt(')
    .replace(/√\s*(\d+(?:\.\d+)?|[A-Za-z][A-Za-z0-9_]*)/g, 'sqrt($1)');
}

/** Full user-input normalization pipeline (order matters — see steps). */
function normalizeUserInput(raw: string, vars: string[]): string {
  let s = raw.trim();
  s = normalizeUnicode(s);
  s = stripLeftHandSide(s);
  s = normalizeDecimalCommas(s);
  s = flattenSubscripts(s);
  s = separateVarCalls(s, vars);
  s = insertImplicitMultiplication(s);
  return s;
}

/** Canonical normalization after LaTeX conversion (no comma/unicode games). */
function normalizeCanonical(converted: string, vars: string[]): string {
  let s = stripLeftHandSide(converted.trim());
  s = flattenSubscripts(s); // latex.ts already flattens; idempotent safety
  s = separateVarCalls(s, vars);
  s = insertImplicitMultiplication(s);
  return s;
}

/* ------------------------------------------------------------------ *
 * Equivalence machinery.
 * ------------------------------------------------------------------ */

type SamplingResult = {
  validPoints: number;
  agreeingPoints: number;
  counterexample: boolean;
};

interface Evaluable {
  evaluate(scope?: Record<string, number>): unknown;
}

function evaluateAt(fn: Evaluable, scope: Record<string, number>): number | undefined {
  try {
    const v = fn.evaluate(scope);
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  } catch {
    return undefined; // singular point / undefined symbol → skip
  }
}

function sample(user: MathNode, canonical: MathNode, vars: string[]): SamplingResult {
  const result: SamplingResult = { validPoints: 0, agreeingPoints: 0, counterexample: false };
  const compiledUser = user.compile();
  const compiledCanonical = canonical.compile();
  const n = SAMPLE_VALUES.length;
  for (let i = 0; i < n; i++) {
    const scope: Record<string, number> = {};
    // Stride 7 (coprime with 16) decorrelates variables at each point.
    vars.forEach((v, j) => {
      scope[v] = SAMPLE_VALUES[(i + 7 * j) % n]!;
    });
    const a = evaluateAt(compiledUser, scope);
    const b = evaluateAt(compiledCanonical, scope);
    if (a === undefined || b === undefined) continue; // NaN/∞/complex/error on either side
    result.validPoints++;
    const magnitude = Math.max(1, Math.abs(a), Math.abs(b));
    const diff = Math.abs(a - b);
    if (diff <= AGREE_TOL * magnitude) result.agreeingPoints++;
    else if (diff > COUNTEREXAMPLE_TOL * magnitude) result.counterexample = true;
  }
  return result;
}

/** Does simplify((user)-(canonical)) collapse to the constant 0? */
function simplifiesToZero(userSrc: string, canonicalSrc: string): boolean {
  try {
    const simplified = math.simplify(`(${userSrc})-(${canonicalSrc})`);
    // Evaluating without a scope succeeds only if no free symbols remain
    // (mathjs constants pi/e still resolve).
    const v: unknown = simplified.evaluate({});
    return typeof v === 'number' && Math.abs(v) <= AGREE_TOL;
  } catch {
    return false; // symbols left over, or simplify itself failed → inconclusive
  }
}

/* ------------------------------------------------------------------ *
 * Grader.
 * ------------------------------------------------------------------ */

export function gradeExpression(
  answer: ExpressionAnswer,
  submission: ExpressionSubmission,
  scoring: Scoring | undefined,
  points: number | undefined,
): GradeOutcome {
  // Scoring: expression parts are allOrNothing in practice (a single blank),
  // so we replicate applyScoring's allOrNothing arm inline instead of
  // importing ./scoring.js — keeps this module decoupled from the scoring
  // module that is developed independently. perBlank/tiered/rubric make no
  // sense for one expression and fall back to `points ?? 1`.
  const maxPoints = scoring?.mode === 'allOrNothing' ? scoring.points : (points ?? 1);

  const incorrect: GradeOutcome = {
    verdict: 'incorrect',
    correct: false,
    awardedPoints: 0,
    maxPoints,
  };
  const correct: GradeOutcome = {
    verdict: 'correct',
    correct: true,
    awardedPoints: maxPoints,
    maxPoints,
  };

  // Variables use the same subscript flattening as the canonical (x_n → xn).
  const vars = answer.vars.map(flattenSubscripts);

  // 1) Canonical: LaTeX → mathjs → parse. Failure = bank/tooling problem,
  //    never the user's fault → indeterminate.
  let canonicalNode: MathNode;
  let canonicalSrc: string;
  try {
    canonicalSrc = normalizeCanonical(latexToMathjs(answer.canonical), vars);
    canonicalNode = math.parse(canonicalSrc);
  } catch {
    return { verdict: 'indeterminate', reason: 'cas-parse-error', maxPoints };
  }

  // 2) User input. Empty/whitespace is clearly "no answer" → incorrect.
  //    Anything else that fails to parse might still be a notation the CAS
  //    doesn't know → indeterminate (self-assess), not incorrect.
  if (submission.expr.trim() === '') return incorrect;
  let userNode: MathNode;
  let userSrc: string;
  try {
    userSrc = normalizeUserInput(submission.expr, vars);
    userNode = math.parse(userSrc);
  } catch {
    return { verdict: 'indeterminate', reason: 'cas-parse-error', maxPoints };
  }

  // 3) Equivalence. Constant expressions (no vars) are fully determined by a
  //    single evaluation, so the 8-point threshold does not apply.
  if (vars.length === 0) {
    const a = evaluateAt(userNode.compile(), {});
    const b = evaluateAt(canonicalNode.compile(), {});
    if (a !== undefined && b !== undefined) {
      const magnitude = Math.max(1, Math.abs(a), Math.abs(b));
      const diff = Math.abs(a - b);
      if (diff <= AGREE_TOL * magnitude) return correct;
      if (diff > COUNTEREXAMPLE_TOL * magnitude) return incorrect;
    }
    if (simplifiesToZero(userSrc, canonicalSrc)) return correct;
    return { verdict: 'indeterminate', reason: 'cas-unreliable', maxPoints };
  }

  const s = sample(userNode, canonicalNode, vars);

  // A clear numeric counterexample beats everything (guards against simplify
  // ever collapsing non-equivalent forms, e.g. sqrt(x^2) vs x).
  if (s.counterexample) return incorrect;

  if (simplifiesToZero(userSrc, canonicalSrc)) return correct;

  // Sampling alone: enough valid points and none of them disagreeing.
  if (s.validPoints >= MIN_VALID_POINTS && s.agreeingPoints === s.validPoints) return correct;

  return { verdict: 'indeterminate', reason: 'cas-unreliable', maxPoints };
}
