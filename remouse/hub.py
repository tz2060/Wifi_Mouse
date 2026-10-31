"""会话管理：消息分发、位移合帧、断线兜底。

为什么每个连接一个注入线程：
  SendInput 是阻塞调用。如果在 asyncio 事件循环里直接调，
  一次卡顿就把所有连接的响应拖住，手感立刻变成"鼠标一顿一顿"。
  放后台线程，事件循环只负责收包和排队。

为什么合并位移：
  手机 60~120Hz 发 mv，网络抖动会带来成串的突发消息。
  把一批里连续的 mv 合成一次 SendInput，突发时不会堆积成滞后队列，
  而点击、按键、文本一律不合并——它们的顺序和时点必须精确。
"""

from __future__ import annotations

import json
import queue
import threading
import time
from dataclasses import dataclass
from typing import Any

from . import auth, protocol
from .config import Settings
from .input.base import InputBackend

SHUTDOWN = object()
MAX_QUEUE = 512

# 同一批里合并位移的上限，防止一次跳太远
MERGE_LIMIT = 2000.0


def _is_text_like(raw: str | bytes) -> bool:
    """粗略判断这是不是一条文本消息。

    只在 decode 失败后调用，用来决定要不要把错误回传给用户。
    文本超限是用户自己造成的、可以自查的问题，值得告知；
    而畸形 JSON / 非法字段属于协议层噪音，继续静默。

    这里不追求精确——解析本来就已经失败了，只能做字节层面的粗判。
    判错的代价很小：要么多回一条无害的错误提示，要么少提示一次。
    """
    try:
        head = raw if isinstance(raw, str) else raw.decode("utf-8", "ignore")
    except Exception:
        return False
    # 文本消息的特征：类型字段是 tx
    return '"tx"' in head or '"t": "tx"' in head or "'tx'" in head


@dataclass(frozen=True)
class SessionInfo:
    peer: str
    user_agent: str
    connected_at: float


class Session:
    """一条手机连接。生命周期内只有一个注入线程。"""

    def __init__(self, hub: "Hub", info: SessionInfo) -> None:
        self.hub = hub
        self.info = info
        self._queue: queue.Queue[Any] = queue.Queue(maxsize=MAX_QUEUE)
        self._closed = threading.Event()
        self._thread = threading.Thread(target=self._run, name=f"inject-{info.peer}", daemon=True)
        self._thread.start()
        self.commands = 0
        self.dropped = 0

    # ---------- 生产者（事件循环线程） ----------

    def submit(self, command: protocol.Command) -> None:
        if self._closed.is_set():
            return
        try:
            self._queue.put_nowait(command)
        except queue.Full:
            # 队列满说明注入卡住了，丢掉最旧的移动指令比丢弃点击好
            self.dropped += 1
            try:
                self._queue.get_nowait()
                self._queue.put_nowait(command)
            except queue.Empty:
                pass

    def close(self) -> None:
        if self._closed.is_set():
            return
        self._closed.set()
        try:
            self._queue.put_nowait(SHUTDOWN)
        except queue.Full:
            pass
        self._thread.join(timeout=1.0)

    # ---------- 消费者（注入线程） ----------

    def _run(self) -> None:
        backend = self.hub.backend
        while True:
            try:
                first = self._queue.get(timeout=0.5)
            except queue.Empty:
                if self._closed.is_set():
                    break
                continue

            if first is SHUTDOWN:
                break

            batch = [first]
            # 把已经排队的都取出来，一次处理，顺手合并相邻位移
            while True:
                try:
                    batch.append(self._queue.get_nowait())
                except queue.Empty:
                    break

            if any(item is SHUTDOWN for item in batch):
                break

            self._execute_batch(backend, batch)

        # 无论怎么退出，都必须放掉还按着的键
        try:
            backend.release_all()
        except Exception:
            pass

    def _execute_batch(self, backend: InputBackend, batch: list) -> None:
        pending_dx = 0.0
        pending_dy = 0.0
        has_pending = False

        def flush() -> None:
            nonlocal pending_dx, pending_dy, has_pending
            if not has_pending:
                return
            dx = max(-MERGE_LIMIT, min(MERGE_LIMIT, pending_dx))
            dy = max(-MERGE_LIMIT, min(MERGE_LIMIT, pending_dy))
            if abs(dx) >= 0.5 or abs(dy) >= 0.5:
                try:
                    backend.move_rel(dx, dy)
                except Exception as exc:
                    self._report(exc)
            pending_dx = 0.0
            pending_dy = 0.0
            has_pending = False

        for command in batch:
            self.commands += 1
            kind = command.kind
            args = command.args

            if kind == "move_rel":
                pending_dx += args["dx"]
                pending_dy += args["dy"]
                has_pending = True
                continue

            # 任何非移动指令之前，先把攒下的位移刷出去，保证顺序
            flush()

            try:
                if kind == "move_abs":
                    backend.move_abs(args["nx"], args["ny"])
                elif kind == "button":
                    backend.button(args["btn"], args["action"])
                elif kind == "wheel":
                    backend.wheel(args["dy"], args["dx"])
                elif kind == "key":
                    backend.key_combo(args["combo"])
                elif kind == "text":
                    backend.type_text(args["text"])
                elif kind == "media":
                    backend.media(args["action"])
                else:  # pragma: no cover - 上游已过滤
                    continue
            except Exception as exc:
                self._report(exc)

        flush()

    def _report(self, exc: Exception) -> None:
        self.hub.on_error(self, exc)


