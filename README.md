<p align="center">
  <img src="./assets/banner.svg" alt="DshPeakPriceGuard —— 高峰时段，先问一句再发" width="100%">
</p>

<p align="center">
  <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-3ddc97.svg"></a>
  <a href="https://www.npmjs.com/package/dsh-peak-price-guard"><img alt="npm" src="https://img.shields.io/npm/v/dsh-peak-price-guard?color=cb3837"></a>
  <img alt="DSH plugin" src="https://img.shields.io/badge/DeepSeek%20Harness-plugin-6b5bff.svg">
  <a href="https://github.com/nowscott/DshPeakPriceGuard/actions/workflows/test.yml"><img alt="tests" src="https://github.com/nowscott/DshPeakPriceGuard/actions/workflows/test.yml/badge.svg"></a>
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A522-339933.svg">
</p>

<p align="center"><i>DeepSeek 有两档价格，你的手只有一双。</i></p>

<p align="center">中文 · <a href="./README.en.md">English</a></p>

---

一个 DeepSeek Harness 插件。它在**高峰（标准价）时段**帮你把手从发送键上按回去零点五秒——
先问一句「这条真要现在发？」，你说发，它才发。特价时段它完全不存在，绝不打扰。

## 它到底干什么

| 你的动作 | 它的反应 |
| --- | --- |
| 高峰时段按发送 | 消息不进网络，弹一张确认卡：现在几点、这条多长、哪个会话、几点恢复特价 |
| 点「仍要发送」 | 原样发出，跟你自己按的一样 |
| 点「先不发」/ Esc / 点遮罩 | 草稿和附件一起退回输入框，**不报错**（免得你以为自己弄坏了什么） |
| 特价时段按发送 | 直接发，当它不存在 |
| 在输入框下面看见小胶囊 | 红=高峰，绿=特价，琥珀=正等你确认，红字「未生效」= 上游接口变了，去看设置页 |
| 换成 glm 等第三方模型再按发送 | 直接发：价格日历是 DeepSeek 的价目表，默认只拦 DeepSeek 账号 / 官方 API 的会话（设置页可关掉这个限定） |

胶囊可以关掉。关掉之后它依然默默拦着，只是不告诉你——所以建议留着。

## 价格日历是怎么算的

北京时间，**周一至周五**的 `09:00–12:00`、`14:00–18:00` 是高峰，其余全是特价：
晚上、凌晨、周末、法定节假日，以及「你以为要上班但其实放假」的那些天。

时段可以在设置页改成任意写法：`09:00-12:00, 14:00-18:00`、`9-12`、`00:00-24:00`
（最后这个是自测用的，不用真等到明早九点）。

## 节假日：去查，不背

假期安排每年 11–12 月才公布，任何「写死在代码里的假期表」都会在某个元旦突然变成错的。
所以这个插件不背假期，它去查：

