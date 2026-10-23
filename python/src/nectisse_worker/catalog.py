"""界面和工作者共用的站点能力登记。"""
import json
from pathlib import Path
CATALOG = json.loads(Path(__file__).with_name('source_catalog.json').read_text())


def image_domains(source):
    row = CATALOG[source]
    return tuple(dict.fromkeys(row['images'] + (row['domains'] if source == 'makers' else [])))
