from __future__ import annotations

import difflib
import hashlib
import json
import os
import re
import subprocess
import sys
import threading
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlparse

import requests
import webview


APP_NAME = "CodeX"
APP_DIR = Path(__file__).resolve().parent
UI_FILE = APP_DIR / "ui" / "index.html"
APP_ICON = (APP_DIR / "icon.ico") if (APP_DIR / "icon.ico").is_file() else (APP_DIR / "ui" / "icon.ico")
API_URL = "YOUR_API_URL_HERE"
IGNORED_DIRS = {".git", ".venv", "venv", "__pycache__", "node_modules", ".idea", ".pytest_cache"}
TEXT_EXTENSIONS = {
    ".py", ".js", ".jsx", ".ts", ".tsx", ".html", ".htm", ".css", ".scss", ".json",
    ".md", ".txt", ".yml", ".yaml", ".toml", ".xml", ".sql", ".sh", ".bat", ".ps1",
    ".c", ".h", ".cpp", ".cs", ".java", ".go", ".rs", ".php", ".rb", ".ini", ".env",
}
MAX_CONTEXT_CHARS = 8500
MAX_OPEN_FILE_BYTES = 8 * 1024 * 1024


class PreviewRequestHandler(SimpleHTTPRequestHandler):
    """Serve project files to the preview tab, keeping paths inside the project."""

    def translate_path(self, path: str) -> str:
        candidate = Path(super().translate_path(path)).resolve()
        root = Path(self.directory).resolve()
        try:
            candidate.relative_to(root)
            return str(candidate)
        except ValueError:
            return str(root / ".codex-missing-file")

    def do_GET(self):
        request_path = unquote(urlparse(self.path).path)
        if Path(request_path).suffix.lower() not in {".html", ".htm"}:
            return super().do_GET()
        file_path = Path(self.translate_path(self.path))
        try:
            raw = file_path.read_bytes()
            stat = file_path.stat()
        except OSError:
            return super().do_GET()
        try:
            html = raw.decode("utf-8")
        except UnicodeDecodeError:
            return super().do_GET()
        version = self.project_version(Path(self.directory))
        reload_script = (
            "<script>(function(){const v=" + json.dumps(version) + ";"
            "setInterval(async()=>{try{const r=await fetch(location.href,{method:'HEAD',cache:'no-store'});"
            "if(r.ok&&r.headers.get('X-CodeX-Version')!==v)location.reload()}catch(e){}},1000)})();</script>"
        )
        lower = html.lower()
        position = lower.rfind("</body>")
        html = html[:position] + reload_script + html[position:] if position >= 0 else html + reload_script
        payload = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Last-Modified", self.date_time_string(stat.st_mtime))
        self.send_header("X-CodeX-Version", version)
        self.end_headers()
        self.wfile.write(payload)

    def do_HEAD(self):
        request_path = unquote(urlparse(self.path).path)
        if Path(request_path).suffix.lower() in {".html", ".htm"}:
            file_path = Path(self.translate_path(self.path))
            try:
                stat = file_path.stat()
            except OSError:
                return super().do_HEAD()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(stat.st_size))
            self.send_header("Last-Modified", self.date_time_string(stat.st_mtime))
            self.send_header("X-CodeX-Version", self.project_version(Path(self.directory)))
            self.end_headers()
            return
        super().do_HEAD()

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, _format, *_args):
        pass

    @staticmethod
    def project_version(root: Path) -> str:
        digest = hashlib.blake2b(digest_size=8)
        for current, directories, filenames in os.walk(root):
            directories[:] = sorted(d for d in directories if d not in IGNORED_DIRS)
            for filename in sorted(filenames):
                path = Path(current) / filename
                try:
                    stat = path.stat()
                    relative = path.relative_to(root).as_posix()
                    digest.update(f"{relative}:{stat.st_mtime_ns}:{stat.st_size}\n".encode())
                except OSError:
                    continue
        return digest.hexdigest()


