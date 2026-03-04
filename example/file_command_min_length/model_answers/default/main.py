import os

in_dir = input().strip()
files = []
for name in os.listdir(in_dir):
    path = os.path.join(in_dir, name)
    if not os.path.isfile(path):
        continue
    if not name.endswith('.txt'):
        continue
    with open(path, encoding='utf-8') as f:
        files.append((name, len(f.read())))

if not files:
    raise SystemExit('no txt files')

print(min(files, key=lambda item: item[1])[0])
