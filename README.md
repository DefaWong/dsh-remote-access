# dsh-remote-access

让手机、平板或其他电脑通过局域网，用浏览器继续使用这台电脑上 DeepSeek Harness 桌面版的对话。电脑上正在跑的任务，手机上能实时看到输出、继续发消息、审批权限、停止任务。

它是一个普通的 dsh 插件包，不修改桌面版本身，也适用于只监听 `127.0.0.1` 的 `dsh --profile web`。

## 安装

1. 桌面版侧栏打开“插件”，点“添加插件”，输入下面的地址并安装：

   ```text
   https://github.com/DefaWong/dsh-remote-access/releases/latest/download/dsh-remote-access.tgz
   ```

   这个地址总是指向最新版本，安装时只需要能访问 GitHub，不需要在电脑上装 git。
2. 打开插件详情页“远程访问”，点“生成新令牌”，再点“保存”。
3. 页面顶部会显示访问链接。在手机浏览器打开这个链接即可登录，之后直接访问不带令牌的地址；也可以“添加到主屏幕”。

Windows 第一次开始监听时可能弹出防火墙提示，勾选“专用网络”并允许。

这样安装的插件没有“更新”按钮：升级时先在插件页卸载，再按上面的方式重新添加，然后完全退出桌面版（托盘图标右键“退出”）再打开，否则可能仍在运行旧版本。卸载可能会清掉已保存的设置，重新添加后打开插件页确认一下令牌。

## 设置项

| 设置 | 默认 | 说明 |
|---|---|---|
| 监听地址 | 自动 | 留空时自动使用当前网卡的局域网 IPv4 地址，跳过 WSL、虚拟机、VPN、代理 TUN 等虚拟网卡；网络切换后 30 秒内自动跟随。也可以手动填写某个具体 IP，例如 Tailscale 地址 |
| 端口 | 30990 | 监听端口 |
| 访问令牌 | 空 | 至少 16 个字符；为空时不监听 |

保存后立即生效，不需要重启桌面版。设置保存在当前 profile 的 `cordis.patch.yml` 里（行 id 为 `remote-access-listener`）。

## 工作方式

插件在桌面版的 Host 进程里另开一个监听，把请求（包括 WebSocket 和事件流）转发给只监听 `127.0.0.1` 的 Host：

- **来源检查**：Host 头必须是监听地址本身、回环名，或配置项 `trustedHosts` 里声明的名字；浏览器带了 Origin 时必须与 Host 一致；明确的跨站请求一律拒绝。规则与 Host 自己的 `/api` 校验相同，用来防 DNS 重绑定和跨站请求。
- **登录**：仍然是 Host 自带的令牌换 Cookie。`?token=<访问令牌>` 会被换成 Host 当次启动的随机令牌，所以登录链接每次重启都不变；转发时 Host 头改写为 `127.0.0.1:<端口>`，登录 Cookie 跨重启依然有效。

## 安全须知

- 能登录这个地址就等于能在这台电脑上执行任意命令。只在可信网络使用，令牌不要外传。
- 连接是明文 HTTP。在家庭局域网之外请走 Tailscale/WireGuard 等加密通道，不要映射到公网。
- 桌面版退出或电脑睡眠后远程地址不可用；需要手机持续可用时，关闭电脑的自动睡眠。

## 已知限制

- 只支持纯 HTTP 的回环 Host（桌面版就是这样）；Host 配置了 TLS 时插件启动失败。
- 原生选目录、文件拖出、内嵌账号页面等依赖 Electron 的功能在手机上不可用，会走浏览器版的替代方式。
- 官方 0.2.2 的登录 Cookie 是 `SameSite=Strict`：Android 上从主屏幕图标冷启动可能需要重新打开带令牌的链接。

## 开发

```bash
npm install          # 安装 TypeScript、类型定义和 @deepseek-ai/schemastery
npm run build        # Host 半编译到 lib/，浏览器半编译并包装成 lib/client.js
npm test             # 单元与转发测试（Node ≥ 23）
```

`lib/` 随仓库提交，改完源码后要重新构建并一起提交。

发布新版本：改 `package.json` 的 `version`，构建并提交后打包上传到 GitHub Release，文件名固定为 `dsh-remote-access.tgz`，这样上面的安装地址始终指向最新版本：

```bash
npm pack && mv dsh-remote-access-<版本>.tgz dsh-remote-access.tgz
gh release create v<版本> dsh-remote-access.tgz --title v<版本> --notes "..."
```
