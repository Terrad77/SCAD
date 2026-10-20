"""Binary, cmap, bounds, metrics, WOFF2 roundtrip and real HarfBuzz checks."""
from pathlib import Path
import sys,json,hashlib,unicodedata
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'.tools'))
from fontTools.ttLib import TTFont
import uharfbuzz as hb
from PIL import Image,ImageDraw,ImageFont

def shape(path,text,kern):
 font=hb.Font(hb.Face(path.read_bytes()));buf=hb.Buffer();buf.add_str(text);buf.guess_segment_properties();hb.shape(font,buf,{'kern':kern});return [p.x_advance for p in buf.glyph_positions],[i.codepoint for i in buf.glyph_infos]
report={'status':'PASS','files':[],'checks':[],'version':'1.200'}
coverage=json.loads((ROOT/'reports/coverage.json').read_text(encoding='utf8'))
expected={int(x['hex'][2:],16) for x in coverage['codepoints']}
for style,weight in [('Regular',400),('Medium',500)]:
 ttf=ROOT/'fonts'/f'BrandSans-{style}.ttf';web=ttf.with_suffix('.woff2')
 a=TTFont(ttf,checkChecksums=2);b=TTFont(web,checkChecksums=2)
 assert ttf.read_bytes()[:4]==b'\x00\x01\x00\x00' and web.read_bytes()[:4]==b'wOF2'
 assert set(a.getBestCmap())==set(b.getBestCmap())==expected
 assert a['OS/2'].usWeightClass==weight and a['OS/2'].fsType==0 and a['OS/2'].version==4
 assert a['OS/2'].usWidthClass==7 and a['head'].fontRevision>1.19
 assert a['name'].getDebugName(5)=='Version 1.200'
 assert a['head'].unitsPerEm==1000 and a['hhea'].ascent==1000 and a['hhea'].descent==-260
 assert a['hmtx'].metrics==b['hmtx'].metrics
 assert 'GPOS' in a and 'kern' in a and len(a['kern'].kernTables[0].kernTable)==coverage['kerningPairs'][style]
 assert 'cyrl' in {record.ScriptTag for record in a['GPOS'].table.ScriptList.ScriptRecord}
 assert a['GPOS'].compile(a)==b['GPOS'].compile(b)
 assert len({a['hmtx'].metrics[a.getBestCmap()[ord(c)]][0] for c in '0123456789'})==1
 assert a['hmtx'].metrics[a.getBestCmap()[ord('0')]][0]==coverage['metrics']['numeralAdvance']
 for c in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ':
  g=a['glyf'][a.getBestCmap()[ord(c)]];g.recalcBounds(a['glyf'])
  assert g.yMax==700,(c,g.yMax)
  assert g.yMin==0 if c!='Q' else g.yMin<0,(c,g.yMin)
 for c in 'acemnorsuvwxz':
  g=a['glyf'][a.getBestCmap()[ord(c)]];g.recalcBounds(a['glyf'])
  assert g.yMin==0 and g.yMax==520,(c,g.yMin,g.yMax)
 for c in 'АБВГЕЖЗИКЛМНОПРСТУФХЧШЪЫЬЭЮЯҐЄІ':
  g=a['glyf'][a.getBestCmap()[ord(c)]];g.recalcBounds(a['glyf'])
  assert g.yMin==0 and g.yMax==700,(c,g.yMin,g.yMax)
 for c in 'авгежзиклмностхчшыьъэюяґє':
  g=a['glyf'][a.getBestCmap()[ord(c)]];g.recalcBounds(a['glyf'])
  assert g.yMin==0 and g.yMax==520,(c,g.yMin,g.yMax)
 required='АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯҐЄІЇЎ'
 required+=required.lower()
 assert {ord(c) for c in required}<=expected
 assert coverage['cyrillicCodepointCount']==len(set(required))==76
 # All prior outlines, widths and pair values must survive the Cyrillic addition.
 old=TTFont(ROOT/'versions/1.100/fonts'/ttf.name)
 for cp,gn in old.getBestCmap().items():
  current=a.getBestCmap()[cp]
  assert old['glyf'][gn].getCoordinates(old['glyf'])==a['glyf'][current].getCoordinates(a['glyf']),(cp,'changed old outline')
  assert old['hmtx'].metrics[gn]==a['hmtx'].metrics[current],(cp,'changed old metric')
 for pair,value in old['kern'].kernTables[0].kernTable.items():
  assert a['kern'].kernTables[0].kernTable[pair]==value,(pair,'changed old pair')
 bounds=[]
 for cp,gn in a.getBestCmap().items():
  glyph=a['glyf'][gn];other=b['glyf'][gn]
  assert glyph.getCoordinates(a['glyf'])==other.getCoordinates(b['glyf'])
  if cp in (32,160,173):assert glyph.numberOfContours==0;continue
  assert glyph.numberOfContours>0,hex(cp)
  glyph.recalcBounds(a['glyf']);assert glyph.yMax<=1000 and glyph.yMin>=-260,(gn,glyph.yMin,glyph.yMax)
  bounds.append((glyph.yMin,glyph.yMax))
  _,ids=shape(ttf,chr(cp),True);assert ids and all(ids),(hex(cp),ids)
 for text in ['AV','To','WA','Yo','ÁV','Tö','ТА','То','Га','УА','Гё','Ґє']:
  on,_=shape(ttf,text,True);off,_=shape(ttf,text,False);assert sum(on)<sum(off),(text,on,off)
 for text in [required,'Съешь ещё этих мягких французских булок, да выпей чаю.','Привіт, Україно! Ґанок, їжак, єдність.','Жыве Беларусь! Ўзоры шрыфту. № 2026']:
  _,ids=shape(ttf,text,True);assert all(ids),(text,'missing shaped glyph')
 for path in (ttf,web):report['files'].append({'file':path.name,'bytes':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'mappedCodepoints':len(expected),'weight':weight,'glyphBoundsY':[min(x[0] for x in bounds),max(x[1] for x in bounds)]})
 report['checks'].append({'weight':style,'cmap':'PASS','nonblankGlyphs':'PASS','bounds':'PASS','roundtrip':'PASS','shapingAllCodepoints':'PASS','kerningOnOff':'PASS','tabularNumerals':'PASS','capAndXHeight':'PASS','russianUkrainianBelarusian':'PASS','cyrillicKerning':'PASS','priorOutlinesMetricsAndKerningUnchanged':'PASS'})
