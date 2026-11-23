import re, pathlib
src = pathlib.Path('src')  # 在 source 文件夹里运行
js = []
for f in ['mix.js', 'synth.js', 'calib.js', 'separator.js', 'lyrics.js', 'engine.js', 'transport.js', 'live.js', 'app.js']:
    t = (src / f).read_text()
    t = re.sub(r'^import .*?;\s*$', '', t, flags=re.M)
    t = re.sub(r'^export \{[^}]*\};\s*$', '', t, flags=re.M)
    t = re.sub(r'^export ', '', t, flags=re.M)
    js.append(f'// ===== {f} =====\n' + t)
def vendor(path):
    t = pathlib.Path(path).read_text()
    t = re.sub(r'//# sourceMappingURL=.*$', '', t, flags=re.M)
    return t.replace('</script', '<\\/script')
vend = '// PeerJS 1.5.5 (MIT) + qrcode-generator (MIT)\n' + vendor('node_modules/peerjs/dist/peerjs.min.js') + '\n' + vendor('node_modules/qrcode-generator/dist/qrcode.js')
page = (src / 'page.html').read_text()
page = page.replace('/*STYLE*/', (src / 'style.css').read_text())
page = page.replace('/*VENDOR*/', vend)
page = page.replace('/*TRYSTERO*/', '// Trystero (MIT)\n' + vendor('vendor/trystero.min.js'))
page = page.replace('/*SCRIPT*/', '\n'.join(js))
pathlib.Path('../index.html').write_text(page)
print(len(page), 'bytes')

import shutil
for f in ['manifest.webmanifest', 'sw.js', 'icon-192.png', 'icon-512.png']:
    shutil.copy(src / 'pwa' / f, pathlib.Path('..') / f)
