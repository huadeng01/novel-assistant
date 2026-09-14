# 墨语 · 每日小说榜单抓取（GitHub Actions）交接文档

> **给谁看**：负责实现「每日榜单抓取」的智能体 / 开发者。
> **要做什么**：用 GitHub Actions 每天定时跑一个 Node 抓取脚本，从多个主流网文平台抓取**热门榜单元数据**，产出 `public/ranks.json` 提交回仓库，并让 GitHub Pages 上的墨语 SPA 顶栏「榜单」区读到它。
> **绝对红线**：**只抓榜单元数据（书名/作者/封面/简介/分类/排名/官方链接），不抓正文、不抓章节目录、不复制转载、点击一律外链官方页面。** 详见 §6 合规红线。
> 生成时间：2026-09-08。

---

## 0. TL;DR（先看这段）

- 墨语是**纯前端 SPA**（React 18 + Vite 6 + Tailwind 4，无后端）。浏览器 JS 直连小说平台会被 **CORS 拦截**且有反爬，所以抓取必须放在**服务端**——这里用 **GitHub Actions runner** 每日定时跑 Node 脚本。
- 产物是一份**静态快照** `public/ranks.json`；SPA 运行时只 `fetch` 这份本地 JSON，**保持「无后端」**。
- 抓取脚本 `scripts/fetch-ranks.mjs`（Node 20 ESM，用内置 `fetch`，尽量零重依赖）：每个平台一个 adapter，先**运行时校验 robots.txt**，命中 Disallow 就跳过；限速、并发=1、失败跳过不阻塞。
- 工作流 `.github/workflows/fetch-ranks.yml`：`schedule`（每日 cron）+ `workflow_dispatch`（手动）；抓取 → 提交 `public/ranks.json` 回 `main` → **在同一个 workflow 内直接 build + 部署 Pages**（原因见 §5「关键坑」：`GITHUB_TOKEN` 的提交不会触发 `deploy.yml`）。
- **最大不确定性**：GitHub 托管 runner 在**美国 Azure**，访问国内平台可能慢 / 被地域限制 / 被数据中心 IP 反爬拦截。必须**容错跳过**，必要时改用**国内 self-hosted runner**。见 §5。

---

## 1. 架构与数据流

```
GitHub Actions (schedule: 每日 cron)
        │  ubuntu-latest runner（美国 Azure）
        ▼
node scripts/fetch-ranks.mjs
        │  ① 逐平台 fetch /robots.txt → 校验是否允许
        │  ② 允许的 → 抓「榜单列表页」HTML（SSR）
        │  ③ 解析 SSR JSON/DOM → 抽取元数据记录
        │  ④ 限速 Crawl-delay、并发=1、超时/重试≤3、失败跳过
        ▼
public/ranks.json（带 generatedAt 时间戳 + 各平台列表）
        │  git commit + push 回 main（GITHUB_TOKEN, contents: write）
        ▼
同一 workflow 内 npm run build → 部署 GitHub Pages
        │
        ▼
墨语 SPA 顶栏「榜单」tab → fetch('./ranks.json') → 渲染榜单卡片
        │  点击某本书
        ▼
window.open(officialUrl, '_blank', 'noopener')  ← 外链官方阅读页，不在本应用展示任何正文
```

**为什么用快照而非实时**：① 纯前端无后端，实时抓取绕不开 CORS；② 榜单每日更新一次足够；③ 快照天然限速、可审计、对平台压力最小；④ 与参考项目 `staysharp1104/WebCrawler`（每周定时刷新 + 本地存储）思路一致。

---

## 2. 平台清单与 robots.txt 核验（2026-09-08 实测）

> 原则：**只纳入 robots 明确允许通用爬虫（`User-agent: *`）访问榜单/书籍页的平台**；robots 整站禁止或强反爬的一律排除或降级处理。**运行时仍需重新 fetch robots 校验**（协议会变，不硬编码信任）。

### 2.1 ✅ 可纳入（robots 允许，榜单元数据可抓）

