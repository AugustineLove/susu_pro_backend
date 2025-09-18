import fs from 'fs';

const key = JSON.parse(fs.readFileSync('./serviceAccountKey.json', 'utf8'));

console.log(JSON.stringify(key));
