# -*- coding: utf-8 -*-
"""统计 polygon SVG 中「被两个以上子路径共享」的边，用于判断 cutout 共享边是否成立。

用法: python shared_edges.py <polygon.svg>
输出: 共享边数量 / 各子路径点数 / 是否双向一致
"""
import re
import sys
from collections import defaultdict

NUM = re.compile(r'[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?')
TOK = re.compile(r'[MmLlZz]|[-+]?(?:\d*\.\d+|\d+\.?)')


def parse_subs(d):
    toks = TOK.findall(d)
    subs, cur = [], []
    x = y = sx = sy = 0.0
    cmd = ''
    i = 0
    while i < len(toks):
        t = toks[i]
        if t in 'MmLlZz' and len(t) == 1:
            cmd = t
            i += 1
            if cmd in 'Zz':
                if len(cur) >= 3:
                    subs.append(cur)
                cur = []
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
            if len(cur) >= 3:
                subs.append(cur)
            cur = [(nx, ny)]
            x, y = nx, ny
            sx, sy = nx, ny
            cmd = 'l' if rel else 'L'
        elif c == 'L':
            nx, ny = float(toks[i]), float(toks[i + 1]); i += 2
            if rel:
                nx += x; ny += y
            cur.append((nx, ny))
            x, y = nx, ny
        else:
            i += 1
    if len(cur) >= 3:
        subs.append(cur)
    return subs


svg_path = sys.argv[1]
s = open(svg_path, encoding='utf-8').read()
paths = re.findall(r'<path[^>]*\bd="([^"]+)"', s)

edge_owner = defaultdict(set)     # 量化边 -> 子路径集合
sub_count = 0
pt_total = 0
for d in paths:
    for sub in parse_subs(d):
        sub_count += 1
        pt_total += len(sub)
        n = len(sub)
        for i in range(n):
            a = sub[i]
            b = sub[(i + 1) % n]
            ka = (round(a[0], 2), round(a[1], 2))
            kb = (round(b[0], 2), round(b[1], 2))
            key = (ka, kb) if ka <= kb else (kb, ka)
            edge_owner[key].add(sub_count - 1)

shared = sum(1 for k, v in edge_owner.items() if len(v) >= 2)
print(f"subpaths={sub_count} points={pt_total} edges={len(edge_owner)} shared_edges={shared} "
      f"shared_ratio={shared / max(1, len(edge_owner)):.3f}")
