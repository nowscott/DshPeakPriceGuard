# DshPeakPriceGuard · 高峰价格提醒

> DeepSeek Harness 插件 · npm 包名 `dsh-peak-price-guard` · MIT · [github.com/nowscott/DshPeakPriceGuard](https://github.com/nowscott/DshPeakPriceGuard)

DeepSeek 有两档计费：北京时间**周一至周五的 09:00–12:00、14:00–18:00 是高峰（标准价）**，其余时段——晚上、夜间、周末、中国法定节假日——全天都是**特价（优惠价）**。

这个插件在高峰时段按下发送时**先不发出**，而是弹一个提醒，只有点「仍要发送」才真正提交；点「先不发」/Esc/点遮罩则把草稿和附件退回输入框。特价时段完全不拦截。

## 用起来是什么样

- **输入框下方一个小胶囊**：`● 高峰时段 标准价`（红）/ `● 特价时段 优惠价`（绿）；发送被拦下时变成 `● 等待确认`；闸门失效时是 `提醒 未生效`。
  鼠标悬停（或键盘聚焦）会弹出说明：现在哪一档、什么时候切换、以及去哪里改——不用猜这个提示是干嘛的。
- **确认框**：显示当前北京时间、这条消息的预览、哪个会话、以及「{when} 起恢复特价」；可勾选「本次会话 N 分钟内不再提醒」。
- **设置 → 高峰价格提醒**：开关提醒、改高峰时段、节假日是否按特价、会话静默时长、价格胶囊开关、恢复默认；底部显示节假日数据的同步状态。

## 高峰时段的写法

`HH:MM-HH:MM`，逗号分隔多段，例如：

```
09:00-12:00, 14:00-18:00
```

- 留空 = 任何时段都不提醒。
- `00:00-24:00` = 全天都提醒（**自测提醒效果就用这个**，不必等到明早）。
- 格式无法识别时沿用上一组时段，输入框会标红。
- 只对工作日生效；节假日是否豁免由「法定节假日按特价」控制。

## 节假日数据会自动更新

假期安排每年 11–12 月才由国务院公布，写死在代码里的表必然会在某一年失效。所以插件在启动时从
[`NateScarlet/holiday-cn`](https://github.com/NateScarlet/holiday-cn)（MIT）拉取**当年和下一年**的放假日 JSON——它每天从国务院公告重新抓取、变更时自动发版，经 jsDelivr 分发，CORS 开放，浏览器可直接读取。

三层兜底，任何一层挂了都不会把假期误判成高峰：

1. **cookie 缓存**（`dsh_peak_price_guard_holidays`，30 天）：页面首帧就是对的，断网启动也一样。
2. **在线拉取**：每次加载 + 每 12 小时刷新一次；某一年的数据一旦到手，就对该年拥有最终解释权（公告修正也会随之生效）。
3. **内置表**（2025–2026 的硬编码日期）：只在前两层都拿不到该年数据时回答。

缓存刻意不放 `localStorage`：Desktop 每次启动是随机端口，origin 含端口，`localStorage` 会被清空；cookie 只按 host 归属，跨重启有效。

## 实现要点

1. **发送闸门**：UI 的发送最终都走 ui-conversation 的 `conversation.sendSession`，插件把该方法在服务原型上包一层（`ctx.get('conversation')` 返回 traceable proxy，实例级赋值不可靠，所以改原型），卸载时还原。
2. **拦下时不报错**：闸门返回该出口自带的失败结果 `{kind:'error'}`，ui-conversation 会自己恢复草稿、保留附件，且不弹错误提示。
3. **弹窗**注册在 `shell.overlay`，**胶囊**注册在 `conversation.composer.dock`，**设置页**注册在 `settings.section`。
4. **偏好存在浏览器**：cookie `dsh_peak_price_guard`（主）+ `localStorage`（镜像）。
   原因有两层：Client 半部拿不到 `cordis.patch.yml` 的行配置（boot manifest 创建 client 插件条目时没有 config），而走设置文档（`configForms`）需要 Host 侧 schemastery schema —— 以目录 link 安装的包解析不到 `@deepseek-ai/schemastery`。所以偏好是本机浏览器级的，不进配置文件。

## 两个踩过的坑

- **确认框曾经完全不出现**：`ConfirmDialog` 在「没有待确认请求」时先 `return null`，之后再调用 slot 提供的 `useSessions`。请求一到，hook 数量从 1 变 2，React 抛 "Rendered more hooks than during the previous render"，整个 slot entry 变空白——表现就是发送按钮转圈、消息发不出去、也没有弹窗。现在所有 hook 都在早退之前无条件调用，并有专门的回归测试。
- 确认框通过 `createPortal` 挂到 `document.body`：`shell.overlay` 之外任何带 `overflow`/`transform` 的祖先都裁不到它。

## 已知限制

- **依赖内部接口** `conversation.sendSession`，不是官方扩展点。上游改名时插件会静默失效，所以加了启动自检：一旦包装后在 proxy 上读不回来，胶囊变红、设置页顶部出现提示。
- 只拦**人工发送**（Enter/发送按钮，含 busy 时的 queue/steer 提交）。`updateQueue(steer)` 重发的是已在队列里的消息，那一条在入队时就问过了；定时任务等程序化 prompt 不会拦——没人能确认。
- 节假日数据依赖第三方仓库与 CDN；两者同时不可用且缓存过期时，会退回内置表（2025–2026），此后新一年的假期可能被误判为高峰。设置页会显示当前用的是哪一层。
- 静默窗口只活在本次页面生命周期内，刷新即清空（符合「本次会话」的语义）。
- 偏好不进 `cordis.patch.yml`，因此不会随插件分发给别人，也不会出现在配置文件里；换浏览器/清 cookie 后回到默认值。
- 设置页「高峰时段」格式错误时不会写坏偏好：沿用上一组时段并在输入框标红。

## 安装

在 DSH 的设置 → 插件里安装，或让 Agent 执行：

```
plugin_manager install_bundle <目录绝对路径 或 npm 包名>
```

目录 link 安装时，改完 `client.js` 需要刷新页面才会加载新版本。

## 开发与验证

```bash
node --test test/peak.test.mjs   # 26 项
```

覆盖：时段边界、节假日判定与在线数据替换、下次高峰、时段解析、偏好归一化、闸门流程、静默、FIFO、abort、弹窗 hook 顺序、胶囊状态、cookie 持久化。

`test/` 用 `window.__ModuleLoader__` + 一个极简 React 桩直接执行 `client.js`，所以测的是真实代码路径，而不是复制品。

## 卸载

插件管理页停用「高峰价格提醒」即可；卸载后发送立即恢复原样，`localStorage` 里那条偏好不会被自动清除（无副作用）。

## 许可证

MIT，见 [LICENSE](./LICENSE)。

节假日数据来自 [NateScarlet/holiday-cn](https://github.com/NateScarlet/holiday-cn)（MIT），由该项目的 CI 从国务院公告生成。
