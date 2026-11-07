# materials-helper · 资料助手

**把「资料」类任务自动过一遍：打开页面、让文件加载够时长、上报进度。**

| | |
|---|---|
| 版本 | v1.3.1 |
| 形态 | Tampermonkey 用户脚本（主推）/ Python CLI（可选） |
| 依赖 | 脚本无依赖；CLI 需要 Python 3 + requests |
| 入口 | `userscript/csgmooc-materials.user.js` |

> **适用平台：易智教云课堂（`csgmooc.com`）**
> 只处理该平台的「资料」类任务；其他平台的资料页不会出现按钮，接口也不通用。

---

## 速览（原来的详细说明在下面）

易智教「资料」任务的自动完成。**独立于刷题那套**（刷题在 `..\quiz\`），两套实现二选一：

```
materials\
  README.md          本文件
  userscript\        ★ 油猴版（主推）
    csgmooc-materials.user.js      插件本体（拖进浏览器就能用）
    test_materials_userscript.mjs  离线单测（10 条，桩页面）
    panel-preview.png              面板长什么样
  cli\               ☆ 命令行版（可选，Python）
    materials.py                   list / inspect / complete
    chrome_session.py              从本机 Chrome 只读登录态
    test_materials.py              离线单测（28 条）
    logs\                          每次运行自动落盘的记录（排障用）
```

| | 油猴版 | 命令行版 |
|---|---|---|
| 放哪 | `userscript\` | `cli\` |
| 登录 | **不用管**（跑在你已登录的页面里） | 自动读本机 Chrome（只读），也不用单独登录 |
| 用起来 | 右下角绿色胶囊「资料助手」 | `python materials\cli\materials.py …` |
| 适合 | 日常点按钮 | 不开浏览器批量、排障 |

两个版本是**同一套逻辑**（同一批接口、同一个"两步走"），互不依赖，代码各写各的。

---

## 为什么能"一秒完成"

资料页（`stud_material.min.js`）压根不校验你真实看了多久，它只是把**秒数**报给服务端：

| 环节 | 接口 | 参数 |
|---|---|---|
| 看详情 | `GET classroomDocument/getStuDocumentDetail` | `documentId` / `stuClassId` → `viewDetail`（已看时长、得分） |
| 文档上报 | `POST student/lessonsituation/updatePreviewTime` | `docId` / `scId` / `stuClassId` / `viewTime` |
| 视频上报 | `POST student/lessonsituation/updateWatchTime` | `docId` / `sclassId` / `scId` / `viewTime` / `totalTime` |
| 建查看记录 | `POST student/lessonsituation/preViewDocumentOfImage` | `scDocid` / `stuName` / `sclassid` |

页面自己是 `setInterval(T, 10000)` —— **每 10 秒才上报一次**，关掉预览时再补一次。
既然服务端只认这个数字，那就没必要真播视频。

---

## 油猴版（主推）

**装**：把 `materials\userscript\csgmooc-materials.user.js` 拖进浏览器窗口 → Tampermonkey 弹安装页 → 点安装。

**用**：打开 csgmooc 任意页面，右下角绿色胶囊「**资料助手**」：

1. **刷新列表** → 列出所有班的资料（视频 / 文档 / 图片 分色标出）；
2. **查已看** → 逐份显示已看多少秒；
3. **一键完成** → 二次确认（会告诉你预计要跑多久）后逐份处理，列表上直接显示 `52 秒 ✓` / `跳过` / 失败原因。
   开跑后按钮区会多出一个红色 **停止**，下面显示进度（`已完成 12/147，队列还剩 135 份（约 35 分钟）`）。

**跑起来之后（v1.3.0，抄刷题脚本那套经验）**：

| 行为 | 说明 |
|---|---|
| **互斥** | 同一时间只允许一轮。连点「一键完成」不会开第二个循环（第二次会被拒并提示） |
| **断点续跑** | 队列存在油猴存储里：**刷新页面 / 跳转后再回来，会自动接着跑剩下的**（日志会写「检测到上次没跑完」） |
| **可停止** | 随时点「停止」中断；已写入的不受影响，剩下不会偷偷继续 |
| 代际令牌 | 停止后即使旧循环还在 sleep，下一轮也会自己退出，不会"复活" |

每份资料的顺序是**照着真实页面来的**（v1.2.0）：

```
① 打开       文档 → judgeDocument（页面点「预览」先发这个）
             视频 → videoSliceView（拿播放地址）
