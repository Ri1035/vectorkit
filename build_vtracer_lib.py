# -*- coding: utf-8 -*-
"""
把官方 npm 包里的 Node 版 VTracer 胶水（pkg/vtracer_wasm.js）转成浏览器版：
- 移除 Node 专属导出（exports.xxx）
- 截掉 Node 尾部（__dirname / require('fs') 读取 wasm）
- 把 wasm 本体以 base64 内嵌，实例化后挂到 window.VTracerEngine
产物：lib/vtracer.js（纯浏览器、可 file:// 双击打开、完全离线）
输入文件来自官方包：https://cdn.jsdelivr.net/npm/@visioncortex/vtracer@1.0.0-alpha.4/pkg/
"""
import base64
import pathlib

BASE = pathlib.Path(r"C:\Users\Mayn\Doubao\chats\2026-10-04\new-chat\bitmap2vector")

glue = (BASE / "lib" / "_vtracer_wasm.js").read_text(encoding="utf-8")
wasm = (BASE / "lib" / "_vtracer_wasm_bg.wasm").read_bytes()

# 1) 去掉 Node 导出行（保留函数声明本身）
glue = glue.replace("exports.vectorize_bytes = vectorize_bytes;\n", "")
glue = glue.replace("exports.vectorize_rgba = vectorize_rgba;\n", "")

# 2) 截掉 Node 尾部（从 const wasmPath 开始）
marker = "const wasmPath ="
idx = glue.find(marker)
assert idx != -1, "tail marker not found"
glue = glue[:idx]

# 3) 追加浏览器实例化 + 全局导出
b64 = base64.b64encode(wasm).decode("ascii")
tail = (
    'const WASM_BASE64 = "' + b64 + '";\n'
    "const _b64bytes = (function(){\n"
    "  const bin = atob(WASM_BASE64);\n"
    "  const out = new Uint8Array(bin.length);\n"
    "  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);\n"
    "  return out;\n"
    "})();\n"
    "const wasmModule = new WebAssembly.Module(_b64bytes);\n"
    "let wasmInstance = new WebAssembly.Instance(wasmModule, __wbg_get_imports());\n"
    "let wasm = wasmInstance.exports;\n"
    "wasm.__wbindgen_start();\n"
    "window.VTracerEngine = {\n"
    "  vectorize_bytes: vectorize_bytes,\n"
    "  vectorize_rgba: vectorize_rgba\n"
    "};\n"
)

out = glue + tail
(BASE / "lib" / "vtracer.js").write_text(out, encoding="utf-8")
print("lib/vtracer.js written, size:", len(out.encode("utf-8")), "bytes")
