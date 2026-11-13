"""Offline quotation layout. Input is sanitized text and inline static image bytes."""
import base64
import hashlib
import html
import io
import json
import math
import os
from pathlib import Path
import sys

if len(sys.argv) == 4:
    os.environ["FONTCONFIG_FILE"] = sys.argv[3]
elif os.environ.get("QUOTE_FONTCONFIG_FILE"):
    os.environ["FONTCONFIG_FILE"] = os.environ["QUOTE_FONTCONFIG_FILE"]

import cairocffi as cairo
import pangocffi as pango
import pangocairocffi as pangocairo
from PIL import Image, ImageOps

MAX_ASSET = 8 * 1024 * 1024
MAX_TOTAL_ASSETS = 24 * 1024 * 1024
MAX_PIXELS = 16_000_000
MAX_OUTPUT = 8 * 1024 * 1024
BODY_SIZE = 24
NAME_SIZE = 20
FONT = "Noto Sans, Noto Sans CJK SC, Noto Color Emoji"
STYLE = {
    "bold": ('weight', 'bold'), "italic": ('style', 'italic'),
    "underline": ('underline', 'single'), "strikethrough": ('strikethrough', 'true'),
    "code": ('font_family', 'monospace'), "pre": ('font_family', 'monospace'),
    "blockquote": ('style', 'italic'), "highlight": ('background', '#7659a5'),
    "text_link": ('underline', 'single'), "url": ('underline', 'single'),
}


def require(condition, code="invalid_input"):
    if not condition:
        raise ValueError(code)


def fields(value, allowed):
    require(isinstance(value, dict) and not (set(value) - set(allowed)))