② 建记录     preViewDocumentOfImage
③ 读位置     视频还会调 getLastViewTime
④ 分次上报   每 10 秒报一次（1→10→20→…→目标），不是一秒写完
⑤ 回读确认   没确认到就标 unconfirmed
⑥ 份与份之间歇 15~45 秒
```

面板里这 4 个参数都能改：**时长**（每份随机 30~90 秒）、**节拍**（默认 10 秒/次）、
**间隔**（份与份之间 15~45 秒）。改小了跑得快，也更容易看出规律。

面板本身（v1.3.1 收拾过）：标题条只留「标题 + 版本号 + 收起」，账号挪到正文第一行；
节奏那 4 个数字按用途拆成**三行带标签的输入**（停留时长 / 节拍 / 份与份间隔），
不再是一行挤在一起的内联输入框；「停止」用红色危险样式，清单和日志各有自己的分区块。

安全设计：

- **必弹二次确认**才写；
- 已经看过的**不重复建查看记录**（免得多计浏览人数），也**不会把已看时长改小**；
- 秒数取**随机 30~90 秒**（面板里可改），不是恒定 1 秒；
- 上报后**回读确认**，没确认到标 `unconfirmed`，不谎报成功；
- 单份失败不影响其它份。

### 日志（出问题就导这个给我）

面板底部三个按钮：

| 按钮 | 作用 |
|---|---|
| **导出日志** | 下载 `yzj-mat-log-<日期>-<序号>.txt` 到「下载」文件夹 |
| **复制日志** | 直接进剪贴板，粘给我就行 |
| **清空日志** | 清掉运行日志（不影响题库/设置） |

日志里**自带诊断头**，我拿到就能定位，不用你复述：

```
===== 易智教 · 资料助手 诊断日志 =====
脚本版本：1.2.0
导出时间：2026/10/5 23:39:52
页面地址：https://www.csgmooc.com/spoc/html/stud_task.html
浏览器：...
账号：stuId=12885　姓名=李赫　登录态=有效
当前设置：{"min":30,"max":90,"tick":10,"gapMin":15,"gapMax":45}
列表条数：3
登录票据：tok-test…
------------------------------
[2026/10/5 23:39:52] info  脚本启动 v1.2.0：/spoc/html/stud_task.html
[2026/10/5 23:39:52] api   GET student/task/getteachtask → 200 (98ms, 512B)
...
```

每次接口调用（含耗时、返回字节数）都会记一条，日志存在油猴存储里，**刷新页面也不丢**（最多留 1000 条）。

**单测**（离线：注入桩页面 + 假服务端，不打真接口）：

```powershell
node materials\userscript\test_materials_userscript.mjs
```

跑完会顺手把面板渲染成 `materials\userscript\panel-preview.png`。19 条用例里包含：
打开步骤的顺序、分次递增上报、上报之间真有间隔、日志系统，
面板结构（版本号 / 三行节奏设置 / 危险色停止按钮），
以及 v1.3.0 的**互斥 / 停止 / 刷新后续跑**（续跑那条是真的 `page.reload()` 之后再验的）。
脚本改动前的版本备份在 `materials\userscript\backups\`。

---

## 命令行版（可选）

> ⚠️ CLI 版目前是**一口气上报**（没有"打开"步骤、没有分次节拍），跑得快但规律明显；
> 要稳、要像真人，用上面的油猴版。CLI 留着是给"不开浏览器批量/排障"用的。

```powershell
python materials\cli\materials.py list                    # 列出资料（只读）
python materials\cli\materials.py inspect                 # 类型/已看时长/得分（只读）
python materials\cli\materials.py inspect --raw           # 连原始 JSON 一起打
python materials\cli\materials.py inspect --tmid 399816   # 按 id 复核单份（看过的也能查）
python materials\cli\materials.py complete --yes          # 上报（默认随机 30~90 秒）
python materials\cli\materials.py complete --yes --tmid 399816   # 只处理一份
```

**登录态不用你操心**：按顺序找、**每个都真的验活一次**（不是"文件存在就当能用"）：

1. `--session <file>` 显式指定；
2. `work\session.json`（刷题那套写的）；
3. **本机 Chrome 的 sessionStorage**（`chrome_session.py`：只读 leveldb，**不启动、不控制、不杀**浏览器）。

**每次运行都会落盘一份记录**到 `materials\cli\logs\mat-<时间>.log`（连 traceback 都进），
出问题直接把这个文件发我，不用再抓终端。

**单测**（全离线：不打网络、不碰账号、不需要浏览器）：

```powershell
python materials\cli\test_materials.py
```

---

## 实测记录（2026-10-05，账号 李赫 stuId=12885）

**必须两步**——直接报时长会被服务端**静默拒绝**（HTTP 200 但 `data:false`，回读 `viewTime` 仍是 null）：

```
① POST preViewDocumentOfImage {scDocid, stuName, sclassid}  → "更新浏览人数成功"（建立查看记录）
② POST updateWatchTime / updatePreviewTime {docId, scId, …} → data:true（这次才落地）
   回读 getStuDocumentDetail → viewTime=52, isView=1, viewId=13448620  ✅
```

页面点「预览 / 播放」时发的第一条就是 ①。它叫 `preViewDocumentOfImage`，但**文档和视频都要调它**
（名字有误导）。两个版本的单测里都有回归用例盯着这个坑。

实测确认的字段（跟直觉不一样的地方标了 ⚠️）：

| 用途 | 字段 | 说明 |
|---|---|---|
| 上报用的资料 id | **`data.id`** ⚠️ | 399816 这种（班级级）；**不是** `resDocument.docId`（260244，资源 id） |
| 上报用的 scId | `data.scId` | 166335；列表接口里也有 |
| 上报用的班级 id | `getStuDocModules` 的 `stuClassId` | 485991 |
| 已看时长 | `viewDetail.viewTime` | 没看过时是 `null` |
| 看过没 | `viewDetail.isView` | 0/1；`viewId` 非空也表示建过记录 |

另外两条：

- `getStuDocModules` 的 `data` 是**一份份资料平铺的数组**（不是"模块"），每份自带
  `docId / scId / stuClassId / resName / resType` 和班级进度 `viewNum/totalNum`；一个账号一次能列 100+ 份。
- **看完的资料会从列表里消失**（跟交完卷的题一样）——复核单份要用 `inspect --tmid <docId>`，
  它按 id 直接查详情（轮询各班 sclassid），不依赖它还在列表里。

## 已知边界

- 视频的 `totalTime` 直接取上报时长（跟页面"没播完就关掉"一致）。若某门课按"看完比例"算完成，
  得改成真实视频总时长——`getLastViewTime` 只返回 `maxViewTime`，精确值要读播放器元数据。
- 老师若设了 `learnRequire`（学习要求富文本），实测这批都是 `null`；遇到有的先 `inspect --raw` 看一眼。
