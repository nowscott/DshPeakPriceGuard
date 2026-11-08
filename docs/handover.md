# 交接文档（handover）

写给「半年后的我」和「下一个接手的人」。这里记的不是怎么用插件（那在 README），而是**为什么长成现在这样**、**哪些地方踩过坑**、**改东西要动哪根线**。

最后更新：2026-11-08 · 对应版本 v0.5.0

---

## 一、坐标

| | |
| --- | --- |
| 本地目录 | `~/Documents/开发项目/08_dsh/DshPeakPriceGuard` |
| 仓库 | https://github.com/nowscott/DshPeakPriceGuard |
| npm | https://www.npmjs.com/package/dsh-peak-price-guard |
| 插件在 DSH 里的 id | `dsh-peak-price-guard`（包名） / `peak-price-guard`（行 id） |
| 许可证 | MIT |

名字的由来：对外展示用大驼峰 `DshPeakPriceGuard`（`Dsh` 前缀是为了让人一眼看出是 DSH 插件），
npm 包名必须小写，所以是 `dsh-peak-price-guard`。

---

## 二、它到底是什么

一个 **DSH Client 插件**（浏览器里跑），在 DeepSeek 高峰时段拦下「发送」，弹确认框，确认后才真正提交。

- **Host 半部只干一件事**：把行配置送进页面、把页面里的改动写回配置（见下面「偏好为什么进配置文件」）。
  闸门、日历、界面全部在 Client 半部，所以没有 Host 半部时它依然是一个完整可用的插件。
- **界面逻辑在 `client.js`**（单文件，`__ModuleLoader__` 模块，不是构建产物）。
- 注册了三个插槽：
  - `conversation.composer.dock` → 输入框下方的价格胶囊
  - `shell.overlay` → 确认弹窗（必须 portal 到 `document.body`，否则被 dock 裁剪）
  - `settings.section` → 设置页

### 闸门怎么装上的

`conversation.sendSession` 是**内部接口，不是扩展点**。做法是拿到 `ctx.get('conversation')` 后，
把**原型上的** `sendSession` 包一层（实例级赋值会被 traceable proxy 挡住），卸载时还原。

两个关键细节：

- 拦下时返回 `{ kind: 'error' }`——这是 composer 自带的失败出口，会恢复草稿、保留附件，且**不弹错误提示**。
- 装不上时不能沉默：`gateStore` 变红，胶囊显示「提醒 未生效」，设置页顶部报警。挂载时如果接口还没组装好，
  会按 0.4s→6.4s 退避重试几次（0.4.3 加的）。
- 0.5.0 起还会**运行时复查**：每 15 秒回读一次 `service.sendSession[PATCH_MARK]`。
  - 上游把方法换掉（前端热更新重建服务、换了实现）→ 发现 `proto.sendSession` 没有标记就重新包一次；
  - 方法在、但通过服务读不到（实例属性遮蔽、代理换了目标）→ 标红 `sink lookup bypassed the patch`；
  - 方法彻底没了 → 标红 `missing sink`。
  运行时复查只能**发现并尽量自愈**，不能阻止「两次检查之间」漏掉的那一次发送——这是包内部接口的固有代价。

### 偏好怎么进配置文件（0.5.0 起）

Client 半部**拿不到插件的行配置**：启动清单（`dsh-client-modules` 的 `resolveMeta`）只读
`dsh.client` 声明和 bundle 路径，client 条目里没有 config 字段。所以链路是：

```
cordis.patch.yml 行 config
        │  apply(ctx, config)
        ▼
  index.js  ── webserver/index-inject ──>  globalThis.__DSH_PEAK_PRICE_GUARD__ = {config}
        │                                          │  Client apply() 先读它
        │                                          ▼
        │                                    settingsStore（来源标记 file）
        │  POST /dsh-peak-price-guard/config
        └──  <── 设置页改动 ── configEditor.edit(entry, …) ──> profile 补丁
```

几个必须知道的细节：

- **行配置只能从 Host 拿**。注入用 Web 服务器的结构化注入行（`kind: 'global'`），不是自己拼 HTML；
  `tapIndex` 是同一件事的手工版，没必要。