> 每平台按各自实际榜单配置（listId 语义化：hot 主热度、new 新书、finish 完结/完本、collect 收藏、ticket 月票/银票、update 更新、free 免费、reading 阅读、best-sale 畅销、total 总分、half-year 半年、click-week/click-month 周/月点击、popular 人气等，平台内唯一）。平台无「新书榜」命名时，酌情选用能反映近期热度的榜单（月/周/半年/阅读等）替代，见下表「榜单（listId: listName）」列。

| 平台 | 域名 | robots `User-agent:*` 结论 | 榜单（listId: listName · 数据源 URL） | 解析方式（参考 repo `staysharp1104/WebCrawler`） |
|---|---|---|---|---|
| 番茄小说 | `fanqienovel.com` | `Allow: /` | hot 阅读榜 `/rank/1_2`；new 新书榜 `/rank/1_1`（实测无完结榜 SSR） | SSR `__INITIAL_STATE__` + 详情页 head 区补全真实书名（**不碰正文**；正文有字体加密，我们不抓正文） |
| 七猫小说 | `qimao.com` | `Allow: /` | hot 热度月榜 `/paihang/boy/hot/month/`；new 新书日榜 `/paihang/boy/new/date/`；finish 完结榜 `/paihang/boy/over/date/`；collect 收藏榜 `/paihang/boy/collect/date/` | 排行页 SSR `li.rank-list-item`（结构统一，四榜同源） |
| QQ阅读 | `book.qq.com` | `Allow: /`（`Disallow: /so/ /intro.html` 等） | hot 热门榜 `/book-rank/male-sell/cycle-1`（上架30天）；new 新书榜 `/book-rank/male-new/cycle-1`；free 免费榜 `/book-rank/male-free/cycle-1`；finish 完结榜 `/book-rank/male-finish/cycle-1` | Nuxt SSR `div.book-large.rank-book`（`a.wrap[title]`+书ID、`h4.title`、`p.intro`、`p.other`）；封面 JS 懒加载无 `src` → 留空；排名=列表顺序 |
| 晋江文学城 | `jjwxc.net` | `Allow: /`（仅 `Disallow: /sp`） | month 月度榜 `topten.php?orderstr=10`；quarter 季度榜 `orderstr=4`；half-year 半年榜 `orderstr=6`；total 总分榜 `orderstr=7`（无新书榜，按近期热度替代） | 榜单页 HTML/DOM 表格行；GBK |
| 潇湘书院 | `xxsy.net` | `Allow: /`（仅 `Disallow: /so/`） | ticket 潇湘票榜 `/rank`（默认页 li.n2，含作者/名次）；reading 阅读榜 `/rank/reading`；finish 完结榜 `/rank/finish`（本周完结）；best-sale 畅销榜 `/rank/bestsales`（本月畅销；`/rank/new` 为 SPA 壳故不用） | 默认页 SSR `li.n2`（`span.piao` 作者/`span.num` 名次/`p>a` 书名）；其余 SSR `a.page-one`（`title` 书名+`/book/{id}`+封面 `bookcover.yuewen.com`） |
| 纵横中文网 | `zongheng.com` | `Allow: /`（`Disallow: *.css/*.js`） | popular 人气榜 `/rank/`（其余榜 tab 为 SPA 前端切换，SSR 无数据；按合规不破译） | 榜单页 HTML/DOM `div.zh-modules-rank-book` |
| 刺猬猫 | `ciweimao.com` | 禁 `/recharge/ /user/ /payment/ /admin/` 等后台/付费路径，其余允许；有 book/chapter sitemap | click-week 周点击榜 `rank-index/no-vip-click-week`；click-month 月点击榜 `rank-index/no-vip-click-month`；ticket 月票榜 `rank-index/yp`；collect 收藏榜 `rank-index/favor`（无新书榜，按周/月榜替代） | 榜单页 HTML/DOM `ol.rank-book-list`；**需浏览器 UA 回退**（平台对机器人 UA 404，已透明记录） |
| 塔读文学 | `tadu.com` | `Allow: /`（`Disallow: /tadu/, /search, *.css/*.js`） | popular 人气榜 `/book/rank/list/0-hour72-0-0-1`；new 新书榜 `/book/rank/list/0-potential-0-0-1`；finish 完本榜 `/book/rank/list/0-wholebook-0-0-1`；ticket 银票榜 `/book/rank/list/0-votes-0-0-1` | 榜单页 HTML/DOM `div.booklist`（`NO.x` 排名） |
| 书旗小说 | `shuqi.com` | 仅 `Disallow: /about/ /excellence /inviteauthor /label /comment`，其余允许；海量 `book_sitemap_all_pc_*.xml` | 单页多区块（`/rank/` 一次解析）：click 点击榜 / collect 收藏榜 / order 订阅榜 / popular 人气榜 / finish 完结榜 / update 更新榜（男频组） | 榜单页 HTML/DOM（同页多区块 `ul.cp-ranks-list`） |
| 17K 小说网 | `17k.com` | `Allow: /`（`Disallow: /azapp*, /ck*`） | —（阿里云 WAF JS 挑战，按合规跳过） | — |

