"""A scriptable OpenAI-compatible model for end-to-end tests. No key, no network, deterministic.

    python fake_model.py <port>

Behaviour, from the latest user message of a turn:
- contains "single word": answers "ready" (the provider test message).
- contains "WORK": a long turn. Each model call waits `WORK_STEP_S` (default 4) seconds, then calls a
  harmless built-in tool (`todo_list` with no arguments: it only reads the list), twice (a third identical call trips Hermes's loop guard), so a steered message has safe points to land on.
  The final answer lists every `CTX-<word>` marker seen anywhere in the conversation of that turn.
- anything else: "Hello from the local test model. You said: …".
Streaming and non-streaming are both supported.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 18080
STEP = float(os.environ.get("WORK_STEP_S", "4"))
MODEL = "tiny-local"


def _text(content) -> str:
    if isinstance(content, list):
        return " ".join(part.get("text", "") for part in content if isinstance(part, dict))
    return str(content or "")


def _turn(messages: list[dict]) -> tuple[str, list[dict]]:
    """The user message that opened the current turn (the first after the previous final answer), and the turn."""
    start = 0
    for i, m in enumerate(messages):
        if m.get("role") == "assistant" and not m.get("tool_calls") and _text(m.get("content")).strip():
            start = i + 1
    turn = messages[start:]
    opener = next((m for m in turn if m.get("role") == "user"), {})
    return _text(opener.get("content")), turn


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _json(self, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _reply(self, message: dict, finish: str, stream: bool) -> None:
        if not stream:
            self._json({"id": "x", "object": "chat.completion", "created": int(time.time()), "model": MODEL,
                        "choices": [{"index": 0, "finish_reason": finish, "message": message}],
                        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}})
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        delta = {"role": "assistant"}
        if message.get("content"):
            delta["content"] = message["content"]
        if message.get("tool_calls"):
            delta["tool_calls"] = [{"index": i, **call} for i, call in enumerate(message["tool_calls"])]
        chunk = {"id": "c", "object": "chat.completion.chunk", "created": int(time.time()), "model": MODEL,
                 "choices": [{"index": 0, "delta": delta, "finish_reason": None}]}
        self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
        done = {**chunk, "choices": [{"index": 0, "delta": {}, "finish_reason": finish}]}
        self.wfile.write(f"data: {json.dumps(done)}\n\ndata: [DONE]\n\n".encode())

    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"):
            self._json({"object": "list", "data": [{"id": MODEL, "object": "model"}]})
        else:
            self.send_error(404)

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        request = json.loads(self.rfile.read(length) or b"{}")
        if not self.path.rstrip("/").endswith("/chat/completions"):
            self.send_error(404)
            return
        messages = request.get("messages") or []
        stream = bool(request.get("stream"))
        opener, turn = _turn(messages)
        if "single word" in opener:
            self._reply({"role": "assistant", "content": "ready"}, "stop", stream)
            return
        if "WORK" not in opener:
            self._reply({"role": "assistant", "content": f"Hello from the local test model. You said: {opener[-80:]}"}, "stop", stream)
            return
        time.sleep(STEP)
        tool_results = sum(1 for m in turn if m.get("role") == "tool")
        if tool_results < 2:
            call = {"id": f"call_{tool_results}", "type": "function", "function": {"name": "todo_list", "arguments": "{}"}}
            self._reply({"role": "assistant", "content": None, "tool_calls": [call]}, "tool_calls", stream)
            return
        markers = sorted(set(re.findall(r"CTX-\w+", " ".join(_text(m.get("content")) for m in turn))))
        self._reply({"role": "assistant", "content": f"Work finished. Context received: {', '.join(markers) or 'none'}."}, "stop", stream)


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
