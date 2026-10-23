"""一次进程处理一个请求；标准输出只包含有界、带版本的 JSON 消息。"""
from __future__ import annotations

import hashlib
import importlib.metadata
import json
import os
import platform
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

PROTOCOL = 1
MAX_LINE = 64 * 1024


def read_line() -> bytes:
    # Avoid a daemon thread holding BufferedReader's stdin lock during Python
    # finalization. Both the initial request and controls use the same raw fd.
    data = bytearray()
    while len(data) <= MAX_LINE:
        byte = os.read(sys.stdin.fileno(), 1)
        if not byte:
            break
        data.extend(byte)
        if byte == b"\n":
            break
    return bytes(data)


def emit(request_id: str, kind: str, **payload: object) -> None:
    message = {"protocol": PROTOCOL, "id": request_id, "kind": kind, **payload}
    print(json.dumps(message, ensure_ascii=False, separators=(",", ":")), flush=True)


def health() -> dict:
    from peach_core import http
    from peach_core.catalog_rules import normalise_code_key
    from peach_core.sources import dmm, fc2, r18dev
    from PIL import Image
    from nectisse_worker import follow
    from nectisse_worker.metadata.query import SOURCES
    import parsel, pydantic, structlog

    # Construct both native transports without issuing a network request.
    standard = http.HttpxTransport()
    fingerprinted = http.CurlCffiTransport(impersonate="chrome150")
    standard.close()
    fingerprinted.close()
    return {
        "pythonVersion": platform.python_version(),
        "architecture": platform.machine(),
        "pid": os.getpid(),
        "executable": sys.executable,
        "httpxVersion": importlib.metadata.version("httpx"),
        "curlCffiVersion": importlib.metadata.version("curl_cffi"),
        "peachVersion": "0.46.1",
        "transportSha256": hashlib.sha256(Path(http.__file__).read_bytes()).hexdigest(),
        "identityProbe": normalise_code_key("FC2-PPV-1234567"),
    }


