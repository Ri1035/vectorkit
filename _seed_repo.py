# -*- coding: utf-8 -*-
"""空仓库种子提交：用 Contents API 写入 README.md 建立 main 分支与首个提交"""
import base64, json, os, pathlib, urllib.request

token = os.environ["GH_TOKEN"]
readme = pathlib.Path(r"C:\Users\Mayn\Doubao\chats\2026-10-04\new-chat\bitmap2vector\README.md").read_bytes()

req = urllib.request.Request("https://api.github.com/repos/Ri1035/Vector-DB/contents/README.md", method="PUT")
req.add_header("Authorization", "Bearer " + token)
req.add_header("Accept", "application/vnd.github+json")
req.add_header("User-Agent", "vector-db-init")
req.add_header("Content-Type", "application/json")
body = json.dumps({
    "message": "init: README",
    "content": base64.b64encode(readme).decode(),
    "branch": "main",
}).encode("utf-8")
try:
    with urllib.request.urlopen(req, body) as r:
        d = json.loads(r.read().decode("utf-8"))
        print("SEED_OK", d.get("commit", {}).get("sha", "")[:8])
except urllib.error.HTTPError as e:
    print("SEED_FAIL", e.code, e.read().decode()[:400])
