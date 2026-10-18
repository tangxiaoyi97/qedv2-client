import { create, all, type FactoryFunctionMap, type MathNode } from 'mathjs';

/** Share the parser with the live preview instead of initializing two CASes. */
export const expressionMath = create(all as FactoryFunctionMap);

const MAX_SOURCE_LENGTH = 4_096;
const MAX_DEPTH = 48;
const MAX_NODES = 256;

/** Bound work before entering either recursive parser (LaTeX or mathjs). */
export function isBoundedExpressionSource(source: string): boolean {
  if (source.length > MAX_SOURCE_LENGTH) return false;
  let depth = 0;
  for (const char of source) {
    if ('([{'.includes(char) && ++depth > MAX_DEPTH) return false;
    if (')]}'.includes(char)) depth = Math.max(0, depth - 1);
  }
  return true;
}

// Only scalar, deterministic mathematics belongs in an answer. In particular,
// evaluate/import/parse and array constructors can run nested programs or
// allocate unbounded matrices even when the source expression is very short.
const SCALAR_FUNCTIONS = new Set([
  'abs', 'sqrt', 'cbrt', 'nthRoot', 'exp', 'expm1', 'log', 'log10', 'log2', 'log1p',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2',
  'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh',
  'sec', 'csc', 'cot', 'asec', 'acsc', 'acot',
  'floor', 'ceil', 'round', 'fix', 'sign', 'min', 'max', 'mod', 'pow', 'factorial',
  'sum', 'prod', 're', 'im', 'conj', 'arg', 'complex',
]);
const SCALAR_OPERATORS = new Set([
  'add', 'subtract', 'multiply', 'divide', 'pow', 'unaryMinus', 'unaryPlus', 'mod', 'factorial',
]);

/** Iterative validation also bounds deep operator chains without recursing. */
export function isSafeScalarExpression(node: MathNode, vars: readonly string[]): boolean {
  const symbols = new Set([...vars, 'pi', 'e', 'tau', 'phi', 'i', 'LN2', 'LN10', 'LOG2E', 'LOG10E', 'SQRT2']);
  const pending = [{ node, depth: 1 }];
  let count = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (++count > MAX_NODES || current.depth > MAX_DEPTH) return false;
    const value = current.node as MathNode & { name?: string; fn?: unknown; value?: unknown };
    switch (value.type) {
      case 'ConstantNode':
        if (typeof value.value !== 'number' || !Number.isFinite(value.value)) return false;
        break;
      case 'SymbolNode':
        if (!symbols.has(value.name ?? '')) return false;
        break;
      case 'OperatorNode':
        if (typeof value.fn !== 'string' || !SCALAR_OPERATORS.has(value.fn)) return false;
        break;
      case 'FunctionNode': {
        const fn = value.fn as { type?: string; name?: string } | undefined;
        if (fn?.type !== 'SymbolNode' || !SCALAR_FUNCTIONS.has(fn.name ?? '')) return false;
        break;
      }
      case 'ParenthesisNode':
        break;
      default:
        return false;
    }
    value.forEach((child, path) => {
      // Function identifiers are checked against the whitelist above; their
      // arguments still need exactly the same scalar checks as other nodes.
      if (value.type !== 'FunctionNode' || path !== 'fn') {
        pending.push({ node: child, depth: current.depth + 1 });
      }
    });
  }
  return true;
}
