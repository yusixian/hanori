// All built-in extractors use the same host-controlled network bridge. No shell or user flags.
export const UNIVERSAL_YTDLP_SCRIPT = String.raw`
import base64
import hashlib
import io
import json
import os
import re
import html
import sys
import urllib.request
import xml.etree.ElementTree as ET
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit

def emit(value):
    print(json.dumps(value, ensure_ascii=True, separators=(",", ":")), flush=True)

class Failure(Exception):
    pass

try:
    from yt_dlp import YoutubeDL
    from yt_dlp.networking import Request, Response
    from yt_dlp.networking.exceptions import HTTPError
    from yt_dlp.downloader import get_suitable_downloader
    from yt_dlp.utils import DownloadError
except ImportError:
    emit({"type": "error", "code": "unavailable"})
    sys.exit(1)

request = json.loads(sys.stdin.readline())

def audit(event, args):
    if event in ("socket.connect", "socket.bind"):
        raise Failure("unsupported_format")
    if event == "subprocess.Popen" and args[0] != request["nodePath"]:
        if args[1] not in (["ffmpeg", "-bsfs"], ["ffprobe", "-version"], ["ffmpeg", "-version"]):
            raise Failure("unsupported_format")

sys.addaudithook(audit)

class SilentLogger:
    def debug(self, message): pass
    def warning(self, message): pass
    def error(self, message): pass

class HostDownloader(YoutubeDL):
    def urlopen(self, req):
        if isinstance(req, str):
            req = Request(req)
        if isinstance(req, urllib.request.Request):
            req = Request(req.full_url, data=req.data, headers=dict(req.header_items()), method=req.get_method())
        headers = dict(self.params.get("http_headers", {}))
        headers.update(dict(req.headers))
        for attempt in range(6):
            headers = {k: v for k, v in headers.items() if k.lower() != "cookie"}
            cookie = self.cookiejar.get_cookie_header(req.url)
            if cookie:
                headers["Cookie"] = cookie
            emit({"type": "request", "url": req.url, "query": {
                "method": req.method, "headers": headers,
                "data": base64.b64encode(req.data).decode() if req.data is not None else None}})
            reply = json.loads(sys.stdin.readline())
            if not reply.get("ok"):
                raise Failure("extractor_failed")
            value = reply["value"]
            response = Response(io.BytesIO(base64.b64decode(value["data"])), value["url"], {}, status=value["status"])
            for key, items in value["headers"].items():
                for item in items if isinstance(items, list) else [items]:
                    response.headers.add_header(key, item)
            self.cookiejar.extract_cookies(response, urllib.request.Request(req.url))
            if response.status in (301, 302, 303, 307, 308) and response.headers.get("Location"):
                target = urljoin(req.url, response.headers["Location"])
                before, after = urlsplit(req.url), urlsplit(target)
                if (before.scheme, before.netloc) != (after.scheme, after.netloc):
                    # Extractor headers can include site-specific tokens, not only Authorization.
                    headers = {k: v for k, v in headers.items() if k.lower() in ("user-agent", "accept", "accept-language", "range")}
                if response.status == 303 or (response.status in (301, 302) and req.method == "POST"):
                    req = Request(target, method="GET")
                    headers = {k: v for k, v in headers.items() if k.lower() != "content-type"}
                else:
                    req = Request(target, data=req.data, method=req.method)
                continue
            if response.status >= 400:
                raise HTTPError(response)
            return response
        raise Failure("extractor_failed")

def clipped(value, size):
    return str(value or "")[:size]

def parse_subtitle(text, ext):
    if len(text) > 1000000:
        raise Failure("limit_exceeded")
    cues = []
    def add(start, end, value):
        value = value.strip()
        if not value:
            return
        start = round(float(start))
        end = round(float(end)) if end is not None else None
        if start < 0 or start > 86400000 or (end is not None and (end <= start or end > 86400000)) or len(value) > 16384:
            raise Failure("extractor_failed")
        if cues and cues[-1]["text"] == value and cues[-1]["endMs"] is not None and cues[-1]["endMs"] >= start:
            cues[-1]["endMs"] = max(cues[-1]["endMs"], end) if end is not None else None
        else:
            cues.append({"startMs": start, "endMs": end, "text": value})
    def clock(value):
        value = value.replace(",", ".")
        if value.endswith("ms"): return float(value[:-2])
        if value.endswith("s"): return float(value[:-1]) * 1000
        parts = value.split(":")
        return sum(float(v) * 60 ** i for i, v in enumerate(reversed(parts))) * 1000
    if ext == "json3":
        for event in json.loads(text).get("events", []):
            value = "".join(segment.get("utf8", "") for segment in event.get("segs", []))
            start = event.get("tStartMs", 0)
            duration = event.get("dDurationMs")
            add(start, start + duration if duration else None, value)
    elif ext == "json":
        for cue in json.loads(text)["body"]:
            add(cue["from"] * 1000, cue["to"] * 1000, cue["content"])
    elif ext in ("vtt", "srt"):
        for block in re.split(r"\n\s*\n", text.replace("\r", "").lstrip("\ufeff")):
            match = re.search(r"(?m)^((?:\d+:)?\d{2}:\d{2}[.,]\d{3})\s+-->\s+((?:\d+:)?\d{2}:\d{2}[.,]\d{3})[^\n]*\n([\s\S]*)", block)
            if match:
                add(clock(match[1]), clock(match[2]), html.unescape(re.sub(r"<[^>]+>", "", match[3])))
    elif ext in ("ttml", "srv3"):
        if "<!DOCTYPE" in text.upper() or "<!ENTITY" in text.upper():
            raise Failure("extractor_failed")
        root = ET.fromstring(text)
        for cue in root.iter():
            if cue.tag.split("}")[-1] not in ("p", "text"):
                continue
            if "t" in cue.attrib:
                start = float(cue.attrib["t"])
                end = start + float(cue.attrib["d"]) if "d" in cue.attrib else None
            elif "begin" in cue.attrib:
                start = clock(cue.attrib["begin"])
                end = clock(cue.attrib["end"]) if "end" in cue.attrib else start + clock(cue.attrib["dur"]) if "dur" in cue.attrib else None
            elif "start" in cue.attrib:
                start = float(cue.attrib["start"]) * 1000
                end = start + float(cue.attrib["dur"]) * 1000 if "dur" in cue.attrib else None
            else:
                continue
            add(start, end, "".join(cue.itertext()))
    else:
        raise Failure("unsupported_format")
    if len(cues) > 10000 or sum(len(c["text"]) for c in cues) > 500000:
        raise Failure("limit_exceeded")
    if not cues:
        raise Failure("extractor_failed")
    return sorted(cues, key=lambda c: c["startMs"])

def language_tag(value):
    return re.sub(r"[^a-zA-Z0-9-]", "-", str(value or ""))[:64].strip("-") or None

def track_list(info):
    tracks, seen = [], set()
    is_youtube = str(info.get("extractor_key") or info.get("extractor") or "").lower() == "youtube"
    for field, source in (("subtitles", "platform_cc"), ("automatic_captions", "platform_auto")):
        for language, formats in (info.get(field) or {}).items():
            if language == "live_chat":
                continue
            preferred = sorted(formats, key=lambda f: {"json3": 0, "vtt": 1, "srt": 2, "ttml": 3, "srv3": 4, "json": 5}.get(f.get("ext"), 99))
            chosen = next((f for f in preferred if f.get("ext") in ("json3", "vtt", "srt", "ttml", "srv3", "json") and (f.get("url") or f.get("data"))), None)
            if not chosen:
                continue
            tag = language_tag(language) or "und"
            translated, original, group = False, None, None
            if is_youtube and chosen.get("url"):
                parts = urlsplit(chosen["url"])
                pairs = parse_qsl(parts.query, keep_blank_values=True)
                query = dict(pairs)
                # YouTube uses tlang for translations and emits -orig/unsuffixed aliases.
                # Names and automatic_captions alone cannot establish translation provenance.
                translated = bool(query.get("tlang"))
                original = language_tag(query.get("lang"))
                tag = language_tag(query.get("tlang")) if translated else original or language_tag(tag.removesuffix("-orig"))
                tag = tag or "und"
                if original:
                    identity = urlunsplit((parts.scheme, parts.netloc, parts.path,
                        urlencode(sorted((k, v) for k, v in pairs if k not in ("tlang", "fmt", "xosf"))), ""))
                    group = hashlib.sha256(identity.encode()).hexdigest()
                    key = (group, tag.lower(), translated)
                    if key in seen:
                        continue
                    seen.add(key)
            tracks.append({"language": tag, "label": clipped(chosen.get("name") or language, 120),
                "source": source, "isTranslated": translated, "originalLanguage": original, "translationGroup": group,
                "ext": chosen["ext"], "url": chosen.get("url"), "data": chosen.get("data"),
                "headers": chosen.get("http_headers") or info.get("http_headers") or {}})
    return sorted(tracks, key=lambda t: t["isTranslated"])[:2000]

def original_language(info, tracks):
    if explicit := language_tag(info.get("language")):
        return explicit
    audio = [f for f in (info.get("formats") or []) if f.get("acodec") not in (None, "none") and f.get("language")]
    preferred = {language_tag(f["language"]) for f in audio if (f.get("language_preference") or 0) >= 10}
    originals = {t["originalLanguage"] for t in tracks if t["source"] == "platform_auto" and not t["isTranslated"] and t["originalLanguage"]}
    languages = {language_tag(f["language"]) for f in audio}
    for candidates in (preferred, originals, languages):
        candidates.discard(None)
        if len(candidates) == 1:
            return next(iter(candidates))
    return None

def summary(info):
    tracks = track_list(info)
    return {"id": clipped(info.get("id"), 300), "extractor": clipped(info.get("extractor_key") or info.get("extractor"), 100),
        "url": info.get("webpage_url") or info.get("original_url") or request["url"],
        "title": clipped(info.get("title"), 500), "description": clipped(info.get("description"), 4000),
        "author": clipped(info.get("uploader") or info.get("channel") or info.get("creator"), 200),
        "durationSeconds": info.get("duration"), "liveStatus": info.get("live_status"),
        "chapters": [{"title": clipped(c.get("title"), 200), "startSeconds": c.get("start_time"), "endSeconds": c.get("end_time")} for c in (info.get("chapters") or [])[:100]],
        "tracks": tracks, "originalLanguage": original_language(info, tracks),
        "formats": [{k: f.get(k) for k in ("format_id", "ext", "width", "height", "fps", "vcodec", "acodec", "filesize", "filesize_approx", "protocol")} for f in (info.get("formats") or [])[:200]]}

try:
    options = {"quiet": True, "no_warnings": True, "logger": SilentLogger(), "cachedir": False,
        "noplaylist": True, "playlistend": 1, "extract_flat": "in_playlist", "skip_download": True, "ignore_no_formats_error": True,
        "socket_timeout": 15, "retries": 0, "extractor_retries": 0, "fragment_retries": 0,
        "js_runtimes": {"node": {"path": request["nodePath"]}}, "remote_components": set(),
        "concurrent_fragment_downloads": 1, "hls_prefer_native": True, "fixup": "never",
        "nopart": True, "continuedl": False, "overwrites": False,
        "cookiefile": io.StringIO(request["cookies"]) if request.get("cookies") else None}
    with HostDownloader(options) as ydl:
        if request["operation"] == "subtitle":
            if request.get("text") is not None:
                text = request["text"]
            else:
                response = ydl.urlopen(Request(request["url"], headers=request.get("headers") or {}))
                text = response.read().decode("utf-8-sig")
            result = {"cues": parse_subtitle(text, request["ext"])}
        else:
            info = ydl.extract_info(request["url"], download=False)
            if not info:
                raise Failure("unavailable")
            if info.get("_type") in ("playlist", "multi_video") or "entries" in info:
                raise Failure("playlist_requires_selection")
            result = summary(info)
            if request["operation"] == "download":
                if info.get("is_live") or info.get("live_status") in ("is_live", "is_upcoming", "post_live"):
                    raise Failure("live_not_supported")
                if info.get("duration") is not None and (not isinstance(info["duration"], (int, float)) or not 0 < info["duration"] <= request["maxSeconds"]):
                    raise Failure("duration_limit")
                if result["id"] != request["expectedId"] or result["extractor"] != request["expectedExtractor"]:
                    raise Failure("extractor_failed")
                # Native downloaders keep every manifest, segment and CDN request on the bridge.
                formats = [f for f in info.get("formats", []) if f.get("protocol") in ("http", "https", "m3u8_native", "http_dash_segments") and not f.get("has_drm")]
                selector = ydl.build_format_selector("bv*+ba/b")
                selected = next(iter(ydl._select_formats(formats, selector)), None)
                if not selected:
                    raise Failure("unsupported_format")
                streams = selected.get("requested_formats") or [selected]
                if len(streams) > 2:
                    raise Failure("unsupported_format")
                used = 0
                for index, stream in enumerate(streams):
                    name = "video.mp4" if index == 0 else "audio.m4a"
                    path = os.path.join(request["directory"], name)
                    def progress(status):
                        if status.get("downloaded_bytes", 0) + used > request["maxBytes"]:
                            raise Failure("limit_exceeded")
                    params = {**options, "skip_download": False, "max_filesize": request["maxBytes"] - used,
                        "progress_hooks": [progress], "noprogress": True, "hls_use_mpegts": True}
                    fd_class = get_suitable_downloader(stream, params)
                    if not fd_class or fd_class.__module__ not in ("yt_dlp.downloader.http", "yt_dlp.downloader.hls", "yt_dlp.downloader.dash"):
                        raise Failure("unsupported_format")
                    fd = fd_class(ydl, params)
                    fd.add_progress_hook(progress)
                    if not fd.download(path, {**info, **stream})[0] or not os.path.isfile(path):
                        raise Failure("extractor_failed")
                    used += os.path.getsize(path)
                    if used > request["maxBytes"]:
                        raise Failure("limit_exceeded")
                result = {"id": result["id"], "extractor": result["extractor"], "durationSeconds": info.get("duration"), "separateAudio": len(streams) == 2, "bytes": used}
        emit({"type": "result", "value": result})
except Exception as error:
    text = str(error).lower()
    code = str(error) if isinstance(error, Failure) else (
        "rate_limited" if "429" in text or "too many requests" in text else
        "login_required" if any(s in text for s in ("sign in", "login", "log in", "cookies", "not a bot", "authentication")) else
        "unsupported_url" if "unsupported url" in text else "extractor_failed")
    emit({"type": "error", "code": code})
    sys.exit(1)
`;
