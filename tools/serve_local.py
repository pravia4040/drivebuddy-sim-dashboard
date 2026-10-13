"""Local dev server for the SIM dashboard — nothing here is deployed or needed in production.

  python tools/serve_local.py                  real Supabase: log in with your normal account
  python tools/serve_local.py --mock           mock database, auto-signed-in Admin, no network
  python tools/serve_local.py --mock --fixtures "C:/path/to/files"
                                               also serves those files under /__fixtures/ (test uploads)

VI test page (mock only):  http://127.0.0.1:8790/vi-test.html
  The dashboard with tools/vi-test-loader.js added: it uploads the VI files from the test-data folder
  (--fixtures, default ../vi-test-data next to the repo — keep real data OUT of the repo) through the
  normal upload dialog into the mock database, and shows a small checklist panel.

Why a server and not file://
  * js/supabase.js holds __SB_URL__ / __SB_ANON_KEY__ placeholders that GitHub Actions fills in at
    deploy time. This server fills them the same way (from the public values in index.html), so the
    login page works locally.
  * /vi-scale.html?mockMem=1&n=5000 (mock only): scale rehearsal — a synthetic VI fleet of n SIMs through the
    normal upload, save and load paths, with timings, database calls and MB sent (tools/vi-scale-bench.js).
  * /baseline.html serves index.html from the `main` branch (git show main:index.html) so the
    current live version and the local one can be compared side by side on the same data.
Binds to 127.0.0.1 only.
"""
import argparse, http.server, json, pathlib, re, subprocess, sys, urllib.parse

ROOT = pathlib.Path(__file__).resolve().parent.parent


def public_supabase_config():
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    url = re.search(r"const SB_URL='([^']+)'", html)
    key = re.search(r"const SB_KEY='([^']+)'", html)
    if not (url and key):
        sys.exit("Could not find SB_URL / SB_KEY in index.html")
    return url.group(1), key.group(1)


class Handler(http.server.SimpleHTTPRequestHandler):
    mock = False
    fixtures = None
    sb = None

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _send(self, body: bytes, ctype: str):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/js/supabase.js":
            if self.mock:
                return self._send((ROOT / "tools" / "mock-supabase.js").read_bytes(), "application/javascript; charset=utf-8")
            src = (ROOT / "js" / "supabase.js").read_text(encoding="utf-8")
            src = src.replace("__SB_URL__", self.sb[0]).replace("__SB_ANON_KEY__", self.sb[1])
            return self._send(src.encode("utf-8"), "application/javascript; charset=utf-8")
        if path == "/vi-test.html":
            # Only against the mock database: the loader uploads test files and must never reach real Supabase
            if not self.mock:
                return self.send_error(404, "The VI test page needs --mock")
            html = (ROOT / "index.html").read_text(encoding="utf-8")
            html = html.replace("</body>", '<script src="tools/vi-test-loader.js"></script>\n</body>', 1)
            return self._send(html.encode("utf-8"), "text/html; charset=utf-8")
        if path == "/vi-scale.html":
            # Scale rehearsal (mock only, in-memory): a synthetic fleet of any size through the real upload/save/load paths
            if not self.mock:
                return self.send_error(404, "The VI scale rehearsal needs --mock")
            html = (ROOT / "index.html").read_text(encoding="utf-8")
            html = html.replace("</body>", '<script src="tools/vi-scale-bench.js"></script>\n</body>', 1)
            return self._send(html.encode("utf-8"), "text/html; charset=utf-8")
        if path == "/baseline.html":
            try:
                html = subprocess.run(["git", "show", "main:index.html"], cwd=ROOT, capture_output=True, check=True).stdout
            except Exception as e:  # noqa: BLE001
                return self.send_error(500, f"git show main:index.html failed: {e}")
            return self._send(html, "text/html; charset=utf-8")
        if path.startswith("/__fixtures/"):
            if not self.fixtures:
                return self.send_error(404, "Start with --fixtures DIR to serve test files")
            if path == "/__fixtures/":
                # the list of test files: the VI test page finds VI's exports by type and date, not by full name
                names = sorted(p.name for p in self.fixtures.iterdir() if p.is_file() and p.suffix.lower() == ".csv")
                return self._send(json.dumps(names).encode("utf-8"), "application/json; charset=utf-8")
            name = urllib.parse.unquote(path[len("/__fixtures/"):])
            f = (self.fixtures / name).resolve()
            if self.fixtures not in f.parents or not f.is_file():
                return self.send_error(404)
            return self._send(f.read_bytes(), "text/csv; charset=utf-8")
        return super().do_GET()

    def log_message(self, fmt, *args):
        sys.stderr.write("[serve_local] " + (fmt % args) + "\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("port", nargs="?", type=int, default=8790)
    ap.add_argument("--mock", action="store_true", help="serve the mock Supabase client (no network, auto-login)")
    ap.add_argument("--fixtures", help="directory served under /__fixtures/ for upload tests (default: ../vi-test-data if it exists)")
    a = ap.parse_args()
    Handler.mock = a.mock
    default = ROOT.parent / "vi-test-data"
    Handler.fixtures = pathlib.Path(a.fixtures).resolve() if a.fixtures else (default.resolve() if a.mock and default.is_dir() else None)
    Handler.sb = public_supabase_config()
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    mode = "MOCK database (no network)" if a.mock else "REAL Supabase — log in with your account"
    print(f"SIM dashboard on http://127.0.0.1:{a.port}/  -  {mode}", flush=True)
    if a.mock:
        print(f"VI test page:     http://127.0.0.1:{a.port}/vi-test.html  -  test files: {Handler.fixtures or 'none (add --fixtures DIR)'}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
