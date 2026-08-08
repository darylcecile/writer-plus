export default {
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    setupFiles: ["./tests/setup/vm-env.ts"],
  },
  oxc: { jsx: "automatic" },
};
