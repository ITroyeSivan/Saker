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
MAX_ROW_H = 440   # 设置页接近方形，保留足够高度显示正文
RADIUS = 10

# 同一行放**宽高比接近**的图，各行宽度才均衡；混着放会出现一行里一窄两宽。
ROWS = [
    [("desktop-modes.png", "三个测试模式"),
     ("desktop-tasks.png", "测试任务"),
     ("desktop-results.png", "成果与证据（本地夹具）")],
    [("desktop-skills.png", "技能管理"),
     ("desktop-tools.png", "本机工具"),
     ("desktop-mcp.png", "MCP 工作台")],
    [("desktop-methods.png", "方法编排"),
     ("desktop-nday.png", "漏洞情报更新"),
     ("desktop-knowledge.png", "知识库")],
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
