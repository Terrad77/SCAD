"""Render the actual revised TTF files, without tracing or reproducing a logo."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
PAPER = '#f4f4f0'
INK = '#191b18'
MUTED = '#565b52'
UI = 'C:/Windows/Fonts/segoeui.ttf'

def ui(size):
    return ImageFont.truetype(UI, size)

def face(style, size, previous=False):
    folder = ROOT/'versions/1.000/fonts' if previous else ROOT/'fonts'
    return ImageFont.truetype(str(folder/f'BrandSans-{style}.ttf'), size)

def fit(style, text, size, width, previous=False):
    while face(style, size, previous).getlength(text) > width:
        size -= 1
    return face(style, size, previous)

image = Image.new('RGB', (1600, 1060), PAPER)
draw = ImageDraw.Draw(image)
draw.text((64, 32), 'BrandSans 1.100', font=ui(38), fill=INK)
draw.text((64, 91), 'Шире. Прямее. Плотнее.', font=ui(24), fill=MUTED)

for style, top, number in [('Regular', 155, '400'), ('Medium', 392, '500')]:
    draw.text((64, top), f'{style} / {number}', font=ui(22), fill=MUTED)
    draw.text((56, top+38), 'BRANDSANS', font=fit(style, 'BRANDSANS', 172, 1480), fill=INK)

draw.line((64, 644, 1536, 644), fill='#c9ccc2', width=2)
lines = [
    ('ABCDEFGHIJKLMNOPQRSTUVWXYZ', 687, 47),
    ('abcdefghijklmnopqrstuvwxyz', 757, 52),
    ('0123456789 / AVATAR / To / WAY', 827, 45),
    ('€ $ £ ¥ ₽ ₴ ₹ ₩ ₺ ₫ ₪ ₿', 897, 46),
]
for text, top, size in lines:
    draw.text((64, top), text, font=fit('Medium', text, size, 1470), fill=INK)
draw.text((64, 1003), 'Рендер из TTF · 244 кодпоинта · самостоятельный рисунок букв', font=ui(23), fill=MUTED)
image.save(ROOT/'reports/direction-v1.100.png')

comparison = Image.new('RGB', (1600, 680), PAPER)
draw = ImageDraw.Draw(comparison)
draw.text((64, 30), 'BrandSans — сравнение геометрии при одинаковом кегле', font=ui(29), fill=INK)
for previous, top, label in [(True, 115, '1.000 / прежний вариант'), (False, 377, '1.100 / обновлённый вариант')]:
    draw.text((64, top), label, font=ui(23), fill=MUTED)
    draw.text((56, top+34), 'SANS / BRAND', font=face('Medium', 112, previous), fill=INK)
comparison.save(ROOT/'reports/comparison-v1.100.png')
print('Rendered direction-v1.100.png and comparison-v1.100.png from TTF files.')
