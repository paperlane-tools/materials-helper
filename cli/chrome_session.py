#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""从「本机 Chrome」的 sessionStorage 里读易智教的登录态。

**只读，不启动浏览器、不控制浏览器、不杀进程。**
Chrome 把每个标签页的 sessionStorage 落盘在
    <profile>\\Session Storage\\*.ldb|*.log
里（leveldb 格式），我们把它当成字节流扫一遍，找形如

    map-<n>-<key>  <长度> <UTF-16LE 的值>

的记录，取出 `reslibAuthtoken` / `stuId` / `login_name` 等。

单独跑（会把结果写到 work\\session.json，和刷题共用）：
    python materials\\chrome_session.py
    python materials\\chrome_session.py --list     # 只打印找到了什么
"""

import argparse
import ctypes
import json
import os
import re
import sys
from ctypes import wintypes

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))   # materials\cli → 项目根
OUT_SESSION = os.path.join(ROOT, "work", "session.json")

# 依次尝试：真实 Chrome → 项目自己的 browser-profile（browser.mjs 用的那个）
PROFILE_DIRS = [
    os.path.join(os.environ.get("LOCALAPPDATA", ""), "Google", "Chrome", "User Data", "Default", "Session Storage"),
    os.path.join(ROOT, "browser-profile", "Default", "Session Storage"),
]

WANT = ["reslibAuthtoken", "stuId", "login_name", "login_number", "sclassid", "schoolNum", "indexpage:gid"]


def read_shared(path):
    """Chrome 正占着这些文件时也能读：CreateFileW + FILE_SHARE_READ|WRITE|DELETE。"""
    k32 = ctypes.windll.kernel32
    k32.CreateFileW.restype = wintypes.HANDLE
    k32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    h = k32.CreateFileW(path, 0x80000000, 0x1 | 0x2 | 0x4, None, 3, 0x80, None)
    if h in (0, -1, 0xFFFFFFFFFFFFFFFF):
        raise OSError("打不开 %s" % path)
    try:
        chunks, buf, got = [], ctypes.create_string_buffer(1 << 20), wintypes.DWORD(0)
        while k32.ReadFile(h, buf, len(buf), ctypes.byref(got), None):
            if got.value == 0:
                break
            chunks.append(buf.raw[:got.value])
        return b"".join(chunks)
    finally:
        k32.CloseHandle(h)


def _clean(s):
    """长度字节偶尔会错位，取最干净的一段：没有控制字符、像正常文本。"""
    return s and all(ch == "\t" or 32 <= ord(ch) for ch in s)


def parse_records(blob):
    """从 leveldb 字节流里解析 sessionStorage 的键值。纯函数，方便单测。"""
    out = {}
    for m in re.finditer(rb"map-(\d+)-", blob):
        km = re.match(rb"[A-Za-z0-9_:\.\-]{1,40}", blob[m.end():])
        if not km:
            continue
        key = km.group(0).decode("ascii")
        pos = m.end() + km.end()
        # 值前面可能有 0x00/0x01 之类的分隔字节，最多试三种偏移
        for skip in (0, 1, 2):
            p = pos + skip
            if p >= len(blob):
                break
            ln = blob[p]
            raw = blob[p + 1:p + 1 + ln]
            if len(raw) != ln or ln == 0:
                continue
            try:
                val = raw.decode("utf-16-le")
            except UnicodeDecodeError:
                continue
            if _clean(val) and len(val) > 0:
                if key not in out or len(val) > len(out[key]):
                    out[key] = val
                break
    return out


def grab(profile_dirs=None, verbose=False):
    """扫所有候选 profile，返回找到的键值（找不到就返回 {}）。"""
    for d in (profile_dirs or PROFILE_DIRS):
        if not os.path.isdir(d):
            continue
        blob = b""
        for name in sorted(os.listdir(d)):
            if not name.endswith((".ldb", ".log")):
                continue
            p = os.path.join(d, name)
            try:
                if os.path.getsize(p) == 0:
                    continue
                blob += read_shared(p)
            except OSError:
                continue
        if not blob:
            continue
        data = parse_records(blob)
        if data.get("reslibAuthtoken"):
            data["__source__"] = d
            if verbose:
                print("从 %s 读到 %d 个键" % (d, len(data)))
            return data
        if verbose:
            print("%s 里没有 reslibAuthtoken（读到 %d 个键）" % (d, len(data)))
    return {}


def to_session(data):
    """整理成和 work\\session.json 一样的结构。"""
    return {
        "authtoken": data.get("reslibAuthtoken", ""),
        "stuId": data.get("stuId", ""),
        "gid": data.get("indexpage:gid", ""),
        "loginName": data.get("login_name", ""),
        "schoolNum": data.get("schoolNum", ""),
        "apiBase": "https://www.csgmooc.com/uni-gateway/jxapi2/",
        "loggedIn": bool(data.get("reslibAuthtoken")),
        "source": data.get("__source__", ""),
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description="从本机 Chrome 读易智教登录态（只读）")
    ap.add_argument("--list", action="store_true", help="只打印找到的键，不写文件")
    args = ap.parse_args(argv)
    data = grab(verbose=True)
    if not data.get("reslibAuthtoken"):
        print("没找到登录态。请用 Chrome 打开一次 csgmooc.com 并且处于登录状态（标签页开着或刚关都行），再跑一次。")
        return 2
    sess = to_session(data)
    for k in WANT:
        if k in data:
            v = data[k]
            print("  %-18s = %s" % (k, (v[:40] + "…") if len(v) > 40 else v))
    print("账号：%s（stuId=%s）" % (sess["loginName"] or "?", sess["stuId"] or "?"))
    if args.list:
        return 0
    os.makedirs(os.path.dirname(OUT_SESSION), exist_ok=True)
    with open(OUT_SESSION, "w", encoding="utf-8") as fh:
        json.dump(sess, fh, ensure_ascii=False, indent=1)
    print("已写入 %s（来源：%s）" % (OUT_SESSION, sess["source"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
