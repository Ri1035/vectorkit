# -*- coding: utf-8 -*-
"""共享边界联合简化原型（cutout）。

思路：
1) 解析每条路径为子路径（锚点 + 入/出控制点）；
2) 找出「同一段曲线被两条子路径共用」的段（端点与控制点完全一致，方向可反）；
3) 把连续共享段组成链，只对链做一次「采样 → RDP → 三次贝塞尔拟合」；
4) 同一条链的新几何同时写回两侧（反向侧反转顺序并交换控制点）。

只处理 open chain（不跨越子路径起点/终点），且共享方恰好 2 条，避免 T 型接缝冲突。
用法: python joint_simplify.py <in.svg> <out.svg> [tol]
"""
import re
import sys
import math

TOK = re.compile(r'[MmLlCcHhVvSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?')


def parse_path(d):
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
                if len(cur) >= 2: subs.append({'a': cur, 'closed': True})
                cur = []; x, y = sx, sy
            continue
        c = cmd.upper(); rel = cmd.islower()
        if c == 'M':
            nx, ny = float(toks[i]), float(toks[i+1]); i += 2
            if rel: nx += x; ny += y
            if len(cur) >= 2: subs.append({'a': cur, 'closed': closed})
            cur = [{'p': [nx, ny]}]; closed = False
            x, y = nx, ny; sx, sy = nx, ny
            cmd = 'l' if rel else 'L'
        elif c == 'L':
            nx, ny = float(toks[i]), float(toks[i+1]); i += 2
            if rel: nx += x; ny += y
            cur.append({'p': [nx, ny]}); x, y = nx, ny
        elif c == 'C':
            x1, y1, x2, y2, nx, ny = map(float, toks[i:i+6]); i += 6
            if rel:
                x1 += x; y1 += y; x2 += x; y2 += y; nx += x; ny += y
            if cur:
                cur[-1]['out'] = [x1, y1]
                cur.append({'p': [nx, ny], 'in': [x2, y2]})
            else:
                cur.append({'p': [nx, ny]})
            x, y = nx, ny
        elif c in ('H', 'V'):
            v = float(toks[i]); i += 1
            if c == 'H': nx, ny = (x + v if rel else v), y
            else: nx, ny = x, (y + v if rel else v)
            cur.append({'p': [nx, ny]}); x, y = nx, ny
        else:
            i += 1
    if len(cur) >= 2: subs.append({'a': cur, 'closed': closed})
    return subs


def q(v): return round(v, 2)
def qp(p): return (q(p[0]), q(p[1]))
def qm(p): return (round(p[0], 1), round(p[1], 1))   # 匹配用：容忍 2 位小数的舍入差


def segs(sub):
    """[(i, j, c1, c2)]：从锚点 i 到 j 的段及其控制点。"""
    a = sub['a']; n = len(a)
    out = []
    for i in range(n):
        j = i + 1
        if j == n:
            if not sub['closed']: break
            j = 0
        c1 = a[i].get('out'); c2 = a[j].get('in')
        if c1 is None or c2 is None: continue      # 直线段不参与（保守）
        out.append((i, j, c1, c2))
    return out


def seg_key(a, i, j, c1, c2):
    p, n = a[i]['p'], a[j]['p']
    if (q(p[0]), q(p[1])) <= (q(n[0]), q(n[1])):
        return (qp(p), qp(n), qp(c1), qp(c2))
    return (qp(n), qp(p), qp(c2), qp(c1))


def bez(p0, c1, c2, p3, t):
    mt = 1 - t
    return [mt**3*p0[0] + 3*mt*mt*t*c1[0] + 3*mt*t*t*c2[0] + t**3*p3[0],
            mt**3*p0[1] + 3*mt*mt*t*c1[1] + 3*mt*t*t*c2[1] + t**3*p3[1]]


def norm(v):
    L = math.hypot(v[0], v[1]) or 1.0
    return (v[0]/L, v[1]/L)


