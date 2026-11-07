// ==UserScript==
// @name         易智教云课堂 · 资料助手
// @namespace    yzj-js
// @version      1.3.1
// @description  一键把「资料」任务标记为已看（打开→按节拍上报时长；可续跑、可停止、带可导出日志）
// @author       yzj-js
// @match        https://www.csgmooc.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

const MAT_VERSION = "1.3.1";
  const API = "https://www.csgmooc.com/uni-gateway/jxapi2/";
  const VIDEO_EXT = ["mp4", "mov", "avi", "flv", "rmvb", "wmv", "mpeg", "mkv", "f4v", "m4v", "rm", "3gp", "dat", "vob"];
  const IMAGE_EXT = ["jpg", "jpeg", "png", "gif", "bmp", "webp"];

  const CFG = {
    get min() { return Math.max(1, Number(GM_getValue("matMin", 30)) || 30); },
    get max() { return Math.max(1, Number(GM_getValue("matMax", 90)) || 90); },
    // v1.1.0：上报节拍 & 资料之间的间隔——真实页面是每 10 秒报一次，别一秒内连发
    get tick() { return Math.max(3, Number(GM_getValue("matTick", 10)) || 10); },
    get gapMin() { return Math.max(0, Number(GM_getValue("matGapMin", 15))); },
    get gapMax() { return Math.max(0, Number(GM_getValue("matGapMax", 45))); },
  };

  const token = () => sessionStorage.getItem("reslibAuthtoken") || "";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const randInt = (a, b) => { const lo = Math.min(a, b), hi = Math.max(a, b); return lo + Math.floor(Math.random() * (hi - lo + 1)); };
  const codeOf = (b) => (b && (b.errcode !== undefined ? b.errcode : b.code));
  const extOf = (name) => { const m = /\.([A-Za-z0-9]+)$/.exec(String(name || "")); return m ? m[1].toLowerCase() : ""; };

  // ---------------------------------------------------------------- 站点接口
  async function api(path, { method = "GET", body, form = false } = {}) {
    const headers = { authtoken: token() };
    let payload;
    if (body !== undefined) {
      headers["Content-Type"] = form ? "application/x-www-form-urlencoded" : "application/json";
      payload = form ? new URLSearchParams(body).toString() : JSON.stringify(body);
    }
    const t0 = Date.now();
    try {
      const res = await fetch(API + path, { method, headers, body: payload, credentials: "include" });
      const text = await res.text();
      logLine("api", `${method} ${path.slice(0, 70)} → ${res.status} (${Date.now() - t0}ms, ${text.length}B)`);
      try { return JSON.parse(text); } catch { return { errcode: res.status, raw: text.slice(0, 200) }; }
    } catch (e) {
      logLine("error", `${method} ${path.slice(0, 70)} → 网络错误：${e && e.message}`);
      throw e;
    }
  }

  // ---------------------------------------------------------------- 日志系统
  // 内存缓冲 + 写进油猴存储（刷新页面不丢）+ 面板实时显示 + 一键导出/复制
  const LOG_KEY = "matLog";
  const LOG_MAX = 1000;
  let logBuf = null;
  let logDirty = false;
  let logFlushTimer = null;
  const pad2 = (n) => String(n).padStart(2, "0");
  const hhmmss = (t) => { const d = new Date(t || Date.now()); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };

  function logLine(level, msg) {
    try {
      if (!logBuf) logBuf = GM_getValue(LOG_KEY, []) || [];
      logBuf.push({ t: Date.now(), lv: level, m: String(msg).slice(0, 600) });
      if (logBuf.length > LOG_MAX) logBuf.splice(0, logBuf.length - LOG_MAX);
      logDirty = true;
      if (!logFlushTimer) logFlushTimer = setTimeout(flushLog, 1500);
      const el = panelEl && panelEl.querySelector("#yzjm-log");
      if (el) {
        el.textContent += `\n[${hhmmss()}] ${level}  ${msg}`;
        el.scrollTop = el.scrollHeight;
      }
    } catch (e) { /* 记日志失败不影响主流程 */ }
  }

  function flushLog() {
    logFlushTimer = null;
    if (!logDirty || !logBuf) return;
    logDirty = false;
    try { GM_setValue(LOG_KEY, logBuf); } catch (e) { /* ignore */ }
  }

  /** 拼一份可以直接发给我的诊断文本 */
  function logText(extra = {}) {
    flushLog();
    const buf = GM_getValue(LOG_KEY, []) || [];
    const mask = (k) => (k ? k.slice(0, 8) + "…" : "(无)");
    const head = [
      "===== 易智教 · 资料助手 诊断日志 =====",
      "脚本版本：" + MAT_VERSION,
      "导出时间：" + new Date().toLocaleString("zh-CN"),
      "页面地址：" + location.href,
      "浏览器：" + navigator.userAgent,
      "账号：stuId=" + (sessionStorage.getItem("stuId") || "-")
        + "　姓名=" + (sessionStorage.getItem("login_name") || "-")
        + "　登录态=" + (token() ? "有效" : "缺失"),
      "当前设置：" + JSON.stringify({ min: CFG.min, max: CFG.max, tick: CFG.tick,
                                      gapMin: CFG.gapMin, gapMax: CFG.gapMax }),
      "列表条数：" + (extra.rows === undefined ? rows.length : extra.rows),
      "登录票据：" + mask(token()),
      "------------------------------",
      `日志（共 ${buf.length} 条，最新在最后）：`,
    ].join("\n");
    const body = buf.map((x) => `[${new Date(x.t).toLocaleString("zh-CN")}] ${String(x.lv).padEnd(5)} ${x.m}`).join("\n");
    return head + "\n" + (body || "（空）") + "\n";
  }

  // ---------------------------------------------------------------- 纯逻辑
  /** 列表行 → 类型（视频/图片/文档）。resType：1=视频、3=图片（实测），后缀优先兜底。 */
  function kindOf(row) {
    const ext = extOf(row.resName || row.taskName);
    const rt = row.resType;
    if (String(rt) === "3" || (!rt && IMAGE_EXT.includes(ext))) return "image";
    if (VIDEO_EXT.includes(ext) || String(rt) === "1") return "video";
    return "doc";
  }

  /** 详情 → 内部结构。⚠️ 上报用的 id 是 detail.id（班级级），不是 resDocument.docId。 */
  function parseDetail(detail, fallbackId) {
    const d = detail || {};
    const doc = d.resDocument || {};
    const view = d.viewDetail || {};
    const name = doc.resName || d.resName || d.taskName || "";
    const id = d.id || d.scDocid || d.docId || fallbackId;
    let rt = doc.resType;
    if (rt === undefined || rt === null) rt = d.resType;
    let kind = "doc";
    if (String(rt) === "3" || (!rt && IMAGE_EXT.includes(extOf(name)))) kind = "image";
    else if (VIDEO_EXT.includes(extOf(name)) || String(rt) === "1") kind = "video";
    return {
      docId: id, scDocId: id, scId: d.scId, name, kind,
      resDocId: doc.docId || d.docId,          // 资源 id：打开文档/视频时要它
      viewTime: Number(view.viewTime) || 0,
      isView: view.isView, awarded: Number(view.awardScore || d.awardScore || 0),
    };
  }

  /** ① "打开"这一步——页面点「预览/播放」时真正干的事，缺了它后台就没有打开记录 */
  async function openMaterial(item, log = () => {}) {
    const schoolNum = sessionStorage.getItem("schoolNum") || "";
    if (item.kind === "video" && item.resDocId) {
      const r = await api(`teacher/rescourse/videoSliceView?docid=${item.resDocId}&scid=${item.scId}`);
      log(codeOf(r) === 200 ? "  ① 打开视频 ok（拿到播放地址）" : `  ! 打开视频返回 ${codeOf(r)}（继续）`);
      return;
    }
    if (item.kind === "doc" && item.resDocId) {
      // 文档：页面点「预览」先发这个（JSON），服务端据此准备预览
      const r = await api("common/V2/judgeDocument", {
        method: "POST",
        body: { resDocid: item.resDocId, schoolNum, fileId: item.resDocId,
                resName: item.name, businessType: 0 },
      });
      log(codeOf(r) === 200 ? `  ① 打开文档 ok（tresState=${(r.data || {}).tresState}）` : `  ! 打开文档返回 ${codeOf(r)}（继续）`);
      return;
    }
    log("  ① 图片类：直接建查看记录");
  }

  /** 时长上报动作。图片类没有时长这步（靠"建立查看记录"就算完成）。 */
  function buildAction(item, seconds) {
    if (item.kind === "image") return null;
    if (item.isView && item.viewTime >= seconds) return null;        // 已看够，别把时长改小
    const target = Math.max(item.viewTime || 0, seconds);
    if (item.kind === "video") {
      return { endpoint: "student/lessonsituation/updateWatchTime",
               payload: { docId: item.docId, sclassId: item.sclassId, scId: item.scId,
                          viewTime: target, totalTime: target }, target };
    }
    return { endpoint: "student/lessonsituation/updatePreviewTime",
             payload: { docId: item.docId, scId: item.scId, stuClassId: item.sclassId, viewTime: target }, target };
  }

  function startViewPayload(item) {
    return { scDocid: item.scDocId, stuName: item.stuName || "", sclassid: item.sclassId };
  }

  // ---------------------------------------------------------------- 业务
  /** 列出所有教学任务下的资料（getStuDocModules 返回的是平铺数组，每份自带你需要的 id）。 */
  async function listDocs(log = () => {}) {
    const stuId = sessionStorage.getItem("stuId") || "";
    const gid = sessionStorage.getItem("indexpage:gid") || "";
    const teach = await api(`student/task/getteachtask?stuid=${stuId}&gid=${gid}`);
    if (codeOf(teach) !== 200) throw new Error(`拉教学任务失败（${codeOf(teach)}）`);
    const out = [];
    for (const t of (teach.data || [])) {
      const b = await api(`student/task/getStuDocModules?flag=0&gid=${gid}&key=&type=0&ttid=${t.id}`);
      if (codeOf(b) !== 200) { log(`  ! ttid=${t.id} 拉资料失败（${codeOf(b)}）`); continue; }
      for (const d of (b.data || [])) {
        out.push({ ...d, course: t.courseName || "", cls: t.className || "" });
      }
    }
    return out;
  }

  async function readDetail(docId, sclassId) {
    const b = await api(`classroomDocument/getStuDocumentDetail?documentId=${docId}&stuClassId=${sclassId}`);
    if (codeOf(b) !== 200) throw new Error(`读详情失败（${codeOf(b)}）`);
    return parseDetail(b.data, docId);
  }

  /**
   * 完成一份资料：① 建立查看记录 → ② 上报时长 → ③ 回读确认。
   * 少 ① 会被服务端静默拒绝（HTTP 200 但 data:false，回读时长不变）——2026-10-05 实测。
   */
  async function completeOne(row, { seconds, stuName, log = (m) => logLine("info", m), tick } = {}) {
    const step = Math.max(1, Number(tick || CFG.tick || 10));
    const item = { ...row, docId: row.docId || row.id, scDocId: row.docId || row.id,
                   scId: row.scId, sclassId: row.stuClassId, kind: kindOf(row), stuName,
                   viewTime: 0, isView: undefined };
    const before = await readDetail(item.docId, item.sclassId);
    item.viewTime = before.viewTime; item.isView = before.isView; item.kind = before.kind;
    item.name = before.name || item.name;
    item.resDocId = before.resDocId || row.resDocId;
    if (item.isView && item.viewTime >= seconds) return { status: "skip", item, reason: "已看够，跳过" };

    // ① 打开（文档 judgeDocument / 视频 videoSliceView）
    await openMaterial(item, log);
    // ② 建立查看记录
    if (!item.isView) {
      const pre = await api("student/lessonsituation/preViewDocumentOfImage",
        { method: "POST", form: true, body: startViewPayload(item) });
      if (codeOf(pre) !== 200) return { status: "fail", item, reason: `建立查看记录失败（${codeOf(pre)}）` };
      log(`  ② 建立查看记录 ok：${item.name.slice(0, 24)}`);
    }
    // ③ 视频：先读上次看到哪儿（页面每次都调）
    if (item.kind === "video") {
      await api(`student/lessonsituation/getLastViewTime`, { method: "POST", form: true,
        body: { docId: item.docId, sclassId: item.sclassId } });
    }
    // ④ 按节拍分次上报（模拟"每 10 秒一次"），而不是一秒写完
    const act = buildAction(item, seconds);
    if (act) {
      const target = act.target;
      let reported = Math.max(0, item.viewTime || 0);
      while (reported < target) {
        reported = Math.min(target, reported + step);
        const body = { ...act.payload, viewTime: reported };
        if (body.totalTime !== undefined) body.totalTime = reported;
        const r = await api(act.endpoint, { method: "POST", form: true, body });
        if (codeOf(r) !== 200) return { status: "fail", item, reason: `上报失败（${codeOf(r)}）` };
        log(`  ③ 上报 ${reported}/${target} 秒`);
        if (reported < target) await sleep(Math.round(step * 1000 * (0.8 + Math.random() * 0.4)));
      }
    }
    const after = await readDetail(item.docId, item.sclassId);
    const ok = !!after.isView && (!act || after.viewTime >= act.target);
    return { status: ok ? "ok" : "unconfirmed", item: { ...item, viewTime: after.viewTime },
             reason: ok ? "" : "回读没确认（服务端可能没落地）" };
  }

  // ---------------------------------------------------------------- 运行状态（v1.3.0）
  // 抄刷题脚本那套：状态落盘 + 代际令牌 + 可停止，页面刷新/跳转后能接着跑。
  const RUN_KEY = "matRun";
  let runToken = 0;                      // 每次启动 +1；旧循环发现对不上就自己退出

  const runState = () => GM_getValue(RUN_KEY, null) || null;
  const isRunning = () => {
    const s = runState();
    return !!(s && s.active);
  };
  function saveRun(state) {
    GM_setValue(RUN_KEY, state ? { ...state, at: Date.now() } : null);
  }
  function clearRun() { saveRun(null); }
  /** 面板上的忙碌态：span 的 disabled 没用，得自己加类 + 拦重复点击 */
  function setBusy(busy) {
    if (!panelEl) return;
    panelEl.querySelectorAll(".yzjm-btn").forEach((b) => {
      if (["run", "inspect", "load"].includes(b.dataset.a)) b.classList.toggle("busy", busy);
    });
    const stop = panelEl.querySelector('[data-a="stop"]');
    if (stop) stop.style.display = busy ? "inline-block" : "none";
    updateProgress();
  }
  function updateProgress() {
    if (!panelEl) return;
    const el = panelEl.querySelector("#yzjm-progress");
    if (!el) return;
    const s = runState();
    if (!s || !s.active) { el.textContent = ""; return; }
    const total = s.total || (s.queue.length + s.done.length + (s.failed || []).length);
    const left = s.queue.length;
    const per = ((s.cfg.min + s.cfg.max) / 2 + (s.cfg.gapMin + s.cfg.gapMax) / 2);
    el.textContent = `进行中：已完成 ${s.done.length}/${total}，队列还剩 ${left} 份`
      + `（约 ${Math.max(1, Math.round(left * per / 60))} 分钟）；出错 ${(s.failed || []).length}`;
  }

  // ---------------------------------------------------------------- 界面
  const css = `
  .yzjm-launcher{position:fixed;right:16px;bottom:66px;z-index:2147482900;background:#0a7a3d;color:#fff;
    padding:8px 12px;border-radius:999px;box-shadow:0 6px 18px rgba(0,0,0,.25);cursor:pointer;
    font:13px/1.2 "Microsoft YaHei",system-ui,sans-serif;user-select:none}
  .yzjm-panel{position:fixed;right:18px;bottom:18px;width:460px;max-height:72vh;overflow:auto;z-index:2147482901;
    background:#fff;color:#222;border:1px solid #d7dbe0;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.18);
    font:13px/1.6 "Microsoft YaHei",system-ui,sans-serif}
  .yzjm-panel h3{margin:0;padding:9px 12px;font-size:14px;background:#0a7a3d;color:#fff;border-radius:11px 11px 0 0;
    display:flex;gap:8px;align-items:center}
  .yzjm-panel h3>span:first-child{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .yzjm-ver{font-size:11px;font-weight:400;opacity:.85;flex:0 0 auto}
  .yzjm-sec{border-top:1px solid #eef1f5;margin:10px 0 6px;padding-top:8px;font-weight:600;color:#333}
  .yzjm-field{margin:4px 0;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
  .yzjm-num{width:46px;padding:3px 6px;border:1px solid #d7dbe0;border-radius:6px;font:inherit;font-size:12px}
  .yzjm-body{padding:10px 12px}
  .yzjm-btn{display:inline-block;padding:4px 9px;margin:2px 4px 2px 0;border-radius:7px;border:1px solid #0a7a3d;
    background:#0a7a3d;color:#fff;cursor:pointer;font-size:12px}
  .yzjm-btn.sm{padding:3px 8px;font-size:12px;line-height:1.5}
  .yzjm-btn.gray{background:#fff;color:#0a7a3d}
  .yzjm-btn.danger{background:#d1352b;border-color:#d1352b}
  .yzjm-btn:disabled{opacity:.5;cursor:not-allowed}
  .yzjm-btn.busy{opacity:.45;pointer-events:none}
  .yzjm-row{display:flex;gap:6px;align-items:center;padding:4px 0;border-bottom:1px dashed #eceff3;font-size:12px}
  .yzjm-kind{flex:0 0 auto;padding:0 5px;border-radius:4px;background:#eef4ff;color:#1f6feb}
  .yzjm-name{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .yzjm-st{flex:0 0 auto;color:#666}
  .yzjm-ok{color:#0a7a3d;font-weight:700}
  .yzjm-fail{color:#d1352b}
  .yzjm-log{max-height:140px;overflow:auto;background:#f6f8fa;border-radius:8px;padding:6px;
    font-size:12px;white-space:pre-wrap;margin-top:6px}
  `;
  const styleEl = document.createElement("style");
  styleEl.textContent = css;

  let panelEl = null;
  let rows = [];

  function renderRows(listEl, logEl) {
    listEl.innerHTML = rows.map((r, i) => {
      const kind = kindOf(r);
      const label = kind === "video" ? "视频" : kind === "image" ? "图片" : "文档";
      const st = r.__state || "";
      const cls = st === "ok" ? "yzjm-ok" : (st === "fail" || st === "unconfirmed") ? "yzjm-fail" : "yzjm-st";
      return `<div class="yzjm-row" data-i="${i}">
        <span class="yzjm-kind">${label}</span>
        <span class="yzjm-name" title="${String(r.resName || r.taskName || "").replace(/"/g, "&quot;")}">${String(r.resName || r.taskName || "")}</span>
        <span class="yzjm-st ${cls}">${st || (r.__viewTime ? r.__viewTime + " 秒" : "未看")}</span></div>`;
    }).join("") || '<div class="yzjm-st">还没加载列表</div>';
  }

  function ensurePanel() {
    if (panelEl && document.body.contains(panelEl)) return panelEl;
    if (!document.head.contains(styleEl)) (document.head || document.documentElement).appendChild(styleEl);
    panelEl = document.createElement("div");
    panelEl.className = "yzjm-panel";
    const who = sessionStorage.getItem("login_name") || "未登录";
    panelEl.innerHTML = `<h3><span>易智教 · 资料助手</span><span class="yzjm-ver">v${MAT_VERSION}</span>
        <span class="yzjm-btn gray sm" data-a="close">收起</span></h3>
      <div class="yzjm-body">
        <div class="yzjm-st">当前账号：${who}</div>
        <div style="margin-top:6px">
          <span class="yzjm-btn" data-a="load">刷新列表</span>
          <span class="yzjm-btn" data-a="run">一键完成</span>
          <span class="yzjm-btn gray" data-a="inspect">查已看</span>
          <span class="yzjm-btn danger" data-a="stop" style="display:none">停止</span>
        </div>
        <div class="yzjm-st" id="yzjm-progress" style="margin-top:2px"></div>

        <div class="yzjm-sec">节奏</div>
        <div class="yzjm-field">每份停留时长
          <input class="yzjm-num" id="yzjm-min" value="${CFG.min}"> ~
          <input class="yzjm-num" id="yzjm-max" value="${CFG.max}"> 秒</div>
        <div class="yzjm-field">节拍（几秒检查一次）
          <input class="yzjm-num" id="yzjm-tick" value="${CFG.tick}"> 秒</div>
        <div class="yzjm-field">每份之间间隔
          <input class="yzjm-num" id="yzjm-gapmin" value="${CFG.gapMin}"> ~
          <input class="yzjm-num" id="yzjm-gapmax" value="${CFG.gapMax}"> 秒</div>

        <div class="yzjm-sec">清单</div>
        <div id="yzjm-list" style="max-height:34vh;overflow:auto"></div>

        <div class="yzjm-sec">日志</div>
        <div>
          <span class="yzjm-btn gray" data-a="logexport">导出日志</span>
          <span class="yzjm-btn gray" data-a="logcopy">复制日志</span>
          <span class="yzjm-btn gray" data-a="logclear">清空日志</span>
          <span class="yzjm-st">出问题就把导出的日志发我</span>
        </div>
        <div class="yzjm-log" id="yzjm-log">就绪。先「刷新列表」，再「一键完成」。</div>
      </div>`;
    document.body.appendChild(panelEl);
    const listEl = panelEl.querySelector("#yzjm-list");
    const logEl = panelEl.querySelector("#yzjm-log");
    const log = (m) => logLine("info", m);

    panelEl.querySelector('[data-a="logexport"]').onclick = () => {
      try {
        const blob = new Blob([logText({ rows: rows.length })], { type: "text/plain;charset=utf-8" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `yzj-mat-log-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Date.now() % 100000}.txt`;
        document.body.appendChild(a); a.click(); a.remove();
        log(`日志已导出到「下载」文件夹（${(logBuf || []).length} 条）`);
      } catch (e) { alert("导出失败：" + e.message); }
    };
    panelEl.querySelector('[data-a="logcopy"]').onclick = async () => {
      const txt = logText({ rows: rows.length });
      try {
        if (typeof GM_setClipboard === "function") GM_setClipboard(txt, "text");
        else await navigator.clipboard.writeText(txt);
        log("日志已复制到剪贴板，直接粘给我即可");
      } catch (e) { alert("复制失败，请用「导出日志」"); }
    };
    panelEl.querySelector('[data-a="logclear"]').onclick = () => {
      if (!confirm("清空运行日志？（题库/设置不受影响）")) return;
      logBuf = []; GM_setValue(LOG_KEY, []);
      logEl.textContent = "日志已清空。";
    };

    panelEl.querySelector('[data-a="close"]').onclick = () => { panelEl.style.display = "none"; showLauncher(); };
    panelEl.querySelector('[data-a="load"]').onclick = async (e) => {
      e.target.disabled = true;
      try {
        log("拉资料列表…");
        rows = await listDocs(log);
        log(`共 ${rows.length} 份资料`);
        renderRows(listEl, logEl);
      } catch (err) { log("失败：" + err.message); }
      e.target.disabled = false;
    };
    panelEl.querySelector('[data-a="inspect"]').onclick = async (e) => {
      e.target.disabled = true;
      try {
        for (let i = 0; i < rows.length; i += 1) {
          try {
            const d = await readDetail(rows[i].docId, rows[i].stuClassId);
            rows[i].__viewTime = d.viewTime;
            rows[i].__state = d.isView ? `${d.viewTime || 0} 秒` : "未看";
          } catch (err) { rows[i].__state = "查不到"; }
          renderRows(listEl, logEl);
        }
        log("已刷新每份的已看时长");
      } finally { e.target.disabled = false; }
    };
    panelEl.querySelector('[data-a="run"]').onclick = async () => {
      if (isRunning()) { log("已经有一轮在跑了 —— 等它结束，或点「停止」"); return; }
      const cfg = readCfg();
      if (!rows.length) { log("列表是空的，先点「刷新列表」"); return; }
      const queue = rows.map(toQueueItem);
      const eta = Math.round(queue.length * ((cfg.min + cfg.max) / 2 + (cfg.gapMin + cfg.gapMax) / 2) / 60);
      const msg = [
        `要对 ${queue.length} 份资料上报「已看」吗？`,
        `每份随机 ${cfg.min}~${cfg.max} 秒，每 ${cfg.tick} 秒上报一次（模拟真实观看节奏），`,
        `两份之间歇 ${cfg.gapMin}~${cfg.gapMax} 秒。`,
        "",
        `预计要跑约 ${eta} 分钟 —— 期间可以刷新/跳转，页面重开后会接着跑；`,
        "想中断随时点「停止」。已经看过的会跳过。",
      ].join("\n");
      if (!confirm(msg)) return;
      startRun({ queue, cfg });
    };
    panelEl.querySelector('[data-a="stop"]').onclick = () => stopRun();
    return panelEl;
  }

  function readCfg() {
    const g = (sel, dflt) => {
      const el = panelEl && panelEl.querySelector(sel);
      const v = Number(el && el.value);
      return Number.isFinite(v) ? v : dflt;
    };
    const cfg = {
      min: g("#yzjm-min", CFG.min), max: g("#yzjm-max", CFG.max),
      tick: Math.max(3, g("#yzjm-tick", CFG.tick)),
      gapMin: Math.max(0, g("#yzjm-gapmin", CFG.gapMin)),
      gapMax: Math.max(0, g("#yzjm-gapmax", CFG.gapMax)),
    };
    GM_setValue("matMin", cfg.min); GM_setValue("matMax", cfg.max);
    GM_setValue("matTick", cfg.tick); GM_setValue("matGapMin", cfg.gapMin); GM_setValue("matGapMax", cfg.gapMax);
    return cfg;
  }

  const toQueueItem = (r) => ({ docId: r.docId, stuClassId: r.stuClassId, scId: r.scId,
                                resName: r.resName, resType: r.resType, taskName: r.taskName });

  /**
   * 跑一轮（v1.3.0）：状态落盘 + 代际令牌，所以
   *   - 连点「一键完成」不会开第二轮（有锁，并且在跑的会被拦下）；
   *   - 页面刷新/跳转后，boot() 会接着跑剩下的（队列存在油猴存储里）；
   *   - 「停止」随时能中断。
   */
  async function startRun({ queue, cfg, resume = false }) {
    // v1.3.0：互斥在这层兜底，不管谁调用；但"续跑"（页面重开）要放行
    if (!resume && isRunning()) {
      logLine("warn", "已经有一轮在跑了（或上次没跑完）——等它结束，或点「停止」");
      return false;
    }
    const token = ++runToken;
    let state = runState();
    if (!state || !state.active) {
      state = { active: true, runId: "r" + Date.now().toString(36), startedAt: Date.now(),
                total: queue.length, cfg, queue, done: [], failed: [] };
    } else {
      state.active = true;
      if (cfg) state.cfg = cfg;
    }
    saveRun(state);
    setBusy(true);
    logLine("info", `开始处理：队列 ${state.queue.length} 份，设置 ${JSON.stringify(state.cfg)}`);
    const alive = () => token === runToken && !!(runState() || {}).active;
    while (state.queue.length) {
      if (!alive()) { logLine("warn", "本轮已停止（或状态被清掉）"); setBusy(false); return false; }
      const it = state.queue[0];
      const sec = randInt(state.cfg.min, state.cfg.max);
      const pos = state.total - state.queue.length + 1;
      logLine("info", `[${pos}/${state.total}] ${String(it.resName || it.taskName || "").slice(0, 26)} …`);
      const r = await completeOne(it, { seconds: sec, tick: state.cfg.tick,
        stuName: sessionStorage.getItem("login_name") || "", log: (m) => logLine("info", m) });
      state.queue.shift();
      if (r.status === "ok" || r.status === "skip") state.done.push(it.docId);
      else { state.failed.push({ docId: it.docId, name: r.item && r.item.name, reason: r.reason }); logLine("warn", "  × " + r.reason); }
      const row = rows.find((x) => String(x.docId) === String(it.docId));
      if (row) row.__state = r.status === "ok" ? `${sec} 秒 ✓` : r.status;
      saveRun(state);
      if (panelEl) renderRows(panelEl.querySelector("#yzjm-list"), panelEl.querySelector("#yzjm-log"));
      setBusy(true);
      if (state.queue.length) {
        const gap = randInt(state.cfg.gapMin, state.cfg.gapMax);
        if (gap > 0) { logLine("info", `  …歇 ${gap} 秒再做下一份`); await sleep(gap * 1000); }
      }
    }
    clearRun();
    setBusy(false);
    logLine("info", `本轮结束：成功/跳过 ${state.done.length}，失败 ${state.failed.length}（共 ${state.total}）`);
    return true;
  }

  function stopRun() {
    runToken += 1;                       // 让正在跑的循环下一轮就退出
    clearRun();
    setBusy(false);
    logLine("warn", "已停止本轮（已经写进去的不受影响；剩下的资料不会自动接着跑）");
  }

  function showLauncher() {
    if (document.querySelector(".yzjm-launcher")) return;
    const b = document.createElement("div");
    b.className = "yzjm-launcher";
    b.textContent = "资料助手";
    b.onclick = () => { const p = ensurePanel(); p.style.display = ""; b.remove(); };
    document.body.appendChild(b);
  }

  function boot() {
    if (!document.body) return;
    if (!document.head.contains(styleEl)) (document.head || document.documentElement).appendChild(styleEl);
    showLauncher();
    logLine("info", `脚本启动 v${MAT_VERSION}：${location.pathname}`);
    // v1.3.0：上次没跑完就接着跑（页面刷新/跳转不再把整轮丢掉）
    const s = runState();
    if (s && s.active && (s.queue || []).length) {
      logLine("warn", `检测到上次没跑完：还剩 ${s.queue.length} 份，3 秒后接着跑（要停就点面板里的「停止」）`);
      setTimeout(() => {
        const now = runState();
        if (now && now.active) startRun({ queue: now.queue, cfg: now.cfg, resume: true });
      }, 3000);
    } else if (s && s.active) {
      clearRun();                       // 空跑状态，清掉
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  // 调试/自测入口
  window.__yzjMat = { VERSION: MAT_VERSION, CFG, api, kindOf, parseDetail, buildAction, startViewPayload,
                      openMaterial,
                      listDocs, readDetail, completeOne, codeOf, extOf,
                      logLine, logText, flushLog, LOG_KEY,
                      startRun, stopRun, runState, isRunning, readCfg, toQueueItem, RUN_KEY };
})();
