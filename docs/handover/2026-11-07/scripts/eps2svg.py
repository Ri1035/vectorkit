# -*- coding: utf-8 -*-
"""把 VM 导出的简单 PS 子集（moveto/lineto/curveto/closepath/setrgbcolor/fill）
转成 SVG，并统计结构（填充块、子路径、节点、颜色）。"""
import re
import sys
import json


def parse(path):
    lines = open(path, encoding="utf-8", errors="replace").read().splitlines()
    m = re.search(r"%%BoundingBox:\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)", "\n".join(lines[:20]))
    x0, y0, x1, y1 = [float(v) for v in m.groups()]
    W, H = x1 - x0, y1 - y0
    fills = []
    cur = []          # 当前 fill 的子路径列表（每个是命令字符串）
    sub = None
    color = (0, 0, 0)
    pend = []         # 待解析的数值
    stats = {"fills": 0, "subpaths": 0, "curves": 0, "lines": 0, "moves": 0, "colors": set()}

    def num(v):
        return float(v)

    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("%") or line in ("newpath",):
            continue
        if line == "closepath":
            if sub:
                sub.append("Z")
            continue
        if line == "fill":
            if cur:
                fills.append((color, cur))
                stats["fills"] += 1
                stats["colors"].add(color)
            cur = []
            sub = None
            continue
        mm = re.match(r"^([-\d.\s]+)\s+setrgbcolor$", line)
        if mm:
            vals = [float(v) for v in mm.group(1).split()]
            color = tuple(int(round(min(1, max(0, v)) * 255)) for v in vals[:3])
            continue
        mm = re.match(r"^([-\d.\s]+)\s+(\w+)$", line)
        if not mm:
            continue
        vals = [float(v) for v in mm.group(1).split()]
        op = mm.group(2)
        if op == "moveto":
            sub = ["M%.2f %.2f" % (vals[0] - x0, H - (vals[1] - y0))]
            cur.append(sub)
            stats["moves"] += 1
        elif op == "lineto":
            if sub is None:
                sub = []
                cur.append(sub)
                sub.append("M%.2f %.2f" % (vals[0] - x0, H - (vals[1] - y0)))
            sub.append("L%.2f %.2f" % (vals[0] - x0, H - (vals[1] - y0)))
            stats["lines"] += 1
        elif op == "curveto":
            sub.append("C%.2f %.2f %.2f %.2f %.2f %.2f" % (
                vals[0] - x0, H - (vals[1] - y0),
                vals[2] - x0, H - (vals[3] - y0),
                vals[4] - x0, H - (vals[5] - y0)))
            stats["curves"] += 1

    for color, subs in fills:
        stats["subpaths"] += len(subs)

    parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="%g" height="%g" viewBox="0 0 %g %g">' % (W, H, W, H)]
    details = []
    for color, subs in fills:
        d = " ".join(" ".join(s) for s in subs)
        hexc = "#%02x%02x%02x" % color
        parts.append('<path d="%s" fill="%s"/>' % (d, hexc))
        details.append({"fill": hexc, "subs": len(subs), "segs": sum(1 for s in subs for c in s if c in "LC")})
    parts.append("</svg>")
    stats["colors"] = len(stats["colors"])
    return "\n".join(parts), stats, details, (W, H)


if __name__ == "__main__":
    src, out = sys.argv[1], sys.argv[2]
    svg, stats, details, size = parse(src)
    open(out, "w", encoding="utf-8").write(svg)
    print(json.dumps({"size": size, "stats": stats,
                      "segs_per_fill": sorted([d["segs"] for d in details], reverse=True)[:10],
                      "subs_per_fill": sorted([d["subs"] for d in details], reverse=True)[:10]}, ensure_ascii=False))
