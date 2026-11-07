# -*- coding: utf-8 -*-
"""统计 SVG 中「锚点」的重合情况，用于判断重拟合后共享边是否仍对齐。

用法: python anchor_coincidence.py <svg>
折线（L）取端点；曲线（C）取锚点（段起点/终点），控制点不算。
"""
import re
import sys
from collections import defaultdict

TOK = re.compile(r'[MmLlCcZz]|[-+]?(?:\d*\.\d+|\d+\.?)')


def anchors(d):
    toks = TOK.findall(d)
    out, x, y, sx, sy = [], 0.0, 0.0, 0.0, 0.0
    cmd = ''
    i = 0
    while i < len(toks):
        t = toks[i]
        if len(t) == 1 and t.isalpha():
            cmd = t
            i += 1
            if cmd in 'Zz':
                x, y = sx, sy
            continue
        if not cmd:
            i += 1
            continue
        rel = cmd.islower()
        c = cmd.upper()
        if c == 'M':
            nx, ny = float(toks[i]), float(toks[i + 1]); i += 2
            if rel:
                nx += x; ny += y
            out.append((nx, ny))
            x, y = nx, ny
            sx, sy = nx, ny
            cmd = 'l' if rel else 'L'
        elif c == 'L':
            nx, ny = float(toks[i]), float(toks[i + 1]); i += 2
            if rel:
                nx += x; ny += y
            out.append((nx, ny))
            x, y = nx, ny
        elif c == 'C':
            i += 4
            nx, ny = float(toks[i]), float(toks[i + 1]); i += 2
            if rel:
                nx += x; ny += y
            out.append((nx, ny))
            x, y = nx, ny
        else:
            i += 1
    return out


s = open(sys.argv[1], encoding='utf-8').read()
paths = re.findall(r'<path[^>]*\bd="([^"]+)"', s)
owner = defaultdict(set)
total = 0
for pi, d in enumerate(paths):
    for k, a in enumerate(anchors(d)):
        total += 1
        owner[(round(a[0], 2), round(a[1], 2))].add(pi)

coincident = sum(1 for v in owner.values() if len(v) >= 2)
print(f"anchors={total} unique_pos={len(owner)} coincident_pos={coincident} "
      f"ratio={coincident / max(1, len(owner)):.3f}")