> 平台表顺序 = 前端展示顺序（按平台主流程度/用户体量排序：免费阅读头部 → 阅文系与女频大站 → 其余）。
> adapter 结构：`lists: [{listId, listName, url}]`（平台内榜单配置，数量因平台而异）；`parse(html, ctx)` 返回 books 数组；书旗等单页多榜平台返回 `[{listId, listName, books}]`。前端按平台渲染各自榜单 tab。
### 2.2 ⚠️ 谨慎 / 降级处理

| 平台 | 域名 | robots 结论 | 处理建议 |
|---|---|---|---|
| 飞卢小说 | `feilu.com` | 本次核验**连接超时**，robots 未取到 | **实现时必须先成功 fetch 到 robots.txt 并确认允许**，否则不纳入。 |

### 2.3 ❌ 明确排除（不得抓取）

| 对象 | 原因 |
|---|---|
| 起点中文网 `qidian.com` | **全站 WAF（JS 挑战）**：`/robots.txt` 与榜单页均返回 HTTP 202 + `probe.js` 挑战（17K 同款），浏览器 UA 访问同样被拦。按合规不破译、不伪装，明确不可行。 |
| 红袖添香 `hongxiu.com` | robots 允许，但**独立榜单页为 SPA 壳**（SSR 无数据），首页各榜单区块仅 SSR 1-2 本 → 数据量不足，无法成榜。 |
| SF 轻小说 `sfacg.com` | 原小说站**已转型漫画站**（首页标题/关键词全为漫画），无小说榜单可抓。 |
| 掌阅 `zhangyue.com` | robots **`User-agent: * → Disallow: /`（整站禁止通用爬虫）**，仅放行指定搜索引擎。抓取即违反 robots。 |
| 笔趣阁及各类盗版聚合站 | 内容本身侵权，抓取/展示=帮助传播盗版。 |
| 知乎盐选 / 任何付费墙内容 | 有**明确刑事判例**（爬付费网文做免费小程序 → 侵犯著作权罪获刑），且属破解技术措施。 |
| 咪咕 / 微信读书 等 App 为主、Web 受限的平台 | Web 端多需登录/加密，且未逐一核验 robots；如需纳入，**必须先核验 robots + 确认无反爬**再单独评估。 |

> **扩展新平台的硬规则**：任何新增平台，必须①成功 fetch 其 `/robots.txt` 并确认 `User-agent:*` 允许目标榜单路径；②确认目标页无登录墙/验证码/字体加密；③只取榜单元数据；④低速。三者缺一不纳入。

---

## 3. 输出契约：`public/ranks.json` schema