class CodeXBridge:
    """Narrow Python API exposed to the local PyWebView frontend."""

    def __init__(self):
        self.root = (Path.home() / "CodeX").resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.window = None
        self.preview_server = None
        self.preview_thread = None
        self.preview_port = None
        self.preview_root = None
        self.active_file = None
        self._terminal_processes = set()
        self._terminal_lock = threading.Lock()

    def _inside_project(self, value: str | Path) -> Path:
        path = Path(value)
        target = (self.root / path).resolve() if not path.is_absolute() else path.resolve()
        target.relative_to(self.root)
        return target

    @staticmethod
    def _relative(path: Path, root: Path) -> str:
        return path.relative_to(root).as_posix()

    def _walk_files(self):
        for current, directories, filenames in os.walk(self.root):
            directories[:] = sorted(d for d in directories if d not in IGNORED_DIRS and not (Path(current) / d).is_symlink())
            for filename in sorted(filenames, key=str.casefold):
                path = Path(current) / filename
                if path.is_symlink():
                    continue
                yield path

    def list_files(self):
        result = []
        for path in self._walk_files():
            try:
                rel = self._relative(path, self.root)
                result.append({
                    "path": rel,
                    "name": path.name,
                    "extension": path.suffix.lower(),
                    "is_dir": False,
                })
            except (OSError, ValueError):
                continue
        # Keep directories explicit so the frontend can render a familiar tree.
        dirs = []
        for current, names, _files in os.walk(self.root):
            names[:] = sorted(d for d in names if d not in IGNORED_DIRS and not (Path(current) / d).is_symlink())
            for name in names:
                path = Path(current) / name
                dirs.append({"path": self._relative(path, self.root), "name": name, "extension": "", "is_dir": True})
        result.extend(dirs)
        result.sort(key=lambda item: (item["path"].count("/"), item["path"].casefold()))
        return {"root": self.root.name, "files": result}

    def get_file(self, relative_path: str):
        try:
            path = self._inside_project(relative_path)
            if not path.is_file() or path.stat().st_size > MAX_OPEN_FILE_BYTES:
                return {"ok": False, "error": "This file is missing or larger than 8 MB."}
            content = path.read_text(encoding="utf-8-sig")
            self.active_file = self._relative(path, self.root)
            return {"ok": True, "path": self.active_file, "content": content, "extension": path.suffix.lower()}
        except (OSError, UnicodeError, ValueError) as exc:
            return {"ok": False, "error": str(exc)}

    def save_file(self, relative_path: str, content: str):
        try:
            path = self._inside_project(relative_path)
            if not path.is_file():
                return {"ok": False, "error": "File no longer exists. Use New File to create it."}
            path.write_text(content, encoding="utf-8", newline="")
            self.active_file = self._relative(path, self.root)
            return {"ok": True, "path": self.active_file}
        except (OSError, ValueError) as exc:
            return {"ok": False, "error": str(exc)}

    def create_file(self, relative_path: str):
        try:
            raw = Path(relative_path.strip())
            if not relative_path.strip() or raw.is_absolute():
                return {"ok": False, "error": "Enter a path relative to the current project."}
            path = self._inside_project(raw)
            if path.exists():
                return {"ok": False, "error": "A file or folder with that name already exists."}
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("", encoding="utf-8")
            self.active_file = self._relative(path, self.root)
            return {"ok": True, "path": self.active_file, "content": "", "extension": path.suffix.lower()}
        except (OSError, ValueError) as exc:
            return {"ok": False, "error": str(exc)}

    def choose_project(self):
        try:
            selected = self.window.create_file_dialog(webview.FileDialog.FOLDER, directory=str(self.root))
            if not selected:
                return {"ok": False, "cancelled": True}
            root = Path(selected[0]).resolve()
            if not root.is_dir():
                return {"ok": False, "error": "Choose an existing folder."}
            self.root = root
            self.active_file = None
            return {"ok": True, **self.list_files()}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def open_file_dialog(self):
        try:
            selected = self.window.create_file_dialog(
                webview.FileDialog.OPEN,
                directory=str(self.root),
                allow_multiple=False,
                file_types=("Text and source files (*.py;*.js;*.ts;*.html;*.css;*.json;*.md;*.txt)", "All files (*.*)"),
            )
            if not selected:
                return {"ok": False, "cancelled": True}
            path = Path(selected[0]).resolve()
            path.relative_to(self.root)
            return self.get_file(self._relative(path, self.root))
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def rename_file(self, relative_path: str, new_name: str):
        try:
            old = self._inside_project(relative_path)
            name = Path(new_name.strip())
            if not new_name.strip() or name.name != new_name.strip() or new_name.strip() in {".", ".."}:
                return {"ok": False, "error": "Enter a file name without a folder path."}
            new = old.with_name(new_name.strip())
            if new.exists():
                return {"ok": False, "error": "That name is already in use."}
            old.rename(new)
            old_rel = self._relative(old, self.root)
            new_rel = self._relative(new, self.root)
            if self.active_file == old_rel:
                self.active_file = new_rel
            return {"ok": True, "old_path": old_rel, "path": new_rel, "name": new.name}
        except (OSError, ValueError) as exc:
            return {"ok": False, "error": str(exc)}

    def delete_file(self, relative_path: str):
        try:
            path = self._inside_project(relative_path)
            if path.is_dir():
                return {"ok": False, "error": "Folder deletion is disabled here."}
            path.unlink()
            if self.active_file == self._relative(path, self.root):
                self.active_file = None
            return {"ok": True, "path": relative_path}
        except (OSError, ValueError) as exc:
            return {"ok": False, "error": str(exc)}

    def search(self, query: str):
        query = query.strip()
        if not query:
            return []
        matches = []
        needle = query.casefold()
        for path in self._walk_files():
            if path.suffix.lower() not in TEXT_EXTENSIONS:
                continue
            try:
                if path.stat().st_size > MAX_OPEN_FILE_BYTES:
                    continue
                for line_no, line in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), 1):
                    if needle in line.casefold():
                        matches.append({
                            "path": self._relative(path, self.root),
                            "line": line_no,
                            "text": line.strip()[:220],
                        })
                        if len(matches) >= 150:
                            return matches
            except (OSError, UnicodeError):
                continue
        return matches

    def _project_context(self):
        chunks = []
        total = 0
        for path in self._walk_files():
            if path.suffix.lower() not in TEXT_EXTENSIONS:
                continue
            try:
                if path.stat().st_size > MAX_OPEN_FILE_BYTES:
                    continue
                content = path.read_text(encoding="utf-8-sig")[:2200]
            except (OSError, UnicodeError):
                continue
            rel = self._relative(path, self.root)
            chunk = f"\n--- FILE: {rel} ---\n{content}"
            if total + len(chunk) > MAX_CONTEXT_CHARS:
                break
            chunks.append(chunk)
            total += len(chunk)
        return "\n".join(chunks) if chunks else "(No readable project files.)"

    def ask_ai(self, prompt: str, mode: str = "Chat", include_context: bool = True, request_id: str = ""):
        prompt = str(prompt).strip()
        if not prompt:
            return {"ok": False, "error": "Enter a prompt first."}
        threading.Thread(
            target=self._ask_ai_worker,
            args=(prompt, mode, bool(include_context), str(request_id)),
            daemon=True,
        ).start()
        return {"ok": True}

    def _ask_ai_worker(self, prompt: str, mode: str, include_context: bool, request_id: str):
        try:
            if mode == "Agent":
                instruction = (
                    "You are CodeX, a careful coding agent. Return ONLY valid JSON with schema "
                    '{"message":"short explanation","actions":[{"type":"write_file","path":"relative/path",'
                    '"content":"complete file content"},{"type":"run_command","command":"command"}]}. '
                    "Only use write_file and run_command. Do not propose destructive commands. Paths stay inside project root."
                )
            else:
                instruction = "You are CodeX, a concise expert coding assistant. Explain clearly and give useful examples."
            context = self._project_context() if include_context else "(Project context disabled.)"
            full_prompt = (
                f"{instruction}\n\nPROJECT ROOT: {self.root}\n\nPROJECT CONTEXT:\n{context}"
                f"\n\nUSER REQUEST:\n{prompt[:12000]}"
            )
            response = requests.get(API_URL, params={"text": full_prompt}, timeout=120)
            response.raise_for_status()
            result = response.json().get("response")
            if not isinstance(result, str):
                raise ValueError("The AI service returned no text response.")
            payload = {"ok": True, "mode": mode, "text": result}
            if mode == "Agent":
                payload["agent"] = self._extract_json(result)
        except Exception as exc:
            payload = {"ok": False, "mode": mode, "text": f"AI request failed: {exc}"}
        payload["id"] = request_id
        self._send_js("window.codex.aiDone(" + json.dumps(payload) + ")")

    @staticmethod
    def _extract_json(text: str):
        cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.I)
        try:
            return json.loads(cleaned)
        except json.JSONDecodeError:
            start, end = cleaned.find("{"), cleaned.rfind("}")
            if start >= 0 and end > start:
                return json.loads(cleaned[start:end + 1])
            raise

    def apply_agent_files(self, files):
        if not isinstance(files, list):
            return {"ok": False, "error": "Invalid file change list."}
        written = []
        try:
            for item in files:
                if not isinstance(item, dict) or not isinstance(item.get("content"), str):
                    continue
                path = self._inside_project(str(item.get("path", "")))
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(item["content"], encoding="utf-8", newline="")
                written.append(self._relative(path, self.root))
            return {"ok": True, "written": written}
        except (OSError, ValueError) as exc:
            return {"ok": False, "error": str(exc), "written": written}

    def preview_file(self, relative_path: str):
        try:
            path = self._inside_project(relative_path)
            if not path.is_file() or path.suffix.lower() not in {".html", ".htm"}:
                return {"ok": False, "error": "Save and open an HTML file before previewing it."}
            self._start_preview_server()
            rel = quote(self._relative(path, self.root), safe="/")
            return {"ok": True, "url": f"http://127.0.0.1:{self.preview_port}/{rel}"}
        except (OSError, ValueError) as exc:
            return {"ok": False, "error": str(exc)}

    def _start_preview_server(self):
        if self.preview_server and self.preview_root == self.root:
            return
        self._stop_preview_server()
        handler = partial(PreviewRequestHandler, directory=str(self.root))
        self.preview_server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.preview_server.daemon_threads = True
        self.preview_port = self.preview_server.server_address[1]
        self.preview_root = self.root
        self.preview_thread = threading.Thread(target=self.preview_server.serve_forever, daemon=True)
        self.preview_thread.start()

    def _stop_preview_server(self):
        if self.preview_server:
            self.preview_server.shutdown()
            self.preview_server.server_close()
            self.preview_server = None
            self.preview_thread = None

    def open_in_browser(self, url: str):
        if not re.fullmatch(r"http://127\.0\.0\.1:\d+/[^\s]*", str(url)):
            return {"ok": False, "error": "Only this project's localhost preview can be opened."}
        webbrowser.open(url)
        return {"ok": True}

    def execute_command(self, command: str):
        command = str(command).strip()
        if not command or len(command) > 2000:
            return {"ok": False, "error": "Enter a command under 2,000 characters."}
        try:
            creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            process = subprocess.Popen(
                ["powershell.exe", "-NoLogo", "-NoProfile", "-Command", command],
                cwd=str(self.root),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                text=True,
                encoding="utf-8",
                errors="replace",
                creationflags=creationflags,
            )
            with self._terminal_lock:
                self._terminal_processes.add(process)
            threading.Thread(target=self._read_command, args=(process, command), daemon=True).start()
            return {"ok": True}
        except OSError as exc:
            return {"ok": False, "error": str(exc)}

    def _read_command(self, process, command):
        try:
            if process.stdout:
                for line in process.stdout:
                    self._send_js("window.codex.terminalOutput(" + json.dumps(line) + ")")
            code = process.wait()
            self._send_js("window.codex.terminalDone(" + json.dumps({"command": command, "code": code}) + ")")
        except Exception as exc:
            self._send_js("window.codex.terminalOutput(" + json.dumps(f"Terminal error: {exc}\n") + ")")
        finally:
            with self._terminal_lock:
                self._terminal_processes.discard(process)

    def run_current_python(self, relative_path: str, content: str):
        saved = self.save_file(relative_path, content)
        if not saved.get("ok"):
            return saved
        path = self._inside_project(relative_path)
        if path.suffix.lower() != ".py":
            return {"ok": False, "error": "Open a Python file to run it."}
        quoted_path = str(path).replace("'", "''")
        return self.execute_command(f"python '{quoted_path}'")

    def _send_js(self, script: str):
        try:
            if self.window:
                self.window.evaluate_js(script)
        except Exception:
            pass

    def shutdown(self, *_args):
        self._stop_preview_server()
        with self._terminal_lock:
            processes = list(self._terminal_processes)
            self._terminal_processes.clear()
        for process in processes:
            try:
                process.terminate()
            except OSError:
                pass


def main():
    if not UI_FILE.is_file():
        raise FileNotFoundError(f"CodeX frontend is missing: {UI_FILE}")
    bridge = CodeXBridge()
    window = webview.create_window(
        APP_NAME,
        url=str(UI_FILE),
        js_api=bridge,
        x=40,
        y=30,
        width=1280,
        height=720,
        min_size=(980, 640),
        background_color="#212121",
        text_select=True,
    )
    bridge.window = window
    window.events.closed += bridge.shutdown
    webview.start(gui="qt", icon=str(APP_ICON) if APP_ICON.is_file() else None)


if __name__ == "__main__":
    main()