def fit_group(a, s, e, tol):
    """把段 s..e 合并成一条三次贝塞尔（端点/切线固定，最小二乘求两个长度参数）。

    返回 (c1, c2, maxerr)；maxerr > tol 表示不能合并。
    """
    n = len(a)
    if e + 1 >= n: return None
    p0 = a[s]['p']; p3 = a[e+1]['p']
    pts = []; params = []; acc = 0.0; prev = p0
    for seg in range(s, e + 1):
        j = seg + 1
        if j >= n: return None
        c1 = a[seg].get('out'); c2 = a[j].get('in')
        if c1 is None or c2 is None: return None
        for k in range(1, 7):
            t = k / 6.0
            q = bez(a[seg]['p'], c1, c2, a[j]['p'], t)
            acc += math.hypot(q[0]-prev[0], q[1]-prev[1])
            prev = q
            pts.append(q); params.append(acc)
    if not pts: return None
    L = acc or 1.0
    params = [t / L for t in params]

    t0 = norm([a[s]['out'][0]-p0[0], a[s]['out'][1]-p0[1]]) if 'out' in a[s] else norm([pts[0][0]-p0[0], pts[0][1]-p0[1]])
    t1 = norm([p3[0]-a[e+1]['in'][0], p3[1]-a[e+1]['in'][1]]) if 'in' in a[e+1] else norm([p3[0]-pts[-1][0], p3[1]-pts[-1][1]])

    # 最小二乘：pt - (B0P0+B1P0+B2P3+B3P3) = alpha*B1*T0 - beta*B2*T1
    suu = suv = svv = sur = svr = 0.0
    for q, t in zip(pts, params):
        mt = 1 - t
        b0 = mt**3; b1 = 3*mt*mt*t; b2 = 3*mt*t*t; b3 = t**3
        base = [b0*p0[0] + b1*p0[0] + b2*p3[0] + b3*p3[0],
                b0*p0[1] + b1*p0[1] + b2*p3[1] + b3*p3[1]]
        rx = q[0] - base[0]; ry = q[1] - base[1]
        ux, uy = b1*t0[0], b1*t0[1]
        vx, vy = -b2*t1[0], -b2*t1[1]
        suu += ux*ux + uy*uy
        suv += ux*vx + uy*vy
        svv += vx*vx + vy*vy
        sur += ux*rx + uy*ry
        svr += vx*rx + vy*ry
    det = suu*svv - suv*suv
    if abs(det) < 1e-12: return None
    alpha = (sur*svv - svr*suv) / det
    beta = (suu*svr - suv*sur) / det
    if alpha <= 0 or beta <= 0: return None
    c1 = [p0[0] + alpha*t0[0], p0[1] + alpha*t0[1]]
    c2 = [p3[0] - beta*t1[0], p3[1] - beta*t1[1]]
    err = 0.0
    for q, t in zip(pts, params):
        b = bez(p0, c1, c2, p3, t)
        err = max(err, math.hypot(q[0]-b[0], q[1]-b[1]))
    return c1, c2, err


def merge_chain(a, start, nseg, tol):
    """贪心合并连续段；返回 [{'p','in','out'}] 或 None（无收益）。"""
    groups = []
    s = start
    end = start + nseg - 1
    while s <= end:
        best_e, best_fit = s, None
        for e in range(s, end + 1):
            fit = fit_group(a, s, e, tol)
            if fit is None: break
            if fit[2] <= tol:
                best_e, best_fit = e, fit
            else:
                break
        groups.append((s, best_e, best_fit))
        s = best_e + 1
    if len(groups) >= nseg: return None
    out = [{'p': a[start]['p'][:]}]
    for (s, e, fit) in groups:
        if fit is None:
            c1 = a[s].get('out'); c2 = a[e+1].get('in')
            if c1 is None or c2 is None: return None
            fit = (c1, c2, 0)
        out[-1]['out'] = fit[0]
        out.append({'p': a[e+1]['p'][:], 'in': fit[1]})
    return out


def sample_chain(a, i0, nseg, closed_dir, per=6):
    pts = []
    for k in range(nseg):
        idx = i0 + k
        j = idx + 1
        if j >= len(a):
            j = 0
        if idx >= len(a):
            idx = 0
        p0 = a[idx]['p']; c1 = a[idx].get('out')
        p3 = a[j]['p']; c2 = a[j].get('in')
        if c1 is None or c2 is None: return None
        for t in range(per):
            t = t / per
            mt = 1 - t
            x = mt**3*p0[0] + 3*mt*mt*t*c1[0] + 3*mt*t*t*c2[0] + t**3*p3[0]
            y = mt**3*p0[1] + 3*mt*mt*t*c1[1] + 3*mt*t*t*c2[1] + t**3*p3[1]
            pts.append([x, y])
    # 末端
    idx = i0 + nseg
    if idx >= len(a): idx -= len(a)
    pts.append(list(a[idx]['p']))
    return pts


