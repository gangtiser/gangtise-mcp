import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // 纯静态数据表，覆盖率对它没有意义
      exclude: ["src/core/lookupData/**"],
      // 只要 text-summary（走 stdout，CI 日志和人看的都是它）。不加任何落盘 reporter：
      // 门禁是下面的 thresholds，vitest 在进程内判定，与写不写文件无关；而 json-summary
      // 会产出一个 coverage/ 目录，仓里没有任何东西读它。将来接 codecov / badge 再加回来。
      reporter: ["text-summary"],
      // 🔴 阈值取**当前实测值往下留一点余量**，不是拍一个好看的数字。
      // 作用是「不许倒退」，不是「必须达标」——定得比现状高会让它长期红着被无视，
      // 定得比现状低太多又挡不住回归。提高覆盖率时同步上调这里。
      thresholds: { lines: 95, statements: 95, functions: 97, branches: 87 },
    },
  },
})
