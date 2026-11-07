# -*- coding: utf-8 -*-
"""PNG -> RGBA raw（供 perceptual-eval.mjs 使用）。"""
import sys
import numpy as np
from PIL import Image

im = Image.open(sys.argv[1]).convert("RGBA")
np.asarray(im, dtype=np.uint8).tofile(sys.argv[2])
print(f"{im.width}x{im.height}")
