// Pin the private Bilibili extractor methods through requirements.txt and real extractor tests.
// The pinned yt-dlp extractors run without credentials or direct network access.
// JSON requests cross back to the host's bounded, origin-scoped media transport.
export const YTDLP_SCRIPT = String.raw`
import json
import sys

def emit(value):
    print(json.dumps(value, ensure_ascii=True, separators=(",", ":")), flush=True)

try:
    from yt_dlp import YoutubeDL
    from yt_dlp.extractor.bilibili import BiliBiliIE
except ImportError:
    emit({"type": "error", "code": "unavailable"})
    sys.exit(1)

class SilentLogger:
    def debug(self, message): pass
    def warning(self, message): pass
    def error(self, message): pass

class HostExtractor(BiliBiliIE):
    def __init__(self, downloader):
        super().__init__(downloader)
        self.subtitle_info = {}
        self.bodies = {}

    def _download_json(self, url, video_id, **kwargs):
        emit({"type": "request", "url": url, "query": kwargs.get("query") or {}})
        response = json.loads(sys.stdin.readline())
        if not response.get("ok"):
            raise RuntimeError("request_failed")
        value = response["value"]
        if "/x/player/wbi/v2" in url:
            self.subtitle_info = value.get("data", {})
        return value

    def json2srt(self, body):
        srt = super().json2srt(body)
        self.bodies[srt] = body
        return srt

try:
    request = json.loads(sys.stdin.readline())
    video = request["video"]
    with YoutubeDL({"quiet": True, "no_warnings": True, "skip_download": True,
                    "cachedir": False, "logger": SilentLogger()}) as downloader:
        extractor = HostExtractor(downloader)
        if request["operation"] == "subtitles":
            subtitles = extractor._get_subtitles(video["bvid"], video["cid"], video["aid"])
            labels = {track["lan"]: track.get("lan_doc", track["lan"])
                      for track in extractor.subtitle_info.get("subtitle", {}).get("subtitles", [])}
            tracks = []
            for language, formats in subtitles.items():
                if language == "danmaku":
                    continue
                for subtitle in formats:
                    if "data" not in subtitle or subtitle["data"] not in extractor.bodies:
                        raise RuntimeError("invalid_response")
                    tracks.append({"language": language, "label": labels.get(language, language),
                                   "body": extractor.bodies[subtitle["data"]]})
            result = {"status": "login_required" if extractor.subtitle_info.get("need_login_subtitle") else "ok",
                      "tracks": tracks}
        elif request["operation"] == "video":
            result = extractor._download_playinfo(video["bvid"], video["cid"], query={"qn": 80})
        else:
            raise RuntimeError("invalid_response")
        emit({"type": "result", "value": result})
except Exception:
    emit({"type": "error", "code": "extractor_failed"})
    sys.exit(1)
`;
