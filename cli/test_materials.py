#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""materials 的单测 —— 全离线：不打网络、不碰账号、不需要浏览器。

    python materials\\test_materials.py

覆盖：资料类型识别、上报动作拼装（文档/视频/图片三种口径）、
「已有时长不会被改小」、上限下限、上报失败不吞、上报后回读确认。
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import materials as M  # noqa: E402


# ----------------------------------------------------------------- 测试脚手架
class FakeApi:
    """假传输层：记录所有调用，并按真实服务端的行为更新"服务端"状态。

    关键：**没有查看记录时，时长上报会被拒**（HTTP 200 但 data:false 且不落地）——
    这正是 2026-10-05 实测到的坑（`preViewDocumentOfImage` 建记录 → 才能报时长）。
    """

    def __init__(self, details, post_code=200):
        self.details = {str(k): v for k, v in details.items()}
        self.post_code = post_code
        self.calls = []

    def get(self, path, **params):
        self.calls.append(("GET", path, params))
        if "getStuDocumentDetail" in path:
            d = self.details.get(str(params.get("documentId")))
            if d is None:
                return {"errcode": 200, "data": None}
            return {"errcode": 200, "data": d}
        return {"errcode": 200, "data": []}

    def post(self, path, data=None, as_json=False):
        self.calls.append(("POST", path, data))
        if self.post_code != 200:
            return {"errcode": self.post_code, "errmsg": "boom"}
        if "preViewDocumentOfImage" in path:          # 建立查看记录
            d = self.details.get(str((data or {}).get("scDocid")))
            if d is None:
                return {"errcode": 200, "data": {"value": 0}}
            vd = d.setdefault("viewDetail", {})
            vd["isView"] = 1
            vd["viewId"] = 13448620
            return {"errcode": 200, "errmsg": "更新浏览人数成功", "data": {"value": 1}}
        d = self.details.get(str((data or {}).get("docId")))
        if d is None:
            return {"code": 200, "data": False}
        vd = d.setdefault("viewDetail", {})
        if not vd.get("isView"):                      # ← 没记录 → 静默拒绝
            return {"code": 200, "data": False}
        vt = (data or {}).get("viewTime")
        if vt is not None:
            vd["viewTime"] = vt
        return {"code": 200, "data": True}


def detail(name, res_type=None, view_time=0, awarded=0, doc_id=1001, sc_id=166335, is_view=None):
    """真实结构（getStuDocumentDetail 实测返回）：上报用的 id 是 data.id。"""
    if is_view is None:
        is_view = 1 if (view_time or awarded) else 0
    return {"id": doc_id, "scId": sc_id, "taskName": name,
            "resDocument": {"resName": name, "resType": res_type, "docId": 555},
            "viewDetail": {"viewTime": view_time or None, "awardScore": awarded or None,
                           "isView": is_view, "viewId": 1 if is_view else None}}


RESULTS = []


def check(name, ok, extra=""):
    RESULTS.append((name, bool(ok)))
    print("%s %s%s" % ("✅" if ok else "❌", name, ("  " + extra) if extra else ""))


# ----------------------------------------------------------------- 用例
def test_pick_seconds():
    rng = __import__("random").Random(7)
    vals = [M.pick_seconds(30, 90, rng) for _ in range(200)]
    check("时长在 [min,max] 区间内", all(30 <= v <= 90 for v in vals), "样例 %s" % vals[:5])
    check("min/max 写反了也能用", 10 <= M.pick_seconds(90, 30, rng) <= 90)


def test_ext_and_code():
    check("取扩展名", M.ext_of("a/b/微课.MP4") == "mp4" and M.ext_of("无后缀") == "")
    check("成功码兼容 errcode/code",
          M.code_of({"errcode": 200}) == 200 and M.code_of({"code": 200}) == 200
          and M.code_of({"code": 501}) == 501 and M.code_of(None) is None)


