"""Native rendering checks, executed inside the production quote-worker image build."""
import base64
import io
import tempfile
import unittest
from pathlib import Path
from PIL import Image, ImageDraw
from renderer import render, styled_markup


def document(body='中文 日本語 Hello 😀❤️ 👩🏽‍💻', **extra):
    return {'background': '#251D3A', 'messages': [{'author': {'key': 'fiction:lin', 'name': '小林'}, 'text': body, **extra}]}


def asset():
    picture = Image.new('RGBA', (320, 180))
    draw = ImageDraw.Draw(picture)
    draw.rounded_rectangle((20, 20, 300, 160), radius=30, fill='#65C8AE')
    output = io.BytesIO()
    picture.save(output, 'PNG')
    return {'mimeType': 'image/png', 'base64': base64.b64encode(output.getvalue()).decode()}


class RendererTests(unittest.TestCase):
    def paint(self, payload):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'render.bin'
            result = render(payload, path)
            image = Image.open(path).convert('RGBA')
            image.load()
            return result, image, path.stat().st_size

    def test_real_cjk_color_emoji_and_sticker_bounds(self):
        result, image, size = self.paint(document())
        self.assertEqual(result['format'], 'webp')
        self.assertEqual(max(image.size), 512)
        self.assertLessEqual(size, 512 * 1024)
        self.assertEqual(image.getpixel((0, 0))[3], 0)
        # Emoji should contain saturated yellow/red rather than monochrome missing-glyph boxes.
        self.assertTrue(any(r > 200 and g > 130 and b < 100 and a > 200 for r, g, b, a in image.getdata()))

    def test_utf16_offsets_and_overlapping_styles_escape_markup(self):
        value = 'A😀B <b>'
        markup = styled_markup(value, [{'type': 'bold', 'offset': 3, 'length': 1}, {'type': 'italic', 'offset': 0, 'length': 4}])
        self.assertIn('weight="bold"', markup)
        self.assertIn('>B</span>', markup)
        self.assertIn('&lt;b&gt;', markup)
        with self.assertRaises(ValueError): styled_markup(value, [{'type': 'bold', 'offset': 2, 'length': 1}])
        with self.assertRaises(ValueError): styled_markup(value, [{'type': 'spoiler', 'offset': 0, 'length': 1}])
        self.paint(document(value, entities=[{'type': 'bold', 'offset': 3, 'length': 1}]))

    def test_long_text_falls_back_to_readable_png(self):
        result, image, size = self.paint(document('这是虚构的长语录，用来检查文字可读性。\n' * 20))
        self.assertEqual(result['format'], 'png')
        self.assertGreater(image.height, 512)
        self.assertLessEqual(image.height, 4096)
        self.assertLessEqual(size, 8 * 1024 * 1024)

    def test_media_avatar_reply_and_multiple_authors(self):
        data = document('一张虚构图片', media=asset(), reply={'author': '阿岚', 'text': '今晚一起看星星吗？'})
        data['messages'][0]['author']['avatar'] = asset()
        data['messages'].append({'author': {'key': 'fiction:lan', 'name': '阿岚'}, 'text': '这次真的修好了。'})
        _, image, _ = self.paint(data)
        self.assertTrue(any(g > 160 and b > 100 and r < 140 for r, g, b, a in image.getdata() if a > 200))

    def test_adjacent_same_author_media_share_one_bubble(self):
        data = document('第一张', media=asset())
        data['messages'].append({'author': {'key': 'fiction:lin', 'name': '小林'}, 'text': '第二张', 'media': asset()})
        _, merged, _ = self.paint(data)
        data['messages'][1]['author']['key'] = 'fiction:other'
        _, separate, _ = self.paint(data)
        self.assertLess(merged.height / merged.width, separate.height / separate.width)
        # Both pictures survive the merge; the central column contains two colored runs.
        colored = [y for y in range(merged.height) if (lambda p: p[1] > 160 and p[0] < 140 and p[3] > 200)(merged.getpixel((180, y)))]
        self.assertEqual(sum(i == 0 or y > colored[i-1] + 1 for i, y in enumerate(colored)), 2)

    def test_parent_previews_survive_same_author_merge(self):
        data = document('第一句', reply={'author': '阿岚', 'text': '第一条父消息'})
        data['messages'].append({'author': data['messages'][0]['author'], 'text': '第二句',
                                 'reply': {'author': '阿岚', 'text': '第二条父消息'}})
        _, image, _ = self.paint(data)
        del data['messages'][1]['reply']
        _, without_second, _ = self.paint(data)
        self.assertGreater(image.height / image.width, without_second.height / without_second.width)

    def test_long_author_and_utf16_bounded_emoji_parent(self):
        data = document('署名和父消息均保留', reply={'author': '中文署名' * 32, 'text': '😀' * 89 + '…'})
        data['messages'][0]['author'] = {'key': 'k' * 512, 'name': '测试群聊' * 32}
        result, _, _ = self.paint(data)
        self.assertIn(result['format'], ('webp', 'png'))
        data['messages'][0]['reply']['text'] = '😀' * 91
        with self.assertRaises(ValueError): self.paint(data)

    def test_limits_reject_paths_spoilers_and_oversized_canvas(self):
        for value in [document('x' * 4097), document('a\n' * 1000), {**document(), 'path': '/etc/passwd'}, document('secret', entities=[{'type': 'spoiler', 'offset': 0, 'length': 6}]), document(media={'mimeType': 'image/png', 'base64': 'not-base64'})]:
            with self.assertRaises(ValueError): self.paint(value)

    def test_animated_and_oversized_images_are_rejected(self):
        output = io.BytesIO()
        Image.new('RGB', (8, 8), 'red').save(output, 'PNG', save_all=True, append_images=[Image.new('RGB', (8, 8), 'blue')])
        with self.assertRaises(ValueError): self.paint(document(media={'mimeType': 'image/png', 'base64': base64.b64encode(output.getvalue()).decode()}))
        output = io.BytesIO()
        Image.new('1', (4001, 4000)).save(output, 'PNG')
        with self.assertRaises(ValueError): self.paint(document(media={'mimeType': 'image/png', 'base64': base64.b64encode(output.getvalue()).decode()}))

    def test_colors_include_light_and_dark(self):
        for background in ['#FFFFFF', '#000000', '#172B4D']:
            payload = document('配色测试 Hello')
            payload['background'] = background
            self.paint(payload)


if __name__ == '__main__': unittest.main()
