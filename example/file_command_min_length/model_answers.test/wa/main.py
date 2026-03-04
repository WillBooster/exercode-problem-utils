import os

# 意図的に間違い: 常に長い方を出力
in_dir = input().strip()
longest = ('', -1)
for name in os.listdir(in_dir):
    path = os.path.join(in_dir, name)
    if os.path.isdir(path) or not name.endswith('.txt'):
        continue
    with open(path, encoding='utf-8') as f:
        text = f.read()
    if len(text) > longest[1]:
        longest = (name, len(text))

print(longest[0])
