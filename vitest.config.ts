import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // One file at a time. Most of these suites spawn the real plugin as a
    // child process and talk to it over a socket; running several at once put
    // four node processes on the same cores and they timed out waiting for
    // each other, passing whenever run alone. Inflating the timeouts would
    // have hidden that rather than fixed it.
    fileParallelism: false,
  },
});