- **写入走 `configEditor`**，不是自己去改用户的 `cordis.patch.yml`。`configEditor.edit(entry, change)`
  会保留注释和 `!!js`、串行化写入、失败回滚，并在写完后按 Loader 正常路径重启这个插件。
  所以**每次改偏好，Host 侧的插件会重启一次**（路由和注入会重新注册）。Client 不受影响。
- 路由 `/dsh-peak-price-guard/config` 自己注册在 `webServer` 上，因此**不经过** `/api` 的鉴权链路。
  防滥用靠两条：必须带请求头 `x-dsh-peak-price-guard: 1`（跨站表单做不到，且会触发预检被浏览器拦下），
  以及 `Origin` 必须等于本机 `Host`。body 上限 8KB。
- 没有 `webServer`、没有 `configEditor`、或者 POST 失败时，**自动退回 cookie**：
  cookie `dsh_peak_price_guard` 仍是缓存/兜底，`dsh_peak_price_guard_sync` 记住上次写没写成——
  写失败过（值 `local`）时，下次启动**不让文件值覆盖浏览器值**，否则用户刚改的东西会被旧配置顶回去。
- 保存偏好会加一条 override 行到 profile 补丁里（`- id: peak-price-guard` + 完整 config），
  这是 `configEditor` 的语义：整份覆盖，不是逐键 patch。

cookie 仍然是必需品，因为 Desktop 每次启动是**随机端口**，origin 含端口 → `localStorage` 每次启动被清空；
cookie 只按 host 归属，能跨重启。

### 价格日历

北京时间，**周一至周五** `09:00–12:00`、`14:00–18:00` 是高峰；其余（晚上、周末、法定节假日）全天空闲。
2026-11 核对过官方文档，口径一致。

节假日**不写死**，三层：

