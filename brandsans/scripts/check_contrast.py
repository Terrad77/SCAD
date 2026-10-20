import json,math
from pathlib import Path
R=Path(__file__).resolve().parents[1]
def lum(h):
 v=[int(h[i:i+2],16)/255 for i in (1,3,5)]
 v=[c/12.92 if c<=.04045 else ((c+.055)/1.055)**2.4 for c in v]
 return sum(c*w for c,w in zip(v,[.2126,.7152,.0722]))
def ratio(a,b):
 x,y=sorted([lum(a),lum(b)]);return round((y+.05)/(x+.05),2)
pairs=[('body and glyph buttons','#20211f','#eeeeea'),('secondary text','#5c5e57','#eeeeea'),('dark specimen text','#eeeeea','#242620'),('dark specimen labels','#c5c9bb','#242620'),('button hover glyphs','#20211f','#d9dcd1'),('accent hover links','#b42a18','#eeeeea')]
results=[{'role':label,'foreground':a,'background':b,'ratio':ratio(a,b),'normalTextPass':ratio(a,b)>=4.5} for label,a,b in pairs]
assert all(x['normalTextPass'] for x in results)
report={'method':'WCAG sRGB relative luminance, explicit CSS tokens','checks':results,'axeManualReview':'Symbol-only buttons use the verified body/glyph token pair. Decorative Aa has aria-hidden=true; guide background spans paper and #c4c7bc. The foreground remains dark ink at .85 parent opacity. Automated color-contrast incomplete is retained in browser report.','limits':'No screen reader or physical-device audit; no certification claimed.'}
(R/'reports/manual-accessibility.json').write_text(json.dumps(report,indent=2),encoding='utf8');print(json.dumps(results))