report['currencySymbols']=[chr(cp) for cp in sorted(expected) if unicodedata.category(chr(cp))=='Sc']
(ROOT/'reports/validation.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
# Desktop raster proof of actual TTF files, including the complete mapped repertoire.
image=Image.new('RGB',(1600,2700),'#eeeeea');draw=ImageDraw.Draw(image)
y=50
for style in ('Regular','Medium'):
 path=str(ROOT/'fonts'/f'BrandSans-{style}.ttf')
 f=ImageFont.truetype(path,86);label=ImageFont.truetype(path,28)
 draw.text((55,y),f'BrandSans {style}',font=label,fill='#5c5e57');y+=60
 for line in ['Precision. With a pulse.','ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz','0123456789  AVATAR  To  WAY','ÀÉÎÖÜ ÇÑ æœ ß · € $ £ ¥ ₽ ₴ ₹ ₿']:
  # Fit long proof lines while preserving actual font rendering.
  size=86
  while ImageFont.truetype(path,size).getlength(line)>1480:size-=1
  draw.text((55,y),line,font=ImageFont.truetype(path,size),fill='#20211f');y+=115
 y+=35
font=ImageFont.truetype(str(ROOT/'fonts/BrandSans-Regular.ttf'),32)
chars=[chr(cp) for cp in sorted(expected)]
for i in range(0,len(chars),32):
 for j,c in enumerate(chars[i:i+32]):draw.text((55+j*46,y),c,font=font,fill='#20211f')
 y+=60
image.crop((0,0,1600,min(y+50,2700))).save(ROOT/'reports/specimen.png')
print(json.dumps(report,ensure_ascii=True,indent=2))