1. cookie 缓存（45 天）
2. 在线拉 [holiday-cn](https://github.com/NateScarlet/holiday-cn)（MIT，国务院公告自动生成）的当年 + 下一年，
   jsDelivr 分发，CORS 开放；每 12 小时刷新，失败则 30 分钟后重试
3. 内置表（2025–2026）兜底

某一年的在线数据一旦到手，该年就完全听它的（公告修正也能生效）。

缓存格式是压缩的：`{v:2, s:时间戳, y:{2026:"01-01,01-02,..."}}`——同一年只存一次年份前缀，
两年数据实测 **421 字节**（旧格式约 1KB）。读取同时兼容 0.3.x 的旧格式。

---

## 三、发布链路（零 secret）

```
PR 合并 → 打 tag → publish.yml
                        ├─ node 22 / 24 跑测试 + 打包自检
                        ├─ npm CLI 用 GitHub OIDC 换一张短命令牌
                        ├─ npm publish
                        └─ gh release create --generate-notes
```

**没有 `NPM_TOKEN`，也不需要**。靠的是 npm **trusted publishing**：在 npm 包设置里登记
「这个仓库 + 这个 workflow 文件」，GitHub 每次运行时签发一张短命令牌，npm 认这个组合。

已登记的配置（在 https://www.npmjs.com/package/dsh-peak-price-guard/access ）：

- Provider：GitHub Actions
- Organization/user：`nowscott`
- Repository：`DshPeakPriceGuard`
- Workflow filename：`publish.yml`
- Allowed actions：`npm publish` + `npm stage publish`
- Publishing access：**Require 2FA and disallow bypass 2fa tokens**
- 注意：新配置必须在 **2 天内**完成第一次发布，否则作废

### 分支保护（main）

- 必须走 PR（批准数 0，自己就能合）
- 必须 `node 22`、`node 24` 两个检查通过，且分支要最新
- 禁 force push、禁删除、要求线性历史（squash）
- `enforce_admins: true`——**管理员也推不上去**

所以**版本号不能直接在 main 上 `npm version` 然后 push**，必须在 PR 里改。正确顺序见 README「发布」。

### 几个只有踩过才知道的坑

| 现象 | 原因 | 修法 |
| --- | --- | --- |
| `npm publish` 报 `ENEEDAUTH`，但环境里有 OIDC | `actions/setup-node` 的 `registry-url` 会写一个 `_authToken` 为空的 `.npmrc`，npm 于是走 token 认证 | 去掉 `registry-url` 参数 |
| OIDC 换取返回 404 `package not found` | npm 侧还没登记 trusted publisher（或填错/没保存） | 在包页 `/access` 重新登记 |
| 诊断脚本把成功当失败 | 换取接口返回 **201** 不是 200 | 判 `2*` |
| `workflow_dispatch` 跑完建了个叫 `main` 的 Release | `GITHUB_REF_NAME` 是分支名 | Release 步骤加 `if: startsWith(github.ref, 'refs/tags/')` |
| 刚 `npm publish` 完 registry 里只有 `0.0.0-stage` | npm 新版「暂存发布」流程，约 1–2 分钟后才真正上线 | 等，别重复发 |
| `npm trust ...` 命令 403 | 带 bypass 2FA 的 granular token **不能**改账号/包设置 | 只能在网页上手动点 |
| 明明改了 `index.js`，线上行为没变 | 目录 link 只热更 **client** bundle；Host 半部的 ESM 模块还在进程缓存里 | 更新 Host 半部后**重启应用**（不是刷新页面） |
| `curl` 打本地 GUI 一律 401 | 页面与人 API 走 Connection 的鉴权，裸 curl 没有凭据 | 别用 curl 当探针；看插件自己的路由（它不经过 `/api` 鉴权） |

### 为什么没上 release-please

它默认用内置的 `GITHUB_TOKEN`，而 GitHub 规定 **`GITHUB_TOKEN` 产生的事件不会触发新 workflow**：

1. 它打的 tag 触发不了 `publish.yml`（包发不出去）
2. 它开的版本 PR 不会有 CI 结果，会被分支保护**卡死**

要修就得给它 PAT（有过期）或 GitHub App（私钥不过期）。收益只剩「自动写 changelog」，
而我们现在用 `--generate-notes` 已经解决。**结论：不上**，除非将来多人协作。

---

## 四、本地开发

### 现在装的是哪个

desktop profile 里装的是 **npm 上的版本**（`~/.dsh/profiles/desktop/package.json` 里 pin 的精确版本），
不是目录 link。所以**改仓库代码不会自动生效**。

### 想在本地改代码并立刻看效果

```bash
# 切成目录 link（开发模式）
plugin_manager remove_bundle dsh-peak-price-guard
plugin_manager install_bundle link:/Users/nowscott/Documents/开发项目/08_dsh/DshPeakPriceGuard
```

改完 `client.js` **刷新页面**（Cmd+R）即可，不用重装。想切回线上版本：

```bash
plugin_manager remove_bundle dsh-peak-price-guard
plugin_manager install_bundle dsh-peak-price-guard@0.4.3
```

> `install_bundle` 对已安装的包会报 `already-installed`，所以永远先 `remove_bundle`。

### 验证

```bash
npm test                 # 45 项（node --test test/*.test.mjs）
                         #   peak.test.mjs —— Client：直接执行 client.js
                         #   host.test.mjs —— Host：直接调 apply()，假 ctx + 假 req/res
node scripts/check.mjs   # 打包自检：files 路径、npm 徽章、字典 key 对齐、语法
```

`test/peak.test.mjs` 用 `window.__ModuleLoader__` + 极简 React 桩直接执行真实的 `client.js`，不是复制品。
`test/host.test.mjs` 不依赖 Harness：`apply()` 只碰传给它的 ctx，所以测试给一个假 ctx 就够了。

---

## 五、容易忘的事

- 改了 `client.js` → 必须刷新页面才生效；改了工作流 → 必须 push 才生效。
- 发版前先确认 `main` 是干净的、CI 是绿的。
- 节假日数据每年 11 月左右更新，插件会自动拿到；如果某年数据缺失，设置页会显示用了哪一层。
- `npm view dsh-peak-price-guard dist-tags` 可以确认线上版本。
- 插件出问题先看输入框下方的胶囊：红字「未生效」= 闸门没装上，先查 DSH 是否改了 `sendSession`。

---

## 六、还没做的

1. **真实界面截图**：README 里只有手绘 banner 和文字描述（英文 README 已补）
2. **Dependabot**：自动升级 workflow 里的 action 版本
