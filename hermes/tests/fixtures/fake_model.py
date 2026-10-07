"""A scriptable OpenAI-compatible model for end-to-end tests. No key, no network, deterministic.

    python fake_model.py <port>

Behaviour, from the latest user message of a turn:
- contains "single word": answers "ready" (the provider test message).
- contains "WORK": a long turn. Each model call waits `WORK_STEP_S` (default 4) seconds, then calls a
  harmless built-in tool (`skills_list`, read-only and always visible: deferred tools such as `todo_list` are
  refused before they start), twice (a third identical call trips Hermes's loop guard), so a steered message
  has safe points to land on and the live step line has a step to show.
  The final answer lists every `CTX-<word>` marker seen anywhere in the conversation of that turn.
- contains "QUIZME": calls Hermes's `clarify` tool ("Which colour?", Red / Blue; "QUIZME FREE" asks without
  choices), then answers "You picked: <the owner's answer>." from the tool's result.
- contains "ENVCHECK": runs one harmless `terminal` command that reports whether the bridge token is in the
  agent's own environment, then answers "Env check: <the command's output>." (the token must never be seen).
- contains "APPROVEME": runs `rm -r ./chief-smoke-absent` (a folder that doesn't exist), which Hermes asks the
  owner to approve as a recursive delete; once approved and run, answers "Approved and ran." (the Electron smoke test).
- contains "LANES": hands two tasks to helpers with `delegate_task` ("WORK on lane one", "WORK on lane two", each a
  long turn as above, so they run for a while in the background), then answers "Lanes started.".
- contains "MAILME": "sends" an email through the Google Workspace skill (a harmless `echo google_api.py gmail send …`),
  which the bridge's mail guard asks the owner to approve; once approved, answers "Mail step done.".
- contains "CONNECTME": asks for Gmail with the bridge's `connections` tool (a Connect card), then answers
  "Asked for Gmail.".
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
# Seconds between streamed words (streaming requests only).
STREAM_STEP = float(os.environ.get("STREAM_STEP_S", "0.04"))
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
            self._json(
                {
                    "id": "x",
                    "object": "chat.completion",
                    "created": int(time.time()),
                    "model": MODEL,
                    "choices": [{"index": 0, "finish_reason": finish, "message": message}],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
                }
            )
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        chunk = {
            "id": "c",
            "object": "chat.completion.chunk",
            "created": int(time.time()),
            "model": MODEL,
            "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}],
        }
        if message.get("tool_calls"):
            delta = {"role": "assistant", "tool_calls": [{"index": i, **call} for i, call in enumerate(message["tool_calls"])]}
            self.wfile.write(f"data: {json.dumps({**chunk, 'choices': [{'index': 0, 'delta': delta, 'finish_reason': None}]})}\n\n".encode())
        # Text streams a word at a time, like a real model, so the app's "reply as it's written" has frames to show.
        words = str(message.get("content") or "").split(" ")
        for i, word in enumerate(w for w in words if w or True):
            if not word and i:
                continue
            piece = (" " if i else "") + word
            self.wfile.write(
                f"data: {json.dumps({**chunk, 'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': piece}, 'finish_reason': None}]})}\n\n".encode()
            )
            self.wfile.flush()
            time.sleep(STREAM_STEP)
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
        # FAKE_MODEL_DUMP=<file>: one JSON line per request's messages, to check what the agent sends.
        if os.environ.get("FAKE_MODEL_DUMP"):
            with open(os.environ["FAKE_MODEL_DUMP"], "a", encoding="utf-8") as dump:
                dump.write(json.dumps(request.get("messages") or [], ensure_ascii=False) + "\n")
        messages = request.get("messages") or []
        stream = bool(request.get("stream"))
        opener, turn = _turn(messages)
        if "single word" in opener:
            self._reply({"role": "assistant", "content": "ready"}, "stop", stream)
            return
        if "QUIZME" in opener:
            answered = [m for m in turn if m.get("role") == "tool"]
            if not answered:
                args = {"question": "Which colour?"} if "FREE" in opener else {"question": "Which colour?", "choices": ["Red", "Blue"]}
                call = {"id": "call_ask", "type": "function", "function": {"name": "clarify", "arguments": json.dumps(args)}}
                self._reply({"role": "assistant", "content": None, "tool_calls": [call]}, "tool_calls", stream)
                return
            try:
                picked = json.loads(_text(answered[-1].get("content"))).get("user_response")
            except (ValueError, AttributeError):
                picked = _text(answered[-1].get("content"))
            self._reply({"role": "assistant", "content": f"You picked: {picked}."}, "stop", stream)
            return
        if "ENVCHECK" in opener:
            answered = [m for m in turn if m.get("role") == "tool"]
            if not answered:
                cmd = 'if [ -n "${CHIEF_DASHBOARD_TOKEN:-}" ]; then echo TOKEN-SEEN; else echo TOKEN-ABSENT; fi'
                call = {"id": "call_env", "type": "function", "function": {"name": "terminal", "arguments": json.dumps({"command": cmd})}}
                self._reply({"role": "assistant", "content": None, "tool_calls": [call]}, "tool_calls", stream)
                return
            out = _text(answered[-1].get("content"))
            seen = "TOKEN-SEEN" if "TOKEN-SEEN" in out else "TOKEN-ABSENT" if "TOKEN-ABSENT" in out else f"unclear: {out[:200]}"
            self._reply({"role": "assistant", "content": f"Env check: {seen}."}, "stop", stream)
            return
        if "APPROVEME" in opener:
            answered = [m for m in turn if m.get("role") == "tool"]
            if not answered:
                args = {"command": "rm -r ./chief-smoke-absent"}
                call = {"id": "call_approve", "type": "function", "function": {"name": "terminal", "arguments": json.dumps(args)}}
                self._reply({"role": "assistant", "content": None, "tool_calls": [call]}, "tool_calls", stream)
                return
            self._reply({"role": "assistant", "content": "Approved and ran."}, "stop", stream)
            return
        if "MAILME" in opener:
            answered = [m for m in turn if m.get("role") == "tool"]
            if not answered:
                args = {"command": 'echo google_api.py gmail send --to friend@example.com --subject "Thursday plan" --body "See you at noon"'}
                call = {"id": "call_mail", "type": "function", "function": {"name": "terminal", "arguments": json.dumps(args)}}
                self._reply({"role": "assistant", "content": None, "tool_calls": [call]}, "tool_calls", stream)
                return
            self._reply({"role": "assistant", "content": "Mail step done."}, "stop", stream)
            return
        if "CONNECTME" in opener:
            answered = [m for m in turn if m.get("role") == "tool"]
            if not answered:
                # Plugin tools are deferred behind Hermes's tool search: a model reaches them through tool_call.
                args = {"calls": [{"name": "connections", "arguments": {"action": "request", "service": "gmail", "why": "to sort your inbox"}}]}
                call = {"id": "call_connect", "type": "function", "function": {"name": "tool_call", "arguments": json.dumps(args)}}
                self._reply({"role": "assistant", "content": None, "tool_calls": [call]}, "tool_calls", stream)
                return
            self._reply({"role": "assistant", "content": "Asked for Gmail."}, "stop", stream)
            return
        if "LANES" in opener:
            answered = [m for m in turn if m.get("role") == "tool"]
            if not answered:
                args = {"tasks": [{"goal": "WORK on lane one"}, {"goal": "WORK on lane two"}]}
                call = {"id": "call_lanes", "type": "function", "function": {"name": "delegate_task", "arguments": json.dumps(args)}}
                self._reply({"role": "assistant", "content": None, "tool_calls": [call]}, "tool_calls", stream)
                return
            self._reply({"role": "assistant", "content": "Lanes started."}, "stop", stream)
            return
        if "WORK" not in opener:
            self._reply({"role": "assistant", "content": f"Hello from the local test model. You said: {opener[-80:]}"}, "stop", stream)
            return
        time.sleep(STEP)
        tool_results = sum(1 for m in turn if m.get("role") == "tool")
        if tool_results < 2:
            call = {"id": f"call_{tool_results}", "type": "function", "function": {"name": "skills_list", "arguments": "{}"}}
            self._reply({"role": "assistant", "content": None, "tool_calls": [call]}, "tool_calls", stream)
            return
        markers = sorted(set(re.findall(r"CTX-\w+", " ".join(_text(m.get("content")) for m in turn))))
        self._reply({"role": "assistant", "content": f"Work finished. Context received: {', '.join(markers) or 'none'}."}, "stop", stream)


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
