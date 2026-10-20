from pathlib import Path
import zipfile
ROOT=Path(__file__).resolve().parents[1]
with zipfile.ZipFile(ROOT/'demo/public/BrandSans-fonts.zip','w',zipfile.ZIP_DEFLATED) as z:
 for directory in ['fonts']:
  for p in (ROOT/directory).iterdir():z.write(p,p.relative_to(ROOT))
 for p in [ROOT/'OFL.txt',ROOT/'reports/coverage.json',ROOT/'reports/validation.json']:z.write(p,p.relative_to(ROOT))
with zipfile.ZipFile(ROOT/'demo/public/BrandSans-fonts.zip') as z:assert z.testzip() is None