> **这是抓取脚本（本文件）与前端 UI（`RanksPage.jsx`）之间的硬契约**。前端已按此 schema 实现，脚本输出必须匹配。字段可多不可少（前端忽略未知字段），但 `platform / ok / lists[].books[].{rank,title,author,officialUrl}` 必须存在。

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-09-08T22:00:00.000Z",          // ISO UTC
  "generatedAtLocal": "2026-09-09 06:00 (Asia/Shanghai)", // 供 UI 展示的本地时间字符串
  "sources": [
    {
      "platform": "fanqie",                 // 稳定英文 id
      "platformName": "番茄小说",            // 展示名
      "home": "https://fanqienovel.com",
      "ok": true,                            // 本平台是否抓取成功
      "error": null,                         // 失败时的原因字符串（跳过原因，如 "robots-disallow" / "timeout" / "http-403"）
      "robotsAllowed": true,                 // 运行时 robots 校验结果
      "fetchedAt": "2026-09-08T22:00:03.000Z",
      "lists": [
        {
          "listId": "hot",                   // 榜单 id（hot=热度榜 / new=新书榜，平台无对应榜时用替代榜名）
          "listName": "热门榜",
          "category": "全部",
          "books": [
            {
              "rank": 1,
              "title": "书名",
              "author": "作者",
              "cover": "https://…/cover.jpg", // 可空；封面为平台宣传图，直接热链
              "intro": "简介，建议截断到 ≤120 字", // 可空
              "category": "都市",              // 可空
              "officialUrl": "https://fanqienovel.com/page/xxxx", // 必填：官方书籍页，点击外链跳转
              "extra": { "status": "连载", "wordCount": "120万字" } // 可选附加元数据
            }
            // … 建议每榜 Top 20~50
          ]
        }
      ]
    }
    // … 其它平台；抓取失败的平台也要保留一条 { platform, ok:false, error }，便于 UI 显示「该平台今日不可用」
  ]
}
```

**约束**：
- **不得包含任何正文章节内容、章节标题列表、章节 URL**。`officialUrl` 指向书籍主页即可（用户点进去在官方站阅读）。
- `intro` 只取平台公开展示的简介，截断到 ≤120 字。
- 抓取失败的平台**不要整份失败**：保留 `ok:false` 占位，其余平台照常输出。
- 文件放 `public/ranks.json`（Vite 构建时原样拷进 `dist/` 根）。

---

## 4. 抓取脚本规格：`scripts/fetch-ranks.mjs`

### 4.1 运行环境
- Node 20（用内置全局 `fetch`，无需 `node-fetch`）。
- ESM（项目 `package.json` 已 `"type": "module"`）。
- **尽量零重依赖**：优先用正则/`JSON.parse` 抽取 SSR 内联 JSON（`__INITIAL_STATE__` / `__NUXT__` / `<script type="application/json">`）。若某平台必须解析复杂 DOM，可加 `cheerio`（唯一可接受的新依赖），并在 PR 说明。

### 4.2 结构（建议）
```
scripts/
  fetch-ranks.mjs        # 入口：遍历 adapters → 汇总 → 写 public/ranks.json
  ranks/
    robots.mjs           # fetchRobots(origin) + isAllowed(robotsText, path, ua)  ← 运行时 robots 校验
    http.mjs             # get(url)：正规 UA、超时、重试≤3、Crawl-delay 节流
    adapters/
      fanqie.mjs         # { id, name, home, rankUrls[], parse(html) -> lists[] }
      qimao.mjs
      jjwxc.mjs
      zongheng.mjs
      k17.mjs
      ciweimao.mjs
      tadu.mjs
      shuqi.mjs
      index.mjs          # 汇总导出 adapter 列表
