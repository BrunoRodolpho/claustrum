// Root ESLint flat config — applies the shared @claustrum/eslint-config to
// every package. ESLint v9 discovers this file by walking up from each
// linted source file, so per-package configs aren't needed.

import config from "@claustrum/eslint-config";

export default config;
