export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'test', 'docs', 'ci', 'build', 'refactor', 'chore'],
    ],
    'scope-empty': [0],
    'subject-case': [0],
  },
};
