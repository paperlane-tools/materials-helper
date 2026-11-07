#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""刷资料（易智教「资料」任务）—— 独立于刷题流水线的一套小工具。

资料这类任务不用真的看视频/看文档：站点只认你「上报的观看秒数」。
页面自己的做法是每 10 秒调一次上报接口，服务端并不校验你真实看了多久，
所以这里直接按接口口径上报就行（详见 README.md）。

用法（在 E:\\yzj-js 下）：
    python materials\\materials.py list                    # 列出各班的资料模块（只读）
    python materials\\materials.py inspect                 # 逐个看资料详情：类型/已看时长/得分（只读）
    python materials\\materials.py inspect --raw           # 连原始 JSON 一起打，方便对字段
    python materials\\materials.py complete --yes          # 上报观看时长（默认随机 30~90 秒）
    python materials\\materials.py complete --yes --min 60 --max 180

安全约定：
  - 默认只读；`complete` 必须显式加 `--yes` 才会写。
  - 上报的秒数**只会往上走**：已看 600 秒的资料，不会因为这次报了 90 秒而被改小。
  - 每一步都记 response code，失败不吞（写进报告里）。
"""

import argparse
import json
import os
import random
import re
import sys
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    import chrome_session  # 同目录：从本机 Chrome 只读登录态
except ImportError:
    chrome_session = None

try:
    import requests
except ImportError:  # 理论上 AGENTS.md 说 requests 已全局安装
    requests = None

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))   # materials\cli → 项目根
API_BASE = "https://www.csgmooc.com/uni-gateway/jxapi2/"
SESSION = os.path.join(ROOT, "work", "session.json")
LOGDIR = os.path.join(HERE, "logs")

# ---- 运行日志落盘：以后出问题直接把这个文件发我，不用再"抓终端" ----
_LOG_FH = None


class _Tee:
    """把 stdout/stderr 同时写到控制台和日志文件；某个流写不了（编码不支持）也不会炸。"""

    def __init__(self, *streams):
        self.streams = streams

    def write(self, s):
        txt = s if isinstance(s, str) else str(s)
        for st in self.streams:
            try:
                st.write(txt)
            except Exception:
                try:
                    st.write(txt.encode("utf-8", "replace").decode(st.encoding or "utf-8", "replace"))
                except Exception:
                    pass
        return len(txt)

    def flush(self):
        for st in self.streams:
            try:
                st.flush()
            except Exception:
                pass


def setup_stdout():
    """Windows 控制台默认 GBK，遇到 ✓ / → 这类字符会 UnicodeEncodeError；能改就改成 utf-8。"""
    for st in (sys.stdout, sys.stderr):
        try:
            st.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def open_run_log():
    """每次运行写一份 materials\\cli\\logs\\mat-YYYYmmdd-HHMMSS.log。

    用的是"把 stdout/stderr 分流"的办法，所以 **连 traceback 都会进日志**——
    以后出问题直接把那个文件发我，不用再抓终端。
    """
    global _LOG_FH
    try:
        os.makedirs(LOGDIR, exist_ok=True)
        path = os.path.join(LOGDIR, "mat-%s.log" % time.strftime("%Y%m%d-%H%M%S"))
        _LOG_FH = open(path, "w", encoding="utf-8")
        sys.stdout = _Tee(sys.__stdout__, _LOG_FH)
        sys.stderr = _Tee(sys.__stderr__, _LOG_FH)
        print("===== 资料脚本运行记录 =====")
        print("时间：%s" % time.strftime("%Y-%m-%d %H:%M:%S"))
        print("命令行：%s" % " ".join(sys.argv))
        print("工作目录：%s" % os.getcwd())
        print("------------------------------")
        return path
    except Exception:
        _LOG_FH = None
        return None

VIDEO_EXT = {"mp4", "mov", "avi", "flv", "rmvb", "wmv", "mpeg", "mkv", "f4v", "m4v", "rm", "3gp", "dat", "vob"}
IMAGE_EXT = {"jpg", "jpeg", "png", "gif", "bmp", "webp"}


# ----------------------------------------------------------------- 传输层
class Transport:
    """一个很薄的 HTTP 包装；单测里换成假的即可（只要同名方法）。"""

    def __init__(self, token, base=API_BASE, timeout=30):
        self.token = token
        self.base = base
        self.timeout = timeout

    def _headers(self, json_body=False):
        h = {"authtoken": self.token}
        h["Content-Type"] = "application/json" if json_body else "application/x-www-form-urlencoded"
        return h

    def get(self, path, **params):
        r = requests.get(self.base + path, headers=self._headers(), params=params, timeout=self.timeout)
        return _parse(r)

    def post(self, path, data=None, as_json=False):
        if as_json:
            r = requests.post(self.base + path, headers=self._headers(True), data=json.dumps(data or {}),
                              timeout=self.timeout)
        else:
            r = requests.post(self.base + path, headers=self._headers(), data=data or {}, timeout=self.timeout)
        return _parse(r)


def _parse(resp):
    try:
        return resp.json()
    except Exception:
        return {"errcode": resp.status_code, "raw": resp.text[:300]}


def code_of(body):
    """站点的成功码不统一：有 errcode 有 code，都是 200 才算成功。"""
    if not isinstance(body, dict):
        return None
    return body.get("errcode", body.get("code"))


def ensure_ok(body, what):
    """接口成功码统一检查：203 单独翻译成人话（登录态过期是最常见的坑）。"""
    code = code_of(body)
    if code == 203:
        raise SystemExit("登录态过期（203 authtoken expired）→ 先跑：node scripts\\get_session.mjs --headful")
    if code != 200:
        raise SystemExit("%s 返回 %s：%s" % (what, code, str(body)[:200]))
    return body


# ----------------------------------------------------------------- 纯逻辑（单测重点）
def pick_seconds(low, high, rng=random):
    low, high = int(low), int(high)
    if high < low:
        low, high = high, low
    return rng.randint(low, high)


def ext_of(name):
    m = re.search(r"\.([A-Za-z0-9]+)$", str(name or ""))
    return m.group(1).lower() if m else ""


def classify(detail, fallback_id=None):
    """把 getStuDocumentDetail 的返回整理成内部结构（字段名做了兼容，缺哪个都不炸）。

    真实返回（2026-10-05 实测）：
        {"id": 399816, "scId": 166335, "taskName": "...mp4", "awardScore": 0,
         "docId": 260244,                       ← 资源 id，**上报不要用它**
         "resDocument": {"docId": 260244, "resName": "...mp4", "resType": 1, "url": "..."},
         "viewDetail": {"viewTime": null, "totalTime": null, "awardScore": null, "viewId": null, "isView": 0}}
    上报要的 docId 是 **data.id**（班级级资料 id），这点跟直觉相反。

    返回 {kind, docId, scId, name, ext, viewTime, awarded, isView, raw}
    kind: video | image | doc
    """
    d = detail or {}
    doc = d.get("resDocument") or {}
    view = d.get("viewDetail") or {}
    name = doc.get("resName") or d.get("resName") or d.get("taskName") or d.get("name") or ""
    doc_id = d.get("id") or d.get("scDocid") or d.get("docId") or doc.get("docId") or fallback_id
    ext = ext_of(name)
    res_type = doc.get("resType")
    if res_type is None:
        res_type = d.get("resType")
    if str(res_type) == "3" or (not res_type and ext in IMAGE_EXT):
        kind = "image"
    elif ext in VIDEO_EXT or str(res_type) == "1":
        kind = "video"
    else:
        kind = "doc"
    view_time = _first_num(view, ("viewTime", "watchTime", "studyTime", "time")) or 0
    awarded = _first_num(view, ("awardScore", "score", "taskScore"))
    if awarded is None:
        awarded = _first_num(d, ("awardScore", "score")) or 0
    return {
        "kind": kind, "docId": doc_id, "scDocId": doc_id, "scId": d.get("scId"),
        "name": name, "ext": ext, "viewTime": int(view_time), "awarded": awarded,
        "isView": view.get("isView"), "resType": res_type, "raw": d,
    }


def _first_num(d, keys):
    for k in keys:
        v = (d or {}).get(k)
        if isinstance(v, (int, float)):
            return v
        if isinstance(v, str):
            try:
                return float(v)
            except ValueError:
                pass
    return None


def build_action(item, seconds):
    """生成"时长上报"动作；返回 None 表示不需要报时长。

    两种 None：① 图片类资料没有时长（建立查看记录就算完成）；② 已看时长已经不低于本次。
    （建立查看记录那一步在 complete_all 里统一做，页面点「预览/播放」时就是它。）
    """
    if item["kind"] == "image":
        return None
    if item.get("viewTime") and int(item["viewTime"]) >= int(seconds):
        return None
    target = max(int(item.get("viewTime") or 0), int(seconds))
    if item["kind"] == "video":
        return {
            "kind": "video",
            "endpoint": "student/lessonsituation/updateWatchTime",
            "payload": {"docId": item["docId"], "sclassId": item.get("sclassid"),
                        "scId": item.get("scid"),
                        "viewTime": target, "totalTime": target},
            "target": target,
            "note": "视频：viewTime=totalTime 一起报（跟页面「没播完就关掉」时一样）",
        }
    return {
        "kind": "doc",
        "endpoint": "student/lessonsituation/updatePreviewTime",
        "payload": {"docId": item["docId"], "scId": item.get("scid"),
                    "stuClassId": item.get("sclassid"), "viewTime": target},
        "target": target,
        "note": "文档：报预览时长",
    }


PREVIEW_ENDPOINT = "student/lessonsituation/preViewDocumentOfImage"


def start_view_payload(item):
    """页面点「预览 / 播放」时发的第一条请求：建立查看记录（服务端回「更新浏览人数成功」）。

    没有这条记录，后面的 updateWatchTime / updatePreviewTime 会被服务端静默拒掉
    （HTTP 200 但 `data:false`，回读 viewTime 仍是 null）。
    """
    return {"scDocid": item["scDocId"], "stuName": item.get("stuName") or "",
            "sclassid": item.get("sclassid")}


def complete_all(transport, items, seconds_fn, log=print):
    """对每份资料：建立查看记录 → 上报时长 → 回读确认。返回报告（单测直接断言这个结构）。"""
    report = {"total": len(items), "done": 0, "skipped": 0, "failed": 0, "rows": []}
    for it in items:
        row = {"name": it.get("name") or it.get("docId"), "kind": it.get("kind"),
               "before": it.get("viewTime"), "status": "", "target": None, "error": ""}
        try:
            seconds = seconds_fn()
            # 已经看过、而且时长够了 → 整条跳过（既不重复上报，也不重复记浏览人数）
            if it.get("isView") and int(it.get("viewTime") or 0) >= int(seconds):
                row["status"] = "skip"
                row["note"] = "已有时长不低于本次，跳过（不会把时长改小）"
                report["skipped"] += 1
                report["rows"].append(row)
                continue
            # ① 没有查看记录 → 先建立（否则后面的时长上报会被服务端拒掉）
            if not it.get("isView"):
                pre = transport.post(PREVIEW_ENDPOINT, data=start_view_payload(it))
                row["pre"] = code_of(pre)
                if code_of(pre) != 200:
                    row["status"] = "fail"
                    row["error"] = "建立查看记录失败：%s" % str(pre)[:110]
                    report["failed"] += 1
                    report["rows"].append(row)
                    continue
            # ② 上报时长（图片类没有这一步）
            act = build_action(it, seconds)
            if act:
                row["target"] = act["target"]
                body = transport.post(act["endpoint"], data=act["payload"])
                row["code"] = code_of(body)
                if code_of(body) != 200:
                    row["status"] = "fail"
                    row["error"] = "上报返回 %s %s" % (code_of(body), str(body)[:120])
                    report["failed"] += 1
                    report["rows"].append(row)
                    continue
            # ③ 回读确认
            after = read_detail(transport, it["docId"], it.get("sclassid"))
            row["after"] = after.get("viewTime")
            row["awarded"] = after.get("awarded")
            enough = act is None or (after.get("viewTime") or 0) >= act["target"]
            row["status"] = "ok" if (after.get("isView") and enough) else "unconfirmed"
            if row["status"] == "ok":
                report["done"] += 1
            else:
                report["failed"] += 1
        except Exception as e:  # 一份失败不影响其它
            row["status"] = "error"
            row["error"] = str(e)[:160]
            report["failed"] += 1
        report["rows"].append(row)
        time.sleep(0.4)
    return report


def read_detail(transport, doc_id, sclassid):
    """读某份资料的详情并整理。"""
    body = transport.get("classroomDocument/getStuDocumentDetail",
                         documentId=doc_id, stuClassId=sclassid)
    ensure_ok(body, "读资料详情")
    d = body.get("data")
    return classify(d, fallback_id=doc_id)


def read_detail_any_class(transport, s, doc_id, log=print):
    """按 docId 直接查详情，不依赖它还在资料列表里。

    （看完的资料会从 getStuDocModules 里消失，所以要复核某一份时只能这么找。）
    轮询各教学任务的 sclassid，谁返回了 data 就用谁。
    """
    teach = ensure_ok(transport.get("student/task/getteachtask", stuid=s["stuId"], gid=s.get("gid") or ""),
                      "拉教学任务列表")
    last_err = None
    for t in (teach.get("data") or []):
        try:
            body = transport.get("classroomDocument/getStuDocumentDetail",
                                 documentId=doc_id, stuClassId=t.get("sclassid"))
        except Exception as e:
            last_err = e
            continue
        if code_of(body) == 200 and body.get("data"):
            it = classify(body["data"], fallback_id=doc_id)
            it["sclassid"] = t.get("sclassid")
            it["scid"] = it.get("scId")
            it["course"] = t.get("courseName") or ""
            return it
        last_err = code_of(body)
    raise SystemExit("查不到 docId=%s 的资料详情（最后错误：%s）" % (doc_id, last_err))


# ----------------------------------------------------------------- CLI
def _read_json(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None


def _default_chrome_grab():
    return chrome_session.to_session(chrome_session.grab()) if chrome_session else {}


def resolve_transport(args, log=print, chrome_grab=None, transport_factory=None):
    """按顺序找一个**真正能用**的登录态：--session 指定 > work\\session.json > 本机 Chrome（只读）。

    每个候选都用一次轻量接口验活，避免"拿了个过期 token 然后静默显示 0 条"。
    """
    chrome_grab = chrome_grab or _default_chrome_grab
    transport_factory = transport_factory or (lambda tok: Transport(tok))
    cands = []
    if getattr(args, "session", None):
        cands.append((args.session, _read_json(args.session)))
    else:
        cands.append(("work\\session.json", _read_json(SESSION)))
        cands.append(("本机 Chrome 的 sessionStorage", chrome_grab()))
    for name, s in cands:
        if not s or not s.get("authtoken"):
            log("  × %s：没拿到登录态" % name)
            continue
        tr = transport_factory(s["authtoken"])
        try:
            body = tr.get("student/task/getteachtask", stuid=s.get("stuId") or "", gid=s.get("gid") or "")
        except Exception as e:
            log("  × %s：请求失败（%s）" % (name, str(e)[:60]))
            continue
        if code_of(body) == 200:
            log("  √ 登录态：%s（%s，stuId=%s）" % (name, s.get("loginName") or "?", s.get("stuId") or "?"))
            return s, tr
        log("  × %s：登录态不可用（code=%s）" % (name, code_of(body)))
    raise SystemExit(
        "没有可用的登录态。两个办法：\n"
        "  1) 用 Chrome 打开一次 csgmooc.com（保持登录）——本脚本会自动读它的 sessionStorage，不用额外登录；\n"
        "  2) node scripts\\get_session.mjs --headful  人工登录一次（项目自己的浏览器）。")


def list_docs(transport, s, log=print):
    """列出各教学任务下的资料（对应任务页的「资料」栏）。

    注意：getStuDocModules 的 data 是**一份份资料平铺的数组**，不是"模块"，
    每份自带 ttId / scId / stuClassId / docId / resName / resType —— 上报要的参数都在里面。
    """
    out = []
    teach = ensure_ok(transport.get("student/task/getteachtask", stuid=s["stuId"], gid=s.get("gid") or ""),
                      "拉教学任务列表")
    for t in (teach.get("data") or []):
        ttid = t.get("id")
        body = transport.get("student/task/getStuDocModules",
                             flag=0, gid=s.get("gid") or "", key="", type=0, ttid=ttid)
        ensure_ok(body, "拉资料模块(ttid=%s)" % ttid)
        for d in (body.get("data") or []):
            d = dict(d)
            d["__course__"] = t.get("courseName") or ""
            d["__class__"] = t.get("className") or ""
            out.append(d)
    return out


def iter_docs(mods):
    """list_docs 已经是平铺的资料列表；保留这个函数是为了兼容旧调用（返回每份资料）。"""
    for d in (mods or []):
        if d.get("docId") or d.get("id"):
            yield d


def collect(transport, s, only_tmid=None):
    """列出 → 逐个读详情，整理成可上报的条目。"""
    items = []
    for d in iter_docs(list_docs(transport, s, log=lambda *_: None)):
        doc_id = d.get("docId") or d.get("id")
        if only_tmid and str(doc_id) != str(only_tmid):
            continue
        it = read_detail(transport, doc_id, d.get("stuClassId"))
        it["scid"] = it.get("scId") or d.get("scId")
        it["sclassid"] = d.get("stuClassId")
        it["stuName"] = s.get("loginName")
        it["course"] = d.get("__course__") or ""
        it.setdefault("name", d.get("resName") or d.get("taskName") or "")
        items.append(it)
    return items


def cmd_list(args):
    s, tr = resolve_transport(args)
    mods = list_docs(tr, s)
    print("资料 %d 份：" % len(mods))
    cur = None
    for d in mods:
        head = "%s（%s）" % (d.get("__course__") or "?", d.get("__class__") or "?")
        if head != cur:
            cur = head
            print("  ── %s" % head)
        print("      %-8s %-6s %s" % (d.get("docId") or "-", _kind_of_row(d),
                                      (d.get("resName") or d.get("taskName") or "")[:48]))
    if args.raw:
        print(json.dumps(mods, ensure_ascii=False)[:4000])


def _kind_of_row(row):
    ext = ext_of(row.get("resName") or row.get("taskName"))
    rt = row.get("resType")
    if str(rt) == "3" or (not rt and ext in IMAGE_EXT):
        return "图片"
    if ext in VIDEO_EXT or str(rt) == "1":
        return "视频"
    return "文档"


def cmd_inspect(args):
    s, tr = resolve_transport(args)
    items = collect(tr, s, args.tmid)
    if not items and args.tmid:      # 可能已经看过了（列表里没有）→ 按 id 直接查
        items = [read_detail_any_class(tr, s, args.tmid)]
    print("待查看资料 %d 份" % len(items))
    for it in items:
        flag = "已看过" if it.get("isView") else ("没看过" if it.get("isView") == 0 else "")
        print("  %-8s %-6s %-38s scId=%-7s 已看 %-6s 得分 %-4s %s" % (
            it["docId"], it["kind"], (it["name"] or "")[:36], it.get("scId"),
            it["viewTime"], it["awarded"], flag))
        if args.raw:
            print("      " + json.dumps(it["raw"], ensure_ascii=False)[:600])


def cmd_complete(args):
    if not args.yes:
        raise SystemExit("这是写操作，确认要上报就加 --yes（先跑 inspect 看一眼更稳）")
    s, tr = resolve_transport(args)
    items = collect(tr, s, args.tmid)
    rng = random.Random()
    rep = complete_all(tr, items, lambda: pick_seconds(args.min, args.max, rng),
                       log=print)
    for row in rep["rows"]:
        print("  %-40s %-12s %s%s" % ((row["name"] or "")[:38], row["status"],
                                      ("target=%s " % row["target"]) if row["target"] else "",
                                      row["error"] or row.get("note") or ""))
    print("完成 %d / 跳过 %d / 失败 %d（共 %d）" % (rep["done"], rep["skipped"], rep["failed"], rep["total"]))
    return rep


def build_parser():
    p = argparse.ArgumentParser(description="刷资料（易智教资料任务）")
    p.add_argument("cmd", choices=["list", "inspect", "complete"])
    p.add_argument("--session", default=None, help="显式指定 session.json（默认自动：work\\session.json → 本机 Chrome）")
    p.add_argument("--tmid", help="只处理这一份资料")
    p.add_argument("--min", type=int, default=30, help="上报时长下限（秒），默认 30")
    p.add_argument("--max", type=int, default=90, help="上报时长上限（秒），默认 90")
    p.add_argument("--raw", action="store_true", help="把原始 JSON 也打出来")
    p.add_argument("--yes", action="store_true", help="complete 必须带这个")
    return p


def main(argv=None):
    setup_stdout()
    log_path = open_run_log()
    try:
        args = build_parser().parse_args(argv)
        if args.cmd == "list":
            rc = cmd_list(args)
        elif args.cmd == "inspect":
            rc = cmd_inspect(args)
        else:
            rc = cmd_complete(args)
    except SystemExit as e:                       # 自己 raise 的"人话"提示
        if e.code not in (0, None):
            print("退出：%s" % e.code)
        rc = e.code if isinstance(e.code, int) else 1
    except Exception:
        print("!! 未预期的错误 —— 把下面这段（连同上面几行）发我：")
        traceback.print_exc(file=sys.stdout)
        rc = 1
    finally:
        if log_path:
            print("\n（本次运行记录已写入 %s）" % log_path)
        if _LOG_FH:
            try:
                _LOG_FH.close()
            except Exception:
                pass
    return rc


if __name__ == "__main__":
    sys.exit(main() or 0)