def test_classify():
    v = M.classify(detail("微课.mp4", view_time=12))
    check("视频识别", v["kind"] == "video" and v["viewTime"] == 12, v["kind"])
    d = M.classify(detail("讲义.pdf"))
    check("文档识别", d["kind"] == "doc", d["kind"])
    i = M.classify(detail("扫描件", res_type=3))
    check("图片类（resType=3）识别", i["kind"] == "image", i["kind"])
    v2 = M.classify(detail("无后缀但有 resType=1", res_type=1))
    check("resType=1 也认成视频", v2["kind"] == "video", v2["kind"])
    empty = M.classify(None, fallback_id=42)
    check("空详情不炸，且能拿到 docId", empty["docId"] == 42 and empty["viewTime"] == 0)
    real = M.classify(detail("微课.mp4", doc_id=399816, sc_id=166335))
    check("上报 id 用 data.id、scId 单独取",
          real["docId"] == 399816 and real["scId"] == 166335 and real["name"] == "微课.mp4",
          "%s/%s" % (real["docId"], real["scId"]))


def test_build_action_doc():
    it = M.classify(detail("讲义.pdf"))
    it.update(scid=166240, sclassid=465633)
    act = M.build_action(it, 45)
    p = act["payload"]
    check("文档上报走 updatePreviewTime", act["endpoint"] == "student/lessonsituation/updatePreviewTime")
    check("文档 payload 字段齐全",
          set(p) == {"docId", "scId", "stuClassId", "viewTime"} and p["viewTime"] == 45
          and p["scId"] == 166240 and p["stuClassId"] == 465633, str(p))


def test_build_action_video():
    it = M.classify(detail("微课.mp4"))
    it.update(scid=166240, sclassid=465633)
    act = M.build_action(it, 60)
    p = act["payload"]
    check("视频上报走 updateWatchTime", act["endpoint"] == "student/lessonsituation/updateWatchTime")
    check("视频 payload：viewTime=totalTime",
          p["viewTime"] == 60 and p["totalTime"] == 60 and p["scId"] == 166240, str(p))


def test_build_action_image():
    it = M.classify(detail("扫描件", res_type=3))
    it.update(scid=166240, sclassid=465633, stuName="张三")
    check("图片类没有时长上报这一步", M.build_action(it, 30) is None)
    p = M.start_view_payload(it)
    check("建立查看记录的 payload",
          p["scDocid"] == it["scDocId"] and p["sclassid"] == 465633 and p["stuName"] == "张三", str(p))


def test_never_lowers():
    it = M.classify(detail("看过的.pdf", view_time=600))
    it.update(scid=1, sclassid=2)
    check("已看 600 秒，本次只报 90 → 跳过（不把时长改小）", M.build_action(it, 90) is None)
    act = M.build_action(it, 900)
    check("本次报 900 秒 → target 取 900", act and act["target"] == 900)


def test_complete_all_ok():
    """两份资料（文档+视频）都能完成：必须先建立查看记录，再报时长。"""
    api = FakeApi({1001: detail("讲义.pdf"), 1002: detail("微课.mp4")})
    items = []
    for doc_id in (1001, 1002):
        it = M.read_detail(api, doc_id, 465633)
        it.update(scid=166240, sclassid=465633, stuName="张三")
        items.append(it)
    rep = M.complete_all(api, items, lambda: 60, log=lambda *_: None)
    posts = [c for c in api.calls if c[0] == "POST"]
    previews = [c for c in posts if "preViewDocumentOfImage" in c[1]]
    times = [c for c in posts if "updateWatchTime" in c[1] or "updatePreviewTime" in c[1]]
    check("每份资料：先建记录 + 再报时长（共 4 次写）",
          rep["done"] == 2 and len(previews) == 2 and len(times) == 2, str(summary(rep)) + " posts=%d" % len(posts))
    check("上报后回读确认到了新时长",
          all(r["after"] == 60 and r["status"] == "ok" for r in rep["rows"]), str(rep["rows"][0]))


def test_skip_view_record_when_already_viewed():
    """已经看过的资料：不重复调 preViewDocumentOfImage（那会重复计浏览人数）。"""
    api = FakeApi({1001: detail("看过的.pdf", view_time=10, is_view=1)})
    it = M.read_detail(api, 1001, 465633)
    it.update(scid=1, sclassid=2, stuName="张三")
    rep = M.complete_all(api, [it], lambda: 60, log=lambda *_: None)
    previews = [c for c in api.calls if c[0] == "POST" and "preViewDocumentOfImage" in c[1]]
    check("已看过的资料不再重复建记录（但会把时长补到 60）",
          not previews and rep["done"] == 1 and rep["rows"][0]["after"] == 60, str(summary(rep)))


