# -*- coding: utf-8 -*-
"""统计 cubic path 输出中「共享锚点/控制点」的比例，评估共享边界联合简化的可行性。"""
import re, sys
from collections import defaultdict

TOK = re.compile(r'[MmLlCcHhVvSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?')


def parse(d):
    """返回子路径列表：[(anchors, closed)]，anchor={p,c1,c2}（绝对坐标）。"""
    toks = TOK.findall(d)
    subs, cur = [], []
    x = y = sx = sy = 0.0
    cmd = ''
    i = 0
    closed = False
    while i < len(toks):
        t = toks[i]
        if len(t) == 1 and t.isalpha():
            cmd = t; i += 1
            if cmd in 'Zz':
                closed = True
                if len(cur) >= 3: subs.append((cur, True))
                cur = []; x, y = sx, sy
            continue
        c = cmd.upper(); rel = cmd.islower()
        if c == 'M':
            nx, ny = float(toks[i]), float(toks[i+1]); i += 2
            if rel: nx += x; ny += y
            if len(cur) >= 3: subs.append((cur, closed))
            cur = [{'p': (nx, ny)}]; closed = False
            x, y = nx, ny; sx, sy = nx, ny
            cmd = 'l' if rel else 'L'
        elif c == 'L':
            nx, ny = float(toks[i]), float(toks[i+1]); i += 2
            if rel: nx += x; ny += y
            cur.append({'p': (nx, ny)}); x, y = nx, ny
        elif c == 'C':
            x1, y1, x2, y2, nx, ny = map(float, toks[i:i+6]); i += 6
            if rel:
                x1 += x; y1 += y; x2 += x; y2 += y; nx += x; ny += y
            if cur:
                # 前一个锚点的出控制点 + 当前锚点的入控制点
                cur[-1]['c2'] = (x1, y1)
                cur.append({'p': (nx, ny), 'c1': (x2, y2)})
            else:
                cur.append({'p': (nx, ny)})
            x, y = nx, ny
        elif c in 'HV':
            v = float(toks[i]); i += 1
            if c == 'H': nx, ny = (x + v if rel else v), y
            else: nx, ny = x, (y + v if rel else v)
            cur.append({'p': (nx, ny)}); x, y = nx, ny
        else:
            i += 1
    if len(cur) >= 3: subs.append((cur, closed))
    return subs


def q(p): return (round(p[0], 2), round(p[1], 2))


def analyze(svg_path):
    s = open(svg_path, encoding='utf-8').read()
    paths = re.findall(r'<path[^>]*\bd="([^"]+)"', s)
    anchor_owners = defaultdict(set)     # 锚点 -> {(path_idx, sub_idx)}
    handle_owners = defaultdict(set)     # (锚点, 控制点) -> ...
    total_anchors = 0
    total_subs = 0
    for pi, d in enumerate(paths):
        for si, (anchors, closed) in enumerate(parse(d)):
            total_subs += 1
            n = len(anchors)
            total_anchors += n
            for ai, a in enumerate(anchors):
                anchor_owners[q(a['p'])].add((pi, si, ai))
                if 'c1' in a: handle_owners[(q(a['p']), q(a['c1']))].add((pi, si, ai))
                if 'c2' in a: handle_owners[(q(a['p']), q(a['c2']))].add((pi, si, ai))
    shared_anchors = sum(1 for v in anchor_owners.values() if len(v) >= 2)
    shared_unique = sum(len(v) for v in anchor_owners.values() if len(v) >= 2)
    shared_handles = sum(1 for v in handle_owners.values() if len({p for p, _, _ in v}) >= 2)
    print(f"{svg_path.split(chr(92))[-1]}: paths={len(paths)} subpaths={total_subs} anchors={total_anchors}")
    print(f"  unique anchor positions={len(anchor_owners)}  shared (>=2 subpaths)={shared_anchors} "
          f"({shared_anchors/max(1,len(anchor_owners))*100:.1f}%)  shared anchor instances={shared_unique}")
    print(f"  unique (anchor,handle)={len(handle_owners)}  shared across paths={shared_handles} "
          f"({shared_handles/max(1,len(handle_owners))*100:.1f}%)")


if __name__ == '__main__':
    for p in sys.argv[1:]:
        analyze(p)
