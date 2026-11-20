import fs from 'fs';
import { parts } from './parts.mjs';
const b = JSON.parse(fs.readFileSync('fighter/body.json', 'utf8'));
b.parts = parts;
fs.writeFileSync('fighter/body.json', JSON.stringify(b, null, 1));
