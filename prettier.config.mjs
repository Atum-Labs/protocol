// Formatting for the packages linted by eslint.config.mjs. Scope is set by the `format` /
// `format:check` globs in package.json: .ts, .js, .mjs and .json inside those packages, plus this
// file and eslint.config.mjs. Markdown is excluded (also in .prettierignore): READMEs are
// hand-wrapped prose.
export default {
  // 100 columns keeps nearly every existing line intact.
  printWidth: 100,

  // One quote style for the whole repo.
  singleQuote: true,
};
