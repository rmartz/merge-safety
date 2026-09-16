// @ts-check
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import importPlugin from 'eslint-plugin-import';

/**
 * Flat ESLint config for the standalone merge-safety package. Descended from the
 * ai-tools monorepo config (and its repo-hygiene sibling): the layer-boundary
 * model is gone (no cross-package layers here), but the code-style rules —
 * promoted from CLAUDE.md prose to static enforcement — are kept intact so they
 * hold at every model tier instead of relying on a reviewer's eye.
 */

const tsParserOptions = { sourceType: 'module', ecmaVersion: 2023 };

/**
 * Code-style conventions enforced statically. Every rule is core ESLint or an
 * already-installed plugin — no type-aware rules, so a file does not need to live
 * in a tsconfig to be linted.
 */
const STYLE_RULES = {
  // "Strict TypeScript throughout — no `any`, no `@ts-ignore`." `ban-ts-comment`
  // still permits `@ts-expect-error` with a description (the sanctioned hatch).
  '@typescript-eslint/no-explicit-any': 'error',
  '@typescript-eslint/ban-ts-comment': 'error',
  // Type-only imports: `import type`, side-effect-free (companion pair).
  '@typescript-eslint/consistent-type-imports': 'error',
  '@typescript-eslint/no-import-type-side-effects': 'error',
  '@typescript-eslint/no-inferrable-types': 'error',
};

// "Prefer async/await over .then() chains", "No IIFEs", and "Named exports only —
// no default exports". Core `no-restricted-syntax` selectors, so there is no
// plugin-compat risk. Config files are globally ignored, so tsup / eslint /
// vitest configs keep their required default export.
const RESTRICTED_SYNTAX = [
  {
    selector: "CallExpression[callee.property.name='then']",
    message: 'Prefer async/await over .then() chains (AGENTS.md).',
  },
  {
    selector: 'CallExpression[callee.type=/FunctionExpression|ArrowFunctionExpression/]',
    message:
      'No IIFEs — extract a named helper or compute the value with a plain expression (AGENTS.md).',
  },
  {
    selector: 'ExportDefaultDeclaration',
    message: 'Named exports only — no default exports (AGENTS.md).',
  },
];

// Tests additionally forbid Vitest's `test()` global — the repo uses describe/it.
const TEST_RESTRICTED_SYNTAX = [
  ...RESTRICTED_SYNTAX,
  {
    selector: "CallExpression[callee.name='test']",
    message: 'Use it() from Vitest, not test() (AGENTS.md).',
  },
];

export default [
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**', '**/*.config.*'],
  },
  {
    // Package source — full rules.
    files: ['src/**/*.ts'],
    languageOptions: { parser: tsparser, parserOptions: tsParserOptions },
    plugins: { '@typescript-eslint': tseslint, import: importPlugin },
    settings: {
      'import/resolver': {
        typescript: { alwaysTryTypes: true, project: ['tsconfig.json'] },
        node: true,
      },
    },
    rules: {
      // File size: the sole file-length cap (there is no separate CI ratchet).
      // Hard ceiling at 2x the 240 split point; counts every line.
      'max-lines': ['error', { max: 480, skipBlankLines: false, skipComments: false }],
      'import/no-cycle': ['error', { maxDepth: 1 }],
      ...STYLE_RULES,
      'no-restricted-syntax': ['error', ...RESTRICTED_SYNTAX],
    },
  },
  {
    // Tests — longer ceiling.
    files: ['test/**/*.ts', '**/*.test.ts'],
    languageOptions: { parser: tsparser, parserOptions: tsParserOptions },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      'max-lines': ['error', { max: 720 }],
      ...STYLE_RULES,
      'no-restricted-syntax': ['error', ...TEST_RESTRICTED_SYNTAX],
    },
  },
];
