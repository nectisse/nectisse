"""使用显式依赖目录启动工作者，不读取用户的 Python 环境。"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--dependencies", required=True, type=Path)
parser.add_argument("--diagnostics", action="store_true")
parser.add_argument("--browser-session", type=Path)
args = parser.parse_args()

root = Path(__file__).resolve().parent
sys.path[:0] = [
    str(root / "src"),
    str(root / "vendor"),
    str(args.dependencies.resolve()),
]

from nectisse_worker.worker import main

if __name__ == "__main__":
    if args.browser_session is not None:
        from nectisse_worker.browser_worker import main as browser_main
        raise SystemExit(browser_main(args.browser_session, allow_diagnostics=args.diagnostics))
    raise SystemExit(main(allow_diagnostics=args.diagnostics))