def main(*, allow_diagnostics: bool = False) -> int:
    raw = read_line()
    request_id = "invalid"
    try:
        if len(raw) > MAX_LINE:
            raise ValueError("message too large")
        request = json.loads(raw)
        if not isinstance(request, dict) or request.get("protocol") != PROTOCOL:
            raise ValueError("invalid protocol")
        request_id = request.get("id")
        if not isinstance(request_id, str) or not 1 <= len(request_id) <= 100:
            raise ValueError("invalid id")
        method = request.get("method")
        if method not in {"health", "metadata.query", "metadata.cover", "metadata.coverProbe", "follow.lookup", "follow.check", "follow.image", "magnet.search"} and not (allow_diagnostics and method in {"diagnostics.wait", "diagnostics.block"}):
            emit(request_id, "error", code="UNSUPPORTED_METHOD", message="尚未接入此采集能力")
            return 2
    except (ValueError, TypeError):
        emit("invalid", "error", code="INVALID_REQUEST", message="工作者请求格式不正确")
        return 2

    cancelled = threading.Event()
    permits: dict[int, threading.Event] = {}
    permit_lock = threading.Lock()
    sequence = 0
    parent = os.getppid()

    def terminate_owned_tree() -> None:
        if os.name != "nt" and os.getpgrp() == os.getpid():
            os.killpg(os.getpgrp(), signal.SIGTERM)
        else:
            os._exit(1)

    def controls() -> None:
        while True:
            line = read_line()
            if not line:
                cancelled.set()
                terminate_owned_tree()
                return
            if len(line) > MAX_LINE:
                cancelled.set()
                return
            try:
                command = json.loads(line)
                if command.get("id") == request_id and command.get("method") == "cancel":
                    cancelled.set()
                    return
                if command.get("id") == request_id and command.get("method") == "permit":
                    with permit_lock:
                        event = permits.get(command.get("sequence"))
                        if event is not None:
                            event.set()
            except (ValueError, AttributeError):
                cancelled.set()
                return

    def parent_watch() -> None:
        while True:
            time.sleep(0.5)
            if os.getppid() != parent:
                # The parent died, including when it could not run its quit handler.
                terminate_owned_tree()
                return

    threading.Thread(target=controls, daemon=True).start()
    threading.Thread(target=parent_watch, daemon=True).start()
    emit(request_id, "ready")
    def permit(source: str, host: str) -> None:
        nonlocal sequence
        from nectisse_worker.metadata.base import Cancelled, SourceFailure, FailureReason
        sequence += 1
        event = threading.Event()
        with permit_lock:
            permits[sequence] = event
        emit(request_id, "progress", payload={"event": "request", "source": source, "host": host, "sequence": sequence})
        until = time.monotonic() + 15
        try:
            while not event.wait(.05):
                if cancelled.is_set():
                    raise Cancelled()
                if time.monotonic() >= until:
                    raise SourceFailure(FailureReason.BUDGET, "请求调度等待超时")
        finally:
            with permit_lock:
                permits.pop(sequence, None)
        if cancelled.is_set():
            raise Cancelled()
    try:
        if method == "health":
            payload = health()
        elif method == "magnet.search":
            from nectisse_worker.magnets import job
            payload = job(request.get('params') or {}, cancelled, permit)
        elif method in {"follow.lookup", "follow.check", "follow.image"}:
            from nectisse_worker.follow import job
            payload = job(method, request.get("params") or {}, cancelled, permit, lambda entry: emit(request_id, "progress", payload={"event": "entry", "entry": entry}))
        elif method in {"metadata.query", "metadata.cover", "metadata.coverProbe"}:
            payload = metadata_job(request, cancelled, permit, lambda record: emit(request_id, "progress", payload={"event": "record", "record": record}))
        elif method == "diagnostics.wait":
            seconds = min(max(float(request.get("params", {}).get("seconds", 30)), 0), 60)
            cancelled.wait(seconds)
            payload = {"waited": seconds}
        else:
            # Only enabled by the test runner, never by the desktop IPC surface.
            child = subprocess.Popen(
                [sys.executable, "-I", "-S", "-c", "import time; time.sleep(60)"],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            emit(request_id, "progress", payload={"childPid": child.pid})
            time.sleep(60)
            payload = {}
        if cancelled.is_set():
            emit(request_id, "cancelled")
            return 0
        emit(request_id, "result", payload=payload)
        return 0
    except Exception as error:
        from nectisse_worker.metadata.base import Cancelled
        if isinstance(error, Cancelled):
            emit(request_id, "cancelled")
            return 0
        # Do not forward arbitrary exception strings, request headers or URLs.
        print(f"worker failure: {type(error).__name__}", file=sys.stderr, flush=True)
        emit(request_id, "error", code="ENVIRONMENT_ERROR", message="采集环境检查失败，请检查随包依赖")
        return 1


def metadata_job(request: dict, cancelled, permit, on_record) -> dict:
    from nectisse_worker.metadata.network import NetworkSession
    from nectisse_worker.metadata.query import SOURCES, query
    from nectisse_worker.metadata.cover import fetch_cover, probe_cover
    from nectisse_worker.metadata.base import SourceFailure, FailureReason
    params = request.get("params")
    if not isinstance(params, dict) or params.get("source") not in SOURCES:
        return {"status": "error", "reason": "unsupported", "message": "来源参数不正确", "retryAfter": 0, "requests": 0, "warnings": []}
    source = params["source"]
    probing = request['method'] == 'metadata.coverProbe'
    cover = request["method"] == "metadata.cover" or probing
    from nectisse_worker.catalog import image_domains
    domains = image_domains(source) if cover else SOURCES[source]().config.domains
    session = NetworkSession(source, domains, cancelled, permit, proxy=str(params.get("proxy") or ""), cookie=str(params.get('cookie') or ''), fingerprint=params.get('transport') == 'fingerprint')
    try:
        probe = probe_cover(params, session) if probing else None
        asset = fetch_cover(params, session) if cover and not probing else None
        if not cover:
            query(params, session, on_record=on_record)
        failure = session.failures[-1] if session.failures else None
        return {"status": "partial" if failure else "success", "reason": failure.reason.value if failure else "", "message": failure.message if failure else "来源查询完成", "retryAfter": failure.retry_after if failure else 0, "requests": session.count, "warnings": [item.message for item in session.failures], **({'probe': probe} if probing else {"asset": asset} if cover else {})}
    except SourceFailure as failure:
        return {"status": "error", "reason": failure.reason.value, "message": failure.message, "retryAfter": failure.retry_after, "requests": session.count, "warnings": []}
    except (ValueError, TypeError, KeyError, AttributeError):
        return {"status": "error", "reason": "parse_error", "message": "来源数据结构与解析器不匹配", "retryAfter": 0, "requests": session.count, "warnings": []}
    finally:
        session.close()
