# Independent test package

将此 ZIP 与源码 ZIP 解压到同一个父目录，合并为 `faultline/`。测试包仅含 tests/，不含网页、服务源码或数据文件。

```sh
cd faultline
npm test
```

Node 24.15+（24.x）。领域、HTTP 与真实进程测试不需要安装第三方依赖。

浏览器测试：安装 tests/package.json 中固定版本的 Playwright，并下载对应浏览器。安装后从项目根目录执行 `node tests/browser.mjs`；可用 FAULTLINE_BROWSER 选择 chromium、firefox、webkit。截图和 JSON 输出到 test-results/，不覆盖测试源文件。

`evidence/batch-01/core-run-final.tap`：本批最终 40 项测试原始结果。当前交付没有已执行的浏览器截图或浏览器通过报告。
