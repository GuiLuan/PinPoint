from __future__ import annotations

import html
import re
from html.parser import HTMLParser
from typing import Any

MIN_CARD_WIDTH = 250
DEFAULT_CARD_WIDTH = 310
DEFAULT_CARD_HEIGHT = 140
GRID_SIZE = 24
MIN_ZOOM = 0.35
MAX_ZOOM = 2.5
MAX_HISTORY_STACK = 60

DEFAULT_COLOR_NEUTRAL = "#98989d"
DEFAULT_PALETTE = ["#30d158", "#0a84ff", "#bf5af2", "#ffd60a", "#ff9f0a"]
PRESET_POOL = [
    "#30d158", "#0a84ff", "#bf5af2", "#ffd60a", "#ff9f0a",
    "#ff453a", "#64d2ff", "#ac8e68", "#ff375f", "#5e5ce6",
]
VALID_MINIMAP_POSITIONS = {"top-left", "top-right", "bottom-left", "bottom-right"}
VALID_ALIGN_TYPES = {
    "left", "center-h", "right",
    "top", "center-v", "bottom",
    "distribute-h", "distribute-v",
}

CAPSULE_CLASS_COLOR_MAP = {
    "capsule-blue": "#0a84ff",
    "capsule-green": "#30d158",
    "capsule-purple": "#bf5af2",
    "capsule-yellow": "#ffd60a",
    "capsule-orange": "#ff9f0a",
    "capsule-red": "#ff453a",
}

DEFAULT_STATE: dict[str, Any] = {
    "viewport": {"x": 0, "y": 0, "zoom": 1.0},
    "settings": {
        "alignMode": False,
        "gridSnapMode": False,
        "palette": list(DEFAULT_PALETTE),
        "minimap": {
            "enabled": True,
            "position": "bottom-right",
            "size": 220,
        },
    },
    "cards": [
        {
            "id": "card-1",
            "title": "灵感源头",
            "x": 140,
            "y": 200,
            "width": 340,
            "contentHtml": (
                '记录最初的想法。你可以划选任意'
                '<span class="text-capsule" data-pin-id="pin-1"><i class="capsule-pin"></i>核心词汇</span>'
                '，直接连线到其他节点。'
            ),
        },
        {
            "id": "card-2",
            "title": "衍生延展",
            "x": 640,
            "y": 190,
            "width": 320,
            "contentHtml": (
                '节点完全纯粹，只有'
                '<span class="text-capsule capsule-blue" data-pin-id="pin-2"><i class="capsule-pin"></i>标题与内容</span>'
                '。点击头部或胶囊圆孔即可跨卡片连接。'
            ),
        },
    ],
    "connections": [
        {"id": "conn-1", "fromPinId": "pin-1", "toPinId": "pin-2", "color": "#30d158"}
    ],
    "groups": [],
}


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, details: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details


def hex_to_rgba(hex_color: str | None, alpha: float = 1.0) -> str:
    if not hex_color:
        return f"rgba(48, 209, 88, {alpha})"
    c = hex_color.lstrip("#")
    if len(c) == 3:
        c = "".join(ch * 2 for ch in c)
    if len(c) != 6:
        return hex_color
    try:
        r = int(c[0:2], 16)
        g = int(c[2:4], 16)
        b = int(c[4:6], 16)
        return f"rgba({r}, {g}, {b}, {alpha})"
    except ValueError:
        return hex_color


def build_capsule_html(pin_id: str, text: str, color: str | None = "#30d158") -> str:
    safe_pin = html.escape(pin_id, quote=True)
    safe_text = html.escape(text)
    if color:
        safe_color = html.escape(color, quote=True)
        bg = hex_to_rgba(color, 0.14)
        border = hex_to_rgba(color, 0.38)
        style = (
            f"--capsule-pin: {safe_color}; "
            f"background-color: {bg}; "
            f"border-color: {border};"
        )
    else:
        style = (
            f"--capsule-pin: {DEFAULT_COLOR_NEUTRAL}; "
            "background-color: rgba(255, 255, 255, 0.08); "
            "border-color: rgba(255, 255, 255, 0.2);"
        )
    return (
        f'<span class="text-capsule" data-pin-id="{safe_pin}" '
        f'contenteditable="false" style="{style}">'
        f'<i class="capsule-pin"></i>{safe_text}</span>'
    )