def rdp(points, tol):
    if len(points) < 3: return [0, len(points)-1]
    keep = [False]*len(points); keep[0] = keep[-1] = True
    stack = [(0, len(points)-1)]
    while stack:
        s, e = stack.pop()
        if e <= s+1: continue
        ax, ay = points[s]; bx, by = points[e]
        dx, dy = bx-ax, by-ay
        L2 = dx*dx + dy*dy
        best, bi = -1.0, -1
        for i in range(s+1, e):
            px, py = points[i]
            if L2 <= 1e-12:
                d = math.hypot(px-ax, py-ay)
            else:
                t = max(0, min(1, ((px-ax)*dx + (py-ay)*dy)/L2))
                d = math.hypot(px-(ax+t*dx), py-(ay+t*dy))
            if d > best: best, bi = d, i
        if best > tol:
            keep[bi] = True
            stack.append((s, bi)); stack.append((bi, e))
    return [i for i, k in enumerate(keep) if k]


def fit_chain(pts, keep_idx):
    """把 RDP 保留点拟合成三次贝塞尔，返回 [{p,in,out}...]。"""
    P = [pts[i] for i in keep_idx]
    n = len(P)
    # 切线：中心差分，端点用单侧
    T = []
    for i in range(n):
        if i == 0: tx, ty = P[1][0]-P[0][0], P[1][1]-P[0][1]
        elif i == n-1: tx, ty = P[-1][0]-P[-2][0], P[-1][1]-P[-2][1]
        else: tx, ty = P[i+1][0]-P[i-1][0], P[i+1][1]-P[i-1][1]
        L = math.hypot(tx, ty) or 1.0
        T.append((tx/L, ty/L))
    out = [{'p': P[0][:]}]
    for i in range(n-1):
        d = math.hypot(P[i+1][0]-P[i][0], P[i+1][1]-P[i][1])
        h = d/3.0
        c1 = [P[i][0] + T[i][0]*h, P[i][1] + T[i][1]*h]
        c2 = [P[i+1][0] - T[i+1][0]*h, P[i+1][1] - T[i+1][1]*h]
        out[-1]['out'] = c1
        out.append({'p': P[i+1][:], 'in': c2})
    return out


def sub_to_d(sub):
    a = sub['a']
    if not a: return ''
    s = f"M{q(a[0]['p'][0])},{q(a[0]['p'][1])}"
    for i in range(1, len(a)):
        prev = a[i-1]; cur = a[i]
        if 'out' in prev and 'in' in cur:
            s += f"C{q(prev['out'][0])},{q(prev['out'][1])} {q(cur['in'][0])},{q(cur['in'][1])} {q(cur['p'][0])},{q(cur['p'][1])}"
        else:
            s += f"L{q(cur['p'][0])},{q(cur['p'][1])}"
    if sub['closed']:
        # 闭合段：若首尾锚点有控制点，用 C 闭合
        last = a[-1]; first = a[0]
        s += 'Z'
    return s