def text(value, maximum):
    require(isinstance(value, str) and '\x00' not in value)
    require(len(value.encode('utf-16-le')) // 2 <= maximum, 'text_limit')
    return value


def styled_markup(value, entities):
    """Partition overlapping UTF-16 ranges; Pango receives escaped markup, never user markup."""
    encoded = value.encode('utf-16-le')
    spans = []
    for entity in entities:
        fields(entity, ('type', 'offset', 'length'))
        kind = entity.get('type')
        offset, length = entity.get('offset'), entity.get('length')
        require(kind in STYLE and type(offset) is int and type(length) is int)
        require(offset >= 0 and length > 0 and (offset + length) * 2 <= len(encoded))
        start = len(encoded[:offset * 2].decode('utf-16-le'))
        end = len(encoded[:(offset + length) * 2].decode('utf-16-le'))
        spans.append((start, end, kind))
    boundaries = sorted({0, len(value), *(n for a, b, _ in spans for n in (a, b))})
    output = []
    for a, b in zip(boundaries, boundaries[1:]):
        attrs = dict(STYLE[kind] for start, end, kind in spans if start <= a and end >= b)
        part = html.escape(value[a:b])
        if attrs:
            part = '<span ' + ' '.join(f'{key}="{val}"' for key, val in attrs.items()) + '>' + part + '</span>'
        output.append(part)
    return ''.join(output)


def measure(context, value, size, entities=(), bold=False, width=432):
    layout = pangocairo.create_layout(context)
    font = pango.FontDescription()
    font.family = FONT
    font.set_absolute_size(size * pango.units_from_double(1))
    font.weight = pango.Weight.BOLD if bold else pango.Weight.NORMAL
    layout.font_description = font
    layout.width = pango.units_from_double(width)
    layout.wrap = pango.WrapMode.WORD_CHAR
    layout.spacing = pango.units_from_double(3)
    layout.apply_markup(styled_markup(value, entities))
    require(pango.pango.pango_layout_get_unknown_glyphs_count(layout.pointer) == 0, 'missing_glyph')
    ink, logical = layout.get_extents()
    x0 = min(0, ink.x, logical.x) / 1024
    y0 = min(0, ink.y, logical.y) / 1024
    x1 = max(ink.x + ink.width, logical.x + logical.width) / 1024
    y1 = max(ink.y + ink.height, logical.y + logical.height) / 1024
    return layout, math.ceil(x1 - x0), math.ceil(y1 - y0), -x0, -y0


def image_asset(asset, totals, avatar=False):
    fields(asset, ('base64', 'mimeType'))
    require(asset.get('mimeType') in ('image/png', 'image/jpeg', 'image/webp'))
    data = base64.b64decode(asset.get('base64', ''), validate=True)
    require(0 < len(data) <= (1024 * 1024 if avatar else MAX_ASSET), 'asset_limit')
    totals[0] += len(data)
    require(totals[0] <= MAX_TOTAL_ASSETS, 'asset_limit')
    with Image.open(io.BytesIO(data)) as source:
        require(source.format in ('PNG', 'JPEG', 'WEBP') and getattr(source, 'n_frames', 1) == 1, 'invalid_image')
        require(source.width * source.height <= (4_000_000 if avatar else MAX_PIXELS), 'pixel_limit')
        pixels = ImageOps.exif_transpose(source).convert('RGBA')
        if avatar:
            pixels = ImageOps.fit(pixels, (96, 96), method=Image.Resampling.LANCZOS)
        else:
            pixels.thumbnail((800, 520), Image.Resampling.LANCZOS)
        stream = io.BytesIO()
        pixels.save(stream, format='PNG')
        stream.seek(0)
        return cairo.ImageSurface.create_from_png(stream)


def color(hex_value):
    require(isinstance(hex_value, str) and len(hex_value) == 7 and hex_value[0] == '#')
    return tuple(int(hex_value[n:n + 2], 16) / 255 for n in (1, 3, 5))


def bubble(context, x, y, width, height):
    context.new_sub_path()
    radius = 16
    for cx, cy, start in ((x + width - radius, y + radius, -math.pi / 2), (x + width - radius, y + height - radius, 0), (x + radius, y + height - radius, math.pi / 2), (x + radius, y + radius, math.pi)):
        context.arc(cx, cy, radius, start, start + math.pi / 2)
    context.close_path()
    context.fill()


def render(document, destination):
    fields(document, ('background', 'messages'))
    messages = document.get('messages')
    require(isinstance(messages, list) and 1 <= len(messages) <= 10)
    background = color(document.get('background'))
    linear = tuple(c / 12.92 if c <= .04045 else ((c + .055) / 1.055) ** 2.4 for c in background)
    luminance = sum(c * w for c, w in zip(linear, (.2126, .7152, .0722)))
    foreground = (1, 1, 1) if luminance < .179 else (0, 0, 0)
    name_color = (.76, .81, 1) if luminance < .179 else (.21, .15, .43)
    measuring = cairo.Context(cairo.ImageSurface(cairo.FORMAT_ARGB32, 1, 1))
    rows, assets, total_text, height, width = [], [0], 0, 12, 0
    for message in messages:
        fields(message, ('author', 'text', 'entities', 'media', 'reply'))
        author = message.get('author', {})
        fields(author, ('key', 'name', 'avatar'))
        name = text(author.get('name'), 256)
        key = text(author.get('key'), 512)
        body = text(message.get('text'), 4096)
        total_text += len(body.encode('utf-16-le')) // 2
        require(total_text <= 12000, 'text_limit')
        entities = message.get('entities', [])
        require(isinstance(entities, list) and len(entities) <= 100)
        parts = [('text', (measure(measuring, name, NAME_SIZE, bold=True), name_color))]
        reply = message.get('reply')
        if reply:
            fields(reply, ('author', 'text'))
            reply_name = measure(measuring, text(reply.get('author'), 256), 16, bold=True, width=420)
            reply_text = measure(measuring, text(reply.get('text'), 180), 16, width=420)
            parts.append(('reply', (reply_name, reply_text)))
        if body:
            parts.append(('text', (measure(measuring, body, BODY_SIZE, entities), foreground)))
        media = image_asset(message['media'], assets) if message.get('media') else None
        avatar = None
        if message.get('author', {}).get('avatar'):
            # The host may omit a failed avatar; malformed provided images are rejected rather than decoded unchecked.
            avatar = image_asset(author['avatar'], assets, True)
        media_w = math.ceil(media.get_width() / 2) if media else 0
        media_h = math.ceil(media.get_height() / 2) if media else 0
        if media:
            parts.append(('image', (media, media_w, media_h)))
        if rows and rows[-1]['key'] == key and rows[-1]['name'] == name:
            rows[-1]['parts'].extend(parts[1:])
        else:
            initial = measure(measuring, name[:1] or '?', 24, width=40)
            rows.append({'key': key, 'name': name, 'initial': initial, 'avatar': avatar, 'parts': parts})
    for row in rows:
        widths, heights = [], []
        for kind, part in row['parts']:
            if kind == 'text':
                widths.append(part[0][1])
                heights.append(part[0][2])
            elif kind == 'reply':
                widths.append(max(part[0][1], part[1][1]) + 12)
                heights.append(part[0][2] + part[1][2] + 4)
            else:
                widths.append(part[1])
                heights.append(part[2])
        row['width'] = max([24, *widths]) + 24
        row['height'] = max(48, sum(heights) + 6 * len(heights) + 22)
        width = max(width, 48 + row['width'] + 8)
        height += row['height'] + 12
        require(width <= 512 and height <= 4096, 'canvas_limit')
    surface = cairo.ImageSurface(cairo.FORMAT_ARGB32, width * 2, height * 2)
    ctx = cairo.Context(surface)
    ctx.scale(2, 2)
    y = 12
    for row in rows:
        key, initial, avatar = row["key"], row["initial"], row["avatar"]
        ctx.set_source_rgb(*background)
        bubble(ctx, 48, y, row["width"], row["height"])
        ctx.save()
        ctx.arc(24, y + 18, 18, 0, math.tau)
        ctx.clip()
        if avatar:
            ctx.translate(6, y)
            ctx.scale(.375, .375)
            ctx.set_source_surface(avatar)
            ctx.paint()
        else:
            digest = hashlib.blake2s(key.encode()).digest()
            ctx.set_source_rgb(*(0.25 + channel / 510 for channel in digest[:3]))
            ctx.paint()
            obj, w, h, dx, dy = initial
            ctx.set_source_rgb(1, 1, 1)
            ctx.move_to(24 - w / 2 + dx, y + 18 - h / 2 + dy)
            pangocairo.show_layout(ctx, obj)
        ctx.restore()
        cursor = y + 12
        for kind, part in row['parts']:
            if kind == 'text':
                (obj, _, h, dx, dy), foreground_color = part
                ctx.set_source_rgb(*foreground_color)
                ctx.move_to(60 + dx, cursor + dy)
                pangocairo.show_layout(ctx, obj)
                cursor += h + 6
            elif kind == 'reply':
                reply_name, reply_text = part
                preview_height = reply_name[2] + reply_text[2] + 4
                ctx.set_source_rgb(*name_color)
                ctx.rectangle(60, cursor, 3, preview_height)
                ctx.fill()
                for block, tint in ((reply_name, name_color), (reply_text, foreground)):
                    obj, _, h, dx, dy = block
                    ctx.set_source_rgba(*tint, .85)
                    ctx.move_to(72 + dx, cursor + dy)
                    pangocairo.show_layout(ctx, obj)
                    cursor += h + 2
                cursor += 6
            else:
                media, _, media_h = part
                ctx.save()
                ctx.translate(60, cursor)
                ctx.scale(.5, .5)
                ctx.set_source_surface(media)
                ctx.paint()
                ctx.restore()
                cursor += media_h + 6
        y += row['height'] + 12
    png = io.BytesIO()
    surface.write_to_png(png)
    png.seek(0)
    with Image.open(png) as image:
        image = image.resize((width, height), Image.Resampling.LANCZOS)
        scale = 512 / max(width, height)
        if BODY_SIZE * scale >= 14 and NAME_SIZE * scale >= 10:
            sticker = image.resize((max(1, round(width * scale)), max(1, round(height * scale))), Image.Resampling.LANCZOS)
            output = io.BytesIO()
            sticker.save(output, format='WEBP', lossless=True, method=4)
            if output.tell() <= 512 * 1024:
                Path(destination).write_bytes(output.getvalue())
                return {'format': 'webp', 'width': sticker.width, 'height': sticker.height}
        output = io.BytesIO()
        image.save(output, format='PNG')
        require(output.tell() <= MAX_OUTPUT, 'output_limit')
        Path(destination).write_bytes(output.getvalue())
        return {'format': 'png', 'width': width, 'height': height}


def main():
    source, destination = sys.argv[1:3]
    try:
        payload = json.loads(Path(source).read_bytes())
        metadata = render(payload, destination)
        print(json.dumps(metadata))
    except (ValueError, OSError, TypeError, KeyError, AttributeError, Image.DecompressionBombError):
        print('quote_render_failed', file=sys.stderr)
        raise SystemExit(1)


if __name__ == '__main__':
    main()
