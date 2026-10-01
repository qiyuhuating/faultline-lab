# Independent test package

将此 ZIP 与源码 ZIP 解压到同一个父目录，合并为 `faultline/`。测试包仅含 tests/，不含网页、服务源码或数据文件。

```sh
cd faultline
npm test
```

Node 24.15+（24.x）。领域、HTTP 与真实进程测试不需要安装第三方依赖。

浏览器测试：`npm ci --prefix tests --ignore-scripts`，在 tests/ 下运行 `npx playwright install --with-deps` 下载浏览器。然后从项目根目录执行 `node tests/browser.mjs` 和 `node tests/showcase.mjs`；可用 FAULTLINE_BROWSER 选择 chromium、firefox、webkit。截图和 JSON 输出到 test-results/，不覆盖测试源文件。

`evidence/batch-01/` 保留早期 40 项测试及源码包烟雾验证；`batch-02/` 保留扩展后的 48 项测试多次运行；`batch-03/` 保留实际三浏览器 CI 结果和截图。发布时 `ci-run-NNNN/` 自动汇总各轮完整 CI 工件与元数据，包括失败批次。同批的多次记录放在一个目录，全部批次收录在同一个独立测试 ZIP 中。完整范围见源码包 docs/VERIFICATION.md。