1. **在线**：启动时拉当年 + 下一年的 [holiday-cn](https://github.com/NateScarlet/holiday-cn) 数据（MIT），
   那个项目每天从国务院公告重新抓一遍，改了就发版。
2. **缓存**：拉回来的表存进 cookie，45 天有效——断网开机也不至于把假期当成工作日。
3. **兜底**：内置 2025–2026 的表，只在前两层都拿不到那一年时开口。

某一年的数据一旦到手，那一年就听它的；公告改了，插件跟着改，不用等我们发新版本。

设置页底部会写清楚现在用的是哪一层、上次什么时候更新的，旁边还有个「立即更新」。
拉取失败不会假装没事：状态行变成琥珀色，30 分钟后自动重试（成功则回到 12 小时一次的节奏）。
缓存是压缩过的——同一年只存一遍年份前缀，两年的假期数据仍塞得进一个 cookie。

## 几个刻意的选择

- **弹窗是无障碍的**：`role="dialog"` + `aria-modal`，标题与说明各自挂 id；Esc 取消、
  打开时焦点落在「先不发」、Tab 在弹窗内循环，跑不到背后的输入框里去。
- **闸门会等人**：挂载时如果发送接口还没组装好，按 0.4s→6.4s 退避重试几次，
  而不是因为插件加载顺序就整场放弃。
- **装上了还会复查**：每 15 秒回读一次发送接口。上游把方法换掉（比如前端热更新重建了
  服务），它会重新包上新方法；只有真包不上时才标红。挂载时查一次是不够的——页面开着
  不动的那几个小时，正是最容易静默失效的时候。
- **失败了要吵**：接口变了就胶囊标红、设置页顶部报警。安静地失效比报错更坑。

## 偏好住在哪里

时段、开关、静音时长写在**插件配置**里（profile 的 `cordis.patch.yml`），所以换浏览器、
换电脑、清 cookie 都还在。设置页底部那一行会直接告诉你现在的情况：

| 那一行写的 | 意思 |
| --- | --- |
| 偏好保存在插件配置（cordis.patch.yml）里 | 正常状态，改动已经落盘 |
| 已写入插件配置 | 刚刚写进去的 |
| 正在写入插件配置… | 落盘途中（连点几下会合并成一次写） |
| 插件配置暂时写不进去 / 写入失败 | 退回本浏览器，界面照常工作，下次打开还是你改后的值 |

实现上没有魔法：Host 半部把行配置通过 Web 服务器的 index 注入变成页面上的一个启动全局，
设置页的改动 POST 回一个同源接口，Host 再用 `configEditor` 写进 profile 补丁——注意是
**写配置**，不是去改写你那份 `cordis.patch.yml` 的原文，注释和 `!!js` 表达式都会保留。
接口认一个私有请求头并校验 `Origin`，所以别的网页没法从浏览器里改你的偏好。

没有 Web 服务器、或 profile 没挂 `config-editor` 时，这条路自动不存在，插件退回浏览器
cookie 存储，功能一分不少。

## 安装

在 DSH 的 **设置 → 插件** 里装，或者让 Agent 跑：

```
plugin_manager install_bundle dsh-peak-price-guard
```

开发时用目录 link 安装（把本地这份挂进 profile），改完 `client.js` 刷新页面即可生效，不用重装：

```
plugin_manager install_bundle link:<本目录绝对路径>
```

## 开发与验证

改动走 PR，不直接推 `main`：

```bash
git switch -c fix/holiday-retry
# 改代码、改版本号
npm test                       # 45 项
node scripts/check.mjs         # 打包自检
git push -u origin HEAD
gh pr create --fill            # CI 在两个 Node 版本上跑绿后再合并
```

`main` 有保护规则：必须走 PR、必须 `node 22` / `node 24` 两个检查通过、必须线性历史（用 squash 合并）。
合并之后打 tag 才会发版——**合并决定「要不要发」，tag 决定「什么时候发」**。

```bash
npm test
```

覆盖：时段边界、节假日在线替换与兜底、压缩缓存与旧版兼容、下次高峰、时段解析、
偏好归一化、发送闸门与加载顺序重试、运行时复查（上游换方法后重新包上）、静默、FIFO、
abort、弹窗 hook 顺序与无障碍属性、Tab 焦点循环、设置页状态文案、胶囊状态、cookie
持久化、配置文件播种与写回、写回被拒后浏览器副本仍占上风、Host 路由的鉴权与大小限制。

前两半的测试方式不一样：`client.js` 部分用 `window.__ModuleLoader__` 加一个极简 React 桩
**直接执行**，跑的是真代码；`index.js` 部分直接调用 `apply()` 并交给它一个假 ctx，检查它
注册了什么、以及那条路由在各种请求下怎么答。

## 诚实清单

- **依赖内部接口** `conversation.sendSession`。它不是官方扩展点，上游改名插件就会静默失效。
  所以加了自检：包装后读不回来就把胶囊标红、设置页顶部报警，而不是假装一切正常。
  挂载时如果这个接口还没组装好，会退避重试几次，不会因为加载顺序就直接放弃。
- 只拦**人工发送**。定时任务这类程序化 prompt 不拦——没人能替它点确认。
- `updateQueue(steer)` 重发的是已入队的消息，入队时已经问过了，不会重复问。
  唯一的缝：特价时入队、高峰时再 steer，按请求时刻计费不会被询问。
- 节假日依赖第三方仓库和 CDN；两者同时挂且缓存过期时退回内置表，新一年的假期可能被误判。
- **偏好写配置要靠 Host 半部**。这条路依赖三样东西：Web 服务器的 index 注入
  （`webserver/index-inject`）、`configEditor` 服务、以及那条自己注册的 HTTP 路由。
  任何一样被上游改名或移除，插件会退回 cookie 存储并在设置页说明，不会崩，但也不再
  「跟着仓库走」。这三处跟 `sendSession` 一样是内部接口，性质上属于同一类风险。
- 设置页的写入是**整份配置覆盖**（`configEditor` 的语义），不是逐键 patch。
  如果以后有人往这个插件里塞了它不认识的配置键，会在写回时被原样保留，但顺序可能变。

## 发布

版本号也要走 PR——`main` 有保护，`npm version` 那种「改完直接推 main」会被拒绝。

```bash
git switch -c release/0.4.4
npm version 0.4.4 --no-git-tag-version   # 只改 package.json，提交和 tag 由人来做
git commit -am "chore: release 0.4.4"
git push -u origin HEAD
gh pr create --fill && gh pr merge --squash --delete-branch
git switch main && git pull

git tag -a v0.4.4 -m "v0.4.4" && git push origin v0.4.4
```

tag 一推，`publish.yml` 自动接手：跑检查 → 用 OIDC 换一张短命令牌 → 发 npm → 用
`--generate-notes` 建 Release。**没有任何 `NPM_TOKEN`**，靠的是 npm trusted publishing
（一次登记：Provider=GitHub Actions、repo=`nowscott/DshPeakPriceGuard`、workflow=`publish.yml`）。

版本号只有一个来源：`package.json`。README 里的徽章是 npm 动态徽章，不用手改。

## 交接文档

改了这么久，踩过的坑、为什么这么设计、发布链路怎么配的，都记在 [docs/handover.md](./docs/handover.md)。
半年后回来看，或者换个人接手，先读它。

## 许可证

[MIT](./LICENSE)。

假期数据来自 [NateScarlet/holiday-cn](https://github.com/NateScarlet/holiday-cn)（MIT），
由它的 CI 从国务院公告生成——我们只是把它端过来，没有自己掐指一算。

<p align="center"><sub>本插件不生产 token，只是 token 的守门员。</sub></p>
