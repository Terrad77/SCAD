"""Proof of the actual Cyrillic TTFs. No logo or raster lettering is used."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT=Path(__file__).resolve().parents[1]
PAPER='#f4f4f0'; INK='#191b18'; MUTED='#565b52'
image=Image.new('RGB',(1600,1510),PAPER)
draw=ImageDraw.Draw(image)
ui=lambda size:ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf',size)

def fit(style,text,size):
    path=str(ROOT/'fonts'/f'BrandSans-{style}.ttf')
    while ImageFont.truetype(path,size).getlength(text)>1472:size-=1
    return ImageFont.truetype(path,size)

draw.text((64,30),'BrandSans 1.200 — кириллица',font=ui(38),fill=INK)
draw.text((64,90),'Русский · Українська · Беларуская',font=ui(26),fill=MUTED)
for style,top in [('Regular',155),('Medium',490)]:
    draw.text((64,top),style,font=ui(24),fill=MUTED)
    text='БРЕНДСАНС'
    draw.text((56,top+32),text,font=fit(style,text,145),fill=INK)
    text='Съешь ещё этих мягких булок.'
    draw.text((64,top+220),text,font=fit(style,text,59),fill=INK)

draw.line((64,808,1536,808),fill='#c9ccc2',width=2)
for text,top,size in [
    ('АБВГДЕЁЖЗИЙКЛМНОП',850,66),
    ('РСТУФХЦЧШЩЪЫЬЭЮЯ',940,66),
    ('абвгдеёжзийклмнопрстуфхцчшщъыьэюя',1038,48),
    ('Ґґ Єє Іі Її Ўў · № 2026',1125,65),
    ('Привіт, Україно! · Жыве Беларусь!',1230,58),
]:draw.text((64,top),text,font=fit('Medium',text,size),fill=INK)

draw.text((64,1428),'Рендер из TTF · 76 кириллических букв · 321 кодпоинт всего',font=ui(24),fill=MUTED)
image.save(ROOT/'reports/cyrillic-v1.200.png')
print('Rendered cyrillic-v1.200.png from actual Regular and Medium TTF files.')
