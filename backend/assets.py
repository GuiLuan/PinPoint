from __future__ import annotations

import base64
import html as html_lib
import io
import json
import mimetypes
import os
import re
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, BinaryIO

MAX_ASSET_BYTES = 500 * 1024 * 1024  # 500 MB
INLINE_EXPORT_LIMIT_BYTES = 50 * 1024 * 1024  # 50 MB
PROBE_MAX_BYTES = 256 * 1024
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

IMAGE_EXTS = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico", ".avif",
}
VIDEO_EXTS = {
    ".mp4", ".webm", ".mov", ".m4v", ".ogv", ".ogg", ".mkv", ".avi",
}
HTML_EXTS = {".html", ".htm"}

EXTRA_MIME_TYPES = {
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".ogv": "video/ogg",
    ".mkv": "video/x-matroska",
    ".mjs": "application/javascript",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".wasm": "application/wasm",
}

ASSET_URL_RE = re.compile(r"/api/v1/assets/(asset-[a-zA-Z0-9_-]+)")


def guess_mime_type(filename: str, fallback: str = "application/octet-stream") -> str:
    ext = Path(filename).suffix.lower()
    if ext in EXTRA_MIME_TYPES:
        return EXTRA_MIME_TYPES[ext]
    guessed, _ = mimetypes.guess_type(filename)
    return guessed or fallback


def classify_filename_or_mime(filename: str, mime_type: str = "") -> str | None:
    ext = Path(filename).suffix.lower()
    mime = (mime_type or "").split(";")[0].strip().lower()
    if ext in IMAGE_EXTS or mime.startswith("image/"):
        return "image"
    if ext in VIDEO_EXTS or mime.startswith("video/"):
        return "video"
    if ext in HTML_EXTS or mime in ("text/html", "application/xhtml+xml"):
        return "html"
    return None


def safe_filename(name: str, default: str = "file") -> str:
    base = Path(str(name or "")).name.strip()
    cleaned = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", base)
    return cleaned or default


def sanitize_rel_path(rel: str) -> Path | None:
    raw = str(rel or "").replace("\\", "/").lstrip("/")
    if not raw:
        return None
    parts = [p for p in raw.split("/") if p not in ("", ".")]
    if not parts or any(p == ".." for p in parts):
        return None
    clean_parts = [re.sub(r'[:*?"<>|\x00-\x1f]', "_", p) for p in parts]
    if any(not p for p in clean_parts):
        return None
    return Path(*clean_parts)


class _MetaHTMLParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.in_title = False
        self.title_parts: list[str] = []
        self.og_title: str = ""
        self.description: str = ""
        self.favicon: str = ""

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        t = tag.lower()
        amap = {k.lower(): (v or "") for k, v in attrs}
        if t == "title":
            self.in_title = True
        elif t == "meta":
            name = amap.get("name", "").lower()
            prop = amap.get("property", "").lower()
            content = amap.get("content", "").strip()
            if prop == "og:title" and content and not self.og_title:
                self.og_title = content
            elif (name == "description" or prop == "og:description") and content and not self.description:
                self.description = content
        elif t == "link":
            rel = amap.get("rel", "").lower().split()
            href = amap.get("href", "").strip()
            if href and ("icon" in rel or "shortcut" in rel) and not self.favicon:
                self.favicon = href

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "title":
            self.in_title = False

    def handle_data(self, data: str) -> None:
        if self.in_title:
            self.title_parts.append(data)


def _check_frame_embeddable(headers: dict[str, str]) -> tuple[bool, str | None]:
    lower_headers = {k.lower(): v for k, v in headers.items()}
    xfo = lower_headers.get("x-frame-options", "").strip()
    if xfo:
        upper = xfo.upper()
        if "DENY" in upper or "SAMEORIGIN" in upper or "ALLOW-FROM" in upper:
            return False, f"X-Frame-Options: {xfo}"

    csp = lower_headers.get("content-security-policy", "")
    if csp:
        for directive in csp.split(";"):
            d = directive.strip()
            if d.lower().startswith("frame-ancestors"):
                tokens = d.split()[1:]
                # If '*' is allowed and not just 'none'/'self', it can be embedded; otherwise blocked for localhost
                if not tokens or "'none'" in tokens:
                    return False, f"CSP: {d}"
                allows_any = any(t == "*" for t in tokens)
                if not allows_any:
                    return False, f"CSP: {d}"
    return True, None


