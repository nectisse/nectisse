"""按站点串行复用浏览器；控制消息始终由独立线程读取，父进程退出即回收进程组。"""
from __future__ import annotations

import json
import os
import queue
import signal
import threading
import time
from pathlib import Path

from .worker import MAX_LINE, PROTOCOL, emit, read_line
from .browser_session import BrowserPool, BrowserSession
from .metadata.base import Cancelled, SourceFailure
from .metadata.query import query


def main(profile: Path, *, allow_diagnostics=False):
    pool = BrowserPool(profile)
    inbox = queue.Queue()
    state = {"id": None, "cancelled": threading.Event(), "permits": {}}
    lock = threading.Lock()
    parent = os.getppid()

    def terminate():
        if os.name != "nt" and os.getpgrp() == os.getpid():
            os.killpg(os.getpgrp(), signal.SIGTERM)
        else:
            os._exit(1)

    def controls():
        while True:
            raw = read_line()
            if not raw or len(raw) > MAX_LINE:
                state["cancelled"].set()
                inbox.put(None)
                return
            try:
                command = json.loads(raw)
                if command.get("protocol") != PROTOCOL:
                    raise ValueError()
                with lock:
                    if command.get("method") == "permit" and command.get("id") == state["id"]:
                        event = state["permits"].get(command.get("sequence"))
                        if event is not None:
                            event.set()
                    elif command.get("method") == "metadata.query":
                        inbox.put(command)
                    else:
                        state["cancelled"].set()
            except (ValueError, TypeError, AttributeError):
                state["cancelled"].set()
                inbox.put(None)
                return

    def watch():
        while True:
            time.sleep(.5)
            if os.getppid() != parent:
                terminate()

    threading.Thread(target=controls, daemon=True).start()
    threading.Thread(target=watch, daemon=True).start()
    try:
        while (request := inbox.get()) is not None:
            request_id = request.get("id")
            if not isinstance(request_id, str) or not 1 <= len(request_id) <= 100:
                return 2
            cancelled = threading.Event()
            with lock:
                state.update(id=request_id, cancelled=cancelled, permits={})
            sequence = 0
            emit(request_id, "ready")

            def progress(payload):
                emit(request_id, "progress", payload=payload)

            def permit(source, host):
                nonlocal sequence
                sequence += 1
                event = threading.Event()
                with lock:
                    state["permits"][sequence] = event
                progress({"event": "request", "source": source, "host": host, "sequence": sequence})
                until = time.monotonic() + 15
                while not event.wait(.05):
                    if cancelled.is_set():
                        raise Cancelled()
                    if time.monotonic() >= until:
                        from .metadata.base import FailureReason
                        raise SourceFailure(FailureReason.BUDGET, "浏览器页面请求调度等待超时")
                with lock:
                    state["permits"].pop(sequence, None)
                if cancelled.is_set():
                    raise Cancelled()

            params = request.get("params") or {}
            session = None
            try:
                if params.get("source") != "fc2ppvdb" or params.get("transport") != "browser":
                    raise ValueError("unsupported browser source")
                if allow_diagnostics and params.get("diagnosticWait"):
                    cancelled.wait(min(float(params["diagnosticWait"]), 60))
                    if cancelled.is_set():
                        raise Cancelled()
                session = BrowserSession(pool.acquire(str(params.get("proxy") or "")), cancelled, permit, progress)
                query(params, session, on_record=lambda record: progress({"event": "record", "record": record}))
                payload = {"status": "success", "reason": "", "message": "FC2PPV-DB 浏览器查询完成", "retryAfter": 0, "requests": session.count, "warnings": []}
            except Cancelled:
                return 0
            except SourceFailure as error:
                payload = {"status": "error", "reason": error.reason.value, "message": error.message, "retryAfter": error.retry_after, "requests": session.count if session else 0, "warnings": []}
            except Exception as error:
                # 仅异常类型进入 stderr，不输出浏览器文档、Cookie、地址或 CDP 消息。
                import sys
                print(f"browser worker failure: {type(error).__name__}", file=sys.stderr, flush=True)
                pool.close()
                payload = {"status": "error", "reason": "parse_error", "message": "FC2PPV-DB 浏览器页面或解析器结构发生变化", "retryAfter": 0, "requests": session.count if session else 0, "warnings": []}
            finally:
                if session is not None:
                    try:
                        session.close()
                    except (OSError, RuntimeError, Cancelled, SourceFailure):
                        pool.close()
            if cancelled.is_set():
                return 0
            emit(request_id, "result", payload=payload)
    finally:
        pool.close()
    return 0
