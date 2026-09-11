"""把功能截图拼成 README 首页的封面图（00-hero-collage.png）。

排版用「等高行（justified rows）」：每行 3 张按同一高度缩放、宽度自适应铺满整行，
不裁剪任何画面内容。背景透明以适配 GitHub 明暗主题，卡片圆角 + 底部半透明标签条。

用法：python docs/images/make-collage.py   （工作目录任意，输出落在本脚本同目录）
"""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "00-hero-collage.png")

PAD = 40          # 画布外边距
GAP = 14          # 卡片水平间距
ROW_GAP = 14      # 行间距
CANVAS_W = 1600
MAX_ROW_H = 340   # 单行最大高度，避免偏方的图把行撑得过高
RADIUS = 10

# 同一行放**宽高比接近**的图，各行宽度才均衡；混着放会出现一行里一窄两宽。
ROWS = [
    [("02-modes.png", "三种模式"),
     ("03-attack-atlas.png", "攻击面覆盖"),
     ("09-findings.png", "成果与证据")],
    [("06-skills.png", "技能可自定义"),
     ("07-tools1.png", "工具可自定义"),
     ("08-tools2.png", "MCP 可接入")],
    [("04-method-stack1.png", "提示词可编排"),
     ("11-webshell1.png", "WebShell 管理"),
     ("13-knowledge1.png", "知识库随包")],
]

CONTENT_W = CANVAS_W - 2 * PAD
_fonts = {}


def load_font(size):
    if size in _fonts:
        return _fonts[size]
    for name in ("msyh.ttc", "msyhbd.ttc", "simhei.ttf", "segoeui.ttf"):
        p = os.path.join(r"C:\Windows\Fonts", name)
        if os.path.exists(p):
            try:
                _fonts[size] = ImageFont.truetype(p, size)
                return _fonts[size]
            except OSError:
                continue
    _fonts[size] = ImageFont.load_default()
    return _fonts[size]


plan = []
total_h = PAD
for row in ROWS:
    imgs = [Image.open(os.path.join(HERE, f)).convert("RGB") for f, _ in row]
    sum_ar = sum(im.width / im.height for im in imgs)
    h = min((CONTENT_W - GAP * (len(row) - 1)) / sum_ar, MAX_ROW_H)
    plan.append({"row": row, "imgs": imgs, "h": round(h),
                 "widths": [round(im.width * (h / im.height)) for im in imgs]})
    total_h += round(h) + ROW_GAP
CANVAS_H = total_h - ROW_GAP + PAD

canvas = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
y = PAD
for item in plan:
    h = item["h"]
    row_w = sum(item["widths"]) + GAP * (len(item["widths"]) - 1)
    x = PAD + (CONTENT_W - row_w) // 2
    bar_h = max(28, round(h * 0.13))
    font = load_font(max(17, round(bar_h * 0.52)))
    for (_, label), im, w in zip(item["row"], item["imgs"], item["widths"]):
        tile = im.resize((w, h), Image.LANCZOS).convert("RGBA")

        m = Image.new("L", (w * 4, h * 4), 0)
        ImageDraw.Draw(m).rounded_rectangle([0, 0, w * 4 - 1, h * 4 - 1], radius=RADIUS * 4, fill=255)
        mask = m.resize((w, h), Image.LANCZOS)

        ov = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        od = ImageDraw.Draw(ov)
        od.rectangle([0, h - bar_h, w, h], fill=(0, 0, 0, 145))
        tb = od.textbbox((0, 0), label, font=font)
        od.text(((w - (tb[2] - tb[0])) / 2 - tb[0],
                 h - bar_h + (bar_h - (tb[3] - tb[1])) / 2 - tb[1]),
                label, font=font, fill=(255, 255, 255, 246))
        tile = Image.alpha_composite(tile, ov)
        tile.putalpha(mask)
        canvas.alpha_composite(tile, (x, y))

        bd = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        ImageDraw.Draw(bd).rounded_rectangle([0, 0, w - 1, h - 1], radius=RADIUS,
                                            outline=(136, 135, 128, 95), width=1)
        canvas.alpha_composite(bd, (x, y))
        x += w + GAP
    y += h + ROW_GAP

canvas.save(OUT, optimize=True)
print("已生成", OUT)
print(f"尺寸 {CANVAS_W}x{CANVAS_H}  大小 {os.path.getsize(OUT)/1024:.0f} KB")
