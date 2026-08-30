// 最小 lint 配置：只开**能抓到真缺陷**的规则，不做风格约束。
// 本仓没有 formatter（CLAUDE.md 明说「匹配现有风格」），所以引号/分号/缩进一律不管 ——
// 那类规则会在每次改动上制造噪音，把真信号淹掉。
import js from "@eslint/js"
import tseslint from "typescript-eslint"

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**", "bug/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // 风格类关掉
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      // 真缺陷类留着
      "@typescript-eslint/no-floating-promises": "off", // 需要 type-aware，另开成本高
      "no-constant-condition": ["error", { checkLoops: false }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none", ignoreRestSiblings: true }],
    },
  },
  {
    files: ["tests/**/*.ts"],
    rules: { "@typescript-eslint/no-unused-expressions": "off" },
  },
  // 发版门禁脚本：纯 Node ESM，跑在 CI 与发布流水线里。不声明 Node 全局的话
  // console / process / Buffer 全被报成 no-undef —— 那是配置缺口，不是缺陷。
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { console: "readonly", process: "readonly", Buffer: "readonly" },
    },
  },
)