def probe_url(raw_url: str, timeout: float = 6.0) -> dict[str, Any]:
    url = str(raw_url or "").strip()
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("Only valid http:// or https:// URLs are supported.")

    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": DEFAULT_USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,image/*,video/*,*/*;q=0.8",
        },
        method="GET",
    )

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            final_url = resp.geturl() or url
            hdrs = dict(resp.headers.items())
            ctype = (resp.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            embeddable, block_reason = _check_frame_embeddable(hdrs)

            if ctype.startswith("image/"):
                return {
                    "url": final_url,
                    "mediaKind": "image",
                    "contentType": ctype,
                    "embeddable": True,
                    "blockReason": None,
                    "title": Path(urllib.parse.urlparse(final_url).path).name or final_url,
                    "favicon": None,
                    "description": "",
                }
            if ctype.startswith("video/"):
                return {
                    "url": final_url,
                    "mediaKind": "video",
                    "contentType": ctype,
                    "embeddable": True,
                    "blockReason": None,
                    "title": Path(urllib.parse.urlparse(final_url).path).name or final_url,
                    "favicon": None,
                    "description": "",
                }

            raw_chunk = resp.read(PROBE_MAX_BYTES)
            charset = resp.headers.get_content_charset() or "utf-8"
            try:
                text = raw_chunk.decode(charset, errors="replace")
            except Exception:
                text = raw_chunk.decode("utf-8", errors="replace")

            parser = _MetaHTMLParser()
            try:
                parser.feed(text)
                parser.close()
            except Exception:
                pass

            title = ("".join(parser.title_parts).strip() or parser.og_title or urllib.parse.urlparse(final_url).netloc)
            favicon_url = None
            if parser.favicon:
                favicon_url = urllib.parse.urljoin(final_url, parser.favicon)
            else:
                fp = urllib.parse.urlparse(final_url)
                favicon_url = f"{fp.scheme}://{fp.netloc}/favicon.ico"

            return {
                "url": final_url,
                "mediaKind": "webpage",
                "contentType": ctype or "text/html",
                "embeddable": embeddable,
                "blockReason": block_reason,
                "title": html_lib.unescape(title)[:180],
                "favicon": favicon_url,
                "description": html_lib.unescape(parser.description)[:300],
            }
    except urllib.error.HTTPError as err:
        hdrs = dict(err.headers.items()) if err.headers else {}
        embeddable, block_reason = _check_frame_embeddable(hdrs)
        fp = urllib.parse.urlparse(url)
        return {
            "url": url,
            "mediaKind": "webpage",
            "contentType": "text/html",
            "embeddable": False if err.code in (401, 403) else embeddable,
            "blockReason": block_reason or f"HTTP {err.code}",
            "title": fp.netloc or url,
            "favicon": f"{fp.scheme}://{fp.netloc}/favicon.ico" if fp.netloc else None,
            "description": "",
            "probeWarning": f"HTTP {err.code}",
        }
    except Exception as exc:
        fp = urllib.parse.urlparse(url)
        return {
            "url": url,
            "mediaKind": "webpage",
            "contentType": "text/html",
            "embeddable": False,
            "blockReason": str(exc),
            "title": fp.netloc or url,
            "favicon": f"{fp.scheme}://{fp.netloc}/favicon.ico" if fp.netloc else None,
            "description": "",
            "probeWarning": str(exc),
        }


class AssetManager:
    """Manages local media/HTML files & folder bundles under data/assets/."""

    def __init__(self, assets_dir: str | Path, db: Any) -> None:
        self.assets_dir = Path(assets_dir).resolve()
        self.assets_dir.mkdir(parents=True, exist_ok=True)
        self.db = db
        self._id_seq = 0

    def _next_asset_id(self) -> str:
        self._id_seq += 1
        return f"asset-{int(time.time() * 1000)}-{self._id_seq}"

    def _save_stream_to_path(self, stream: BinaryIO, content_length: int, target_path: Path) -> int:
        if content_length > MAX_ASSET_BYTES:
            raise ValueError(f"File exceeds maximum limit of {MAX_ASSET_BYTES // (1024 * 1024)}MB.")
        target_path.parent.mkdir(parents=True, exist_ok=True)
        written = 0
        remaining = content_length
        chunk_size = 64 * 1024
        with target_path.open("wb") as fp:
            while remaining > 0:
                to_read = min(chunk_size, remaining)
                chunk = stream.read(to_read)
                if not chunk:
                    break
                written += len(chunk)
                if written > MAX_ASSET_BYTES:
                    raise ValueError(f"File exceeds maximum limit of {MAX_ASSET_BYTES // (1024 * 1024)}MB.")
                fp.write(chunk)
                remaining -= len(chunk)
        return written

    def save_single_stream(
        self,
        stream: BinaryIO,
        content_length: int,
        filename: str,
        mime_type: str = "",
        kind: str | None = None,
        origin_url: str | None = None,
    ) -> dict[str, Any]:
        clean_name = safe_filename(filename, "media.bin")
        resolved_mime = (mime_type or "").split(";")[0].strip() or guess_mime_type(clean_name)
        resolved_kind = kind or classify_filename_or_mime(clean_name, resolved_mime)
        if resolved_kind not in ("image", "video", "html"):
            raise ValueError(f"Unsupported media file type: {clean_name}")

        asset_id = self._next_asset_id()
        asset_folder = self.assets_dir / asset_id
        asset_folder.mkdir(parents=True, exist_ok=True)
        target_path = asset_folder / clean_name
        try:
            size_bytes = self._save_stream_to_path(stream, content_length, target_path)
        except Exception:
            shutil.rmtree(asset_folder, ignore_errors=True)
            raise

        rel_path = f"{asset_id}/{clean_name}"
        meta = {
            "id": asset_id,
            "kind": resolved_kind,
            "storageType": "file",
            "relPath": rel_path,
            "entryPath": clean_name if resolved_kind == "html" else None,
            "fileName": clean_name,
            "mimeType": resolved_mime,
            "sizeBytes": size_bytes,
            "originUrl": origin_url,
            "url": f"/api/v1/assets/{asset_id}",
            "createdAt": int(time.time() * 1000),
        }
        self.db.insert_asset(meta)
        return meta

    def save_single_bytes(
        self,
        data: bytes,
        filename: str,
        mime_type: str = "",
        kind: str | None = None,
        origin_url: str | None = None,
        forced_asset_id: str | None = None,
    ) -> dict[str, Any]:
        if len(data) > MAX_ASSET_BYTES:
            raise ValueError(f"File exceeds maximum limit of {MAX_ASSET_BYTES // (1024 * 1024)}MB.")
        clean_name = safe_filename(filename, "media.bin")
        resolved_mime = (mime_type or "").split(";")[0].strip() or guess_mime_type(clean_name)
        resolved_kind = kind or classify_filename_or_mime(clean_name, resolved_mime) or "image"
        asset_id = forced_asset_id or self._next_asset_id()
        asset_folder = self.assets_dir / asset_id
        asset_folder.mkdir(parents=True, exist_ok=True)
        target_path = asset_folder / clean_name
        target_path.write_bytes(data)

        rel_path = f"{asset_id}/{clean_name}"
        meta = {
            "id": asset_id,
            "kind": resolved_kind,
            "storageType": "file",
            "relPath": rel_path,
            "entryPath": clean_name if resolved_kind == "html" else None,
            "fileName": clean_name,
            "mimeType": resolved_mime,
            "sizeBytes": len(data),
            "originUrl": origin_url,
            "url": f"/api/v1/assets/{asset_id}",
            "createdAt": int(time.time() * 1000),
        }
        self.db.insert_asset(meta)
        return meta

    def save_bundle_files(
        self,
        files: list[tuple[str, bytes]],
        root_name: str = "site",
        entry_path: str | None = None,
        forced_asset_id: str | None = None,
    ) -> dict[str, Any]:
        if not files:
            raise ValueError("Folder bundle has no files.")

        total_size = sum(len(data) for _, data in files)
        if total_size > MAX_ASSET_BYTES:
            raise ValueError(f"Folder exceeds maximum limit of {MAX_ASSET_BYTES // (1024 * 1024)}MB.")

        asset_id = forced_asset_id or self._next_asset_id()
        bundle_dir = (self.assets_dir / asset_id).resolve()
        bundle_dir.mkdir(parents=True, exist_ok=True)

        written_paths: list[str] = []
        html_entries: list[str] = []
        try:
            for raw_rel, data in files:
                rel_p = sanitize_rel_path(raw_rel)
                if rel_p is None:
                    continue
                target = (bundle_dir / rel_p).resolve()
                if not target.is_relative_to(bundle_dir):
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
                posix_rel = rel_p.as_posix()
                written_paths.append(posix_rel)
                if rel_p.suffix.lower() in HTML_EXTS:
                    html_entries.append(posix_rel)
        except Exception:
            shutil.rmtree(bundle_dir, ignore_errors=True)
            raise

        if not written_paths:
            shutil.rmtree(bundle_dir, ignore_errors=True)
            raise ValueError("No valid files found in folder.")

        chosen_entry = entry_path if entry_path in written_paths else None
        if not chosen_entry:
            # Prefer root index.html, then any single top-level html, then shortest path html
            top_html = [p for p in html_entries if "/" not in p]
            if "index.html" in top_html:
                chosen_entry = "index.html"
            elif "index.htm" in top_html:
                chosen_entry = "index.htm"
            elif len(top_html) == 1:
                chosen_entry = top_html[0]
            elif html_entries:
                html_entries.sort(key=lambda p: (p.count("/"), p != "index.html", p))
                chosen_entry = html_entries[0]

        if not chosen_entry:
            shutil.rmtree(bundle_dir, ignore_errors=True)
            raise ValueError("No HTML entry file found in folder bundle.")

        meta = {
            "id": asset_id,
            "kind": "html-bundle",
            "storageType": "dir",
            "relPath": asset_id,
            "entryPath": chosen_entry,
            "htmlEntries": sorted(html_entries, key=lambda p: (p.count("/"), p)),
            "fileName": safe_filename(root_name, "site"),
            "mimeType": "text/html",
            "sizeBytes": total_size,
            "originUrl": None,
            "url": f"/api/v1/assets/{asset_id}/{chosen_entry}",
            "createdAt": int(time.time() * 1000),
        }
        self.db.insert_asset(meta)
        return meta

    def fetch_remote_media(self, raw_url: str, expected_kind: str | None = None, timeout: float = 12.0) -> dict[str, Any]:
        url = str(raw_url or "").strip()
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise ValueError("Invalid media URL.")

        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": DEFAULT_USER_AGENT,
                "Accept": "image/*,video/*,*/*;q=0.8",
            },
            method="GET",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                final_url = resp.geturl() or url
                ctype = (resp.headers.get("Content-Type") or "").split(";")[0].strip().lower()
                cl_raw = resp.headers.get("Content-Length")
                if cl_raw:
                    try:
                        if int(cl_raw) > MAX_ASSET_BYTES:
                            return {"fallbackExternal": True, "reason": "FILE_TOO_LARGE", "url": url}
                    except ValueError:
                        pass

                url_name = Path(urllib.parse.urlparse(final_url).path).name
                ext_from_mime = mimetypes.guess_extension(ctype) or ""
                if not url_name or "." not in url_name:
                    url_name = f"media{ext_from_mime or '.bin'}"
                clean_name = safe_filename(url_name, "media.bin")

                detected_kind = classify_filename_or_mime(clean_name, ctype)
                if detected_kind not in ("image", "video"):
                    if expected_kind in ("image", "video") and ctype in ("", "application/octet-stream", "binary/octet-stream"):
                        detected_kind = expected_kind
                        if not Path(clean_name).suffix:
                            clean_name += ".png" if expected_kind == "image" else ".mp4"
                    else:
                        return {"fallbackExternal": True, "reason": f"UNEXPECTED_CONTENT_TYPE:{ctype}", "url": url}

                buf = bytearray()
                while True:
                    chunk = resp.read(64 * 1024)
                    if not chunk:
                        break
                    buf.extend(chunk)
                    if len(buf) > MAX_ASSET_BYTES:
                        return {"fallbackExternal": True, "reason": "FILE_TOO_LARGE", "url": url}

                meta = self.save_single_bytes(
                    bytes(buf),
                    filename=clean_name,
                    mime_type=ctype or guess_mime_type(clean_name),
                    kind=detected_kind,
                    origin_url=url,
                )
                return {"fallbackExternal": False, "asset": meta}
        except Exception as exc:
            return {"fallbackExternal": True, "reason": str(exc), "url": url}

    def resolve_asset_file(self, asset_id: str, sub_path: str | None = None) -> tuple[Path, str, dict[str, Any]] | None:
        meta = self.db.get_asset(asset_id)
        if not meta:
            return None

        if meta["storageType"] == "dir":
            base_dir = (self.assets_dir / meta["relPath"]).resolve()
            if not base_dir.is_dir():
                return None
            rel_target = sub_path or meta.get("entryPath") or "index.html"
            clean_rel = sanitize_rel_path(rel_target)
            if clean_rel is None:
                return None
            target = (base_dir / clean_rel).resolve()
            if not target.is_relative_to(base_dir) or not target.is_file():
                return None
            mime = guess_mime_type(target.name)
            return target, mime, meta

        # Single file
        target = (self.assets_dir / meta["relPath"]).resolve()
        if not target.is_relative_to(self.assets_dir) or not target.is_file():
            return None
        mime = meta.get("mimeType") or guess_mime_type(target.name)
        return target, mime, meta

    def export_assets_inline(self, asset_ids: set[str]) -> tuple[dict[str, Any], int]:
        out: dict[str, Any] = {}
        total_bytes = 0
        for aid in sorted(asset_ids):
            meta = self.db.get_asset(aid)
            if not meta:
                continue
            if meta["storageType"] == "dir":
                bundle_dir = (self.assets_dir / meta["relPath"]).resolve()
                if not bundle_dir.is_dir():
                    continue
                files_b64: dict[str, str] = {}
                for fp in bundle_dir.rglob("*"):
                    if fp.is_file():
                        data = fp.read_bytes()
                        total_bytes += len(data)
                        rel = fp.relative_to(bundle_dir).as_posix()
                        files_b64[rel] = base64.b64encode(data).decode("ascii")
                out[aid] = {
                    "id": aid,
                    "kind": meta["kind"],
                    "storageType": "dir",
                    "entryPath": meta.get("entryPath"),
                    "fileName": meta.get("fileName"),
                    "mimeType": meta.get("mimeType"),
                    "originUrl": meta.get("originUrl"),
                    "files": files_b64,
                }
            else:
                fp = (self.assets_dir / meta["relPath"]).resolve()
                if not fp.is_file():
                    continue
                data = fp.read_bytes()
                total_bytes += len(data)
                out[aid] = {
                    "id": aid,
                    "kind": meta["kind"],
                    "storageType": "file",
                    "fileName": meta.get("fileName"),
                    "mimeType": meta.get("mimeType"),
                    "originUrl": meta.get("originUrl"),
                    "dataBase64": base64.b64encode(data).decode("ascii"),
                }
        return out, total_bytes

    def import_assets_inline(self, assets_map: dict[str, Any]) -> dict[str, str]:
        """Restore inline exported assets into local assets_dir; return old_id -> asset_id mapping."""
        id_map: dict[str, str] = {}
        if not isinstance(assets_map, dict):
            return id_map
        for old_id, entry in assets_map.items():
            if not isinstance(entry, dict):
                continue
            existing = self.db.get_asset(old_id)
            if existing:
                id_map[old_id] = old_id
                continue
            storage_type = entry.get("storageType")
            if storage_type == "dir" and isinstance(entry.get("files"), dict):
                files_list: list[tuple[str, bytes]] = []
                for rel, b64 in entry["files"].items():
                    try:
                        files_list.append((rel, base64.b64decode(b64)))
                    except Exception:
                        continue
                if files_list:
                    meta = self.save_bundle_files(
                        files_list,
                        root_name=entry.get("fileName") or "site",
                        entry_path=entry.get("entryPath"),
                        forced_asset_id=old_id if old_id.startswith("asset-") else None,
                    )
                    id_map[old_id] = meta["id"]
            elif isinstance(entry.get("dataBase64"), str):
                try:
                    raw = base64.b64decode(entry["dataBase64"])
                except Exception:
                    continue
                meta = self.save_single_bytes(
                    raw,
                    filename=entry.get("fileName") or "media.bin",
                    mime_type=entry.get("mimeType") or "",
                    kind=entry.get("kind"),
                    origin_url=entry.get("originUrl"),
                    forced_asset_id=old_id if old_id.startswith("asset-") else None,
                )
                id_map[old_id] = meta["id"]
        return id_map

    def write_zip_bundle(self, export_data: dict[str, Any], asset_ids: set[str]) -> bytes:
        buf = io.BytesIO()
        assets_manifest: dict[str, Any] = {}
        with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for aid in sorted(asset_ids):
                meta = self.db.get_asset(aid)
                if not meta:
                    continue
                assets_manifest[aid] = {
                    "id": aid,
                    "kind": meta["kind"],
                    "storageType": meta["storageType"],
                    "entryPath": meta.get("entryPath"),
                    "fileName": meta.get("fileName"),
                    "mimeType": meta.get("mimeType"),
                    "originUrl": meta.get("originUrl"),
                }
                if meta["storageType"] == "dir":
                    bundle_dir = (self.assets_dir / meta["relPath"]).resolve()
                    if bundle_dir.is_dir():
                        for fp in bundle_dir.rglob("*"):
                            if fp.is_file():
                                rel = fp.relative_to(bundle_dir).as_posix()
                                zf.write(fp, arcname=f"assets/{aid}/{rel}")
                else:
                    fp = (self.assets_dir / meta["relPath"]).resolve()
                    if fp.is_file():
                        zf.write(fp, arcname=f"assets/{aid}/{meta['fileName']}")

            bundle_graph = dict(export_data)
            if assets_manifest:
                bundle_graph["assetsManifest"] = assets_manifest
            zf.writestr("graph.json", json.dumps(bundle_graph, ensure_ascii=False, indent=2))
        return buf.getvalue()

    def import_zip_bundle(self, zip_bytes: bytes) -> dict[str, Any]:
        with zipfile.ZipFile(io.BytesIO(zip_bytes), "r") as zf:
            if "graph.json" not in zf.namelist():
                raise ValueError("Invalid .pinpoint.zip archive: missing graph.json.")
            graph_data = json.loads(zf.read("graph.json").decode("utf-8"))
            manifest = graph_data.pop("assetsManifest", None) or {}

            files_by_asset: dict[str, list[tuple[str, bytes]]] = {}
            for name in zf.namelist():
                if not name.startswith("assets/") or name.endswith("/"):
                    continue
                parts = name.split("/", 2)
                if len(parts) < 3:
                    continue
                _, aid, rel = parts
                files_by_asset.setdefault(aid, []).append((rel, zf.read(name)))

            for aid, file_list in files_by_asset.items():
                if self.db.get_asset(aid):
                    continue
                info = manifest.get(aid) if isinstance(manifest, dict) else {}
                info = info if isinstance(info, dict) else {}
                storage_type = info.get("storageType")
                if storage_type == "dir" or len(file_list) > 1 or (file_list and "/" in file_list[0][0]):
                    self.save_bundle_files(
                        file_list,
                        root_name=info.get("fileName") or "site",
                        entry_path=info.get("entryPath"),
                        forced_asset_id=aid if aid.startswith("asset-") else None,
                    )
                elif file_list:
                    fname, raw = file_list[0]
                    self.save_single_bytes(
                        raw,
                        filename=info.get("fileName") or fname,
                        mime_type=info.get("mimeType") or "",
                        kind=info.get("kind"),
                        origin_url=info.get("originUrl"),
                        forced_asset_id=aid if aid.startswith("asset-") else None,
                    )
            return graph_data

    def get_stats(self, referenced_ids: set[str]) -> dict[str, Any]:
        all_rows = self.db.list_assets()
        total_bytes = 0
        unreferenced_count = 0
        unreferenced_bytes = 0
        referenced_count = 0
        for row in all_rows:
            sz = int(row.get("sizeBytes") or 0)
            total_bytes += sz
            if row["id"] in referenced_ids:
                referenced_count += 1
            else:
                unreferenced_count += 1
                unreferenced_bytes += sz
        return {
            "totalCount": len(all_rows),
            "totalBytes": total_bytes,
            "referencedCount": referenced_count,
            "unreferencedCount": unreferenced_count,
            "unreferencedBytes": unreferenced_bytes,
        }

    def gc_unreferenced(self, referenced_ids: set[str], grace_ms: int = 5000) -> dict[str, Any]:
        all_rows = self.db.list_assets()
        now_ms = int(time.time() * 1000)
        deleted_ids: list[str] = []
        freed_bytes = 0
        for row in all_rows:
            aid = row["id"]
            if aid in referenced_ids:
                continue
            if now_ms - int(row.get("createdAt") or 0) < grace_ms:
                continue
            asset_folder = (self.assets_dir / aid).resolve()
            if asset_folder.is_relative_to(self.assets_dir) and asset_folder.exists():
                shutil.rmtree(asset_folder, ignore_errors=True)
            self.db.delete_asset(aid)
            deleted_ids.append(aid)
            freed_bytes += int(row.get("sizeBytes") or 0)
        stats = self.get_stats(referenced_ids)
        return {
            "deletedCount": len(deleted_ids),
            "deletedIds": deleted_ids,
            "freedBytes": freed_bytes,
            "stats": stats,
        }
