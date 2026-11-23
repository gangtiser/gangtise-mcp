// 开发机上设的代理变量不能带进测试：GANGTISE_PROXY 会把发往本机桩的连接送到代理，HTTPS_PROXY 这类会改变连不上时的
// 提示文案。需要代理的用例（tests/unit/core/proxy.test.ts）逐条显式设置。
for (const name of ["GANGTISE_PROXY", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) delete process.env[name]
