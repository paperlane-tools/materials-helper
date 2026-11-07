#!/usr/bin/env node
/**
 * test_materials_userscript.mjs —— 资料助手油猴脚本的离线单测。
 *
 *   node materials\userscript\test_materials_userscript.mjs
 *
 * 做法跟刷题那套一样：把脚本注入一个"同源但没有站点脚本"的页面，
 * 站点接口全部换成桩（内存里的假服务端），不打真接口、不碰账号。
 *
 * 桩服务端刻意还原了实测行为：
 *   - 没有查看记录时，时长上报被**静默拒绝**（HTTP 200 但 data:false，时长不落地）；
 *   - 先调 preViewDocumentOfImage 建立记录后才认。
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { moduleDirs } from "../../scripts/runtime.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(path.dirname(HERE));   // materials/userscript → 项目根

function loadPlaywright() {
  for (const d of moduleDirs()) {
    try { return createRequire("file:///" + d.replace(/\\/g, "/"))("playwright"); } catch { /* next */ }
  }
  return createRequire(import.meta.url)("playwright");
}

const code = fs.readFileSync(path.join(HERE, "csgmooc-materials.user.js"), "utf8");

const SHIM = `
(function () {
  const P = "yzjm_";
  window.GM_getValue = (k, d) => { const v = localStorage.getItem(P + k); return v === null ? d : JSON.parse(v); };
  window.GM_setValue = (k, v) => localStorage.setItem(P + k, JSON.stringify(v));
  window.GM_setClipboard = (t) => localStorage.setItem(P + "__clip", String(t));
  window.confirm = () => true;

  const S = {
    docs: {
      399816: { id: 399816, scId: 166335, taskName: "微课.mp4", resType: 1,
                resDocument: { resName: "微课.mp4", resType: 1, docId: 260244 },
                viewDetail: { viewTime: null, isView: 0, viewId: null, awardScore: null } },
      399817: { id: 399817, scId: 166335, taskName: "讲义.ppt", resType: 0,
                resDocument: { resName: "讲义.ppt", resType: 0, docId: 260245 },
                viewDetail: { viewTime: null, isView: 0, viewId: null, awardScore: null } },
      399818: { id: 399818, scId: 166335, taskName: "扫描件", resType: 3,
                resDocument: { resName: "扫描件", resType: 3, docId: 260246 },
                viewDetail: { viewTime: null, isView: 0, viewId: null, awardScore: null } },
    },
    calls: [],
  };
  window.__mat = S;
  const j = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "Content-Type": "application/json" } });

  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, init) => {
    const u = String(url);
    if (!u.includes("/jxapi2/")) return realFetch(url, init);
    const q = new URL(u).searchParams;
    let body = {};
    if (init && init.body) {
      const raw = String(init.body);
      try { body = raw.trim().startsWith("{") ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw)); }
      catch { body = {}; }
    }
    S.calls.push({ url: u.replace(/^.*\\/jxapi2\\//, ""), method: (init && init.method) || "GET", body });

    if (u.includes("getteachtask")) {
      return j({ errcode: 200, data: [{ id: 11754, className: "24级20班", courseName: "语文（三二）", sclassid: 485991 }] });
    }
    if (u.includes("getStuDocModules")) {
      return j({ errcode: 200, data: [
        { ttId: 11754, scId: 166335, stuClassId: 485991, docId: 399816, resType: 1, resName: "微课.mp4" },
        { ttId: 11754, scId: 166335, stuClassId: 485991, docId: 399817, resType: 0, resName: "讲义.ppt" },
        { ttId: 11754, scId: 166335, stuClassId: 485991, docId: 399818, resType: 3, resName: "扫描件" },
      ] });
    }
    if (u.includes("getStuDocumentDetail")) {
      const d = S.docs[q.get("documentId")];
      return j({ code: 200, data: d || null });
    }
    if (u.includes("videoSliceView")) {
      return j({ errcode: 200, data: { resPrefile: 1, finalviewUrl: "https://x/a.m3u8", studyType: 1 } });
    }
    if (u.includes("judgeDocument")) {
      return j({ code: 200, data: { tresState: 0 } });
    }
    if (u.includes("getLastViewTime")) {
      const d = S.docs[body.docId];
      return j({ code: 200, data: { viewTime: (d && d.viewDetail.viewTime) || 0, maxViewTime: 60 } });
    }
    if (u.includes("preViewDocumentOfImage")) {
      const d = S.docs[body.scDocid];
      if (!d) return j({ errcode: 200, data: { value: 0 } });
      d.viewDetail.isView = 1; d.viewDetail.viewId = 13448620;
      return j({ errcode: 200, errmsg: "更新浏览人数成功", data: { value: 1 } });
    }
    if (u.includes("updateWatchTime") || u.includes("updatePreviewTime")) {
      const d = S.docs[body.docId];
      if (!d) return j({ code: 200, data: false });
      if (!d.viewDetail.isView) return j({ code: 200, data: false });   // ← 没记录就静默拒
      d.viewDetail.viewTime = Number(body.viewTime);
      return j({ code: 200, message: "SUCCESS", data: true });
    }
    return j({ errcode: 200, data: [] });
  };
})();
`;

