# -*- coding: utf-8 -*-
"""白底合成后再写 RGBA raw（alpha=255），避免透明像素被描摹引擎当成独立色层。"""
import sys
from PIL import Image

src, out_raw, out_png = sys.argv[1], sys.argv[2], sys.argv[3]
im = Image.open(src).convert("RGBA")
bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
bg.alpha_composite(im)
flat = bg.convert("RGB").convert("RGBA")
open(out_raw, "wb").write(flat.tobytes())
bg.convert("RGB").save(out_png)
print(f"size={im.width}x{im.height}")
