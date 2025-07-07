module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: './tsconfig.json'
  },
  plugins: ['@typescript-eslint', 'import', 'prettier'],
  extends: [
    'airbnb-base',
    'airbnb-typescript/base',
    'plugin:@typescript-eslint/recommended',
    'plugin:import/recommended',
    'plugin:import/typescript',
    'prettier'
  ],
  rules: {
    'import/extensions': [
      'error',
      'ignorePackages',
      {
        ts: 'always'
      }
    ],
    'prettier/prettier': 'error',
    '@typescript-eslint/no-explicit-any': 'off',
    'no-restricted-syntax': 'off',
    'no-await-in-loop': 'off',
    'import/no-unresolved': 'off',
    'import/no-extraneous-dependencies': 'off',
    'class-methods-use-this': 'off',
    'no-plusplus': 'off',
    'no-continue': 'off',
    'no-nested-ternary': 'off',
    'import/prefer-default-export': 'off',
    'max-classes-per-file': 'off',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    'no-param-reassign': 'off',
    '@typescript-eslint/no-loop-func': 'off',
    'consistent-return': 'off',
    'no-promise-executor-return': 'off',
    '@typescript-eslint/naming-convention': 'off',
    'no-underscore-dangle': 'off'
  },
  env: {
    node: true
  }
}; 