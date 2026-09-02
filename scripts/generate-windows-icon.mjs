import fs from 'node:fs/promises';
import path from 'node:path';
import pngToIco from 'png-to-ico';

const root = process.cwd();
const source = path.join(root, 'assests', 'icons', 'terminal.png');
const target = path.join(root, 'assests', 'icons', 'app-icon.ico');

const icon = await pngToIco(source);
await fs.writeFile(target, icon);
console.log(`Generated ${path.relative(root, target)}`);
