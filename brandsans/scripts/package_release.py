from pathlib import Path
import zipfile,hashlib,json
ROOT=Path(__file__).resolve().parents[1]
# Avoid local tools, node_modules, caches and the delivery archive itself.
def included(p):
 return not any(part in {'.tools','node_modules','__pycache__','.git'} for part in p.relative_to(ROOT).parts) and p.name not in {'BrandSans.zip','archive-validation.json','SHA256SUMS.txt'}
files=sorted(p for p in ROOT.rglob('*') if p.is_file() and included(p))
(ROOT/'SHA256SUMS.txt').write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.relative_to(ROOT).as_posix()+'\n' for p in files),encoding='utf8')
files.append(ROOT/'SHA256SUMS.txt')
out=ROOT/'BrandSans.zip'
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as z:
 for p in files:z.write(p,'BrandSans/'+p.relative_to(ROOT).as_posix())
with zipfile.ZipFile(out) as z:
 assert z.testzip() is None
 for style in ('Regular','Medium'):
  for ext,magic in [('ttf',b'\x00\x01\x00\x00'),('woff2',b'wOF2')]:
   rel=f'fonts/BrandSans-{style}.{ext}';data=z.read('BrandSans/'+rel);assert data[:4]==magic and data==(ROOT/rel).read_bytes()
 for rel in ['demo/package-lock.json','demo/dist/index.html','demo/src/main.tsx','fonts/brandsans.css','OFL.txt','reports/validation.json','reports/browser-validation.json']:
  assert 'BrandSans/'+rel in z.namelist()
 report={'status':'PASS','archive':out.name,'bytes':out.stat().st_size,'fileCount':len(z.namelist()),'crc':'PASS','fontFilesByteEquality':'PASS','sha256':hashlib.sha256(out.read_bytes()).hexdigest()}
(ROOT/'reports/archive-validation.json').write_text(json.dumps(report,indent=2),encoding='utf8');print(json.dumps(report))
