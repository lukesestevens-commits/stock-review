# 复盘模块与成交列精简实施计划

## 目标

按已确认设计合并“明日操作计划”与“持仓复盘与明日预案”，并把成交表的买卖、金额和明细三列合并成一个紧凑的“交易”列，同时保持同步、保存、评分、风险分析和导出兼容。

## 实施步骤

1. 在 `tests/review-page.test.mjs` 增加页面结构回归断言：
   - 独立“明日操作计划”及重复字段不存在。
   - `newPlan` 和 `banRule` 保留。
   - 成交表只保留“交易”合并表头。
   - 买卖方向与价格在合并单元格常显，数量与金额位于同一个折叠区。
2. 在 `index.html` 合并页面结构：
   - 删除独立计划模块和“生成明日计划”按钮。
   - 将新开仓计划与明日禁令移到持仓表下方。
   - 重新编号后续模块。
3. 重构成交行模板与样式：
   - 合并三个表格单元格。
   - 买卖方向和价格常显。
   - 数量与金额折叠。
   - 缩短成交表最小宽度并保持移动端横向滚动。
4. 清理数据与导出逻辑：
   - 删除核心仓、低质量仓、给自己的话及自动汇总函数的 DOM 依赖。
   - `plan` 仅保存和恢复 `newPlan`、`banRule`。
   - 将两项全局计划并入持仓预案导出章节。
5. 运行页面、响应式、移动端和完整回归测试，构建云端站点。
6. 发布 Sites 新版本，核对线上 HTML 与接口功能。

## 验证命令

- `node --test tests/review-page.test.mjs tests/layout-responsive.test.mjs tests/mobile-webkit.test.mjs`
- `node tests/run-all.mjs`
- `node tools/build-cloud-site.mjs`
- `git diff --check`
