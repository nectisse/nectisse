"""Peach 姓名比较片段。"""
import re
import unicodedata

def name_key(name: str) -> str:
    """名字比对用的键：全角半角归一、去空白、不分大小写。

    目录站写 `三上悠亜`，账本别名也是 `三上悠亜`，但中间可能多一个全角空格或半角空格；
    罗马字则常见 `Yua Mikami` 与 `YUA MIKAMI` 两种写法。键只用来找候选，最终装入的
    名字仍是账本里的那一个。
    """
    folded = unicodedata.normalize("NFKC", str(name or "")).casefold()
    return re.sub(r"\s+", "", folded)