const { chromium } = loadPlaywright();
setTimeout(() => { console.log("⏱ 超时退出"); process.exit(2); }, 180000).unref?.();

const ctx = await chromium.launchPersistentContext(
  path.join(ROOT, "work", "matlogictest"),
  { headless: true,
    executablePath: process.env.YZJ_CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe",
    args: ["--no-first-run", "--no-default-browser-check"] });
await ctx.addInitScript(SHIM + "\n" + code);

const page = await ctx.newPage();
await page.route("**/stud_task.html*", (route) => route.fulfill({
  status: 200, contentType: "text/html; charset=utf-8",
  body: "<!doctype html><html><head><meta charset='utf-8'><title>stub</title></head><body></body></html>",
}));
await page.route("**/*.js", (route) => route.abort());
page.on("pageerror", (e) => console.log("  [pageerror] " + String(e && e.message).slice(0, 160)));

await page.goto("https://www.csgmooc.com/spoc/html/stud_task.html", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.__yzjMat && window.__mat, null, { timeout: 20000 });
await page.evaluate(() => {
  sessionStorage.setItem("reslibAuthtoken", "tok-test-1234567890");
  sessionStorage.setItem("stuId", "12885");
  sessionStorage.setItem("indexpage:gid", "20");
  sessionStorage.setItem("schoolNum", "20001");
  sessionStorage.setItem("login_name", "李赫");
  window.__mat.calls.length = 0;
});

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✅" : "❌"} ${name}${extra ? "  " + extra : ""}`);
};
const resetServer = () => page.evaluate(() => {
  for (const id of [399816, 399817, 399818]) {
    window.__mat.docs[id].viewDetail = { viewTime: null, isView: 0, viewId: null, awardScore: null };
  }
  window.__mat.calls.length = 0;
});
const urls = (calls) => calls.map((c) => c.url.split("?")[0].replace(/^.*\//, ""));

// 1) 列表：平铺数组 → 3 份，类型识别正确
let r1 = await page.evaluate(async () => {
  const y = window.__yzjMat;
  const docs = await y.listDocs(() => {});
  return { n: docs.length, kinds: docs.map((d) => y.kindOf(d)) };
});
check("listDocs 把平铺数组摊平（3 份），类型认对",
  r1.n === 3 && r1.kinds.join(",") === "video,doc,image", JSON.stringify(r1.kinds));

// 2) 视频：打开 → 建记录 → 读位置 → 分次上报 → 回读
await resetServer();
let r2 = await page.evaluate(async () => {
  const y = window.__yzjMat;
  const [v] = (await y.listDocs(() => {})).filter((d) => d.docId === 399816);
  window.__mat.calls.length = 0;
  const t0 = Date.now();
  const r = await y.completeOne(v, { seconds: 3, tick: 1, stuName: "李赫", log: () => {} });
  const ms = Date.now() - t0;
  const calls = window.__mat.calls;
  return { status: r.status, ms,
           urls: calls.map((c) => c.url.split("?")[0].replace(/^.*\//, "")),
           watches: calls.filter((c) => c.url.includes("updateWatchTime")).map((c) => c.body.viewTime),
           watch: calls.find((c) => c.url.includes("updateWatchTime")).body,
           serverView: window.__mat.docs[399816].viewDetail };
});
check("视频：先「打开」(videoSliceView) → 建记录 → 读位置 → 再报时长",
  r2.status === "ok"
    && r2.urls.findIndex((u) => u.includes("videoSliceView")) < r2.urls.findIndex((u) => u.includes("preViewDocumentOfImage"))
    && r2.urls.findIndex((u) => u.includes("preViewDocumentOfImage")) < r2.urls.findIndex((u) => u.includes("getLastViewTime"))
    && r2.urls.findIndex((u) => u.includes("getLastViewTime")) < r2.urls.findIndex((u) => u.includes("updateWatchTime")),
  JSON.stringify(r2.urls));
check("视频 payload：docId 用 data.id、scId/班级对",
  r2.watch.docId === "399816" && r2.watch.scId === "166335" && r2.watch.sclassId === "485991",
  JSON.stringify(r2.watch));
check("时长是**分次递增**上报，不是一口气写完",
  r2.watches.length >= 3 && r2.watches.join(",") === "1,2,3", JSON.stringify(r2.watches));
check("分次上报之间真的有间隔（不是一秒内连发）",
  r2.ms >= 1500, `${r2.ms}ms`);
check("服务端真的落地了（viewTime=3, isView=1）",
  r2.serverView.viewTime === 3 && r2.serverView.isView === 1, JSON.stringify(r2.serverView));

// 3) 文档：先 judgeDocument 打开，再 updatePreviewTime
await resetServer();
let r3 = await page.evaluate(async () => {
  const y = window.__yzjMat;
  const [d] = (await y.listDocs(() => {})).filter((x) => x.docId === 399817);
  window.__mat.calls.length = 0;
  const r = await y.completeOne(d, { seconds: 2, tick: 1, stuName: "李赫", log: () => {} });
  const calls = window.__mat.calls;
  return { status: r.status,
           urls: calls.map((c) => c.url.split("?")[0].replace(/^.*\//, "")),
           judge: (calls.find((c) => c.url.includes("judgeDocument")) || {}).body,
           prev: (calls.filter((c) => c.url.includes("updatePreviewTime")).pop() || {}).body };
});
check("文档：先 judgeDocument 打开，再 updatePreviewTime 报时长",
  r3.status === "ok"
    && r3.urls.findIndex((u) => u.includes("judgeDocument")) < r3.urls.findIndex((u) => u.includes("updatePreviewTime")),
  JSON.stringify(r3.urls));
check("文档 payload：resourceId 走 resDocid、上报 id 走 data.id",
  r3.judge.resDocid === 260245 && r3.prev.docId === "399817" && r3.prev.scId === "166335"
    && r3.prev.stuClassId === "485991" && r3.prev.viewTime === "2",
  JSON.stringify({ judge: r3.judge.resDocid, prev: r3.prev }));

// 4) 图片类：只建记录，没有时长上报
await resetServer();
let r4 = await page.evaluate(async () => {
  const y = window.__yzjMat;
  const [i] = (await y.listDocs(() => {})).filter((x) => x.docId === 399818);
  window.__mat.calls.length = 0;
  const r = await y.completeOne(i, { seconds: 30, tick: 1, stuName: "李赫", log: () => {} });
  return { status: r.status, urls: window.__mat.calls.map((c) => c.url.split("?")[0].replace(/^.*\//, "")) };
});
check("图片类：只调 preViewDocumentOfImage（没有时长上报）",
  r4.status === "ok" && r4.urls.filter((u) => u.includes("Time")).length === 0
    && r4.urls.some((u) => u.includes("preViewDocumentOfImage")), JSON.stringify(r4.urls));

// 5) 已看过且时长够 → 整条跳过，不发任何写请求
await resetServer();
let r5 = await page.evaluate(async () => {
  const y = window.__yzjMat;
  window.__mat.docs[399816].viewDetail = { viewTime: 600, isView: 1, viewId: 9, awardScore: 0 };
  const [v] = (await y.listDocs(() => {})).filter((d) => d.docId === 399816);
  window.__mat.calls.length = 0;
  const r = await y.completeOne(v, { seconds: 60, tick: 1, stuName: "李赫", log: () => {} });
  return { status: r.status, writes: window.__mat.calls.filter((c) => c.method === "POST").length };
});
check("已看 600 秒：跳过且不发写请求（不会把时长改小）",
  r5.status === "skip" && r5.writes === 0, JSON.stringify(r5));

// 6) 回归：不建记录直接报时长 → 服务端静默拒
let r6 = await page.evaluate(async () => {
  const y = window.__yzjMat;
  window.__mat.docs[399816].viewDetail = { viewTime: null, isView: 0, viewId: null, awardScore: null };
  const r = await y.api("student/lessonsituation/updateWatchTime",
    { method: "POST", form: true, body: { docId: 399816, sclassId: 485991, scId: 166335, viewTime: 52, totalTime: 52 } });
  return { data: r.data, code: r.code };
});
check("没建记录就报时长 → 桩服务端返回 data:false（复现实测行为）",
  r6.data === false && r6.code === 200, JSON.stringify(r6));

// 7) 日志系统：启动/接口调用都进缓冲，导出的文本带诊断头
let r7 = await page.evaluate(() => {
  const y = window.__yzjMat;
  const buf = JSON.parse(localStorage.getItem("yzjm_matLog") || "[]");
  const txt = y.logText({ rows: 3 });
  return { n: buf.length, hasApi: buf.some((x) => x.lv === "api"),
           head: txt.split("\n").slice(0, 9), hasVersion: txt.includes("脚本版本：" + y.VERSION),
           hasAccount: /stuId=12885/.test(txt), hasSettings: /当前设置/.test(txt),
           hasApiLine: txt.includes("GET student/task/getteachtask") };
});
check("日志缓冲里有启动记录和接口调用记录",
  r7.n > 0 && r7.hasApi, JSON.stringify({ n: r7.n, hasApi: r7.hasApi }));
check("导出的日志带诊断头（版本/账号/设置/接口耗时）",
  r7.hasVersion && r7.hasAccount && r7.hasSettings && r7.hasApiLine, JSON.stringify(r7.head));

// 8) 界面：悬浮入口 + 面板 + 日志按钮
await page.click(".yzjm-launcher");
await page.waitForTimeout(400);
let r8 = await page.evaluate(() => {
  const p = document.querySelector(".yzjm-panel");
  return { panel: !!p,
           run: !!document.querySelector('.yzjm-panel [data-a="run"]'),
           load: !!document.querySelector('.yzjm-panel [data-a="load"]'),
           exp: !!document.querySelector('.yzjm-panel [data-a="logexport"]'),
           copy: !!document.querySelector('.yzjm-panel [data-a="logcopy"]'),
           clr: !!document.querySelector('.yzjm-panel [data-a="logclear"]'),
           tick: !!document.querySelector("#yzjm-tick"),
           gap: !!document.querySelector("#yzjm-gapmin"),
           ver: ((p.querySelector(".yzjm-ver") || {}).textContent || "").trim(),
           secs: [...p.querySelectorAll(".yzjm-sec")].map((x) => x.textContent.trim()),
           fields: p.querySelectorAll(".yzjm-field").length,
           nums: [...p.querySelectorAll(".yzjm-num")].map((x) => x.id),
           stopDanger: (p.querySelector('[data-a="stop"]') || { classList: { contains: () => false } })
             .classList.contains("danger") };
});
check("面板里有 刷新/一键完成/导出日志/复制日志/清空日志 + 节拍与间隔设置",
  r8.panel && r8.run && r8.load && r8.exp && r8.copy && r8.clr && r8.tick && r8.gap,
  JSON.stringify(r8));
check("v1.3.1 面板：标题带版本号、节奏拆成三行带标签、停止按钮用危险色",
  /^v\d+\.\d+\.\d+$/.test(r8.ver) && r8.secs.includes("节奏") && r8.fields === 3 &&
  r8.nums.join() === "yzjm-min,yzjm-max,yzjm-tick,yzjm-gapmin,yzjm-gapmax" && r8.stopDanger,
  JSON.stringify({ ver: r8.ver, secs: r8.secs, fields: r8.fields, nums: r8.nums, danger: r8.stopDanger }));

// 顺手渲染列表并截图（产物：materials\userscript\panel-preview.png）
await page.click('.yzjm-panel [data-a="load"]');
await page.waitForTimeout(800);
await page.screenshot({ path: path.join(HERE, "panel-preview.png") });
console.log("   （面板截图 → materials\\userscript\\panel-preview.png）");

// 9) v1.3.0 互斥：连点两次不会开两个循环（第二次被拒）
await resetServer();
let r9 = await page.evaluate(async () => {
  const y = window.__yzjMat;
  GM_setValue("matRun", null);
  const cfg = { min: 2, max: 2, tick: 1, gapMin: 0, gapMax: 0 };
  const it = { docId: 399816, stuClassId: 485991, scId: 166335, resName: "微课.mp4", resType: 1 };
  const a = y.startRun({ queue: [it], cfg });
  const second = await y.startRun({ queue: [it], cfg });     // 第二次必须被拒
  await a;
  return { second, runningAfter: y.isRunning(), view: window.__mat.docs[399816].viewDetail.viewTime };
});
check("连点两次「一键完成」不会开第二轮（第二次被拒）",
  r9.second === false && r9.runningAfter === false && r9.view === 2, JSON.stringify(r9));

// 10) v1.3.0 停止：中途点「停止」→ 循环退出、状态清空
await resetServer();
let r10 = await page.evaluate(async () => {
  const y = window.__yzjMat;
  const cfg = { min: 1, max: 1, tick: 1, gapMin: 3, gapMax: 3 };   // 份间 3 秒，留出中断窗口
  const queue = [399816, 399817, 399818].map((id, i) =>
    ({ docId: id, stuClassId: 485991, scId: 166335, resName: "doc" + i, resType: 0 }));
  const p = y.startRun({ queue, cfg });
  await new Promise((r) => setTimeout(r, 1200));
  const midRunning = y.isRunning();
  y.stopRun();
  await p;
  return { midRunning, runningAfter: y.isRunning(), state: y.runState() };
});
check("「停止」能中断本轮，并把运行状态清掉",
  r10.midRunning === true && r10.runningAfter === false && !r10.state, JSON.stringify(r10));

// 11) v1.3.0 断点续跑：模拟页面刷新（状态落盘）→ boot 自动接着跑
await resetServer();
await page.evaluate(() => {
  window.__mat.docs[399816].viewDetail = { viewTime: null, isView: 0, viewId: null, awardScore: null };
  GM_setValue("matRun", {
    active: true, runId: "resume-test", startedAt: Date.now(), at: Date.now(), total: 1,
    cfg: { min: 2, max: 2, tick: 1, gapMin: 0, gapMax: 0 },
    queue: [{ docId: 399816, stuClassId: 485991, scId: 166335, resName: "微课.mp4", resType: 1 }],
    done: [], failed: [],
  });
});
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__yzjMat, null, { timeout: 20000 });
await page.waitForTimeout(7000);                       // boot 里 3 秒后才接着跑
const r11 = await page.evaluate(() => ({
  state: window.__yzjMat.runState(),
  view: window.__mat.docs[399816].viewDetail,
  noticed: window.__yzjMat.logText().includes("检测到上次没跑完"),
}));
check("刷新页面后自动接着跑剩下的（整轮不再丢）",
  !r11.state && r11.view.isView === 1 && r11.view.viewTime === 2 && r11.noticed,
  JSON.stringify({ state: r11.state, view: r11.view }));

// 12) 面板上有「停止」按钮和进度行
await page.click(".yzjm-launcher").catch(() => {});
await page.waitForTimeout(400);
const r12 = await page.evaluate(() => {
  const p = document.querySelector(".yzjm-panel");
  return { panel: !!p, stop: !!document.querySelector('.yzjm-panel [data-a="stop"]'),
           progress: !!document.querySelector("#yzjm-progress") };
});
check("面板有「停止」按钮和进度行", r12.panel && r12.stop && r12.progress, JSON.stringify(r12));

const bad = results.filter((x) => !x.ok);
console.log(`\n== 结果：${results.length - bad.length}/${results.length} 通过 ==`);
await ctx.close();
process.exit(bad.length ? 1 : 0);
