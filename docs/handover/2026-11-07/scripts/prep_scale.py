# -*- coding: utf-8 -*-
"""分辨率档位实验：白底合成 → 按倍数上采样 → 写 RGBA raw；参考图保持原始尺寸。

用法: python prep_scale.py <src.png> <scale> <out.raw> <out_ref.png>
插值用 BICUBIC（浏览器 canvas imageSmoothingQuality='high' 的近似）。
"""
import sys
from PIL import Image

src, scale, out_raw, out_ref = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
im = Image.open(src).convert("RGBA")
bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
bg.alpha_composite(im)
bg.convert("RGB").save(out_ref)               # 参考图 = 原始尺寸白底合成

w, h = im.size
if scale > 1:
    im = bg.convert("RGB").resize((w * scale, h * scale), Image.BICUBIC).convert("RGBA")
else:
    im = bg.convert("RGB").convert("RGBA")

open(out_raw, "wb").write(im.tobytes())
print(f"src={w}x{h} scale={scale} raw={im.width}x{im.height} pixels={im.width*im.height/1e6:.2f}M")
