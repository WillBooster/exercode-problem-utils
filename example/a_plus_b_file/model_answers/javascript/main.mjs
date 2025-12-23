import fs from 'node:fs';

const a = Number.parseInt(fs.readFileSync('a.txt', 'utf8').trim(), 10);
const b = Number.parseInt(fs.readFileSync('b.txt', 'utf8').trim(), 10);
fs.writeFileSync('c.txt', `${(a + b).toString()}\n`);