class _ContentSegmentParser(HTMLParser):
    """Tokenize card contentHtml into structured segments (capsules vs HTML/text)."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self.segments: list[dict[str, Any]] = []
        self._in_capsule = False
        self._capsule_depth = 0
        self._capsule_pin_id: str | None = None
        self._capsule_color: str | None = None
        self._capsule_text_parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr_map = dict(attrs)
        classes = (attr_map.get("class") or "").split()
        if not self._in_capsule and tag.lower() == "span" and "text-capsule" in classes:
            self._in_capsule = True
            self._capsule_depth = 1
            self._capsule_pin_id = attr_map.get("data-pin-id")
            self._capsule_color = self._extract_color(attr_map, classes)
            self._capsule_text_parts = []
            return

        if self._in_capsule:
            if tag.lower() == "span":
                self._capsule_depth += 1
            return

        if tag.lower() == "br":
            self.segments.append({"type": "text", "text": "\n"})
            return

        raw = self.get_starttag_text() or f"<{tag}>"
        self.segments.append({"type": "tag", "raw": raw})

    def handle_endtag(self, tag: str) -> None:
        if self._in_capsule:
            if tag.lower() == "span":
                self._capsule_depth -= 1
                if self._capsule_depth <= 0:
                    text = html.unescape("".join(self._capsule_text_parts)).strip()
                    self.segments.append({
                        "type": "capsule",
                        "pinId": self._capsule_pin_id or "",
                        "text": text,
                        "color": self._capsule_color,
                    })
                    self._in_capsule = False
                    self._capsule_pin_id = None
                    self._capsule_color = None
                    self._capsule_text_parts = []
            return
        self.segments.append({"type": "tag", "raw": f"</{tag}>"})

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if self._in_capsule:
            return
        if tag.lower() == "br":
            self.segments.append({"type": "text", "text": "\n"})
            return
        raw = self.get_starttag_text() or f"<{tag}/>"
        self.segments.append({"type": "tag", "raw": raw})

    def handle_data(self, data: str) -> None:
        if self._in_capsule:
            self._capsule_text_parts.append(data)
        else:
            self.segments.append({"type": "text", "text": html.unescape(data)})

    def handle_entityref(self, name: str) -> None:
        ch = html.unescape(f"&{name};")
        if self._in_capsule:
            self._capsule_text_parts.append(ch)
        else:
            self.segments.append({"type": "text", "text": ch})

    def handle_charref(self, name: str) -> None:
        ch = html.unescape(f"&#{name};")
        if self._in_capsule:
            self._capsule_text_parts.append(ch)
        else:
            self.segments.append({"type": "text", "text": ch})

    @staticmethod
    def _extract_color(attr_map: dict[str, str | None], classes: list[str]) -> str | None:
        style = attr_map.get("style") or ""
        m = re.search(r"--capsule-pin:\s*([^;]+)", style)
        if m:
            col = m.group(1).strip()
            if col and col.lower() != DEFAULT_COLOR_NEUTRAL:
                return col
            return None
        for cls in classes:
            if cls in CAPSULE_CLASS_COLOR_MAP:
                return CAPSULE_CLASS_COLOR_MAP[cls]
        return "#30d158"


def parse_content(content_html: str) -> tuple[str, list[dict[str, Any]], list[dict[str, Any]]]:
    """Return (plain_text, capsules_list, segments) from card contentHtml."""
    if not content_html:
        return "", [], []
    parser = _ContentSegmentParser()
    parser.feed(content_html)
    parser.close()

    plain_parts: list[str] = []
    capsules: list[dict[str, Any]] = []
    for seg in parser.segments:
        if seg["type"] == "text":
            plain_parts.append(seg["text"])
        elif seg["type"] == "capsule":
            plain_parts.append(seg["text"])
            capsules.append({
                "pinId": seg["pinId"],
                "text": seg["text"],
                "color": seg["color"],
            })
    return "".join(plain_parts), capsules, parser.segments


def render_segments_to_html(segments: list[dict[str, Any]]) -> str:
    out: list[str] = []
    for seg in segments:
        kind = seg["type"]
        if kind == "text":
            out.append(html.escape(seg["text"]).replace("\n", "<br>"))
        elif kind == "tag":
            out.append(seg["raw"])
        elif kind == "capsule":
            out.append(build_capsule_html(seg["pinId"], seg["text"], seg.get("color")))
    return "".join(out)


def text_and_capsules_to_html(
    content_text: str,
    capsules: list[dict[str, Any]] | None = None,
    gen_pin_fn: Any = None,
) -> str:
    """Convert plain text + optional inline capsule specs into contentHtml."""
    if not capsules:
        return html.escape(content_text).replace("\n", "<br>")

    remaining = content_text
    segments: list[dict[str, Any]] = []
    for cap in capsules:
        cap_text = (cap.get("text") or "").strip()
        if not cap_text:
            continue
        pin_id = cap.get("pinId") or (gen_pin_fn() if gen_pin_fn else "pin-auto")
        color = cap.get("color", "#30d158")
        idx = remaining.find(cap_text)
        if idx >= 0:
            if idx > 0:
                segments.append({"type": "text", "text": remaining[:idx]})
            segments.append({
                "type": "capsule",
                "pinId": pin_id,
                "text": cap_text,
                "color": color,
            })
            remaining = remaining[idx + len(cap_text):]
        else:
            if segments or remaining:
                if remaining:
                    segments.append({"type": "text", "text": remaining})
                    remaining = ""
                segments.append({"type": "text", "text": " "})
            segments.append({
                "type": "capsule",
                "pinId": pin_id,
                "text": cap_text,
                "color": color,
            })

    if remaining:
        segments.append({"type": "text", "text": remaining})

    return render_segments_to_html(segments)