def simplify(svg_text, tol=0.6):
    # 提取所有 path 的 d
    paths = []
    for m in re.finditer(r'<path\b([^>]*?)\bd="([^"]*)"([^>]*)>', svg_text):
        paths.append((m, m.group(2)))
    subs_all = []
    for pi, (m, d) in enumerate(paths):
        subs = parse_path(d)
        for si, sub in enumerate(subs):
            subs_all.append((pi, si, sub))
    # 段索引
    seg_map = {}
    for pi, si, sub in subs_all:
        for (i, j, c1, c2) in segs(sub):
            k = seg_key(sub['a'], i, j, c1, c2)
            seg_map.setdefault(k, []).append((pi, si, i))
    eligible = {k: v for k, v in seg_map.items() if len({(a, b) for a, b, _ in v}) == 2}

    # 子路径索引 + 锚点位置表（按位置匹配，不要求控制点完全一致）
    sub_index = {(pi, si): sub for pi, si, sub in subs_all}
    owners = {}
    for pi, si, sub in subs_all:
        for ai, anc in enumerate(sub['a']):
            owners.setdefault(qm(anc['p']), []).append((pi, si, ai))

    processed = set()
    seen_chains = set()
    replacements = []
    changed = 0; removed = 0; added = 0
    dbg = {'shared_pos': sum(1 for v in owners.values() if len({p for p, _, _ in v}) >= 2),
           'chains_short': 0, 'chains_third': 0, 'no_reduction': 0,
           'sample_fail': 0, 'applied': 0, 'lens': {}}

    for pi, si, sub in subs_all:
        a = sub['a']; n = len(a)
        for i0 in range(n):
            if (pi, si, i0) in processed: continue
            pos0 = qm(a[i0]['p'])
            occ0 = [o for o in owners.get(pos0, []) if o[0] != pi]
            if len(occ0) != 1: continue
            if len({p for p, _, _ in owners.get(pos0, [])}) != 2:
                dbg['chains_third'] += 1
                continue
            opi, osi, oi = occ0[0]
            osub = sub_index[(opi, osi)]
            ob = osub['a']

            # 沿 A 正向 / B 反向扩展
            lo = 0
            while i0 - lo - 1 >= 0 and oi + lo + 1 < len(ob):
                pa = qm(a[i0 - lo - 1]['p']); pb = qm(ob[oi + lo + 1]['p'])
                if pa != pb: break
                if len({p for p, _, _ in owners.get(pa, [])}) != 2: break
                lo += 1
            hi = 0
            while i0 + hi + 1 < n and oi - hi - 1 >= 0:
                pa = qm(a[i0 + hi + 1]['p']); pb = qm(ob[oi - hi - 1]['p'])
                if pa != pb: break
                if len({p for p, _, _ in owners.get(pa, [])}) != 2: break
                hi += 1

            start = i0 - lo
            end = i0 + hi
            k = end - start
            if k < 2:
                dbg['chains_short'] += 1
                continue
            if any((pi, si, t) in processed for t in range(start, end + 1)):
                continue
            sig = frozenset([(pi, si, start), (opi, osi, oi - hi)])
            if sig in seen_chains: continue
            seen_chains.add(sig)

            new = merge_chain(a, start, k, tol)
            if not new or len(new) - 1 >= k:
                dbg['no_reduction'] += 1
                continue

            replacements.append((pi, si, start, end, new, False))
            replacements.append((opi, osi, oi - hi, oi + lo, new, True))
            for t in range(start, end + 1): processed.add((pi, si, t))
            for t in range(oi - hi, oi + lo + 1): processed.add((opi, osi, t))
            removed += (k + 1) - len(new)
            added += len(new)
            changed += 1
            dbg['applied'] += 1
            dbg['lens'][k] = dbg['lens'].get(k, 0) + 1

    # 两阶段写回：先按子路径、再从后往前替换，避免索引失效
    by_sub = {}
    for r in replacements:
        by_sub.setdefault((r[0], r[1]), []).append(r)
    for key, lst in by_sub.items():
        sub = sub_index[key]
        for (_, _, s, e, new, rev) in sorted(lst, key=lambda r: r[2], reverse=True):
            apply_run(sub, s, e, new, rev)
    # 序列化
    out = svg_text
    for pi, (m, d) in enumerate(paths):
        subs = [s for p, si, s in subs_all if p == pi]
        nd = ' '.join(sub_to_d(s) for s in subs)
        out = out.replace(f'd="{d}"', f'd="{nd}"', 1)
    return out, {'chains': changed, 'removed': removed, 'added': added, 'dbg': dbg}


def apply_run(sub, start, end, new, reverse):
    """把子路径中「锚点 start..end」这条链的中间锚点替换为 new。

    new 的方向 = A 侧（start→end）的方向；reverse=True 时用于反向侧（end→start）。
    首尾锚点保留原坐标，只更新它们的入/出控制点，保证与相邻链衔接。
    """
    a = sub['a']
    if reverse:
        chain = []
        for x in reversed(new):
            y = {'p': x['p'][:]}
            if 'in' in x: y['out'] = x['in']      # 反向：原入控制点变出控制点
            if 'out' in x: y['in'] = x['out']
            chain.append(y)
    else:
        chain = [{'p': x['p'][:], 'in': x.get('in'), 'out': x.get('out')} for x in new]

    first = dict(a[start])
    if 'out' in chain[0]: first['out'] = chain[0]['out']
    last = dict(a[end])
    if 'in' in chain[-1]: last['in'] = chain[-1]['in']

    mid = []
    for x in chain[1:-1]:
        y = {'p': x['p']}
        if 'in' in x: y['in'] = x['in']
        if 'out' in x: y['out'] = x['out']
        mid.append(y)
    sub['a'] = a[:start] + [first] + mid + [last] + a[end+1:]


if __name__ == '__main__':
    src, dst = sys.argv[1], sys.argv[2]
    tol = float(sys.argv[3]) if len(sys.argv) > 3 else 0.6
    s = open(src, encoding='utf-8').read()
    out, stats = simplify(s, tol)
    open(dst, 'w', encoding='utf-8').write(out)
    print(stats)