def test_skip_already_done():
    api = FakeApi({1001: detail("看过的.pdf", view_time=600)})
    it = M.read_detail(api, 1001, 465633)
    it.update(scid=1, sclassid=2)
    rep = M.complete_all(api, [it], lambda: 60, log=lambda *_: None)
    posts = [c for c in api.calls if c[0] == "POST"]
    check("已看 600 秒的资料不重复上报", rep["skipped"] == 1 and not posts, str(summary(rep)))


def test_without_view_record_time_report_is_rejected():
    """回归：跳过"建立查看记录"直接报时长 → 服务端不落地 → 必须记成 unconfirmed。"""
    api = FakeApi({1001: detail("讲义.pdf")})
    it = M.read_detail(api, 1001, 465633)
    it.update(scid=1, sclassid=2, stuName="张三")
    it["isView"] = 1                       # 假装"已看过"，从而跳过 preView 那一步
    rep = M.complete_all(api, [it], lambda: 60, log=lambda *_: None)
    check("没建记录就报时长 → 服务端拒收，脚本不谎报成功",
          rep["rows"][0]["status"] == "unconfirmed", str(summary(rep)))


def test_api_error_not_swallowed():
    api = FakeApi({1001: detail("讲义.pdf"), 1002: detail("微课.mp4")}, post_code=500)
    items = []
    for doc_id in (1001, 1002):
        it = M.read_detail(api, doc_id, 465633)
        it.update(scid=1, sclassid=2)
        items.append(it)
    rep = M.complete_all(api, items, lambda: 60, log=lambda *_: None)
    check("上报 500 会记成失败（不吞）", rep["failed"] == 2 and rep["done"] == 0, str(summary(rep)))
    check("失败原因写进了报告", all("500" in (r["error"] or "") for r in rep["rows"]), str(rep["rows"][0]["error"]))


def test_unconfirmed():
    api = FakeApi({1001: detail("讲义.pdf")})

    def noop_post(path, data=None, as_json=False):     # 收下 200 但不改时长
        api.calls.append(("POST", path, data))
        return {"errcode": 200}

    api.post = noop_post
    it = M.read_detail(api, 1001, 465633)
    it.update(scid=1, sclassid=2)
    rep = M.complete_all(api, [it], lambda: 60, log=lambda *_: None)
    check("报了 200 但回读没变 → 记 unconfirmed（不谎报成功）",
          rep["rows"][0]["status"] == "unconfirmed" and rep["failed"] == 1, str(summary(rep)))


def test_expired_token_is_loud():
    class Expired(FakeApi):
        def get(self, path, **params):
            return {"errcode": 203, "errmsg": "authtoken expired"}

    try:
        M.read_detail(Expired({}), 1001, 465633)
        check("登录态过期会明确报错（不是静默 0 条）", False, "没有抛错")
    except SystemExit as e:
        check("登录态过期会明确报错（不是静默 0 条）", "203" in str(e) and "get_session" in str(e), str(e)[:60])

    try:
        M.ensure_ok({"code": 507, "message": "老师已删除当前任务"}, "读资料详情")
        check("其它错误码也会报出来", False)
    except SystemExit as e:
        check("其它错误码也会报出来", "507" in str(e), str(e)[:60])


def summary(rep):
    return "done=%d skip=%d fail=%d/%d" % (rep["done"], rep["skipped"], rep["failed"], rep["total"])


TESTS = [test_pick_seconds, test_ext_and_code, test_classify, test_build_action_doc,
         test_build_action_video, test_build_action_image, test_never_lowers,
         test_complete_all_ok, test_skip_view_record_when_already_viewed,
         test_skip_already_done, test_without_view_record_time_report_is_rejected,
         test_api_error_not_swallowed, test_unconfirmed, test_expired_token_is_loud]


if __name__ == "__main__":
    for fn in TESTS:
        fn()
    bad = [n for n, ok in RESULTS if not ok]
    print("\n== 结果：%d/%d 通过 ==" % (len(RESULTS) - len(bad), len(RESULTS)))
    sys.exit(1 if bad else 0)