```

### 4.3 每个 adapter 的契约
```js
export default {
  id: 'fanqie',
  name: '番茄小说',
  home: 'https://fanqienovel.com',
  // 只列「榜单列表页」URL（1~2 个即可），绝不列章节/正文页
  rankUrls: ['https://fanqienovel.com/rank'],
  // 输入榜单页 HTML，输出 §3 的 lists[]（只含元数据）
  parse(html) { /* 抽 __INITIAL_STATE__ → 映射成 books[] */ return [{ listId, listName, category, books }] },
  // 可选：把书详情拼成 officialUrl 的规则
  officialUrlOf(book) { return `https://fanqienovel.com/page/${book.bookId}` },
}
```

### 4.4 合规护栏（脚本必须实现）
1. **运行时 robots 校验**：抓任一 URL 前，先 `fetch(origin + '/robots.txt')`，解析 `User-agent:*` 段的 `Disallow/Allow`，若目标 path 被 Disallow → **跳过该平台**（记 `error:'robots-disallow'`）。robots 取不到（404）→ 记 `robotsAllowed:'no-robots-file'`，SF 轻小说这类可继续但低速；取不到且超时 → 跳过。
2. **透明 UA**：用一个**诚实、可识别**的 UA，例如 `Mozilla/5.0 (compatible; MoyuRankBot/1.0; +https://github.com/<你的仓库>/blob/main/docs/榜单抓取_GitHubActions_交接文档.md)`。**严禁伪装成 Googlebot/Baiduspider 或任何 AI-bot 绕过规则**（起点显式屏蔽 AI-bot；伪装搜索引擎 UA 属欺骗）。
3. **限速**：并发=1（串行）；同域两次请求间隔 ≥5s（`Crawl-delay` 若更大则取更大值）；每平台只抓榜单列表页（1~2 页），**不做全站/深层爬取**。
4. **超时/重试**：单请求超时 15s；失败重试 ≤3 次（指数退避）；仍失败 → 跳过该平台，不阻塞其它平台。
5. **不破解技术措施**：遇验证码 / 字体加密 / 签名校验 / 登录墙 → **立即跳过该平台**，绝不尝试绕过（破解技术措施可能涉刑）。
6. **最小必要采集**：只取 §3 列出的元数据字段，取到即止。

### 4.5 输出
- 汇总所有 adapter 结果（含失败占位）→ 写 `public/ranks.json`（UTF-8，2 空格缩进）。
- 控制台打印每平台 `ok/skip/error` 摘要 + 总条数，便于 Actions 日志排查。
- 退出码：全部平台失败才 `process.exit(1)`；有 ≥1 平台成功即 `exit(0)`（避免单平台故障让整个 workflow 红）。

---

## 5. GitHub Actions 工作流：`.github/workflows/fetch-ranks.yml`

### 5.1 ⚠️ 关键坑（务必理解，否则数据不会上线）
1. **`GITHUB_TOKEN` 的提交不会触发其它 workflow**：GitHub 为防递归，用仓库自带 `GITHUB_TOKEN` push 的代码**不会**触发 `deploy.yml`。所以「抓取 workflow 提交 ranks.json → 自动触发 deploy.yml 重建 Pages」这条链**默认不成立**。
   - **解决方案（本文档采用）**：在 `fetch-ranks.yml` **同一个 workflow 内**，提交 ranks.json 后**直接 build + 部署 Pages**（见下方 YAML 的 `deploy` 步骤），不依赖 deploy.yml。
   - 备选：用一个 **PAT（Personal Access Token）** 存到 secrets，用 PAT 提交（PAT 的 push 会触发 deploy.yml）。缺点是要额外管理密钥。**推荐前者（自包含）**。
2. **`schedule` 只在默认分支生效**：cron 只会在 `main`（默认分支）上触发；PR/其它分支不会定时跑。
3. **cron 是 UTC 且可能延迟/跳过**：GitHub 定时在高峰期可能延迟数分钟至数小时，偶发跳过。「每日」是**尽力**而非准点。北京时间 = UTC+8（下方示例 UTC 22:00 = 北京次日 06:00）。
4. **runner 地域**：GitHub 托管 runner 在**美国 Azure**。访问国内平台可能：慢、被地域限制、被数据中心 IP 段反爬拦截。**这是本方案最大不确定性**（见 §7）。
5. **Pages 部署需要 `pages: write` + `id-token: write`**（沿用现有 deploy.yml 的权限）。

### 5.2 完整 YAML（可直接用，按需改仓库/时间）
```yaml
name: Fetch novel ranks (daily)

on:
  schedule:
    - cron: '0 22 * * *'      # UTC 22:00 = 北京时间次日 06:00；可调整/加多个时点
  workflow_dispatch: {}        # 允许手动触发（调试必用）

permissions:
  contents: write              # 提交 ranks.json 回仓库
  pages: write                 # 部署 Pages
  id-token: write              # Pages 部署所需

concurrency:
  group: ranks-daily
  cancel-in-progress: false

jobs:
  fetch-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - run: npm ci

      - name: Fetch ranks (metadata only, robots-respecting)
        run: node scripts/fetch-ranks.mjs
        continue-on-error: false

      - name: Commit ranks.json (skip if unchanged)
        run: |
          git config user.name  "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add public/ranks.json
          if git diff --cached --quiet; then
            echo "ranks.json 无变化，跳过提交"
          else
            git commit -m "chore(ranks): daily snapshot $(date -u +'%Y-%m-%dT%H:%MZ')"
            git push
          fi

      # 自包含部署（不依赖 deploy.yml，规避 GITHUB_TOKEN 不触发其它 workflow 的坑）
      - name: Build
        run: npm run build
      - uses: actions/upload-pages-artifact@v3
        with:
          path: dist
      - uses: actions/deploy-pages@v4
```

> 若采用「PAT 提交 + 复用 deploy.yml」的备选方案：把上面 `Commit` 步骤换成 `stefanzweifel/git-auto-commit-action@v5` 并配 `GITHUB_TOKEN`→PAT，然后删掉本 workflow 的 Build/Deploy 三步（交给 deploy.yml）。二选一，不要同时（会重复部署）。

### 5.3 与现有 `deploy.yml` 的关系
- 现有 `deploy.yml`：`push: branches:[main]` + `workflow_dispatch` → build → 部署 Pages。
- 本 workflow 自己也会 push（提交 ranks.json）。为避免两条 workflow 抢部署：本 workflow **自包含部署**且用 `concurrency.group` 与 deploy.yml 错开；deploy.yml 的 push 触发因 `GITHUB_TOKEN` 限制**不会**被本次 push 触发（正好，避免重复）。手动 `git push`（真人）仍会触发 deploy.yml，正常。

---

## 6. 合规红线（不可逾越）

1. **只元数据**：仅抓 §3 字段（排名/书名/作者/封面/简介/分类/官方链接）。**绝不抓正文、章节内容、章节目录、章节 URL。**
2. **不复制转载**：点击 → `window.open(officialUrl,'_blank','noopener')` 外链官方阅读页；本应用**不存储、不展示、不缓存任何正文**。
3. **尊重 robots**：只抓 `User-agent:*` 允许的平台/路径；运行时校验；命中 Disallow 即跳过；掌阅等整站禁止的**永不抓**。
4. **尊重反 AI-bot 意图**：起点等显式屏蔽 AI 爬虫的平台，**不伪装 UA 绕过**；不确定就跳过。
5. **不破解技术措施**：验证码/字体加密/签名/登录墙 → 跳过，绝不绕过（破解可能触犯「非法获取计算机信息系统数据罪」「破坏技术措施」）。
6. **最小必要 + 限速**：并发=1、Crawl-delay≥5s、只抓榜单列表页、每日一次。
7. **排除侵权源**：盗版聚合站（笔趣阁等）、付费墙内容（知乎盐选等，有刑事判例）一律不碰。
8. **法律背景（务必知悉）**：抓取并**传播**小说正文构成侵犯著作权，入罪门槛极低（传播≥500 篇 / 点击≥10 万 / 违法所得≥5 万，满足其一即可），已有多起判例获刑。**本方案通过「只元数据 + 外链」从根本上规避该风险**——请严格遵守，不要"顺手"把正文也抓了。

---

## 7. 关键风险与缓解（诚实告知）

| 风险 | 说明 | 缓解 |
|---|---|---|
| **地域/IP 拦截（最大）** | GH runner 在美国 Azure，国内平台可能地域限制或以数据中心 IP 反爬 | ①每平台容错跳过，≥1 成功即上线；②实测哪些平台从 GH runner 可达；③不可达的多，改用**国内 self-hosted runner**（自己的国内机器/VPS 注册为 runner）或国内 CI；④或退化为「本地/服务器 cron 跑脚本 + 提交」 |
| **cron 不准点/被跳过** | GH 定时高峰期延迟或跳过 | 「每日」为尽力；可加多个 cron 时点；用 `workflow_dispatch` 兜底手动 |
| **反爬升级** | 平台改 SSR 结构 / 加签名 / 加验证码 | adapter 解析失败即跳过并记 error；定期看 Actions 日志；不破解 |
| **robots 变更** | 平台随时改 robots | 脚本**运行时**重新校验，不硬编码信任 |
| **封面热链失效** | 平台防盗链 | cover 允许为空；UI 做占位/降级 |
| **法律/ToS** | 某些平台 ToS 禁止一切自动化访问（即使 robots 放行） | 只做元数据+外链+限速；如收到平台投诉/封禁，立即移除该平台 |

---

## 8. 验收标准

- [ ] `node scripts/fetch-ranks.mjs` 本地能跑通，产出结构符合 §3 的 `public/ranks.json`（≥3 个平台 `ok:true`，字段完整，`officialUrl` 可在浏览器打开官方书籍页）。
- [ ] 脚本对每个平台**先校验 robots**，Disallow 的平台被跳过并在 JSON 里记 `ok:false, error:'robots-disallow'`。
- [ ] 全程**无任何正文/章节内容**被抓取或写入 JSON（可 grep 校验字段白名单）。
- [ ] `.github/workflows/fetch-ranks.yml` `workflow_dispatch` 手动触发成功：抓取 → 提交 ranks.json → 部署 Pages 全绿。
- [ ] Pages 上线后，墨语顶栏「榜单」tab 能读到 `ranks.json` 并渲染；点击书籍外链到官方页；无 CORS/404。
- [ ] Actions 日志显示限速生效、失败平台被优雅跳过。

---

## 9. 交给执行智能体的 TODO 清单

1. 建 `scripts/ranks/`（robots.mjs / http.mjs / adapters/*）与 `scripts/fetch-ranks.mjs`（§4）。
2. 先实现 **番茄 + 七猫**（repo `staysharp1104/WebCrawler` 已验证 SSR 解析路径：番茄 `__INITIAL_STATE__`、七猫 `__NUXT__`），跑通端到端。
3. 再逐个加 **晋江 / 纵横 / 17K / 刺猬猫 / 塔读 / 书旗**（各平台榜单页结构需实地看 HTML 确认选择器/JSON 路径）。
4. 起点：**默认跳过**；若要纳入，只抓 SSR 榜单页、避开 `/ajax/`、透明 UA、遇拒即退。
5. 掌阅/盗版站/付费墙：**不实现**。
6. 写 `public/ranks.json`（§3 schema）；若某平台从 GH runner 不可达，在文档/日志标注。
7. 加 `.github/workflows/fetch-ranks.yml`（§5.2）；先 `workflow_dispatch` 手动验证，再依赖 cron。
8. 若 GH runner 地域拦截严重 → 评估 self-hosted runner（国内机器）方案并在 PR 说明。
9. 前端 `RanksPage.jsx`（已由主线实现，读 `./ranks.json`）——抓取侧只需保证输出符合 §3 契约即可，无需改前端。

---

## 附：参考项目
- `staysharp1104/WebCrawler`（Python+Flask+MySQL+Selenium）：番茄/飞卢/七猫/起点榜单 + 前 10 章 + 每周刷新 + 看板。**本方案借鉴其「SSR 解析路径 + 定时刷新 + 本地存储」，但去掉正文抓取（改为外链）、去掉重后端（改为 Actions + 静态 JSON）。**
- `JeniTurtle/fiction-list-spider`（Node.js 可视化爬虫，内置各大榜单）：可参考其 Node 侧榜单解析思路。