class Hub:
    """进程内所有连接的注册表。"""

    def __init__(self, settings: Settings, backend: InputBackend) -> None:
        self.settings = settings
        self.backend = backend
        self._sessions: dict[str, Session] = {}
        self._lock = threading.Lock()
        self._record_handle = None
        self._record_lock = threading.Lock()
        self.error_count = 0
        self.last_error: str = ""

        if settings.record:
            settings.ensure_state_dir()
            self._record_handle = settings.record_file.open("a", encoding="utf-8")

    # ---------- 连接生命周期 ----------

    def attach(self, info: SessionInfo) -> Session:
        session = Session(self, info)
        with self._lock:
            self._sessions[str(id(session))] = session
        print(f"[remouse] {info.peer} 已连接（UA: {info.user_agent[:60] or '未知'}）")
        return session

    def detach(self, session: Session) -> None:
        with self._lock:
            self._sessions.pop(str(id(session)), None)
        session.close()
        print(f"[remouse] {session.info.peer} 已断开，注入 {session.commands} 条指令")

    def shutdown(self) -> None:
        with self._lock:
            sessions = list(self._sessions.values())
            self._sessions.clear()
        for session in sessions:
            session.close()
        try:
            self.backend.release_all()
        except Exception:
            pass
        if self._record_handle:
            self._record_handle.close()
            self._record_handle = None

    # ---------- 消息入口 ----------

    def handle_text(self, session: Session, raw: str | bytes) -> str | None:
        """处理一条客户端消息，返回需要回给客户端的内容（通常 None）。"""
        if self._record_handle:
            self._record(session, raw)

        try:
            message = protocol.decode(raw)
        except protocol.ProtocolError as exc:
            # 不能一概静默丢弃："消息过大"这类问题如果吞掉，
            # 用户看到的是"提示已发送、电脑上什么都没有"，
            # 完全无法自查。文本类消息把原因回传，其余（畸形 JSON、
            # 非法字段）仍然静默，避免被用来探测协议细节。
            if _is_text_like(raw):
                return protocol.encode_error(str(exc))
            return None

        if message.type == protocol.T_PING:
            return protocol.encode_pong(message.raw.get("n"))

        try:
            command = protocol.to_command(message)
        except protocol.ProtocolError as exc:
            return protocol.encode_error(str(exc))

        if command is not None:
            session.submit(command)
        return None

    def _record(self, session: Session, raw: str | bytes) -> None:
        if isinstance(raw, bytes):
            try:
                raw = raw.decode("utf-8")
            except UnicodeDecodeError:
                return
        entry = {
            "ts": round(time.time(), 4),
            "peer": session.info.peer,
            "msg": raw,
        }
        with self._record_lock:
            if self._record_handle:
                self._record_handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
                self._record_handle.flush()

    def on_error(self, session: Session, exc: Exception) -> None:
        self.error_count += 1
        self.last_error = str(exc)
        # UIPI 拒绝很常见（目标窗口是管理员权限），不必每次刷屏
        if self.error_count <= 5 or self.error_count % 50 == 0:
            print(f"[remouse] 注入失败（第 {self.error_count} 次）: {exc}")

    # ---------- 状态 ----------

    def stats(self) -> dict[str, Any]:
        with self._lock:
            sessions = len(self._sessions)
        return {
            "sessions": sessions,
            "errors": self.error_count,
            "last_error": self.last_error,
            "backend": self.backend.name,
        }


def authorize(settings: Settings, provided: str) -> bool:
    return auth.token_matches(settings.token, provided)
